// Executed by the Go integration test against real Connect handlers.
import assert from "node:assert/strict";
import { Code, ConnectError } from "@connectrpc/connect";
import { quoteClient } from "./client";

const url = process.env.EPEIUS_TEST_URL;
assert.ok(url, "Run through go test, which owns the HTTP fixture.");
const client = quoteClient(url);
const hasCode = (code: Code) => (error: unknown) =>
  error instanceof ConnectError && error.code === code;
await assert.rejects(client.getQuote({}), hasCode(Code.Unimplemented));
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
