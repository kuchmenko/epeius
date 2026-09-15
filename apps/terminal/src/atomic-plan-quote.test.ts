import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  keccak256,
  stringToHex,
} from "viem";
import {
  BalancerPoolSchema,
  BranchQuoteSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanCandidateSchema,
  PlanProgramSchema,
  PlanQuoteResponseSchema,
  PoolOperationSchema,
  SlipstreamPoolSchema,
  V3PoolSchema,
  V4PoolKeySchema,
  V4PoolSchema,
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
const pancakeFixture = await Bun.file(
  "contracts/fixtures/atomic-v1-pancake.json",
).json();
const slipstreamFixture = await Bun.file(
  "contracts/fixtures/atomic-v1-slipstream.json",
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

function response(
  source = fixture,
  provider: "uniswapV3" | "pancakeV3" = "uniswapV3",
) {
  const tokens = [source.tokenIn, source.intermediateToken, source.tokenOut];
  const operations = source.fees.map((fee: number, index: number) =>
    create(PoolOperationSchema, {
      tokenIn: address(tokens[index]),
      tokenOut: address(tokens[index + 1]),
      pool: {
        case: provider,
        value: create(V3PoolSchema, {
          factory: address(source.factory),
          router: address(source.router),
          pool: address(source.pools[index]),
          feePips: fee,
        }),
      },
    }),
  );
  const candidate = create(PlanCandidateSchema, {
    candidateId: hexToBytes(source.candidateId),
    program: create(PlanProgramSchema, {
      formatVersion: source.formatVersion,
      chainId: word(source.chainId),
      tokenIn: address(source.tokenIn),
      tokenOut: address(source.tokenOut),
      amountIn: word(source.amountIn),
      branches: [
        create(PlanBranchSchema, {
          amountIn: word(source.amountIn),
          operations,
        }),
      ],
    }),
    quoteBlock: create(PinnedBlockSchema, {
      number: word(source.quoteBlockNumber),
      hash: hexToBytes(source.quoteBlockHash),
    }),
    branchQuotes: [
      create(BranchQuoteSchema, {
        operationOutputs: source.operationOutputs.map(word),
      }),
    ],
  });
  return create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32).fill(0xbb),
    candidates: [candidate],
    searchComplete: true,
  });
}

function slipstreamResponse(spacings = slipstreamFixture.tickSpacings) {
  const tokens = [
    slipstreamFixture.tokenIn,
    slipstreamFixture.intermediateToken,
    slipstreamFixture.tokenOut,
  ];
  const candidate = create(PlanCandidateSchema, {
    candidateId: hexToBytes(slipstreamFixture.candidateId),
    program: create(PlanProgramSchema, {
      formatVersion: 1,
      chainId: word(slipstreamFixture.chainId),
      tokenIn: address(slipstreamFixture.tokenIn),
      tokenOut: address(slipstreamFixture.tokenOut),
      amountIn: word(slipstreamFixture.amountIn),
      branches: [
        create(PlanBranchSchema, {
          amountIn: word(slipstreamFixture.amountIn),
          operations: spacings.map((tickSpacing: number, index: number) =>
            create(PoolOperationSchema, {
              tokenIn: address(tokens[index]),
              tokenOut: address(tokens[index + 1]),
              pool: {
                case: "slipstreamInitial",
                value: create(SlipstreamPoolSchema, {
                  factory: address(slipstreamFixture.factory),
                  router: address(slipstreamFixture.router),
                  pool: address(slipstreamFixture.pools[index]),
                  tickSpacing,
                }),
              },
            }),
          ),
        }),
      ],
    }),
    quoteBlock: create(PinnedBlockSchema, {
      number: word(slipstreamFixture.quoteBlockNumber),
      hash: hexToBytes(slipstreamFixture.quoteBlockHash),
    }),
    branchQuotes: [
      create(BranchQuoteSchema, {
        operationOutputs: slipstreamFixture.operationOutputs.map(word),
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

function addUnknown(value: object) {
  (value as { $unknown?: unknown[] }).$unknown = [{}];
}

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`test ${name} missing`);
  return value;
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

test("Atomic Pancake candidate identity matches the independent Cast two-hop vector", () => {
  const value = response(pancakeFixture, "pancakeV3");
  expect(atomicCandidateId(value.candidates[0])).toBe(
    pancakeFixture.candidateId,
  );
  expect(
    validateAtomicPlanQuote(value, {
      chainId: BigInt(pancakeFixture.chainId),
      tokenIn: pancakeFixture.tokenIn,
      tokenOut: pancakeFixture.tokenOut,
      amountIn: BigInt(pancakeFixture.amountIn),
    }),
  ).toBe(value);
});

test("Atomic Slipstream candidate identity matches the independent Cast int24 vector", () => {
  const value = slipstreamResponse();
  expect(atomicCandidateId(value.candidates[0])).toBe(
    slipstreamFixture.candidateId,
  );
  expect(
    validateAtomicPlanQuote(value, {
      chainId: BigInt(slipstreamFixture.chainId),
      tokenIn: slipstreamFixture.tokenIn,
      tokenOut: slipstreamFixture.tokenOut,
      amountIn: BigInt(slipstreamFixture.amountIn),
    }),
  ).toBe(value);

  const negative = slipstreamResponse([-100, 200]);
  const negativeProviderHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint8" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "int24" },
      ],
      [
        keccak256(stringToHex("Epeius.AtomicProvider.v1")),
        3,
        slipstreamFixture.factory,
        slipstreamFixture.router,
        slipstreamFixture.pools[0],
        -100,
      ],
    ),
  );
  expect(negativeProviderHash).toBe(
    slipstreamFixture.negativeSpacingProviderHash,
  );
  expect(negativeProviderHash).not.toBe(slipstreamFixture.providerHashes[0]);
  expect(() =>
    validateAtomicPlanQuote(negative, {
      chainId: BigInt(slipstreamFixture.chainId),
      tokenIn: slipstreamFixture.tokenIn,
      tokenOut: slipstreamFixture.tokenOut,
      amountIn: BigInt(slipstreamFixture.amountIn),
    }),
  ).toThrow();
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
    ["unknown response", addUnknown],
    ["unknown candidate", (v) => addUnknown(v.candidates[0])],
    ["unknown program", (v) => addUnknown(program(v))],
    ["unknown branch", (v) => addUnknown(program(v).branches[0])],
    [
      "unknown operation",
      (v) => addUnknown(program(v).branches[0].operations[0]),
    ],
    ["unknown V3 pool", (v) => addUnknown(pool(v, 0))],
    ["unknown quote block", (v) => addUnknown(quoteBlock(v))],
    [
      "unknown branch quote",
      (v) => addUnknown(v.candidates[0].branchQuotes[0]),
    ],
  ];
  for (const [name, mutate] of cases) {
    const value = response();
    mutate(value);
    expect(() => validateAtomicPlanQuote(value, request), name).toThrow();
  }
});

test("Atomic quote rejects unknown fields in every typed pool case and V4 key", () => {
  const pancake = response(pancakeFixture, "pancakeV3");
  const pancakeOperation = program(pancake).branches[0].operations[0];
  if (pancakeOperation.pool.case !== "pancakeV3")
    throw new Error("missing Pancake pool");
  addUnknown(pancakeOperation.pool.value);

  const slipstream = slipstreamResponse();
  const slipstreamOperation = program(slipstream).branches[0].operations[0];
  if (slipstreamOperation.pool.case !== "slipstreamInitial")
    throw new Error("missing Slipstream pool");
  addUnknown(slipstreamOperation.pool.value);

  const balancer = response();
  program(balancer).branches[0].operations[0].pool = {
    case: "balancerV2",
    value: create(BalancerPoolSchema, {
      vault: address(fixture.router),
      poolId: word("1"),
    }),
  };
  addUnknown(
    required(
      program(balancer).branches[0].operations[0].pool.value,
      "Balancer pool",
    ),
  );

  const v4 = response();
  const key = create(V4PoolKeySchema, {
    currency0: address(fixture.tokenIn),
    currency1: address(fixture.intermediateToken),
    feePips: 500,
    tickSpacing: 10,
    hooks: new Uint8Array(20),
  });
  program(v4).branches[0].operations[0].pool = {
    case: "uniswapV4",
    value: create(V4PoolSchema, {
      poolManager: address(fixture.router),
      key,
    }),
  };
  addUnknown(
    required(program(v4).branches[0].operations[0].pool.value, "V4 pool"),
  );

  const v4Key = response();
  const unknownKey = create(V4PoolKeySchema, {
    currency0: address(fixture.tokenIn),
    currency1: address(fixture.intermediateToken),
    feePips: 500,
    tickSpacing: 10,
    hooks: new Uint8Array(20),
  });
  program(v4Key).branches[0].operations[0].pool = {
    case: "uniswapV4",
    value: create(V4PoolSchema, {
      poolManager: address(fixture.router),
      key: unknownKey,
    }),
  };
  addUnknown(unknownKey);

  for (const [name, value, expectedRequest] of [
    [
      "Pancake",
      pancake,
      {
        ...request,
        tokenIn: pancakeFixture.tokenIn,
        tokenOut: pancakeFixture.tokenOut,
        amountIn: BigInt(pancakeFixture.amountIn),
      },
    ],
    [
      "Slipstream",
      slipstream,
      {
        ...request,
        tokenIn: slipstreamFixture.tokenIn,
        tokenOut: slipstreamFixture.tokenOut,
        amountIn: BigInt(slipstreamFixture.amountIn),
      },
    ],
    ["Balancer", balancer, request],
    ["V4 pool", v4, request],
    ["V4 key", v4Key, request],
  ] as const)
    expect(() => validateAtomicPlanQuote(value, expectedRequest), name).toThrow(
      "unsupported fields",
    );
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
    "Hop 1 (Uniswap V3):",
    "output 19 MID",
    "Hop 2 (Uniswap V3):",
    "output 41 OUT",
    "Aggregate/final output: 41 OUT",
    "Search complete: false",
    "not a best or net-output recommendation",
  ])
    expect(text).toContain(expected);
});
