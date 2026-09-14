import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { hexToBytes, keccak256 } from "viem";
import {
  BranchQuoteSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanCandidateSchema,
  PlanProgramSchema,
  PoolOperationSchema,
  V4PoolKeySchema,
  V4PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import { acceptAtomicCandidate } from "./atomic-plan-execution";
import { atomicCandidateId } from "./atomic-plan-quote";
import {
  atomicV1AcceptedBranchHashes,
  atomicV1ExecutorCalldata,
  atomicV1ExecutorPlanHash,
  atomicV1PlanId,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";

const fixture = await Bun.file(
  "contracts/fixtures/atomic-v1-uniswap-v4.json",
).json();
const word = (value: bigint) =>
  hexToBytes(`0x${value.toString(16).padStart(64, "0")}`);

function candidate() {
  const operation = create(PoolOperationSchema, {
    tokenIn: hexToBytes(fixture.tokenIn),
    tokenOut: hexToBytes(fixture.tokenOut),
    pool: {
      case: "uniswapV4",
      value: create(V4PoolSchema, {
        poolManager: hexToBytes(fixture.poolManager),
        key: create(V4PoolKeySchema, {
          currency0: hexToBytes(fixture.currency0),
          currency1: hexToBytes(fixture.currency1),
          feePips: fixture.feePips,
          tickSpacing: fixture.tickSpacing,
          hooks: hexToBytes(fixture.hooks),
        }),
      }),
    },
  });
  const program = create(PlanProgramSchema, {
    formatVersion: 1,
    chainId: word(BigInt(fixture.chainId)),
    tokenIn: hexToBytes(fixture.tokenIn),
    tokenOut: hexToBytes(fixture.tokenOut),
    amountIn: word(BigInt(fixture.amountIn)),
    branches: [
      create(PlanBranchSchema, {
        amountIn: word(BigInt(fixture.amountIn)),
        operations: [operation],
      }),
    ],
  });
  const value = create(PlanCandidateSchema, {
    program,
    quoteBlock: create(PinnedBlockSchema, {
      number: word(BigInt(fixture.quoteBlockNumber)),
      hash: hexToBytes(fixture.quoteBlockHash),
    }),
    branchQuotes: [
      create(BranchQuoteSchema, {
        operationOutputs: [word(BigInt(fixture.operationOutputs[0]))],
      }),
    ],
  });
  value.candidateId = hexToBytes(atomicCandidateId(value));
  return value;
}

test("Uniswap V4 Atomic identities match the independent Cast vector", () => {
  const value = candidate();
  expect(atomicCandidateId(value)).toBe(fixture.candidateId);
  const program = value.program;
  if (!program) throw new Error("missing program");
  const branchHashes = atomicV1AcceptedBranchHashes(program, [
    BigInt(fixture.minimum),
  ]);
  expect(branchHashes[0]).toBe(fixture.acceptedBranchHash);
  const planId = atomicV1PlanId({
    chainId: BigInt(fixture.chainId),
    executor: fixture.executor,
    runtimeCodeHash: fixture.runtimeCodeHash,
    signer: fixture.signer,
    recipient: fixture.signer,
    tokenIn: fixture.tokenIn,
    tokenOut: fixture.tokenOut,
    amountIn: BigInt(fixture.amountIn),
    minimum: BigInt(fixture.minimum),
    quoteBlockNumber: BigInt(fixture.quoteBlockNumber),
    quoteBlockHash: fixture.quoteBlockHash,
    expiresAt: BigInt(fixture.expiresAtUnix),
    deadline: BigInt(fixture.deadlineUnix),
    branchHashes,
  });
  expect(planId).toBe(fixture.planId);
  const plan = {
    tokenIn: fixture.tokenIn,
    tokenOut: fixture.tokenOut,
    amountIn: BigInt(fixture.amountIn),
    minAmountOut: BigInt(fixture.minimum),
    deadline: BigInt(fixture.deadlineUnix),
    branches: [
      {
        amountIn: BigInt(fixture.amountIn),
        minAmountOut: BigInt(fixture.minimum),
        operations: [
          {
            kind: 5,
            tokenOut: fixture.tokenOut,
            fee: fixture.feePips,
            tickSpacing: fixture.tickSpacing,
            poolId: `0x${"00".repeat(32)}`,
          },
        ],
      },
    ],
  } as const;
  const data = atomicV1ExecutorCalldata(plan);
  expect(keccak256(data)).toBe(fixture.executorCalldataHash);
  expect(
    atomicV1ExecutorPlanHash({
      chainId: BigInt(fixture.chainId),
      executor: fixture.executor,
      sender: fixture.signer,
      plan,
    }),
  ).toBe(fixture.executorPlanHash);
  expect(
    atomicV1TransactionFingerprint({
      planId,
      chainId: BigInt(fixture.chainId),
      from: fixture.signer,
      to: fixture.executor,
      value: 0n,
      data,
      gasLimit: BigInt(fixture.gasLimit),
    }),
  ).toBe(fixture.transactionFingerprint);
});

test("Uniswap V4 Atomic acceptance requires the full static zero-hook key", () => {
  const value = candidate();
  const identity = {
    address: fixture.executor,
    runtimeCodeHash: fixture.runtimeCodeHash,
    maxBranches: 4,
    maxOperationsPerBranch: 12,
    maxTotalOperations: 12,
    universalRouter: "0x7777777777777777777777777777777777777777",
    permit2: "0x8888888888888888888888888888888888888888",
    poolManager: fixture.poolManager,
    uniswapV4Pools: [
      {
        currency0: fixture.currency0,
        currency1: fixture.currency1,
        feePips: fixture.feePips,
        tickSpacing: fixture.tickSpacing,
        hooks: fixture.hooks,
      },
    ],
  };
  expect(
    acceptAtomicCandidate(value, fixture.signer, identity, 50, 1_999_999_800n)
      .finalOutput,
  ).toBe(1_111_111n);
  const operation = value.program?.branches[0].operations[0];
  if (operation?.pool.case !== "uniswapV4") throw new Error("missing V4");
  if (!operation.pool.value.key) throw new Error("missing V4 key");
  operation.pool.value.key.hooks = hexToBytes(
    "0x0000000000000000000000000000000000000001",
  );
  expect(() => atomicCandidateId(value)).not.toThrow();
  expect(() =>
    acceptAtomicCandidate(value, fixture.signer, identity, 50),
  ).toThrow("local deployment");
});
