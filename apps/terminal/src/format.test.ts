import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ChainStatusSchema,
  QuoteFinalSchema,
  TokenSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { formatAtomic, formatQuote } from "./format";

test("formatAtomic handles zero and large decimal amounts", () => {
  expect(formatAtomic("1", 0)).toBe("1");
  expect(formatAtomic("1", 18)).toBe("0.000000000000000001");
  expect(formatAtomic("12000000", 6)).toBe("12");
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
    ],
  });
  const text = formatQuote(quote, chain, input, output, "1000000000000000000");
  expect(text).toContain("base (8453)");
  expect(text).toContain("Block: 123");
  expect(text).toContain("1 WETH (1000000000000000000 atomic)");
  expect(text).toContain("1.234567 USDC (1234567 atomic)");
  expect(text).toContain("fee 500 pips");
  expect(text).toContain("Leg 2: pool pool2; tick spacing 200");
  expect(text).toContain("Search was partial");
  expect(text).not.toMatch(/best|economic/i);
});
