import { toJson } from "@bufbuild/protobuf";
import { hexToBigInt, isHash, isHex } from "viem";
import {
  PlanCandidateSchema,
  PlanQuoteResponseSchema,
  PreparePlanResponseSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  type AtomicExecutorIdentity,
  acceptAtomicCandidate,
  assertAtomicPlanRecheck,
  validateAtomicPlanPreparation,
} from "./atomic-plan-execution";
import {
  type AtomicQuoteRequest,
  validateAtomicPlanQuote,
} from "./atomic-plan-quote";
import { ExecutionOutcome, type ExecutionResult } from "./execution";
import { type Receipt, VerificationOutcome, verifyReceipt } from "./receipt";

export type AtomicPlanTradeIO = {
  request: AtomicQuoteRequest;
  candidateIndex: number;
  signer: string;
  executor: AtomicExecutorIdentity;
  slippageBps: number;
  quote: () => Promise<Parameters<typeof validateAtomicPlanQuote>[0]>;
  prepare: (
    request: Parameters<
      Awaited<
        ReturnType<typeof import("./client").atomicPlanClient>
      >["preparePlan"]
    >[0],
  ) => Promise<Parameters<typeof validateAtomicPlanPreparation>[0]>;
  recheck: (
    request: Parameters<
      Awaited<
        ReturnType<typeof import("./client").atomicPlanClient>
      >["recheckPlan"]
    >[0],
  ) => Promise<Parameters<typeof validateAtomicPlanPreparation>[0]>;
  chainId: () => Promise<string>;
  confirm: (
    kind: "approval" | "swap",
    transaction: UnsignedTransaction,
  ) => Promise<boolean>;
  send: (transaction: UnsignedTransaction) => Promise<string>;
  receipt: (hash: string) => Promise<Receipt>;
  report: (event: unknown) => void;
};

export async function runAtomicPlanTrade(
  io: AtomicPlanTradeIO,
): Promise<ExecutionResult> {
  let previousQuote = "";
  for (const afterApproval of [false, true]) {
    const quote = validateAtomicPlanQuote(await io.quote(), io.request);
    const quoteId = bytes(quote.quoteId);
    if (quoteId === previousQuote)
      throw new Error("A fresh Atomic V1 quote ID is required. Nothing sent.");
    const candidate = quote.candidates[io.candidateIndex];
    if (!candidate)
      throw new Error(
        "Selected Atomic V1 candidate is unavailable. Nothing sent.",
      );
    const accepted = acceptAtomicCandidate(
      candidate,
      io.signer,
      io.executor,
      io.slippageBps,
    );
    const selectedOperation = candidate.program?.branches[0]?.operations[0];
    const balancer =
      selectedOperation?.pool.case === "balancerV2"
        ? {
            kind: 4,
            vault: bytes20(selectedOperation.pool.value.vault),
            poolId: bytes(selectedOperation.pool.value.poolId),
          }
        : undefined;
    io.report({
      quote: toJson(PlanQuoteResponseSchema, quote),
      selection: {
        candidateIndex: io.candidateIndex,
        candidateId: bytes(candidate.candidateId),
        source: "manual",
        searchComplete: quote.searchComplete,
        program: toJson(PlanCandidateSchema, candidate),
        quotedFinalOutputAtomic: accepted.finalOutput.toString(),
        branchMinimumAtomic: accepted.minimum.toString(),
        aggregateMinimumAtomic: accepted.minimum.toString(),
        executor: io.executor.address,
        runtimeCodeHash: io.executor.runtimeCodeHash,
        expiresAtUnix: accepted.expiresAt.toString(),
        deadlineUnix: accepted.deadline.toString(),
        planId: accepted.planId,
        afterApproval,
        ...(balancer ? { balancer } : {}),
      },
    });
    const response = await io.prepare({
      quoteId: quote.quoteId,
      candidateId: candidate.candidateId,
      terms: accepted.terms,
      planId: hexBytes(accepted.planId),
    });
    const prepared = validateAtomicPlanPreparation(
      response,
      accepted,
      io.executor,
    );
    io.report({
      preparation: toJson(PreparePlanResponseSchema, response),
      sent: false,
    });
    if (prepared.kind === "approval") {
      if (afterApproval)
        throw new Error(
          "Approval is still required after a fresh quote. Nothing sent.",
        );
      if (!(await io.confirm("approval", prepared.transaction))) {
        io.report({ sent: false, outcome: ExecutionOutcome.Canceled });
        return { kind: ExecutionOutcome.Canceled };
      }
      const hash = await send(io, prepared.transaction, "approval");
      if (!hash)
        return { kind: ExecutionOutcome.Unknown, transactionHash: null };
      try {
        const receipt = await io.receipt(hash);
        if (
          receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
          receipt.status !== "0x1"
        ) {
          io.report({
            transactionHash: hash,
            verification: { outcome: VerificationOutcome.Failed },
          });
          return { kind: ExecutionOutcome.Failed, transactionHash: hash };
        }
        io.report({
          transactionHash: hash,
          verification: { outcome: VerificationOutcome.ReceiptSuccess },
          nextAction: "Fresh Atomic V1 quote required after approval.",
        });
        previousQuote = quoteId;
        continue;
      } catch {
        return unknownReceipt(io, hash);
      }
    }
    if (!(await io.confirm("swap", prepared.transaction))) {
      io.report({ sent: false, outcome: ExecutionOutcome.Canceled });
      return { kind: ExecutionOutcome.Canceled };
    }
    const recheckedResponse = await io.recheck({
      preparationId: prepared.preparation.preparationId,
      planId: hexBytes(prepared.planId),
    });
    const checked = assertAtomicPlanRecheck(
      recheckedResponse,
      prepared,
      accepted,
      io.executor,
    );
    io.report({
      recheck: toJson(PreparePlanResponseSchema, recheckedResponse),
      sent: false,
    });
    const chainId = await io.chainId();
    if (
      !isHex(chainId, { strict: true }) ||
      hexToBigInt(chainId) !== io.request.chainId
    )
      throw new Error("RPC network changed. Nothing sent.");
    const hash = await send(io, checked.transaction, "swap");
    if (!hash) return { kind: ExecutionOutcome.Unknown, transactionHash: null };
    try {
      const evidence = verifyReceipt(
        await io.receipt(hash),
        hash,
        checked.receipt,
      );
      io.report({ transactionHash: hash, verification: evidence });
      return evidence.outcome === VerificationOutcome.Passed
        ? { kind: ExecutionOutcome.SwapVerified, transactionHash: hash }
        : evidence.outcome === VerificationOutcome.Failed
          ? { kind: ExecutionOutcome.Failed, transactionHash: hash }
          : { kind: ExecutionOutcome.Unknown, transactionHash: hash };
    } catch {
      return unknownReceipt(io, hash);
    }
  }
  throw new Error("Atomic V1 trade did not produce a swap result.");
}

async function send(
  io: AtomicPlanTradeIO,
  transaction: UnsignedTransaction,
  kind: "approval" | "swap",
) {
  try {
    const hash = (await io.send(transaction)).trim();
    if (!isHash(hash)) throw new Error("invalid transaction hash");
    io.report({
      transactionHash: hash,
      submission: "submitted",
      kind,
      verification: { outcome: VerificationOutcome.Pending },
    });
    return hash;
  } catch {
    io.report({
      transactionHash: null,
      submission: "unknown",
      verification: { outcome: VerificationOutcome.Unavailable },
      message:
        "Send attempt may have reached the network. Inspect wallet transactions; do not automatically resend.",
    });
    return "";
  }
}

function unknownReceipt(io: AtomicPlanTradeIO, hash: string): ExecutionResult {
  io.report({
    transactionHash: hash,
    submission: "pending_or_unknown",
    verification: { outcome: VerificationOutcome.Unavailable },
    message: "Receipt unavailable. Do not resend automatically.",
  });
  return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
}

function bytes(value: Uint8Array | undefined) {
  if (value?.length !== 32)
    throw new Error("Atomic V1 identity has the wrong width.");
  return `0x${Buffer.from(value).toString("hex")}`;
}

function bytes20(value: Uint8Array | undefined) {
  if (value?.length !== 20)
    throw new Error("Atomic V1 address has the wrong width.");
  return `0x${Buffer.from(value).toString("hex")}`;
}

function hexBytes(value: string) {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}
