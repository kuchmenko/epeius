import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ChainStatusSchema,
  PreparationStatus,
  PrepareExecutionResponseSchema,
  QuoteFinalSchema,
  TokenSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { formatAtomic, formatPreparation, formatQuote } from "./format";

test("formatAtomic handles zero and large decimal amounts", () => {
  expect(formatAtomic("1", 0)).toBe("1");
  expect(formatAtomic("1", 18)).toBe("0.000000000000000001");
  expect(formatAtomic("12000000", 6)).toBe("12");
});

test("preparation review shows trusted exact amounts, complete addresses and separate approval", () => {
  const address = (digit: string) => `0x${digit.repeat(40)}`;
  const p = create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    tokenIn: address("1"),
    tokenOut: address("2"),
    recipient: address("3"),
    amountInAtomic: "9007199254740993123456",
    amountOutMinimumAtomic: "197",
    deadlineUnix: "4102444800",
    expiresAtUnix: "4102444770",
    simulatedAmountOutAtomic: "203",
    simulationBlock: { number: "24", hash: `0x${"a".repeat(64)}` },
    transaction: { from: address("3"), to: address("4"), chainId: "8453" },
    route: {
      routeId: "route\n\u001b[2J",
      deploymentId: "uni",
      provider: "uniswap-v3",
      amountOutAtomic: "198",
      legs: [
        {
          tokenIn: address("1"),
          tokenOut: address("2"),
          pool: address("5"),
          selector: { case: "feePips", value: 0 },
        },
      ],
    },
  });
  if (!p.transaction) throw new Error("Missing fixture transaction.");
  const plan = {
    spender: address("4"),
    routeDetails: [
      [`Pool: ${address("5")}; fee: 0 pips`],
      [`Pool: ${address("5")}; fee: 0 pips`],
    ],
  };
  for (const [decimals, decimal] of [
    [0, "9007199254740993123456"],
    [6, "9007199254740993.123456"],
    [18, "9007.199254740993123456"],
  ] as const) {
    const chain = create(ChainStatusSchema, {
      key: "base",
      chainId: "8453",
      tokens: [
        { address: p.tokenIn, symbol: "IN", decimals },
        { address: p.tokenOut, symbol: "OUT", decimals: 6 },
      ],
    });
    const text = formatPreparation(p, chain, plan);
    for (const expected of [
      `Total input: ${decimal} IN (9007199254740993123456 atomic)`,
      "Minimum output: 0.000197 OUT (197 atomic)",
      "Chain: base (8453)",
      `Account: ${address("3")}`,
      `Recipient: ${address("3")}`,
      `Spender: ${address("4")}`,
      `Input token: IN ${address("1")}`,
      `Output token: OUT ${address("2")}`,
      "Swap deadline: 2100-01-01T00:00:00.000Z (Unix 4102444800)",
      "Preparation expires: 2099-12-31T23:59:30.000Z (Unix 4102444770)",
      "Simulation block: 24",
      "Simulated output (estimate, not a receipt): 0.000203 OUT (203 atomic)",
      "Route: route\\n\\u001b[2J",
      "fee: 0 pips",
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("\u001b");
    const approval = {
      ...p,
      status: PreparationStatus.APPROVAL_REQUIRED,
      transaction: undefined,
      approvalTransaction: { ...p.transaction, to: p.tokenIn },
      approvalSpender: address("4"),
    };
    expect(formatPreparation(approval, chain, plan)).toContain(
      "APPROVAL ONLY — fresh quote and separate swap consent",
    );
    expect(formatPreparation(approval, chain, plan)).toContain(
      "Proposed swap minimum (not sent by this approval)",
    );
    const split = {
      ...p,
      route: undefined,
      allocations: [
        {
          $typeName: "epeius.quote.v1.QuotedAllocation" as const,
          route: p.route,
          amountInAtomic: "37",
        },
        {
          $typeName: "epeius.quote.v1.QuotedAllocation" as const,
          route: p.route,
          amountInAtomic: "64",
        },
      ],
    };
    expect(formatPreparation(split, chain, plan)).toContain("Allocation 2:");
    expect(formatPreparation(split, chain, plan)).toContain("(37 atomic)");
    expect(formatPreparation(split, chain, plan)).toContain("(64 atomic)");
    expect(() => formatPreparation(p, { ...chain, tokens: [] }, plan)).toThrow(
      "metadata",
    );
  }
});

test("quote output includes chain, block, exact amounts, tiers, and partial warning", () => {
  const input = create(TokenSchema, {
    symbol: "WETH",
    address: `0x${"1".repeat(40)}`,
    decimals: 18,
  });
  const output = create(TokenSchema, {
    symbol: "USDC",
    address: `0x${"2".repeat(40)}`,
    decimals: 6,
  });
  const chain = create(ChainStatusSchema, {
    key: "base",
    chainId: "8453",
    tokens: [input, output],
  });
  const quote = create(QuoteFinalSchema, {
    quoteId: "q",
    bestRouteId: "500",
    searchComplete: false,
    block: { number: "123", hash: "0xabc" },
    routes: [
      {
        routeId: "500",
        provider: "uniswap-v3",
        amountOutAtomic: "1234567",
        latencyMs: 4,
        legs: [
          {
            selector: { case: "feePips", value: 500 },
            pool: "pool",
            tokenIn: input.address,
            tokenOut: output.address,
          },
          {
            selector: { case: "tickSpacing", value: 200 },
            pool: "pool2",
            tokenIn: output.address,
            tokenOut: input.address,
          },
        ],
      },
      {
        routeId: "balancer",
        provider: "balancer-v2",
        amountOutAtomic: "1234567",
        legs: [
          {
            pool: "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063",
            tokenIn: input.address,
            tokenOut: output.address,
          },
        ],
      },
    ],
  });
  const text = formatQuote(quote, chain, input, output, "1000000000000000000");
  expect(text).toContain("base (8453)");
  expect(text).toContain("Block: 123");
  expect(text).toContain("1 WETH (1000000000000000000 atomic)");
  expect(text).toContain("1.234567 USDC (1234567 atomic)");
  expect(text).toContain("fee 500 pips");
  expect(text).toContain("Leg 2: pool pool2; tick spacing 200");
  expect(text).toContain(
    "pool address 0x06df3b2bbb68adc8b0e302443692037ed9f91b42",
  );
  expect(text).not.toContain("unknown selector");
  expect(text).toContain("Search was partial");
  expect(text).toContain("Engine recommendation: 500");
  expect(text).toContain(
    "highest raw output among returned routes; not gas-adjusted or a global best",
  );
  quote.bestRouteId = undefined;
  expect(formatQuote(quote, chain, input, output, "1")).not.toContain(
    "Engine recommendation",
  );
});
