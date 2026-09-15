import { toBinary, toJson } from "@bufbuild/protobuf";
import { hexToBigInt, isHash, isHex } from "viem";
import {
  PlanCandidateSchema,
  PlanQuoteResponseSchema,
  PreparePlanResponseSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type {
  AtomicIntentAttempt,
  AtomicIntentJournalWriter,
  SignedAtomicIntentAttempt,
} from "./atomic-intent-journal";
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
import {
  type AtomicEnvelope,
  admitSignedAtomicEnvelope,
  atomicEnvelope,
} from "./atomic-signed-envelope";
import { ExecutionOutcome, type ExecutionResult } from "./execution";
import {
  type Receipt,
  requiresNativeRefundTrace,
  type TransactionCallTrace,
  VerificationOutcome,
  verifyReceipt,
} from "./receipt";

export type AtomicPlanTradeIO = {
  request: AtomicQuoteRequest;
  candidateIndex: number;
  signer: string;
  executor: AtomicExecutorIdentity;
  slippageBps: number;
  pendingNonce: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
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
    envelope: AtomicEnvelope,
  ) => Promise<boolean>;
  sign: (
    transaction: UnsignedTransaction,
    envelope: AtomicEnvelope,
  ) => Promise<string>;
  submitRawTransaction: (raw: string) => Promise<string>;
  receipt: (hash: string) => Promise<Receipt>;
  traceCanonicalTransaction?: (
    hash: string,
    receipt: Receipt,
  ) => Promise<TransactionCallTrace>;
  report: (event: unknown) => void;
  journal: AtomicIntentJournalWriter;
};

export async function runAtomicPlanTrade(
  io: AtomicPlanTradeIO,
): Promise<ExecutionResult> {
  let previousQuote = "";
  let nextNonce = io.pendingNonce;
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
      const envelope = atomicEnvelope(
        nextNonce,
        io.maxFeePerGas,
        io.maxPriorityFeePerGas,
      );
      const attempt = await io.journal.prepare({
        action: "approval",
        payloadType: "approval_response",
        payloadBinary: toBinary(PreparePlanResponseSchema, response),
        planId: accepted.planId,
        transaction: prepared.transaction,
        envelope,
      });
      if (!(await io.confirm("approval", prepared.transaction, envelope))) {
        await io.journal.transition(attempt, "canceled");
        io.report({ sent: false, outcome: ExecutionOutcome.Canceled });
        return { kind: ExecutionOutcome.Canceled };
      }
      const submission = await signAndSubmit(io, attempt);
      if (submission.status === "unknown")
        return {
          kind: ExecutionOutcome.Unknown,
          transactionHash: submission.hash,
        };
      const hash = submission.hash;
      let receipt: Receipt;
      try {
        receipt = await io.receipt(hash);
      } catch {
        if (
          !(await recordReceipt(
            io,
            submission.attempt,
            hash,
            "receipt_unavailable",
          ))
        )
          return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
        return unknownReceipt(io, hash);
      }
      if (
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        receipt.status !== "0x1"
      ) {
        if (
          !(await recordReceipt(io, submission.attempt, hash, "receipt_failed"))
        )
          return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
        io.report({
          transactionHash: hash,
          verification: { outcome: VerificationOutcome.Failed },
        });
        return { kind: ExecutionOutcome.Failed, transactionHash: hash };
      }
      if (
        !(await recordReceipt(io, submission.attempt, hash, "receipt_passed"))
      )
        return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
      io.report({
        transactionHash: hash,
        verification: { outcome: VerificationOutcome.ReceiptSuccess },
        nextAction: "Fresh Atomic V1 quote required after approval.",
      });
      nextNonce++;
      previousQuote = quoteId;
      continue;
    }
    const envelope = atomicEnvelope(
      nextNonce,
      io.maxFeePerGas,
      io.maxPriorityFeePerGas,
    );
    const attempt = await io.journal.prepare({
      action: "swap",
      payloadType: "unsigned_preparation",
      payloadBinary: prepared.frozen,
      planId: prepared.planId,
      executorPlanHash: prepared.executorPlanHash,
      transactionFingerprint: prepared.transactionFingerprint,
      transaction: prepared.transaction,
      envelope,
    });
    if (!(await io.confirm("swap", prepared.transaction, envelope))) {
      await io.journal.transition(attempt, "canceled");
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
    const submission = await signAndSubmit(io, attempt);
    if (submission.status === "unknown")
      return {
        kind: ExecutionOutcome.Unknown,
        transactionHash: submission.hash,
      };
    const hash = submission.hash;
    let evidence: ReturnType<typeof verifyReceipt>;
    try {
      const receipt = await io.receipt(hash);
      evidence = verifyReceipt(receipt, hash, checked.receipt);
      if (requiresNativeRefundTrace(evidence)) {
        if (!io.traceCanonicalTransaction)
          throw new Error("Transaction trace is unavailable.");
        const trace = await io.traceCanonicalTransaction(hash, receipt);
        evidence = verifyReceipt(receipt, hash, checked.receipt, trace);
      }
    } catch {
      if (
        !(await recordReceipt(
          io,
          submission.attempt,
          hash,
          "receipt_unavailable",
        ))
      )
        return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
      return unknownReceipt(io, hash);
    }
    const state =
      evidence.outcome === VerificationOutcome.Passed
        ? "receipt_passed"
        : evidence.outcome === VerificationOutcome.Failed
          ? "receipt_failed"
          : "receipt_unavailable";
    if (!(await recordReceipt(io, submission.attempt, hash, state)))
      return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
    io.report({ transactionHash: hash, verification: evidence });
    return evidence.outcome === VerificationOutcome.Passed
      ? { kind: ExecutionOutcome.SwapVerified, transactionHash: hash }
      : evidence.outcome === VerificationOutcome.Failed
        ? { kind: ExecutionOutcome.Failed, transactionHash: hash }
        : { kind: ExecutionOutcome.Unknown, transactionHash: hash };
  }
  throw new Error("Atomic V1 trade did not produce a swap result.");
}

async function signAndSubmit(
  io: AtomicPlanTradeIO,
  attempt: AtomicIntentAttempt,
) {
  const raw = await io.sign(attempt.transaction, attempt.envelope);
  const envelope = await admitSignedAtomicEnvelope(
    raw,
    attempt.transaction,
    attempt.envelope,
  );
  const signedAttempt = await io.journal.sign(attempt, envelope);
  const hash = envelope.transactionHash;
  try {
    const returned = (await io.submitRawTransaction(raw)).trim();
    if (!isHash(returned) || returned.toLowerCase() !== hash.toLowerCase())
      throw new Error("RPC transaction hash differs from signed bytes.");
  } catch {
    try {
      await io.journal.transition(signedAttempt, "submission_unknown");
    } catch {
      journalIncomplete(io, hash);
      return { status: "unknown" as const, hash };
    }
    io.report({
      transactionHash: hash,
      submission: "unknown",
      verification: { outcome: VerificationOutcome.Unavailable },
      message:
        "Raw submission may have reached the network. Inspect the signed journal record; do not automatically resend.",
    });
    return { status: "unknown" as const, hash };
  }
  try {
    await io.journal.transition(signedAttempt, "submitted", {
      transactionHash: hash,
    });
  } catch {
    journalIncomplete(io, hash);
    return { status: "unknown" as const, hash };
  }
  io.report({
    transactionHash: hash,
    submission: "submitted",
    kind: attempt.action,
    verification: { outcome: VerificationOutcome.Pending },
  });
  return { status: "submitted" as const, hash, attempt: signedAttempt };
}

async function recordReceipt(
  io: AtomicPlanTradeIO,
  attempt: SignedAtomicIntentAttempt,
  hash: string,
  state: "receipt_passed" | "receipt_failed" | "receipt_unavailable",
) {
  try {
    await io.journal.transition(attempt, state, {
      transactionHash: hash,
      verification:
        state === "receipt_passed"
          ? attempt.action === "approval"
            ? "receipt_success"
            : "economic_pass"
          : state === "receipt_failed"
            ? "failed"
            : "unavailable",
    });
    return true;
  } catch {
    journalIncomplete(io, hash);
    return false;
  }
}

function journalIncomplete(io: AtomicPlanTradeIO, hash: string | null) {
  io.report({
    transactionHash: hash,
    submission: hash ? "pending_or_unknown" : "unknown",
    verification: { outcome: VerificationOutcome.Unavailable },
    message:
      "Atomic intent journal is incomplete after wallet handoff. Do not resend; inspect the wallet and journal manually.",
  });
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
