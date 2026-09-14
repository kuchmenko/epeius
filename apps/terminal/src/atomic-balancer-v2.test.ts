import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { encodeAbiParameters, hexToBytes, keccak256, stringToHex } from "viem";
import {
  BalancerPoolSchema,
  BranchQuoteSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanCandidateSchema,
  PlanProgramSchema,
  PoolOperationSchema,
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
  "contracts/fixtures/atomic-v1-balancer.json",
).json();
const vault = fixture.vault;
const poolId = fixture.poolId;
const tokenIn = fixture.tokenIn;
const tokenOut = fixture.tokenOut;
const executor = fixture.executor;
const signer = fixture.signer;
const runtimeCodeHash = fixture.runtimeCodeHash;
const blockHash = fixture.quoteBlockHash;
const word = (value: bigint) =>
  hexToBytes(`0x${value.toString(16).padStart(64, "0")}`);
const domain = (value: string) => keccak256(stringToHex(value));

function candidate() {
  const program = create(PlanProgramSchema, {
    formatVersion: 1,
    chainId: word(8453n),
    tokenIn: hexToBytes(tokenIn),
    tokenOut: hexToBytes(tokenOut),
    amountIn: word(1_234_567n),
    branches: [
      create(PlanBranchSchema, {
        amountIn: word(1_234_567n),
        operations: [
          create(PoolOperationSchema, {
            tokenIn: hexToBytes(tokenIn),
            tokenOut: hexToBytes(tokenOut),
            pool: {
              case: "balancerV2",
              value: create(BalancerPoolSchema, {
                vault: hexToBytes(vault),
                poolId: hexToBytes(poolId),
              }),
            },
          }),
        ],
      }),
    ],
  });
  const value = create(PlanCandidateSchema, {
    program,
    quoteBlock: create(PinnedBlockSchema, {
      number: word(19_876_543n),
      hash: hexToBytes(blockHash),
    }),
    branchQuotes: [
      create(BranchQuoteSchema, {
        operationOutputs: [word(1_111_111n)],
      }),
    ],
  });
  value.candidateId = hexToBytes(atomicCandidateId(value));
  return value;
}

test("Balancer Atomic kind 4 matches the independent Cast fixture", () => {
  const value = candidate();
  expect(atomicCandidateId(value)).toBe(fixture.candidateId);
  const provider = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint8" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [domain("Epeius.AtomicProvider.v1"), 4, vault, poolId],
    ),
  );
  expect(provider).toBe(fixture.providerHashes[0]);
  expect(
    keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint8" },
          { type: "address" },
          { type: "address" },
          { type: "bytes32" },
        ],
        [domain("Epeius.AtomicOperation.v1"), 4, tokenIn, tokenOut, provider],
      ),
    ),
  ).toBe(fixture.operationHashes[0]);

  const program = value.program;
  if (!program) throw new Error("missing program");
  const branchHashes = atomicV1AcceptedBranchHashes(program, [1_000_000n]);
  const planId = atomicV1PlanId({
    chainId: 8453n,
    executor,
    runtimeCodeHash,
    signer,
    recipient: signer,
    tokenIn,
    tokenOut,
    amountIn: 1_234_567n,
    minimum: 1_000_000n,
    quoteBlockNumber: 19_876_543n,
    quoteBlockHash: blockHash,
    expiresAt: 2_000_000_000n,
    deadline: 2_000_000_100n,
    branchHashes,
  });
  expect(planId).toBe(fixture.planId);
  const plan = {
    tokenIn,
    tokenOut,
    amountIn: 1_234_567n,
    minAmountOut: 1_000_000n,
    deadline: 2_000_000_100n,
    branches: [
      {
        amountIn: 1_234_567n,
        minAmountOut: 1_000_000n,
        operations: [{ kind: 4, tokenOut, fee: 0, tickSpacing: 0, poolId }],
      },
    ],
  } as const;
  const data = atomicV1ExecutorCalldata(plan);
  expect(
    atomicV1ExecutorPlanHash({
      chainId: 8453n,
      executor,
      sender: signer,
      plan,
    }),
  ).toBe(fixture.executorPlanHash);
  expect(keccak256(data)).toBe(fixture.executorCalldataHash);
  expect(
    atomicV1TransactionFingerprint({
      planId,
      chainId: 8453n,
      from: signer,
      to: executor,
      value: 0n,
      data,
      gasLimit: 1_000_000n,
    }),
  ).toBe(fixture.transactionFingerprint);
});

test("Balancer Atomic acceptance requires exact local full pool ID", () => {
  const value = candidate();
  const identity = {
    address: executor,
    runtimeCodeHash,
    balancerVault: vault,
    balancerPools: [poolId],
  };
  expect(
    acceptAtomicCandidate(value, signer, identity, 50, 1_999_999_800n)
      .finalOutput,
  ).toBe(1_111_111n);
  const changed = { ...identity, balancerPools: [`${poolId.slice(0, -1)}8`] };
  expect(() => acceptAtomicCandidate(value, signer, changed, 50)).toThrow(
    "local deployment",
  );
  const operation = value.program?.branches[0]?.operations[0];
  if (operation?.pool.case !== "balancerV2")
    throw new Error("missing Balancer operation");
  operation.pool.value.poolId = operation.pool.value.poolId?.slice(0, 20);
  expect(() => atomicCandidateId(value)).toThrow("wrong width");
});
