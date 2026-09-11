import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { executePrepared } from "../apps/terminal/src/execution";
import { configureExecution } from "../apps/terminal/src/execution-composition";
import { executionExitCode } from "../apps/terminal/src/main";
import { pancakeData } from "../apps/terminal/src/pancake";
import type { Receipt } from "../apps/terminal/src/receipt";
import { runTrade, type TradeIO } from "../apps/terminal/src/trade";
import { uniswapData } from "../apps/terminal/src/uniswap";
import {
  BlockContextSchema,
  PreparationStatus,
  PrepareExecutionResponseSchema,
  QuoteFinalSchema,
  RouteQuoteSchema,
} from "../generated/ts/epeius/quote/v1/quote_pb";
import { recordExecution, scenarios } from "./e2e";

test("E2E covers both directions and hop counts independently for each deployment", () => {
  expect(scenarios(["uni", "pancake"])).toEqual([
    { deployment: "pancake", hops: 1, input: "A", output: "C" },
    { deployment: "pancake", hops: 1, input: "C", output: "A" },
    { deployment: "pancake", hops: 2, input: "A", output: "C" },
    { deployment: "pancake", hops: 2, input: "C", output: "A" },
    { deployment: "uni", hops: 1, input: "A", output: "C" },
    { deployment: "uni", hops: 1, input: "C", output: "A" },
    { deployment: "uni", hops: 2, input: "A", output: "C" },
    { deployment: "uni", hops: 2, input: "C", output: "A" },
  ]);
});

test("default E2E only lists scenarios without a signer or reachable engine", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "epeius-e2e-"));
  try {
    const path = join(temporary, "runtime.toml");
    await writeFile(
      path,
      `
[terminal]
default_chain = "base-sepolia"
engine_url = "http://127.0.0.1:1"
search_budget_ms = 2000
[chains.base-sepolia]
chain_id = 84532
execution_enabled = true
[chains.base-sepolia.deployments.uni]
kind = "uniswap-v3"
[chains.base-sepolia.deployments.pancake]
kind = "pancake-v3"
`,
    );
    for (const selection of [false, true]) {
      const child = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "e2e.ts"),
          "--config",
          path,
          ...(selection ? ["--selection"] : []),
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        const result = JSON.parse(output);
        expect(result.broadcast).toBe(false);
        expect(result.track).toBe(selection ? "selection" : "coverage");
        expect(result.scenarios).toEqual(
          selection
            ? [
                { input: "A", output: "C" },
                { input: "C", output: "A" },
              ]
            : scenarios(["uni", "pancake"]),
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("E2E selects --chain and supports any configured deployment count", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "epeius-e2e-chain-"));
  try {
    const path = join(temporary, "runtime.toml");
    await writeFile(
      path,
      `
[terminal]
default_chain = "wrong-default"
engine_url = "http://127.0.0.1:1"
search_budget_ms = 2000
[chains.test]
chain_id = 12345
execution_enabled = true
[chains.test.deployments.one]
kind = "uniswap-v3"
[chains.test.deployments.two]
kind = "pancake-v3"
[chains.test.deployments.three]
kind = "uniswap-v3"
`,
    );
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "e2e.ts"),
        "--config",
        path,
        "--chain",
        "test",
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output).scenarios).toHaveLength(12);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const approvalHash = `0x${"a".repeat(64)}`;
const swapHash = `0x${"b".repeat(64)}`;

async function* outputChunks(text: string) {
  const bytes = new TextEncoder().encode(text);
  // Exercise fragmented JSON, newline, and UTF-8 boundaries.
  for (let offset = 0; offset < bytes.length; offset += 7)
    yield bytes.slice(offset, offset + 7);
}

test("report persists submitted hash before receipt stream resumes", async () => {
  const reports: unknown[] = [];
  const submitted = {
    transactionHash: swapHash,
    kind: "swap",
    message: "Submitted — receipt pending.",
    verification: { outcome: "pending" },
  };
  const verified = {
    transactionHash: swapHash,
    verification: { outcome: "passed", outputReceivedAtomic: "14480" },
  };
  async function* stream() {
    yield* outputChunks(`${JSON.stringify(submitted)}\n`);
    expect(reports).toEqual([submitted]);
    yield* outputChunks(`${JSON.stringify(verified)}\n`);
  }
  await recordExecution(
    stream(),
    Promise.resolve(0),
    "swap",
    async (result) => {
      reports.push(result);
    },
  );
  expect(reports).toEqual([submitted, verified]);
});

test("report requires final verified swap and successful child exit", async () => {
  const passed = JSON.stringify({
    transactionHash: swapHash,
    verification: { outcome: "passed" },
  });
  const approval = JSON.stringify({
    transactionHash: approvalHash,
    verification: { outcome: "receipt_success" },
  });
  for (const [output, code] of [
    ["", 0],
    [`${approval}\n`, 0],
    [`${passed}\n{"sent":false,"outcome":"canceled"}\n`, 0],
    [`${passed}\n{"verification":{"outcome":"failed"}}\n`, 0],
    [`${passed}\n`, 1],
    [passed, 0],
    [`${passed}\n{`, 0],
    [`${passed}\nnot json\n`, 0],
  ] as const) {
    await expect(
      recordExecution(
        outputChunks(output),
        Promise.resolve(code),
        "swap",
        async () => {},
      ),
    ).rejects.toThrow();
  }
});

// These are fixed transport fixtures, not pool predictions or a second ranking implementation.
// Signing, RPC, engine and confirmation responses are supplied; trade/execution/receipt/report code is real.
function selectedTradeFixture(confirmSwap = true, freshNeedsApproval = false) {
  const sender = `0x${"1".repeat(40)}`;
  const input = `0x${"2".repeat(40)}`;
  const output = `0x${"3".repeat(40)}`;
  const uniRouter = `0x${"4".repeat(40)}`;
  const cakeRouter = `0x${"5".repeat(40)}`;
  const pool = `0x${"6".repeat(40)}`;
  const initialBlock = create(BlockContextSchema, {
    number: "40",
    hash: `0x${"c".repeat(64)}`,
  });
  const freshBlock = create(BlockContextSchema, {
    number: "42",
    hash: `0x${"d".repeat(64)}`,
  });
  const uni = create(RouteQuoteSchema, {
    routeId: "uni-direct",
    deploymentId: "uni",
    provider: "uniswap-v3",
    amountOutAtomic: "12000",
    block: initialBlock,
    legs: [
      {
        pool,
        tokenIn: input,
        tokenOut: output,
        selector: { case: "feePips", value: 500 },
      },
    ],
  });
  const cake = create(RouteQuoteSchema, {
    ...uni,
    routeId: "cake-direct",
    deploymentId: "cake",
    provider: "pancake-v3",
    amountOutAtomic: "10000",
  });
  const quotes = [
    create(QuoteFinalSchema, {
      quoteId: "before-approval",
      routes: [uni, cake],
      bestRouteId: "uni-direct",
      searchComplete: true,
      block: initialBlock,
    }),
    create(QuoteFinalSchema, {
      quoteId: "after-approval",
      routes: [
        { ...uni, amountOutAtomic: "11000", block: freshBlock },
        { ...cake, amountOutAtomic: "14500", block: freshBlock },
      ],
      bestRouteId: "cake-direct",
      searchComplete: false,
      errors: [
        {
          provider: "uniswap-v3",
          routeId: "uni-two-hop",
          message: "Search budget expired.",
        },
      ],
      block: freshBlock,
    }),
  ];
  const events: unknown[] = [];
  const calls: string[] = [];
  let quoteCount = 0;
  const report = (event: unknown) => {
    events.push(event);
  };
  const io: TradeIO = {
    quote: async () => {
      calls.push("quote");
      const quote = quotes[quoteCount++];
      if (!quote) throw new Error("Unexpected extra quote.");
      return quote;
    },
    report,
    execute: async (quote, route, afterApproval) => {
      calls.push(`execute:${quote.quoteId}:${route.routeId}:${afterApproval}`);
      const isCake = route.routeId === "cake-direct";
      const router = isCake ? cakeRouter : uniRouter;
      const needsApproval = !afterApproval || freshNeedsApproval;
      const p = create(PrepareExecutionResponseSchema, {
        status: needsApproval
          ? PreparationStatus.APPROVAL_REQUIRED
          : PreparationStatus.READY,
        preparationId: afterApproval
          ? "fresh-preparation"
          : "approval-preparation",
        expiresAtUnix: "4102444800",
        deadlineUnix: "4102444800",
        amountInAtomic: "1000",
        amountOutMinimumAtomic: afterApproval
          ? isCake
            ? "14427"
            : "10945"
          : "11940",
        simulatedAmountOutAtomic: afterApproval
          ? isCake
            ? "14490"
            : "10990"
          : "11990",
        simulationBlock: afterApproval ? freshBlock : initialBlock,
        tokenIn: input,
        tokenOut: output,
        recipient: sender,
        route,
      });
      const tx = {
        chainId: "84532",
        from: sender,
        to: router,
        data: "0x",
        valueAtomic: "0",
        gasLimit: "200000",
      };
      if (needsApproval) {
        p.approvalSpender = router;
        p.approvalTransaction = create(PrepareExecutionResponseSchema, {
          approvalTransaction: {
            ...tx,
            to: input,
            data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${"3e8".padStart(64, "0")}`,
          },
        }).approvalTransaction;
      } else {
        // Encoding itself is covered by terminal tests; expected amounts below are independent constants.
        p.transaction = create(PrepareExecutionResponseSchema, {
          transaction: {
            ...tx,
            data: isCake ? pancakeData(p) : uniswapData(p),
          },
        }).transaction;
      }
      return executePrepared({
        signer: sender,
        expectedChainId: "84532",
        slippageBps: 50,
        trusted: configureExecution({
          tokens: [input, output],
          deployments: {
            uni: { kind: "uniswap-v3", router: uniRouter, fees: [500] },
            cake: { kind: "pancake-v3", router: cakeRouter, fees: [500] },
          },
        }),
        chainId: async () => "0x14a34",
        prepare: async (id) => {
          calls.push(`prepare:${id ?? "new"}`);
          return structuredClone(p);
        },
        confirm: async (kind) => {
          calls.push(`confirm:${kind}:${p.preparationId}`);
          return kind === "approval" || confirmSwap;
        },
        send: async (transaction) => {
          calls.push(`send:${transaction.to}`);
          return needsApproval ? approvalHash : swapHash;
        },
        receipt: async (hash) => {
          calls.push(`receipt:${hash}`);
          const transfer = (
            token: string,
            from: string,
            to: string,
            amount: number,
          ): Receipt["logs"][number] => ({
            transactionHash: hash,
            address: token,
            topics: [
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
              `0x${from.slice(2).padStart(64, "0")}`,
              `0x${to.slice(2).padStart(64, "0")}`,
            ],
            data: `0x${amount.toString(16).padStart(64, "0")}`,
          });
          return {
            transactionHash: hash,
            status: "0x1",
            logs: needsApproval
              ? []
              : [
                  transfer(input, sender, pool, 1000),
                  transfer(output, pool, sender, isCake ? 14480 : 10980),
                ],
          };
        },
        reportPreparation: true,
        swapOnly: afterApproval,
        report,
      });
    },
  };
  return { io, events, calls };
}

test("selected-route integration reselects fresh engine winner, but keeps manual route", async () => {
  for (const manual of [false, true]) {
    const f = selectedTradeFixture();
    const code = executionExitCode(
      await runTrade(f.io, manual ? "uni-direct" : undefined),
    );
    expect(code).toBe(0);
    const routeId = manual ? "uni-direct" : "cake-direct";
    expect(f.calls).toEqual([
      "quote",
      "execute:before-approval:uni-direct:false",
      "prepare:new",
      "confirm:approval:approval-preparation",
      "prepare:approval-preparation",
      `send:0x${"2".repeat(40)}`,
      `receipt:${approvalHash}`,
      "quote",
      `execute:after-approval:${routeId}:true`,
      "prepare:new",
      "confirm:swap:fresh-preparation",
      "prepare:fresh-preparation",
      `send:0x${(manual ? "4" : "5").repeat(40)}`,
      `receipt:${swapHash}`,
    ]);
    const recorded: unknown[] = [];
    await recordExecution(
      outputChunks(
        `${f.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      ),
      Promise.resolve(code),
      "swap",
      async (event) => {
        recorded.push(event);
      },
    );
    expect(recorded).toEqual(f.events);
    expect(recorded).toEqual([
      expect.objectContaining({
        quote: expect.objectContaining({
          quoteId: "before-approval",
          bestRouteId: "uni-direct",
          searchComplete: true,
          block: { number: "40", hash: `0x${"c".repeat(64)}` },
          routes: [
            expect.objectContaining({
              routeId: "uni-direct",
              amountOutAtomic: "12000",
            }),
            expect.objectContaining({
              routeId: "cake-direct",
              amountOutAtomic: "10000",
            }),
          ],
        }),
      }),
      {
        selection: {
          quoteId: "before-approval",
          routeId: "uni-direct",
          source: manual ? "manual" : "engine",
          searchComplete: true,
          basis: "raw_output",
          afterApproval: false,
        },
      },
      expect.objectContaining({
        preparation: expect.objectContaining({
          preparationId: "approval-preparation",
        }),
        sent: false,
      }),
      expect.objectContaining({
        transactionHash: approvalHash,
        verification: { outcome: "pending" },
      }),
      expect.objectContaining({
        transactionHash: approvalHash,
        verification: { outcome: "receipt_success" },
      }),
      expect.objectContaining({
        quote: expect.objectContaining({
          quoteId: "after-approval",
          bestRouteId: "cake-direct",
          block: { number: "42", hash: `0x${"d".repeat(64)}` },
          routes: [
            expect.objectContaining({
              routeId: "uni-direct",
              amountOutAtomic: "11000",
            }),
            expect.objectContaining({
              routeId: "cake-direct",
              amountOutAtomic: "14500",
            }),
          ],
          errors: [
            {
              provider: "uniswap-v3",
              routeId: "uni-two-hop",
              message: "Search budget expired.",
            },
          ],
        }),
      }),
      {
        selection: {
          quoteId: "after-approval",
          routeId,
          source: manual ? "manual" : "engine",
          searchComplete: false,
          basis: "raw_output",
          afterApproval: true,
        },
      },
      {
        preparation: expect.objectContaining({
          preparationId: "fresh-preparation",
          route: expect.objectContaining({
            routeId,
            amountOutAtomic: manual ? "11000" : "14500",
            block: { number: "42", hash: `0x${"d".repeat(64)}` },
          }),
          amountOutMinimumAtomic: manual ? "10945" : "14427",
          simulatedAmountOutAtomic: manual ? "10990" : "14490",
          simulationBlock: { number: "42", hash: `0x${"d".repeat(64)}` },
        }),
        sent: false,
      },
      expect.objectContaining({
        transactionHash: swapHash,
        kind: "swap",
        verification: { outcome: "pending" },
      }),
      {
        transactionHash: swapHash,
        verification: expect.objectContaining({
          outcome: "passed",
          inputSpentAtomic: "1000",
          outputReceivedAtomic: manual ? "10980" : "14480",
        }),
      },
    ]);
  }
});

test("selected-route integration cannot use approval confirmation to send fresh swap", async () => {
  const f = selectedTradeFixture(false);
  expect(await runTrade(f.io)).toEqual({ kind: "canceled" });
  expect(f.calls.filter((call) => call.startsWith("send:"))).toEqual([
    `send:0x${"2".repeat(40)}`,
  ]);
  expect(f.calls).toContain("confirm:swap:fresh-preparation");
  expect(f.events.at(-1)).toEqual({ sent: false, outcome: "canceled" });
});

test("selected-route integration stops if fresh winner needs another approval", async () => {
  const f = selectedTradeFixture(true, true);
  await expect(runTrade(f.io)).rejects.toThrow("Approval is still required.");
  expect(f.calls.filter((call) => call.startsWith("send:"))).toEqual([
    `send:0x${"2".repeat(40)}`,
  ]);
  expect(f.calls.filter((call) => call.startsWith("confirm:"))).toEqual([
    "confirm:approval:approval-preparation",
  ]);
  expect(f.calls.filter((call) => call === "quote")).toHaveLength(2);
});
