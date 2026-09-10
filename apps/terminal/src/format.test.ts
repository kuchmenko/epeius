import { expect, test } from "bun:test";
import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  BlockContextSchema,
  Environment,
  QuoteFinalSchema,
  QuoteRequestSchema,
  RouteLegSchema,
  RouteQuoteSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { smokeQuoteArgs } from "../../../scripts/smoke";
import { root } from "../../../scripts/tasks";
import { formatAtomic, formatQuote, USDC, WETH } from "./format";

const request = create(QuoteRequestSchema, {
  environment: Environment.BASE_MAINNET,
  sender: `0x${"1".repeat(40)}`,
  recipient: `0x${"2".repeat(40)}`,
  tokenIn: WETH,
  tokenOut: USDC,
  amountInAtomic: "123456789012345678901234567890123456789",
  slippageBps: 25,
  searchBudgetMs: 1000,
});

function final(routes = 1, searchComplete = true) {
  const leg = create(RouteLegSchema, {
    pool: `0x${"3".repeat(40)}`,
    tokenIn: WETH,
    tokenOut: USDC,
    feePips: 500,
  });
  const route = create(RouteQuoteSchema, {
    routeId: "route-1",
    provider: "uniswap-v3",
    legs: [leg],
    amountOutAtomic: "987654321098765432109876543210",
    block: create(BlockContextSchema, {
      number: "12345678",
      hash: `0x${"a".repeat(64)}`,
    }),
    latencyMs: 12,
  });
  return create(QuoteFinalSchema, {
    quoteId: "quote-1",
    searchComplete,
    routes: routes ? [route] : [],
    errors: searchComplete
      ? []
      : [
          {
            provider: "uniswap-v3",
            routeId: "route-2",
            message: "timed out",
          },
        ],
    block: create(BlockContextSchema, {
      number: "12345678",
      hash: `0x${"a".repeat(64)}`,
    }),
  });
}

test("formats exact large asymmetric 18 and 6 decimal amounts", () => {
  expect(formatAtomic("1", 18)).toBe("0.000000000000000001");
  expect(formatAtomic("1", 6)).toBe("0.000001");
  expect(formatAtomic("12000000", 6)).toBe("12");
  expect(formatAtomic("123456789012345678901234567890123456789", 18)).toBe(
    "123456789012345678901.234567890123456789",
  );
  expect(formatAtomic("987654321098765432109876543210", 6)).toBe(
    "987654321098765432109876.54321",
  );
  const output = formatQuote(final(1, false), request);
  expect(output).toContain("WARNING: Search was partial");
  expect(output).toContain("fee 500 pips");
  expect(output).toContain("12345678");
  expect(output).toContain("987654321098765432109876543210 atomic");
  expect(output).toContain("Error (uniswap-v3, route route-2): timed out");
  expect(output).not.toMatch(/best|economic/i);
});

test("empty output states that no routes returned", () => {
  expect(formatQuote(final(0, false), request)).toContain(
    "No routes returned.",
  );
});

test("CLI prints protobuf JSON and returns route-based status for complete, partial, and empty results", async () => {
  for (const [routes, complete] of [
    [1, true],
    [1, false],
    [0, true],
    [0, false],
  ] as const) {
    const quote = final(routes, complete);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.url).toContain("/epeius.quote.v1.QuoteService/GetQuote");
        const input = fromBinary(
          QuoteRequestSchema,
          new Uint8Array(await request.arrayBuffer()),
        );
        expect(input.amountInAtomic).toBe("9007199254740993");
        return new Response(toBinary(QuoteFinalSchema, quote), {
          headers: { "content-type": "application/proto" },
        });
      },
    });
    try {
      const cli = Bun.spawn(
        ["bun", "apps/terminal/src/main.ts", ...smokeQuoteArgs, "--json"],
        {
          cwd: root,
          env: {
            ...process.env,
            EPEIUS_ENVIRONMENT: "base-mainnet",
            EPEIUS_ENGINE_URL: server.url.toString(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
        cli.exited,
      ]);
      expect(code).toBe(routes ? 0 : 1);
      expect(JSON.parse(stdout)).toEqual(
        JSON.parse(toJsonString(QuoteFinalSchema, quote)),
      );
      if (routes) {
        expect(JSON.parse(stdout).routes[0].legs[0].feePips).toBe(500);
        expect(JSON.parse(stdout).routes[0].amountOutAtomic).toBe(
          "987654321098765432109876543210",
        );
      }
      expect(stderr).toBe(
        complete
          ? ""
          : "WARNING: Search was partial; some routes may be missing.\n",
      );
    } finally {
      await server.stop(true);
    }
  }
});
