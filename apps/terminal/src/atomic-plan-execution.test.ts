import { expect, test } from "bun:test";
import {
  clone,
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import {
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hexToBytes,
  keccak256,
  padHex,
  toHex,
  zeroHash,
} from "viem";
import {
  BranchQuoteSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanCandidateSchema,
  PlanPreparationStatus,
  PlanProgramSchema,
  PlanTransactionSchema,
  PoolOperationSchema,
  PreparePlanResponseSchema,
  SimulationEvidenceSchema,
  SimulationStatus,
  SlipstreamPoolSchema,
  UnsignedPreparationSchema,
  V3PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import {
  acceptAtomicCandidate,
  assertAtomicPlanRecheck,
  validateAtomicPlanPreparation,
} from "./atomic-plan-execution";
import {
  type AtomicExecutorPlan,
  atomicV1AcceptedBranchHashes,
  atomicV1ExecutorCalldata,
  atomicV1ExecutorPlanHash,
  atomicV1PlanId,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";

const fixture = await Bun.file(
  "contracts/fixtures/atomic-v1-candidate.json",
).json();
const pancakeFixture = await Bun.file(
  "contracts/fixtures/atomic-v1-pancake.json",
).json();
const slipstreamFixture = await Bun.file(
  "contracts/fixtures/atomic-v1-slipstream.json",
).json();
const word = (value: string | bigint | number) =>
  hexToBytes(padHex(toHex(BigInt(value)), { size: 32 }));
const address = (value: string) => hexToBytes(value as Hex);
const signer = "0x0000000000000000000000000000000000000055";
const executor = {
  address: "0x0000000000000000000000000000000000000044",
  runtimeCodeHash:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  maxBranches: 4,
  maxOperationsPerBranch: 12,
  maxTotalOperations: 12,
  factory: fixture.factory,
  router: fixture.router,
  pancakeFactory: "0x0000000000000000000000000000000000000066",
  pancakeRouter: "0x0000000000000000000000000000000000000077",
  slipstreamFactory: "0x00000000000000000000000000000000000000aa",
  slipstreamRouter: "0x00000000000000000000000000000000000000bb",
} as const;

function candidate(kind: 1 | 2 | 3 = 1) {
  const tokens = [fixture.tokenIn, fixture.intermediateToken, fixture.tokenOut];
  return create(PlanCandidateSchema, {
    candidateId: hexToBytes(fixture.candidateId),
    program: create(PlanProgramSchema, {
      formatVersion: 1,
      chainId: word(fixture.chainId),
      tokenIn: address(fixture.tokenIn),
      tokenOut: address(fixture.tokenOut),
      amountIn: word(fixture.amountIn),
      branches: [
        create(PlanBranchSchema, {
          amountIn: word(fixture.amountIn),
          operations: fixture.fees.map((fee: number, index: number) =>
            create(PoolOperationSchema, {
              tokenIn: address(tokens[index]),
              tokenOut: address(tokens[index + 1]),
              pool:
                kind === 1
                  ? {
                      case: "uniswapV3" as const,
                      value: create(V3PoolSchema, {
                        factory: address(fixture.factory),
                        router: address(fixture.router),
                        pool: address(fixture.pools[index]),
                        feePips: fee,
                      }),
                    }
                  : kind === 2
                    ? {
                        case: "pancakeV3" as const,
                        value: create(V3PoolSchema, {
                          factory: address(executor.pancakeFactory),
                          router: address(executor.pancakeRouter),
                          pool: address(fixture.pools[index]),
                          feePips: fee,
                        }),
                      }
                    : {
                        case: "slipstreamInitial" as const,
                        value: create(SlipstreamPoolSchema, {
                          factory: address(executor.slipstreamFactory),
                          router: address(executor.slipstreamRouter),
                          pool: address(fixture.pools[index]),
                          tickSpacing: fee,
                        }),
                      },
            }),
          ),
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
}

function ready(kind: 1 | 2 | 3 = 1) {
  const accepted = acceptAtomicCandidate(
    candidate(kind),
    signer,
    executor,
    50,
    1_999_999_800n,
  );
  const program = accepted.terms.program;
  if (!program) throw new Error("test program missing");
  const plan: AtomicExecutorPlan = {
    tokenIn: fixture.tokenIn,
    tokenOut: fixture.tokenOut,
    amountIn: BigInt(fixture.amountIn),
    minAmountOut: accepted.minimum,
    deadline: accepted.deadline,
    branches: [
      {
        amountIn: BigInt(fixture.amountIn),
        minAmountOut: accepted.minimum,
        operations: program.branches[0].operations.map((operation) => {
          if (operation.pool.case === "slipstreamInitial")
            return {
              kind,
              tokenOut:
                `0x${Buffer.from(operation.tokenOut ?? []).toString("hex")}` as Hex,
              fee: 0,
              tickSpacing: operation.pool.value.tickSpacing ?? 0,
              poolId: zeroHash,
            };
          if (
            operation.pool.case !== "uniswapV3" &&
            operation.pool.case !== "pancakeV3"
          )
            throw new Error("test operation missing");
          return {
            kind,
            tokenOut:
              `0x${Buffer.from(operation.tokenOut ?? []).toString("hex")}` as Hex,
            fee: operation.pool.value.feePips ?? 0,
            tickSpacing: 0,
            poolId: zeroHash,
          };
        }),
      },
    ],
  };
  const data = atomicV1ExecutorCalldata(plan);
  const planHash = atomicV1ExecutorPlanHash({
    chainId: BigInt(fixture.chainId),
    executor: executor.address,
    sender: signer,
    plan,
  });
  const fingerprint = atomicV1TransactionFingerprint({
    planId: accepted.planId,
    chainId: BigInt(fixture.chainId),
    from: signer,
    to: executor.address,
    value: 0n,
    data,
    gasLimit: 1_000_000n,
  });
  const transaction = create(PlanTransactionSchema, {
    chainId: word(fixture.chainId),
    from: address(signer),
    to: address(executor.address),
    data: hexToBytes(data),
    value: word(0),
    gasLimit: word(1_000_000),
  });
  const preparationId = new Uint8Array(32).fill(0xbb);
  const preparation = create(UnsignedPreparationSchema, {
    preparationId,
    planId: hexToBytes(accepted.planId),
    terms: accepted.terms,
    transaction,
  });
  const response = create(PreparePlanResponseSchema, {
    status: PlanPreparationStatus.READY,
    preparation,
    simulation: create(SimulationEvidenceSchema, {
      planId: hexToBytes(accepted.planId),
      preparationId,
      transactionFingerprint: hexToBytes(fingerprint),
      block: create(PinnedBlockSchema, {
        number: word(124),
        hash: new Uint8Array(32).fill(0xcc),
      }),
      status: SimulationStatus.PASSED,
      branchResults: [
        create(BranchQuoteSchema, {
          // Deliberately differ from candidate outputs 19 and 41.
          operationOutputs: [word(23), word(43)],
        }),
      ],
      observedAtUnix: word(1_999_999_801),
    }),
  });
  return { accepted, response, planHash, fingerprint };
}

test("Atomic plan preparation validates calldata and measured evidence independently", () => {
  const value = ready();
  const checked = validateAtomicPlanPreparation(
    value.response,
    value.accepted,
    executor,
  );
  expect(checked.kind).toBe("swap");
  if (checked.kind !== "swap") return;
  expect(checked.executorPlanHash).toBe(value.planHash);
  expect(checked.transactionFingerprint).toBe(value.fingerprint);
  expect(checked.outputs).toEqual([23n, 43n]);
});

test("Pancake Atomic plan keeps kind 2 through accepted identity, calldata, and receipt", () => {
  const value = ready(2);
  const checked = validateAtomicPlanPreparation(
    value.response,
    value.accepted,
    executor,
  );
  expect(checked.kind).toBe("swap");
  if (checked.kind !== "swap") throw new Error("swap missing");
  expect(checked.receipt.atomicPlan?.branches[0].operations).toEqual([
    expect.objectContaining({ kind: 2 }),
    expect.objectContaining({ kind: 2 }),
  ]);
  expect(checked.executorPlanHash).toBe(value.planHash);
});

test("Slipstream Atomic plan keeps kind 3 through accepted identity, calldata, and receipt", () => {
  const value = ready(3);
  const checked = validateAtomicPlanPreparation(
    value.response,
    value.accepted,
    executor,
  );
  expect(checked.kind).toBe("swap");
  if (checked.kind !== "swap") throw new Error("swap missing");
  expect(checked.receipt.atomicPlan?.branches[0].operations).toEqual([
    expect.objectContaining({ kind: 3 }),
    expect.objectContaining({ kind: 3 }),
  ]);
  expect(checked.executorPlanHash).toBe(value.planHash);
});

test("Pancake plan, calldata, and fingerprint match independent Cast vectors", () => {
  const tokens = [
    pancakeFixture.tokenIn,
    pancakeFixture.intermediateToken,
    pancakeFixture.tokenOut,
  ];
  const program = create(PlanProgramSchema, {
    formatVersion: 1,
    chainId: word(pancakeFixture.chainId),
    tokenIn: address(pancakeFixture.tokenIn),
    tokenOut: address(pancakeFixture.tokenOut),
    amountIn: word(pancakeFixture.amountIn),
    branches: [
      create(PlanBranchSchema, {
        amountIn: word(pancakeFixture.amountIn),
        operations: pancakeFixture.fees.map((fee: number, index: number) =>
          create(PoolOperationSchema, {
            tokenIn: address(tokens[index]),
            tokenOut: address(tokens[index + 1]),
            pool: {
              case: "pancakeV3",
              value: create(V3PoolSchema, {
                factory: address(pancakeFixture.factory),
                router: address(pancakeFixture.router),
                pool: address(pancakeFixture.pools[index]),
                feePips: fee,
              }),
            },
          }),
        ),
      }),
    ],
  });
  const minimum = BigInt(pancakeFixture.minimum);
  const planId = atomicV1PlanId({
    chainId: BigInt(pancakeFixture.chainId),
    executor: pancakeFixture.executor,
    runtimeCodeHash: pancakeFixture.runtimeCodeHash,
    signer: pancakeFixture.signer,
    recipient: pancakeFixture.signer,
    tokenIn: pancakeFixture.tokenIn,
    tokenOut: pancakeFixture.tokenOut,
    amountIn: BigInt(pancakeFixture.amountIn),
    minimum,
    quoteBlockNumber: BigInt(pancakeFixture.quoteBlockNumber),
    quoteBlockHash: pancakeFixture.quoteBlockHash,
    expiresAt: BigInt(pancakeFixture.expiresAtUnix),
    deadline: BigInt(pancakeFixture.deadlineUnix),
    branchHashes: atomicV1AcceptedBranchHashes(program, [minimum]),
  });
  const plan: AtomicExecutorPlan = {
    tokenIn: pancakeFixture.tokenIn,
    tokenOut: pancakeFixture.tokenOut,
    amountIn: BigInt(pancakeFixture.amountIn),
    minAmountOut: minimum,
    deadline: BigInt(pancakeFixture.deadlineUnix),
    branches: [
      {
        amountIn: BigInt(pancakeFixture.amountIn),
        minAmountOut: minimum,
        operations: pancakeFixture.fees.map((fee: number, index: number) => ({
          kind: 2,
          tokenOut: tokens[index + 1],
          fee,
          tickSpacing: 0,
          poolId: zeroHash,
        })),
      },
    ],
  };
  const data = atomicV1ExecutorCalldata(plan);
  const executorHash = atomicV1ExecutorPlanHash({
    chainId: BigInt(pancakeFixture.chainId),
    executor: pancakeFixture.executor,
    sender: pancakeFixture.signer,
    plan,
  });
  expect(planId).toBe(pancakeFixture.planId);
  expect(executorHash).toBe(pancakeFixture.executorPlanHash);
  expect(keccak256(data)).toBe(pancakeFixture.executorCalldataHash);
  expect(
    atomicV1TransactionFingerprint({
      planId,
      chainId: BigInt(pancakeFixture.chainId),
      from: pancakeFixture.signer,
      to: pancakeFixture.executor,
      value: 0n,
      data,
      gasLimit: BigInt(pancakeFixture.gasLimit),
    }),
  ).toBe(pancakeFixture.transactionFingerprint);
});

test("Slipstream plan, calldata, and fingerprint match independent Cast int24 vectors", () => {
  const tokens = [
    slipstreamFixture.tokenIn,
    slipstreamFixture.intermediateToken,
    slipstreamFixture.tokenOut,
  ];
  const program = create(PlanProgramSchema, {
    formatVersion: 1,
    chainId: word(slipstreamFixture.chainId),
    tokenIn: address(slipstreamFixture.tokenIn),
    tokenOut: address(slipstreamFixture.tokenOut),
    amountIn: word(slipstreamFixture.amountIn),
    branches: [
      create(PlanBranchSchema, {
        amountIn: word(slipstreamFixture.amountIn),
        operations: slipstreamFixture.tickSpacings.map(
          (tickSpacing: number, index: number) =>
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
  });
  const minimum = BigInt(slipstreamFixture.minimum);
  const planId = atomicV1PlanId({
    chainId: BigInt(slipstreamFixture.chainId),
    executor: slipstreamFixture.executor,
    runtimeCodeHash: slipstreamFixture.runtimeCodeHash,
    signer: slipstreamFixture.signer,
    recipient: slipstreamFixture.signer,
    tokenIn: slipstreamFixture.tokenIn,
    tokenOut: slipstreamFixture.tokenOut,
    amountIn: BigInt(slipstreamFixture.amountIn),
    minimum,
    quoteBlockNumber: BigInt(slipstreamFixture.quoteBlockNumber),
    quoteBlockHash: slipstreamFixture.quoteBlockHash,
    expiresAt: BigInt(slipstreamFixture.expiresAtUnix),
    deadline: BigInt(slipstreamFixture.deadlineUnix),
    branchHashes: atomicV1AcceptedBranchHashes(program, [minimum]),
  });
  const plan: AtomicExecutorPlan = {
    tokenIn: slipstreamFixture.tokenIn,
    tokenOut: slipstreamFixture.tokenOut,
    amountIn: BigInt(slipstreamFixture.amountIn),
    minAmountOut: minimum,
    deadline: BigInt(slipstreamFixture.deadlineUnix),
    branches: [
      {
        amountIn: BigInt(slipstreamFixture.amountIn),
        minAmountOut: minimum,
        operations: slipstreamFixture.tickSpacings.map(
          (tickSpacing: number, index: number) => ({
            kind: 3,
            tokenOut: tokens[index + 1],
            fee: 0,
            tickSpacing,
            poolId: zeroHash,
          }),
        ),
      },
    ],
  };
  const data = atomicV1ExecutorCalldata(plan);
  const executorHash = atomicV1ExecutorPlanHash({
    chainId: BigInt(slipstreamFixture.chainId),
    executor: slipstreamFixture.executor,
    sender: slipstreamFixture.signer,
    plan,
  });
  expect(planId).toBe(slipstreamFixture.planId);
  expect(executorHash).toBe(slipstreamFixture.executorPlanHash);
  expect(keccak256(data)).toBe(slipstreamFixture.executorCalldataHash);
  expect(
    atomicV1TransactionFingerprint({
      planId,
      chainId: BigInt(slipstreamFixture.chainId),
      from: slipstreamFixture.signer,
      to: slipstreamFixture.executor,
      value: 0n,
      data,
      gasLimit: BigInt(slipstreamFixture.gasLimit),
    }),
  ).toBe(slipstreamFixture.transactionFingerprint);
});

test("Atomic plan preparation rejects identity, transaction, and evidence mutations", () => {
  const mutations: Array<
    [string, (value: ReturnType<typeof ready>["response"]) => void]
  > = [
    ["plan ID", (value) => value.preparation?.planId?.fill(1)],
    ["terms", (value) => value.preparation?.terms?.amountOutMinimum?.fill(1)],
    ["target", (value) => value.preparation?.transaction?.to?.fill(1)],
    ["value", (value) => value.preparation?.transaction?.value?.fill(1)],
    ["gas", (value) => value.preparation?.transaction?.gasLimit?.fill(1)],
    ["calldata", (value) => value.preparation?.transaction?.data?.fill(1)],
    [
      "fingerprint",
      (value) => value.simulation?.transactionFingerprint?.fill(1),
    ],
    [
      "status",
      (value) => {
        if (value.simulation) value.simulation.status = 99 as SimulationStatus;
      },
    ],
    [
      "cardinality",
      (value) => value.simulation?.branchResults[0].operationOutputs.pop(),
    ],
    [
      "zero intermediate",
      (value) => value.simulation?.branchResults[0].operationOutputs[0].fill(0),
    ],
    [
      "minimum",
      (value) => value.simulation?.branchResults[0].operationOutputs[1].fill(0),
    ],
    [
      "unknown",
      (value) => {
        if (value.simulation)
          value.simulation.$unknown = [
            { no: 99, wireType: 0, data: new Uint8Array([1]) },
          ];
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const value = ready();
    mutate(value.response);
    try {
      validateAtomicPlanPreparation(value.response, value.accepted, executor);
      throw new Error(`${name} mutation was accepted`);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if ((error as Error).message === `${name} mutation was accepted`)
        throw error;
    }
  }
});

test("Atomic plan recheck permits new evidence only and freezes unsigned preparation", () => {
  const value = ready();
  const initial = validateAtomicPlanPreparation(
    value.response,
    value.accepted,
    executor,
  );
  if (initial.kind !== "swap") throw new Error("test preparation missing");
  const refreshed = clone(PreparePlanResponseSchema, value.response);
  refreshed.simulation?.block?.number?.fill(2);
  refreshed.simulation?.branchResults[0].operationOutputs[0].fill(3);
  expect(
    assertAtomicPlanRecheck(refreshed, initial, value.accepted, executor).kind,
  ).toBe("swap");
  const changed = clone(PreparePlanResponseSchema, refreshed);
  changed.preparation?.transaction?.gasLimit?.fill(1);
  expect(() =>
    assertAtomicPlanRecheck(changed, initial, value.accepted, executor),
  ).toThrow();
});

test("Atomic plan approval is exact and contains no swap preparation", () => {
  const value = ready();
  const amount = BigInt(fixture.amountIn);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [executor.address, amount],
  });
  const response = create(PreparePlanResponseSchema, {
    status: PlanPreparationStatus.APPROVAL_REQUIRED,
    approval: {
      token: address(fixture.tokenIn),
      spender: address(executor.address),
      amount: word(amount),
      transaction: {
        chainId: word(fixture.chainId),
        from: address(signer),
        to: address(fixture.tokenIn),
        data: hexToBytes(data),
        value: word(0),
        gasLimit: word(100_000),
      },
    },
  });
  expect(
    validateAtomicPlanPreparation(response, value.accepted, executor).kind,
  ).toBe("approval");
  response.preparation = value.response.preparation;
  expect(() =>
    validateAtomicPlanPreparation(response, value.accepted, executor),
  ).toThrow();
});

test("Atomic preparation binary and JSON preserve optional status presence", () => {
  const value = ready();
  const binary = toBinary(PreparePlanResponseSchema, value.response);
  const binaryRoundTrip = fromBinary(PreparePlanResponseSchema, binary);
  expect(
    validateAtomicPlanPreparation(binaryRoundTrip, value.accepted, executor)
      .kind,
  ).toBe("swap");

  const json = toJson(PreparePlanResponseSchema, value.response);
  expect(json).toHaveProperty("status", "PLAN_PREPARATION_STATUS_READY");
  expect(json).toHaveProperty("preparation");
  expect(json).toHaveProperty("simulation");
  expect(json).not.toHaveProperty("approval");
  expect(
    validateAtomicPlanPreparation(
      fromJson(PreparePlanResponseSchema, json),
      value.accepted,
      executor,
    ).kind,
  ).toBe("swap");

  const absent = create(PreparePlanResponseSchema);
  expect(toJson(PreparePlanResponseSchema, absent)).not.toHaveProperty(
    "status",
  );
  absent.status = PlanPreparationStatus.UNSPECIFIED;
  expect(toJson(PreparePlanResponseSchema, absent)).toHaveProperty(
    "status",
    "PLAN_PREPARATION_STATUS_UNSPECIFIED",
  );
});
