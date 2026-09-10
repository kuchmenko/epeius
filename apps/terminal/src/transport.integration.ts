// Executed by Go integration tests against real Connect handlers.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { quoteClient } from "./client";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const url = process.env.EPEIUS_TEST_URL;
assert.ok(url, "Run through go test, which owns HTTP fixture.");
const client = quoteClient(url);
const hasCode = (code: Code) => (error: unknown) =>
  error instanceof ConnectError && error.code === code;

const status = await client.getStatus({});
const base = status.chains.find((chain) => chain.key === "base");
assert.ok(base);
assert.equal(base.chainId, "8453");
assert.equal(base.connected, true);
assert.ok(base.tokens.some((token) => token.address === WETH));

await assert.rejects(client.getQuote({}), hasCode(Code.InvalidArgument));
const input = {
  chain: "base",
  chainId: "8453",
  tokenIn: WETH,
  tokenOut: USDC,
  amountInAtomic: "9007199254740993",
  searchBudgetMs: 5000,
};
const quote = await client.getQuote(input);
assert.equal(quote.searchComplete, true);
assert.deepEqual(
  quote.routes.map((route) => route.legs[0].feePips),
  [100, 500, 3000, 10000],
);
assert.equal(quote.routes[0].amountOutAtomic, "987654321");

const directory = await mkdtemp(join(tmpdir(), "epeius-integration-"));
const config = join(directory, "epeius.toml");
await Bun.write(
  config,
  `[terminal]\ndefault_chain='base'\nengine_url='${url}/partial'\nsearch_budget_ms=5500\n`,
);
try {
  const terminal = Bun.spawn(
    [
      "bun",
      "apps/terminal/src/main.ts",
      "quote",
      "--config",
      config,
      "--in",
      "WETH",
      "--out",
      "USDC",
      "--amount-atomic",
      "9007199254740993",
      "--search-budget-ms",
      "5500",
      "--json",
    ],
    // Leave time for cleanup before the outer Go test's 15-second deadline.
    { stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(terminal.stdout).text(),
    new Response(terminal.stderr).text(),
    terminal.exited,
  ]);
  assert.equal(exitCode, 0, stderr);
  const partial = JSON.parse(stdout);
  assert.equal(partial.searchComplete ?? false, false);
  assert.equal(partial.routes.length, 1);
  assert.equal(partial.errors.length, 3);
  assert.match(stderr, /Search was partial/);
} finally {
  await rm(directory, { recursive: true });
}

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

const fixture = quoteClient(`${url}/fixture`);
const events = [];
for await (const message of fixture.streamQuote(input))
  events.push(message.event);
assert.deepEqual(
  events.map((event) => event.case),
  ["quote", "error", "final"],
);
assert.equal(
  events[0].case === "quote" && events[0].value.amountOutAtomic,
  "9007199254740993",
);

const controller = new AbortController();
await assert.rejects(async () => {
  for await (const _ of fixture.streamQuote(
    { ...input, chain: "cancel" },
    { signal: controller.signal },
  ))
    controller.abort();
}, hasCode(Code.Canceled));
await assert.rejects(async () => {
  for await (const _ of fixture.streamQuote(
    { ...input, chain: "deadline" },
    { timeoutMs: 150 },
  )) {
    // Wait for deadline after first event.
  }
}, hasCode(Code.DeadlineExceeded));
