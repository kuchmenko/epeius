import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
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
  PlanQuoteResponseSchema,
  PlanTransactionSchema,
  PoolOperationSchema,
  PreparePlanResponseSchema,
  SimulationEvidenceSchema,
  SimulationStatus,
  UnsignedPreparationSchema,
  V3PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import { acceptAtomicCandidate } from "./atomic-plan-execution";
import { runAtomicPlanTrade } from "./atomic-plan-trade";
import { ExecutionOutcome } from "./execution";
import {
  atomicV1ExecutorCalldata,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";
import type { Receipt } from "./receipt";

const fixture = await Bun.file(
  "contracts/fixtures/atomic-v1-candidate.json",
).json();
const word = (value: string | bigint | number) =>
  hexToBytes(padHex(toHex(BigInt(value)), { size: 32 }));
const address = (value: string) => hexToBytes(value as `0x${string}`);
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
} as const;
const transactionHash = `0x${"d".repeat(64)}`;

function candidate() {
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

function quote(id: number) {
  return create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32).fill(id),
    candidates: [candidate()],
    searchComplete: true,
  });
}

function readyResponse(selected: ReturnType<typeof acceptAtomicCandidate>) {
  const program = selected.terms.program;
  if (!program) throw new Error("test program missing");
  const data = atomicV1ExecutorCalldata({
    tokenIn: fixture.tokenIn,
    tokenOut: fixture.tokenOut,
    amountIn: BigInt(fixture.amountIn),
    minAmountOut: selected.minimum,
    deadline: selected.deadline,
    branches: [
      {
        amountIn: BigInt(fixture.amountIn),
        minAmountOut: selected.minimum,
        operations: program.branches[0].operations.map((operation) => {
          if (operation.pool.case !== "uniswapV3")
            throw new Error("test operation missing");
          return {
            kind: 1,
            tokenOut:
              `0x${Buffer.from(operation.tokenOut ?? []).toString("hex")}` as const,
            fee: operation.pool.value.feePips ?? 0,
            tickSpacing: 0,
            poolId: zeroHash,
          };
        }),
      },
    ],
  });
  const transaction = create(PlanTransactionSchema, {
    chainId: word(fixture.chainId),
    from: address(signer),
    to: address(executor.address),
    data: hexToBytes(data),
    value: word(0),
    gasLimit: word(1_000_000),
  });
  const fingerprint = atomicV1TransactionFingerprint({
    planId: selected.planId,
    chainId: BigInt(fixture.chainId),
    from: signer,
    to: executor.address,
    value: 0n,
    data,
    gasLimit: 1_000_000n,
  });
  const preparationId = new Uint8Array(32).fill(0xbb);
  return create(PreparePlanResponseSchema, {
    status: PlanPreparationStatus.READY,
    preparation: create(UnsignedPreparationSchema, {
      preparationId,
      planId: hexToBytes(selected.planId),
      terms: selected.terms,
      transaction,
    }),
    simulation: create(SimulationEvidenceSchema, {
      planId: hexToBytes(selected.planId),
      preparationId,
      transactionFingerprint: hexToBytes(fingerprint),
      block: create(PinnedBlockSchema, {
        number: word(124),
        hash: new Uint8Array(32).fill(0xcc),
      }),
      status: SimulationStatus.PASSED,
      branchResults: [
        create(BranchQuoteSchema, {
          operationOutputs: [word(23), word(43)],
        }),
      ],
      observedAtUnix: word(1_999_999_801),
    }),
  });
}

function approvalResponse() {
  const amount = BigInt(fixture.amountIn);
  return create(PreparePlanResponseSchema, {
    status: PlanPreparationStatus.APPROVAL_REQUIRED,
    approval: {
      token: address(fixture.tokenIn),
      spender: address(executor.address),
      amount: word(amount),
      transaction: {
        chainId: word(fixture.chainId),
        from: address(signer),
        to: address(fixture.tokenIn),
        data: hexToBytes(
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [executor.address, amount],
          }),
        ),
        value: word(0),
        gasLimit: word(100_000),
      },
    },
  });
}

function harness(responses: Array<"approval" | "ready"> = ["ready"]) {
  const calls: string[] = [];
  const approvalFlow = responses[0] === "approval";
  let receipts = 0;
  let quotes = 0;
  let selected: ReturnType<typeof acceptAtomicCandidate>;
  return {
    calls,
    io: {
      request: {
        chainId: BigInt(fixture.chainId),
        tokenIn: fixture.tokenIn,
        tokenOut: fixture.tokenOut,
        amountIn: BigInt(fixture.amountIn),
      },
      candidateIndex: 0,
      signer,
      executor,
      slippageBps: 50,
      quote: async () => {
        calls.push("quote");
        const value = quote(++quotes);
        selected = acceptAtomicCandidate(
          value.candidates[0],
          signer,
          executor,
          50,
        );
        return value;
      },
      prepare: async () => {
        calls.push("prepare");
        const next = responses.shift();
        return next === "approval"
          ? approvalResponse()
          : readyResponse(selected);
      },
      recheck: async () => {
        calls.push("recheck");
        return readyResponse(selected);
      },
      chainId: async () => {
        calls.push("chainId");
        return toHex(BigInt(fixture.chainId));
      },
      confirm: async (kind: "approval" | "swap") => {
        calls.push(`confirm:${kind}`);
        return true;
      },
      send: async () => {
        calls.push("send");
        return transactionHash;
      },
      receipt: async () => {
        calls.push("receipt");
        receipts++;
        if (approvalFlow && receipts === 1)
          return {
            transactionHash,
            status: "0x1",
          } as unknown as Receipt;
        throw new Error("fixture receipt unavailable");
      },
      report: () => {},
    },
  };
}

test("Atomic plan trade selects explicitly and rechecks frozen bytes before send", async () => {
  const value = harness();
  const result = await runAtomicPlanTrade(value.io);
  expect(result).toEqual({
    kind: ExecutionOutcome.Unknown,
    transactionHash,
  });
  expect(value.calls).toEqual([
    "quote",
    "prepare",
    "confirm:swap",
    "recheck",
    "chainId",
    "send",
    "receipt",
  ]);
});

test("Atomic plan trade obtains a new quote after exact approval", async () => {
  const value = harness(["approval", "ready"]);
  await runAtomicPlanTrade(value.io);
  expect(value.calls).toEqual([
    "quote",
    "prepare",
    "confirm:approval",
    "send",
    "receipt",
    "quote",
    "prepare",
    "confirm:swap",
    "recheck",
    "chainId",
    "send",
    "receipt",
  ]);
});

test("Atomic plan trade never sends after cancellation or changed recheck", async () => {
  const canceled = harness();
  canceled.io.confirm = async () => false;
  expect(await runAtomicPlanTrade(canceled.io)).toEqual({
    kind: ExecutionOutcome.Canceled,
  });
  expect(canceled.calls).not.toContain("send");

  const changed = harness();
  changed.io.recheck = async () => {
    const response = readyResponse(
      acceptAtomicCandidate(candidate(), signer, executor, 50),
    );
    response.preparation?.transaction?.data?.fill(1);
    return response;
  };
  await expect(runAtomicPlanTrade(changed.io)).rejects.toThrow();
  expect(changed.calls).not.toContain("send");
});
