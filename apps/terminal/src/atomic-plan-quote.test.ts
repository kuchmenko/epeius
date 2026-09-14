import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { type Hex, hexToBytes } from "viem";
import {
  BranchQuoteSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanCandidateSchema,
  PlanProgramSchema,
  PlanQuoteResponseSchema,
  PoolOperationSchema,
  V3PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import { TokenSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  atomicCandidateId,
  atomicPlanQuoteRequest,
  formatAtomicPlanQuote,
  validateAtomicPlanQuote,
} from "./atomic-plan-quote";

const fixture = await Bun.file(
  "contracts/fixtures/atomic-v1-candidate.json",
).json();
const word = (value: string) =>
  hexToBytes(`0x${BigInt(value).toString(16).padStart(64, "0")}`);
const address = (value: string) => hexToBytes(value as Hex);
const request = {
  chainId: BigInt(fixture.chainId),
  tokenIn: fixture.tokenIn,
  tokenOut: fixture.tokenOut,
  amountIn: BigInt(fixture.amountIn),
} as const;

function response() {
  const tokens = [fixture.tokenIn, fixture.intermediateToken, fixture.tokenOut];
  const operations = fixture.fees.map((fee: number, index: number) =>
    create(PoolOperationSchema, {
      tokenIn: address(tokens[index]),
      tokenOut: address(tokens[index + 1]),
      pool: {
        case: "uniswapV3",
        value: create(V3PoolSchema, {
          factory: address(fixture.factory),
          router: address(fixture.router),
          pool: address(fixture.pools[index]),
          feePips: fee,
        }),
      },
    }),
  );
  const candidate = create(PlanCandidateSchema, {
    candidateId: hexToBytes(fixture.candidateId),
    program: create(PlanProgramSchema, {
      formatVersion: fixture.formatVersion,
      chainId: word(fixture.chainId),
      tokenIn: address(fixture.tokenIn),
      tokenOut: address(fixture.tokenOut),
      amountIn: word(fixture.amountIn),
      branches: [
        create(PlanBranchSchema, {
          amountIn: word(fixture.amountIn),
          operations,
        }),
      ],
    }),
    quoteBlock: create(PinnedBlockSchema, {
      number: word(fixture.quoteBlockNumber),
      hash: hexToBytes(fixture.quoteBlockHash),
    }),
    branchQuotes: [
      create(BranchQuoteSchema, {
        operationOutputs: fixture.operationOutputs.map(word),
      }),
    ],
  });
  return create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32).fill(0xbb),
    candidates: [candidate],
    searchComplete: true,
  });
}

function program(value: ReturnType<typeof response>) {
  const result = value.candidates[0]?.program;
  if (!result) throw new Error("test candidate program missing");
  return result;
}

function pool(value: ReturnType<typeof response>, operationIndex: number) {
  const operation = program(value).branches[0]?.operations[operationIndex];
  if (operation?.pool.case !== "uniswapV3")
    throw new Error("test Uniswap operation missing");
  return operation.pool.value;
}

function quoteBlock(value: ReturnType<typeof response>) {
  const result = value.candidates[0]?.quoteBlock;
  if (!result) throw new Error("test quote block missing");
  return result;
}

test("Atomic candidate identity matches the independent Cast two-hop vector", () => {
  const value = response();
  expect(atomicCandidateId(value.candidates[0])).toBe(fixture.candidateId);
  expect(validateAtomicPlanQuote(value, request)).toBe(value);
  expect(atomicPlanQuoteRequest(request, 17)).toEqual({
    formatVersion: 1,
    chainId: word(fixture.chainId),
    tokenIn: address(fixture.tokenIn),
    tokenOut: address(fixture.tokenOut),
    amountIn: word(fixture.amountIn),
    searchBudgetMs: 17,
  });
});

test("Atomic quote rejects every identity and recursive structure mutation", () => {
  const cases: Array<[string, (value: ReturnType<typeof response>) => void]> = [
    ["quote ID", (v) => (v.quoteId = new Uint8Array())],
    ["search presence", (v) => (v.searchComplete = undefined)],
    ["candidate ID", (v) => v.candidates[0].candidateId?.fill(0)],
    ["format", (v) => (program(v).formatVersion = 2)],
    ["chain", (v) => (program(v).chainId = word("8454"))],
    ["program input token", (v) => program(v).tokenIn?.fill(9)],
    ["program output token", (v) => program(v).tokenOut?.fill(9)],
    ["amount", (v) => (program(v).amountIn = word("38"))],
    ["branch amount", (v) => (program(v).branches[0].amountIn = word("36"))],
    ["branch count", (v) => program(v).branches.push(create(PlanBranchSchema))],
    ["operation order", (v) => program(v).branches[0].operations.reverse()],
    [
      "operation output order",
      (v) => v.candidates[0].branchQuotes[0].operationOutputs.reverse(),
    ],
    [
      "operation output count",
      (v) => v.candidates[0].branchQuotes[0].operationOutputs.pop(),
    ],
    [
      "zero intermediate output",
      (v) => (v.candidates[0].branchQuotes[0].operationOutputs[0] = word("0")),
    ],
    [
      "zero final output",
      (v) => (v.candidates[0].branchQuotes[0].operationOutputs[1] = word("0")),
    ],
    ["block number", (v) => (quoteBlock(v).number = word("124"))],
    ["block hash", (v) => quoteBlock(v).hash?.fill(8)],
    ["factory", (v) => pool(v, 0).factory?.fill(8)],
    ["router", (v) => pool(v, 0).router?.fill(8)],
    ["pool", (v) => pool(v, 0).pool?.fill(8)],
    ["fee", (v) => (pool(v, 0).feePips = 501)],
    [
      "continuity",
      (v) =>
        (program(v).branches[0].operations[1].tokenIn = address(
          fixture.tokenIn,
        )),
    ],
    ["duplicate pool", (v) => (pool(v, 1).pool = address(fixture.pools[0]))],
    [
      "reverse physical pool",
      (v) => {
        const operation = program(v).branches[0].operations[1];
        operation.tokenIn = address(fixture.intermediateToken);
        operation.tokenOut = address(fixture.tokenIn);
        pool(v, 1).feePips = fixture.fees[0];
      },
    ],
    ["network cost", (v) => (v.candidates[0].networkCostOut = word("1"))],
    [
      "unknown response",
      (v) => ((v as unknown as { $unknown: unknown[] }).$unknown = [{}]),
    ],
    [
      "unknown nested",
      (v) =>
        ((program(v) as unknown as { $unknown: unknown[] }).$unknown = [{}]),
    ],
  ];
  for (const [name, mutate] of cases) {
    const value = response();
    mutate(value);
    expect(() => validateAtomicPlanQuote(value, request), name).toThrow();
  }
});

test("Atomic quote preserves false completion and canonical candidate order", () => {
  const value = response();
  value.searchComplete = false;
  expect(validateAtomicPlanQuote(value, request)).toBe(value);

  const later = response().candidates[0];
  const laterResponse = create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32),
    candidates: [later],
    searchComplete: true,
  });
  pool(laterResponse, 0).feePips = 499;
  later.candidateId = hexToBytes(atomicCandidateId(later));
  value.candidates.push(later);
  expect(() => validateAtomicPlanQuote(value, request)).toThrow(
    "canonical order",
  );

  const empty = create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32).fill(1),
    searchComplete: false,
  });
  expect(validateAtomicPlanQuote(empty, request)).toBe(empty);
});

test("Atomic quote rendering names identity, every hop, block, outputs and limits", () => {
  const value = response();
  value.searchComplete = false;
  const tokens = [
    create(TokenSchema, {
      address: fixture.tokenIn,
      symbol: "IN",
      decimals: 0,
    }),
    create(TokenSchema, {
      address: fixture.intermediateToken,
      symbol: "MID",
      decimals: 0,
    }),
    create(TokenSchema, {
      address: fixture.tokenOut,
      symbol: "OUT",
      decimals: 0,
    }),
  ];
  const text = formatAtomicPlanQuote(
    value,
    { key: "base", chainId: fixture.chainId, tokens },
    tokens[0],
    tokens[2],
    37n,
  );
  for (const expected of [
    fixture.candidateId,
    fixture.quoteBlockHash,
    "Quote block: 123",
    "Hop 1:",
    "output 19 MID",
    "Hop 2:",
    "output 41 OUT",
    "Aggregate/final output: 41 OUT",
    "Search complete: false",
    "not a best or net-output recommendation",
  ])
    expect(text).toContain(expected);
});
