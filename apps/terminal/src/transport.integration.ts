// Executed by the Go integration test against real Connect handlers.
import assert from "node:assert/strict";
import { Code, ConnectError } from "@connectrpc/connect";
import { Environment } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { quoteClient } from "./client";
import { USDC, WETH } from "./format";

const url = process.env.EPEIUS_TEST_URL;
assert.ok(url, "Run through go test, which owns the HTTP fixture.");
const client = quoteClient(url);
const hasCode = (code: Code) => (error: unknown) =>
  error instanceof ConnectError && error.code === code;
await assert.rejects(client.getQuote({}), hasCode(Code.InvalidArgument));
const input = {
  environment: Environment.BASE_MAINNET,
  sender: `0x${"1".repeat(40)}`,
  recipient: `0x${"2".repeat(40)}`,
  tokenIn: WETH,
  tokenOut: USDC,
  amountInAtomic: "9007199254740993",
  slippageBps: 37,
  searchBudgetMs: 5000,
};
const quote = await client.getQuote(input);
assert.equal(quote.searchComplete, true);
assert.deepEqual(
  quote.routes.map((route) => route.legs[0].feePips),
  [100, 500, 3000, 10000],
);
assert.equal(quote.routes[0].amountOutAtomic, "987654321");
assert.equal(quote.routes[0].networkCostOutAtomic, undefined);
assert.equal(quote.bestRouteId, undefined);
const slow = quoteClient(`${url}/slow`);
const unaryCancel = new AbortController();
const timer = setTimeout(() => unaryCancel.abort(), 150);
try {
  await assert.rejects(
    slow.getQuote(input, { signal: unaryCancel.signal }),
    hasCode(Code.Canceled),
  );
} finally {
  clearTimeout(timer);
}
await assert.rejects(
  slow.getQuote(input, { timeoutMs: 150 }),
  hasCode(Code.DeadlineExceeded),
);
await assert.rejects(
  client.prepareExecution({ quoteId: "q", routeId: "r" }),
  hasCode(Code.Unimplemented),
);
await assert.rejects(async () => {
  for await (const _ of client.streamQuote({}))
    assert.fail("unexpected successful event");
}, hasCode(Code.Unimplemented));

const fixture = quoteClient(`${url}/fixture`);
const events = [];
for await (const message of fixture.streamQuote({})) events.push(message.event);
assert.deepEqual(
  events.map((event) => event.case),
  ["quote", "error", "final"],
);
assert.equal(
  events[0].case === "quote" && events[0].value.amountOutAtomic,
  "9007199254740993",
);
assert.equal(
  events[0].case === "quote" && events[0].value.networkCostOutAtomic,
  undefined,
);
assert.equal(
  events[2].case === "final" && events[2].value.quoteId,
  "quote-final",
);

const controller = new AbortController();
await assert.rejects(async () => {
  for await (const _ of fixture.streamQuote(
    { sender: "cancel" },
    { signal: controller.signal },
  ))
    controller.abort();
}, hasCode(Code.Canceled));
await assert.rejects(async () => {
  for await (const _ of fixture.streamQuote(
    { sender: "deadline" },
    { timeoutMs: 150 },
  )) {
    /* Wait for the deadline after the first event. */
  }
}, hasCode(Code.DeadlineExceeded));
