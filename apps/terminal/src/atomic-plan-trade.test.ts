import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  keccak256,
  padHex,
  toHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executorV2Abi } from "../../../generated/abi";
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
  type PreparePlanResponse,
  PreparePlanResponseSchema,
  SimulationEvidenceSchema,
  SimulationStatus,
  SlipstreamPoolSchema,
  UnsignedPreparationSchema,
  V3PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type {
  AtomicIntentAttempt,
  AtomicIntentJournalWriter,
  SignedAtomicIntentAttempt,
} from "./atomic-intent-journal";
import { AtomicIntentJournal } from "./atomic-intent-journal";
import {
  acceptAtomicCandidate,
  validateAtomicPlanPreparation,
} from "./atomic-plan-execution";
import {
  type AtomicPlanTradeIO,
  runAtomicPlanTrade,
} from "./atomic-plan-trade";
import { runAtomicRecovery } from "./atomic-recovery";
import {
  type AtomicEnvelope,
  admitSignedAtomicEnvelope,
  type SignedAtomicEnvelope,
} from "./atomic-signed-envelope";
import { ExecutionOutcome } from "./execution";
import { parseAtomicFinalityPolicy } from "./finality-policy";
import {
  atomicV1ExecutorCalldata,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";
import {
  type Receipt,
  type TransactionCallTrace,
  VerificationOutcome,
} from "./receipt";

type JournalTransition = AtomicIntentJournalWriter["transition"];

const fixture = await Bun.file(
  "contracts/fixtures/atomic-v1-candidate.json",
).json();
const slipstreamFixture = await Bun.file(
  "contracts/fixtures/atomic-v1-slipstream.json",
).json();
const word = (value: string | bigint | number) =>
  hexToBytes(padHex(toHex(BigInt(value)), { size: 32 }));
const address = (value: string) => hexToBytes(value as `0x${string}`);
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const signer = account.address;
const executor = {
  address: "0x0000000000000000000000000000000000000044",
  runtimeCodeHash:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  maxBranches: 4,
  maxOperationsPerBranch: 12,
  maxTotalOperations: 12,
  factory: fixture.factory,
  router: fixture.router,
  slipstreamFactory: slipstreamFixture.factory,
  slipstreamRouter: slipstreamFixture.router,
} as const;

const sign = (
  transaction: UnsignedTransaction,
  envelope: AtomicEnvelope,
): Promise<`0x${string}`> =>
  account.signTransaction({
    type: "eip1559",
    chainId: Number(transaction.chainId),
    nonce: Number(envelope.nonce),
    maxFeePerGas: BigInt(envelope.maxFeePerGasAtomic),
    maxPriorityFeePerGas: BigInt(envelope.maxPriorityFeePerGasAtomic),
    gas: BigInt(transaction.gasLimit),
    to: transaction.to as `0x${string}`,
    value: BigInt(transaction.valueAtomic),
    data: transaction.data as `0x${string}`,
    accessList: [],
  });

function candidate(kind: 1 | 3 = 1) {
  const source = kind === 3 ? slipstreamFixture : fixture;
  const tokens = [source.tokenIn, source.intermediateToken, source.tokenOut];
  const selectors = kind === 3 ? source.tickSpacings : source.fees;
  return create(PlanCandidateSchema, {
    candidateId: hexToBytes(source.candidateId),
    program: create(PlanProgramSchema, {
      formatVersion: 1,
      chainId: word(source.chainId),
      tokenIn: address(source.tokenIn),
      tokenOut: address(source.tokenOut),
      amountIn: word(source.amountIn),
      branches: [
        create(PlanBranchSchema, {
          amountIn: word(source.amountIn),
          operations: selectors.map((selector: number, index: number) =>
            create(PoolOperationSchema, {
              tokenIn: address(tokens[index]),
              tokenOut: address(tokens[index + 1]),
              pool:
                kind === 3
                  ? {
                      case: "slipstreamInitial" as const,
                      value: create(SlipstreamPoolSchema, {
                        factory: address(source.factory),
                        router: address(source.router),
                        pool: address(source.pools[index]),
                        tickSpacing: selector,
                      }),
                    }
                  : {
                      case: "uniswapV3" as const,
                      value: create(V3PoolSchema, {
                        factory: address(source.factory),
                        router: address(source.router),
                        pool: address(source.pools[index]),
                        feePips: selector,
                      }),
                    },
            }),
          ),
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
}

function quote(id: number, kind: 1 | 3 = 1) {
  return create(PlanQuoteResponseSchema, {
    quoteId: new Uint8Array(32).fill(id),
    candidates: [candidate(kind)],
    searchComplete: true,
  });
}

function readyResponse(
  selected: ReturnType<typeof acceptAtomicCandidate>,
  kind: 1 | 3 = 1,
) {
  const source = kind === 3 ? slipstreamFixture : fixture;
  const program = selected.terms.program;
  if (!program) throw new Error("test program missing");
  const data = atomicV1ExecutorCalldata({
    tokenIn: source.tokenIn,
    tokenOut: source.tokenOut,
    amountIn: BigInt(source.amountIn),
    minAmountOut: selected.minimum,
    deadline: selected.deadline,
    branches: [
      {
        amountIn: BigInt(source.amountIn),
        minAmountOut: selected.minimum,
        operations: program.branches[0].operations.map((operation) => {
          if (
            operation.pool.case !== "uniswapV3" &&
            operation.pool.case !== "slipstreamInitial"
          )
            throw new Error("test operation missing");
          return {
            kind,
            tokenOut:
              `0x${Buffer.from(operation.tokenOut ?? []).toString("hex")}` as const,
            fee:
              operation.pool.case === "uniswapV3"
                ? (operation.pool.value.feePips ?? 0)
                : 0,
            tickSpacing:
              operation.pool.case === "slipstreamInitial"
                ? (operation.pool.value.tickSpacing ?? 0)
                : 0,
            poolId: zeroHash,
          };
        }),
      },
    ],
  });
  const transaction = create(PlanTransactionSchema, {
    chainId: word(source.chainId),
    from: address(signer),
    to: address(executor.address),
    data: hexToBytes(data),
    value: word(0),
    gasLimit: word(1_000_000),
  });
  const fingerprint = atomicV1TransactionFingerprint({
    planId: selected.planId,
    chainId: BigInt(source.chainId),
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
          operationOutputs:
            kind === 3
              ? source.operationOutputs.map(word)
              : [word(23), word(43)],
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

function harness(
  responses: Array<"approval" | "ready"> = ["ready"],
  kind: 1 | 3 = 1,
) {
  const source = kind === 3 ? slipstreamFixture : fixture;
  const calls: string[] = [];
  const preparedResponses: PreparePlanResponse[] = [];
  const approvalFlow = responses[0] === "approval";
  let receipts = 0;
  let quotes = 0;
  let currentHash = "";
  let currentRaw = "";
  let currentSigned: SignedAtomicEnvelope | undefined;
  let selected: ReturnType<typeof acceptAtomicCandidate>;
  const finalityPolicy = parseAtomicFinalityPolicy(
    {
      policy_version: "epeius-finality-v1",
      finality_method: "op_l1_derivation",
      completion_tag: "finalized",
      parent_chain_id: 1,
      safe_signal: "op_derived_safe",
      network_anchor_number: 0,
      network_anchor_hash: `0x${"a".repeat(64)}`,
      rpc_source_id: "test",
      capability_record: "test",
      capability_valid_until: "2099-01-01T00:00:00Z",
      request_timeout_ms: 100,
      poll_interval_ms: 1,
      wait_timeout_ms: 2,
      stalled_after_ms: 1,
      max_response_age_ms: 100,
    },
    String(source.chainId),
    0,
  );
  const block = (tag: string) => ({
    number: tag === "0x0" ? "0x0" : "0xc8",
    hash:
      tag === "0x0" ? finalityPolicy.networkAnchorHash : `0x${"b".repeat(64)}`,
    parentHash: tag === "0x0" ? zeroHash : `0x${"9".repeat(64)}`,
    timestamp: "0x1",
    transactions: [] as string[],
  });
  const finalityChain: AtomicPlanTradeIO["finalityChain"] = {
    chainId: async () => toHex(BigInt(source.chainId)),
    blockByNumber: async (tag: string) => block(tag),
    blockByHash: async () => block("finalized"),
    receiptByHash: async () => {
      calls.push("receipt");
      throw new Error("fixture receipt unavailable");
    },
    transactionByHash: async () => null,
    traceCanonicalTransaction: async () => {
      throw new Error("fixture trace unavailable");
    },
  };
  return {
    calls,
    preparedResponses,
    selected: () => selected,
    hash: () => currentHash,
    signed: () => currentSigned,
    io: {
      request: {
        chainId: BigInt(source.chainId),
        tokenIn: source.tokenIn,
        tokenOut: source.tokenOut,
        amountIn: BigInt(source.amountIn),
      },
      candidateIndex: 0,
      signer,
      executor,
      slippageBps: 50,
      pendingNonce: 9n,
      maxFeePerGas: 30n,
      maxPriorityFeePerGas: 2n,
      finalityPolicy,
      signal: new AbortController().signal,
      finalityChain,
      quote: async () => {
        calls.push("quote");
        const value = quote(++quotes, kind);
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
        const response =
          next === "approval"
            ? approvalResponse()
            : readyResponse(selected, kind);
        preparedResponses.push(response);
        return response;
      },
      recheck: async () => {
        calls.push("recheck");
        return readyResponse(selected, kind);
      },
      chainId: async () => {
        calls.push("chainId");
        return toHex(BigInt(source.chainId));
      },
      confirm: async (kind: "approval" | "swap") => {
        calls.push(`confirm:${kind}`);
        return true;
      },
      journal: {
        prepare: async (
          input: Parameters<AtomicIntentJournalWriter["prepare"]>[0],
        ) => {
          calls.push(`journal:prepared:${input.action}`);
          return {
            attemptId: `00000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`,
            action: input.action,
            ...(input.planId ? { planId: input.planId } : {}),
            ...(input.executorPlanHash
              ? { executorPlanHash: input.executorPlanHash }
              : {}),
            ...(input.transactionFingerprint
              ? { transactionFingerprint: input.transactionFingerprint }
              : {}),
            transaction: structuredClone(input.transaction),
            envelope: structuredClone(input.envelope),
            finalityPolicy: structuredClone(input.finalityPolicy),
          };
        },
        sign: async (
          attempt: AtomicIntentAttempt,
          signedEnvelope: Parameters<AtomicIntentJournalWriter["sign"]>[1],
        ) => {
          calls.push("journal:signed");
          return {
            ...structuredClone(attempt),
            signedEnvelope: structuredClone(signedEnvelope),
          };
        },
        transition: async (
          _attempt: AtomicIntentAttempt | SignedAtomicIntentAttempt,
          state: Parameters<AtomicIntentJournalWriter["transition"]>[1],
          _details?: Parameters<AtomicIntentJournalWriter["transition"]>[2],
        ) => {
          calls.push(`journal:${state}`);
        },
      },
      sign: async (
        transaction: UnsignedTransaction,
        envelope: AtomicEnvelope,
      ) => {
        calls.push("sign");
        currentRaw = await sign(transaction, envelope);
        currentHash = keccak256(currentRaw as `0x${string}`);
        currentSigned = await admitSignedAtomicEnvelope(
          currentRaw,
          transaction,
          envelope,
        );
        return currentRaw;
      },
      submitRawTransaction: async (raw: string) => {
        calls.push("submitRawTransaction");
        expect(raw).toBe(currentRaw);
        return currentHash;
      },
      receipt: async () => {
        calls.push("receipt");
        receipts++;
        if (approvalFlow && receipts === 1)
          return {
            transactionHash: currentHash,
            status: "0x1",
          } as unknown as Receipt;
        throw new Error("fixture receipt unavailable");
      },
      traceCanonicalTransaction:
        undefined as AtomicPlanTradeIO["traceCanonicalTransaction"],
      report: (_event: unknown) => {},
    },
  };
}

function enableFinality(
  value: ReturnType<typeof harness>,
  source: Receipt | (() => Receipt),
  trace?: TransactionCallTrace,
) {
  const receiptBlockHash = `0x${"c".repeat(64)}`;
  const receiptBlockNumber = "0x7c";
  const receipt = () => {
    const sourceReceipt = typeof source === "function" ? source() : source;
    return {
      ...sourceReceipt,
      blockHash: receiptBlockHash,
      blockNumber: receiptBlockNumber,
      transactionIndex: "0x0",
      logs: sourceReceipt.logs.map((log, index) => ({
        ...log,
        blockHash: receiptBlockHash,
        blockNumber: receiptBlockNumber,
        transactionIndex: "0x0",
        logIndex: toHex(index),
        removed: false,
      })),
    };
  };
  const headHash = `0x${"b".repeat(64)}`;
  const block = (tag: string) =>
    tag === "0x0"
      ? {
          number: "0x0",
          hash: value.io.finalityPolicy.networkAnchorHash,
          parentHash: zeroHash,
          timestamp: "0x1",
          transactions: [],
        }
      : tag === receiptBlockNumber
        ? {
            number: receiptBlockNumber,
            hash: receiptBlockHash,
            parentHash: `0x${"9".repeat(64)}`,
            timestamp: "0x2",
            transactions: [value.hash()],
          }
        : {
            number: "0xc8",
            hash: headHash,
            parentHash: `0x${"9".repeat(64)}`,
            timestamp: "0x3",
            transactions: [],
          };
  value.io.finalityChain.receiptByHash = async () => receipt();
  value.io.finalityChain.blockByNumber = async (tag) => block(tag);
  value.io.finalityChain.blockByHash = async () => block("finalized");
  value.io.finalityChain.transactionByHash = async () => {
    const signed = value.signed();
    if (!signed) throw new Error("missing signed fixture");
    return {
      hash: signed.transactionHash,
      type: "0x2",
      chainId: toHex(BigInt(signed.chainId)),
      nonce: toHex(BigInt(signed.nonce)),
      from: signed.signer,
      to: signed.to,
      input: signed.data,
      value: toHex(BigInt(signed.valueAtomic)),
      gas: toHex(BigInt(signed.gasLimit)),
      maxFeePerGas: toHex(BigInt(signed.maxFeePerGasAtomic)),
      maxPriorityFeePerGas: toHex(BigInt(signed.maxPriorityFeePerGasAtomic)),
      accessList: [],
      yParity: toHex(signed.yParity),
      r: signed.r,
      s: signed.s,
    };
  };
  if (trace)
    value.io.finalityChain.traceCanonicalTransaction = async () => trace;
}

function slipstreamReceipt(
  selected: ReturnType<typeof acceptAtomicCandidate>,
  transactionHash: string,
): Receipt {
  const prepared = validateAtomicPlanPreparation(
    readyResponse(selected, 3),
    selected,
    executor,
  );
  if (prepared.kind !== "swap" || !prepared.receipt.atomicPlan)
    throw new Error("test Slipstream preparation missing");
  const plan = prepared.receipt.atomicPlan;
  const operationOutputs = [83n, 61n];
  const logs: Receipt["logs"] = [
    {
      address: slipstreamFixture.tokenIn,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: signer, to: slipstreamFixture.pools[0] },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "uint256" }],
        [BigInt(slipstreamFixture.amountIn)],
      ),
      transactionHash,
    },
    {
      address: slipstreamFixture.tokenOut,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: slipstreamFixture.pools[1], to: signer },
      }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [operationOutputs[1]]),
      transactionHash,
    },
  ];
  let previous = BigInt(slipstreamFixture.amountIn);
  for (const [index, operation] of plan.branches[0].operations.entries()) {
    logs.push({
      address: executor.address,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "OperationExecuted",
        args: {
          planHash: plan.planHash as `0x${string}`,
          branchIndex: 0n,
          operationIndex: BigInt(index),
        },
      }) as string[],
      data: encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [
          3,
          operation.tokenIn as `0x${string}`,
          operation.tokenOut as `0x${string}`,
          previous,
          operationOutputs[index],
        ],
      ),
      transactionHash,
    });
    previous = operationOutputs[index];
  }
  logs.push(
    {
      address: executor.address,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "BranchExecuted",
        args: { planHash: plan.planHash as `0x${string}`, branchIndex: 0n },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [BigInt(slipstreamFixture.amountIn), operationOutputs[1]],
      ),
      transactionHash,
    },
    {
      address: executor.address,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "NativeRefunded",
        args: { planHash: plan.planHash as `0x${string}`, caller: signer },
      }) as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [7n]),
      transactionHash,
    },
    {
      address: executor.address,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "PlanExecuted",
        args: {
          planHash: plan.planHash as `0x${string}`,
          caller: signer,
          tokenOut: slipstreamFixture.tokenOut,
        },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [
          slipstreamFixture.tokenIn,
          BigInt(slipstreamFixture.amountIn),
          operationOutputs[1],
        ],
      ),
      transactionHash,
    },
  );
  return {
    transactionHash,
    status: "0x1",
    blockHash: `0x${"c".repeat(64)}`,
    blockNumber: "0x7c",
    logs,
  };
}

test("Atomic plan trade selects explicitly and rechecks frozen bytes before send", async () => {
  const value = harness();
  const result = await runAtomicPlanTrade(value.io);
  expect(result).toEqual({
    kind: ExecutionOutcome.Unknown,
    transactionHash: value.hash(),
  });
  expect(value.calls).toEqual([
    "quote",
    "prepare",
    "journal:prepared:swap",
    "confirm:swap",
    "recheck",
    "chainId",
    "sign",
    "journal:signed",
    "submitRawTransaction",
    "journal:submitted",
    "receipt",
    "journal:finality_unknown",
  ]);
});

test("Slipstream Atomic trade journals economic pass only after accepted native trace", async () => {
  const value = harness(["ready"], 3);
  value.io.receipt = async () => {
    value.calls.push("receipt");
    return slipstreamReceipt(value.selected(), value.hash());
  };
  value.io.traceCanonicalTransaction = async (hash, receipt) => {
    value.calls.push("trace");
    expect(hash).toBe(value.hash());
    expect(receipt.transactionHash).toBe(value.hash());
    return {
      type: "CALL",
      from: signer,
      to: executor.address,
      value: "0x0",
      input: "0x661983c5",
      calls: [
        {
          type: "CALL",
          from: executor.address,
          to: signer,
          value: "0x7",
          input: "0x",
        },
      ],
    };
  };
  enableFinality(
    value,
    () => slipstreamReceipt(value.selected(), value.hash()),
    {
      type: "CALL",
      from: signer,
      to: executor.address,
      value: "0x0",
      input: "0x661983c5",
      calls: [
        {
          type: "CALL",
          from: executor.address,
          to: signer,
          value: "0x7",
          input: "0x",
        },
      ],
    },
  );
  const reports: unknown[] = [];
  value.io.report = (event) => reports.push(event);
  expect(await runAtomicPlanTrade(value.io)).toEqual({
    kind: ExecutionOutcome.SwapComplete,
    transactionHash: value.hash(),
  });
  expect(value.calls).toContain("journal:receipt_observed");
  expect(value.calls.at(-1)).toBe("journal:finalized_complete");
  expect(reports.at(-1)).toMatchObject({
    finality: { stage: "complete", transactionHash: value.hash() },
  });
});

test("explicit recovery re-admits frozen Slipstream swap and journals pass only after native trace", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "epeius-atomic-recovery-swap-"),
  );
  const path = join(directory, "intent.jsonl");
  const value = harness(["ready"], 3);
  let journal = await AtomicIntentJournal.open(path);
  value.io.journal = journal;
  try {
    expect((await runAtomicPlanTrade(value.io)).kind).toBe(
      ExecutionOutcome.Unknown,
    );
    await journal.close();
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const attemptId = records[0].attemptId as string;
    journal = await AtomicIntentJournal.open(path);
    const attempt = journal.recoveryAttempt(attemptId);
    let submits = 0;
    let traces = 0;
    const receipt = slipstreamReceipt(value.selected(), value.hash());
    const trace = {
      type: "CALL",
      from: signer,
      to: executor.address,
      value: "0x0",
      input: "0x661983c5",
      calls: [
        {
          type: "CALL",
          from: executor.address,
          to: signer,
          value: "0x7",
          input: "0x",
        },
      ],
    };
    enableFinality(value, receipt, trace);
    const blockByNumber = value.io.finalityChain.blockByNumber;
    value.io.finalityChain.blockByNumber = async (tag) => {
      if (tag === "safe") throw new Error("unsupported block tag");
      return blockByNumber(tag);
    };
    value.io.finalityChain.traceCanonicalTransaction = async () => {
      traces++;
      return trace;
    };
    const result = await runAtomicRecovery({
      journal,
      attempt,
      executor,
      policy: value.io.finalityPolicy,
      signal: value.io.signal,
      chain: {
        ...value.io.finalityChain,
        chainId: async () => toHex(BigInt(slipstreamFixture.chainId)),
        nonce: async () => {
          throw new Error("nonce must not be read for an existing receipt");
        },
        canonicalReceipt: async () => receipt,
        waitCanonicalReceipt: async () => receipt,
        submitRawTransaction: async () => {
          submits++;
          return value.hash();
        },
      },
      verifyExecutor: async () => true,
      confirm: async () => {
        throw new Error(
          "consent must not be requested for an existing receipt",
        );
      },
      report: () => {},
    });
    expect(result).toEqual({
      kind: ExecutionOutcome.SwapComplete,
      transactionHash: value.hash(),
    });
    expect(traces).toBe(1);
    expect(submits).toBe(0);
    expect(
      (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).state)
        .at(-1),
    ).toBe("finalized_complete");
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Slipstream Atomic trade journals unavailable when native trace is unsupported", async () => {
  const value = harness(["ready"], 3);
  value.io.receipt = async () => {
    value.calls.push("receipt");
    return slipstreamReceipt(value.selected(), value.hash());
  };
  expect(await runAtomicPlanTrade(value.io)).toEqual({
    kind: ExecutionOutcome.Unknown,
    transactionHash: value.hash(),
  });
  expect(value.calls).toContain("journal:finality_unknown");
  expect(value.calls).not.toContain("journal:receipt_passed");
});

test("Atomic plan trade obtains a new quote after exact approval", async () => {
  const value = harness(["approval", "ready"]);
  await runAtomicPlanTrade(value.io);
  expect(value.calls).toEqual([
    "quote",
    "prepare",
    "journal:prepared:approval",
    "confirm:approval",
    "sign",
    "journal:signed",
    "submitRawTransaction",
    "journal:submitted",
    "receipt",
    "journal:receipt_passed",
    "quote",
    "prepare",
    "journal:prepared:swap",
    "confirm:swap",
    "recheck",
    "chainId",
    "sign",
    "journal:signed",
    "submitRawTransaction",
    "journal:submitted",
    "receipt",
    "journal:finality_unknown",
  ]);
});

test("Atomic plan trade never sends after cancellation or changed recheck", async () => {
  const canceled = harness();
  canceled.io.confirm = async () => false;
  expect(await runAtomicPlanTrade(canceled.io)).toEqual({
    kind: ExecutionOutcome.Canceled,
  });
  expect(canceled.calls).toContain("journal:canceled");
  expect(canceled.calls).not.toContain("sign");
  expect(canceled.calls).not.toContain("submitRawTransaction");

  const changed = harness();
  changed.io.recheck = async () => {
    const response = readyResponse(
      acceptAtomicCandidate(candidate(), signer, executor, 50),
    );
    response.preparation?.transaction?.data?.fill(1);
    return response;
  };
  await expect(runAtomicPlanTrade(changed.io)).rejects.toThrow();
  expect(changed.calls).not.toContain("sign");
  expect(changed.calls).not.toContain("submitRawTransaction");
});

test("Atomic finality preflight failure stops before consent, signing, or submission", async () => {
  for (const unavailable of ["anchor", "finalized"] as const) {
    const value = harness();
    const blockByNumber = value.io.finalityChain.blockByNumber;
    value.io.finalityChain.blockByNumber = async (tag) => {
      if (
        (unavailable === "anchor" && tag === "0x0") ||
        (unavailable === "finalized" && tag === "finalized")
      )
        throw new Error(`${unavailable} unavailable`);
      return blockByNumber(tag);
    };
    await expect(runAtomicPlanTrade(value.io)).rejects.toThrow();
    expect(value.calls).not.toContain("confirm:swap");
    expect(value.calls).not.toContain("sign");
    expect(value.calls).not.toContain("submitRawTransaction");
  }
});

test("Atomic journal stores separate approval and swap attempts with exact protobuf bytes and identities", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "epeius-atomic-trade-journal-"),
  );
  const path = join(directory, "intent.jsonl");
  const value = harness(["approval", "ready"]);
  const journal = await AtomicIntentJournal.open(path);
  value.io.journal = journal;
  try {
    await runAtomicPlanTrade(value.io);
  } finally {
    await journal.close();
  }
  try {
    const records = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.state)).toEqual([
      "prepared",
      "signed",
      "submitted",
      "receipt_passed",
      "prepared",
      "signed",
      "submitted",
      "finality_unknown",
    ]);
    expect(records[0].action).toBe("approval");
    expect(records[4].action).toBe("swap");
    expect(records[0].attemptId).not.toBe(records[4].attemptId);
    expect(records[1].signedEnvelope.nonce).toBe("9");
    expect(records[5].signedEnvelope.nonce).toBe("10");
    expect(records[1].signedEnvelope.rawTransaction).toMatch(/^0x02[0-9a-f]+$/);
    expect(records[5].signedEnvelope.rawTransaction).toMatch(/^0x02[0-9a-f]+$/);
    const approvalBytes = new Uint8Array(
      hexToBytes(records[0].payloadBinaryHex),
    );
    expect(
      toBinary(
        PreparePlanResponseSchema,
        fromBinary(PreparePlanResponseSchema, approvalBytes),
      ),
    ).toEqual(approvalBytes);
    const preparationBytes = new Uint8Array(
      hexToBytes(records[4].payloadBinaryHex),
    );
    expect(
      toBinary(
        UnsignedPreparationSchema,
        fromBinary(UnsignedPreparationSchema, preparationBytes),
      ),
    ).toEqual(preparationBytes);
    expect(records[4].planId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(records[4].executorPlanHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(records[4].transactionFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(records[4].transaction).toEqual({
      chainId: fixture.chainId,
      from: signer.toLowerCase(),
      to: executor.address,
      valueAtomic: "0",
      data: records[4].transaction.data,
      gasLimit: "1000000",
    });
    expect(records[4].transaction.data).toMatch(/^0x[0-9a-f]+$/);
    const frozen = fromBinary(UnsignedPreparationSchema, preparationBytes);
    expect(`0x${Buffer.from(frozen.planId ?? []).toString("hex")}`).toBe(
      records[4].planId,
    );
    const validated = validateAtomicPlanPreparation(
      value.preparedResponses[1],
      value.selected(),
      executor,
    );
    if (validated.kind !== "swap") throw new Error("expected swap preparation");
    expect(preparationBytes).toEqual(validated.frozen);
    expect(records[4].executorPlanHash).toBe(validated.executorPlanHash);
    expect(records[4].transaction).toEqual({
      chainId: validated.transaction.chainId,
      from: validated.transaction.from,
      to: validated.transaction.to,
      data: validated.transaction.data,
      valueAtomic: validated.transaction.valueAtomic,
      gasLimit: validated.transaction.gasLimit,
    });
    expect(records[4].transactionFingerprint).toBe(
      atomicV1TransactionFingerprint({
        planId: records[4].planId,
        chainId: BigInt(records[4].transaction.chainId),
        from: records[4].transaction.from,
        to: records[4].transaction.to,
        value: BigInt(records[4].transaction.valueAtomic),
        data: records[4].transaction.data,
        gasLimit: BigInt(records[4].transaction.gasLimit),
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal failures enforce zero submissions before durable signed bytes and at most one after", async () => {
  const beforeConsent = harness();
  beforeConsent.io.journal.prepare = async () => {
    throw new Error("prepare append failed");
  };
  await expect(runAtomicPlanTrade(beforeConsent.io)).rejects.toThrow(
    "prepare append failed",
  );
  expect(beforeConsent.calls).not.toContain("confirm:swap");
  expect(beforeConsent.calls).not.toContain("sign");
  expect(beforeConsent.calls).not.toContain("submitRawTransaction");

  const beforeSigned = harness();
  beforeSigned.io.journal.sign = async () => {
    throw new Error("signed append failed");
  };
  await expect(runAtomicPlanTrade(beforeSigned.io)).rejects.toThrow(
    "signed append failed",
  );
  expect(beforeSigned.calls).toContain("sign");
  expect(beforeSigned.calls).not.toContain("submitRawTransaction");

  for (const failure of ["submit", "submitted", "receipt"] as const) {
    const value = harness();
    let submissions = 0;
    const submit = value.io.submitRawTransaction;
    value.io.submitRawTransaction = async (raw) => {
      submissions++;
      if (failure === "submit") throw new Error("RPC failed");
      return submit(raw);
    };
    const transition = value.io.journal.transition;
    value.io.journal.transition = async (
      attempt: Parameters<JournalTransition>[0],
      state: Parameters<JournalTransition>[1],
      details?: Parameters<JournalTransition>[2],
    ) => {
      if (
        (failure === "submitted" && state === "submitted") ||
        (failure === "receipt" &&
          (state.startsWith("receipt_") ||
            state.startsWith("finality_") ||
            state.startsWith("finalized_")))
      )
        throw new Error(`${failure} append failed`);
      return transition(attempt, state, details);
    };
    const reports: unknown[] = [];
    value.io.report = (event: unknown) => {
      reports.push(event);
    };
    expect(await runAtomicPlanTrade(value.io)).toMatchObject({
      kind: ExecutionOutcome.Unknown,
      transactionHash: value.hash(),
    });
    expect(submissions).toBe(1);
    expect(reports.at(-1)).toMatchObject(
      failure === "receipt"
        ? { finality: { stage: "persistence_failed" } }
        : {
            verification: { outcome: VerificationOutcome.Unavailable },
            ...(failure === "submit"
              ? { submission: "unknown" }
              : { message: expect.stringContaining("journal is incomplete") }),
          },
    );
  }
});

test("Cast and signed-envelope admission failures submit nothing", async () => {
  for (const mode of ["cast", "malformed"] as const) {
    const value = harness();
    let submissions = 0;
    value.io.sign = async () => {
      if (mode === "cast") throw new Error("Cast failed");
      return "0x02";
    };
    value.io.submitRawTransaction = async () => {
      submissions++;
      throw new Error("must not submit");
    };
    await expect(runAtomicPlanTrade(value.io)).rejects.toThrow();
    expect(submissions).toBe(0);
    expect(value.calls).not.toContain("journal:signed");
  }
});

test("invalid returned hash is submission_unknown and never reads receipt or retries", async () => {
  const value = harness();
  let submissions = 0;
  let receipts = 0;
  value.io.submitRawTransaction = async () => {
    submissions++;
    return "not-a-hash";
  };
  value.io.receipt = async () => {
    receipts++;
    throw new Error("must not read receipt");
  };
  expect(await runAtomicPlanTrade(value.io)).toEqual({
    kind: ExecutionOutcome.Unknown,
    transactionHash: value.hash(),
  });
  expect(submissions).toBe(1);
  expect(receipts).toBe(0);
  expect(value.calls).toContain("journal:submission_unknown");
});

test("failed receipt is durably distinct from submission and economic pass", async () => {
  const value = harness();
  value.io.receipt = async () => {
    value.calls.push("receipt");
    return {
      transactionHash: value.hash(),
      status: "0x0",
      logs: [],
    };
  };
  enableFinality(value, () => ({
    transactionHash: value.hash(),
    status: "0x0",
    logs: [],
  }));
  expect(await runAtomicPlanTrade(value.io)).toEqual({
    kind: ExecutionOutcome.Failed,
    transactionHash: value.hash(),
  });
  expect(value.calls).toContain("journal:submitted");
  expect(value.calls).toContain("journal:receipt_observed");
  expect(value.calls).toContain("journal:finalized_failed");
  expect(value.calls).not.toContain("journal:finalized_complete");
});
