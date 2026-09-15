import { isHash, isHex } from "viem";
import { finalizeAtomicSwap, preflightAtomicFinality } from "./atomic-finality";
import type {
  AtomicIntentJournal,
  AtomicRecoveryAttempt,
} from "./atomic-intent-journal";
import type { AtomicExecutorIdentity } from "./atomic-plan-execution";
import { admitAtomicRecoveryPayload } from "./atomic-plan-execution";
import {
  admitRpcAtomicTransaction,
  admitSignedAtomicEnvelope,
} from "./atomic-signed-envelope";
import type { readChain } from "./chain";
import { ExecutionOutcome, type ExecutionResult } from "./execution";
import type { AtomicFinalityPolicy } from "./finality-policy";
import { assertAtomicFinalityPolicyReadmission } from "./finality-policy";
import { type Receipt, VerificationOutcome } from "./receipt";

type RecoveryChain = Pick<
  ReturnType<typeof readChain>,
  | "chainId"
  | "nonce"
  | "canonicalReceipt"
  | "receiptByHash"
  | "transactionByHash"
  | "blockByNumber"
  | "blockByHash"
  | "waitCanonicalReceipt"
  | "traceCanonicalTransaction"
  | "submitRawTransaction"
>;

export type AtomicRecoveryIO = {
  journal: Pick<
    AtomicIntentJournal,
    "readmitFinalityPolicy" | "recoveryTransition"
  >;
  attempt: AtomicRecoveryAttempt;
  executor: AtomicExecutorIdentity;
  policy: AtomicFinalityPolicy;
  signal: AbortSignal;
  now?: () => number;
  chain: RecoveryChain;
  verifyExecutor: () => Promise<boolean>;
  confirm: (attempt: AtomicRecoveryAttempt) => Promise<boolean>;
  report: (event: unknown) => void;
};

export async function runAtomicRecovery(
  io: AtomicRecoveryIO,
): Promise<ExecutionResult> {
  const attempt = io.attempt;
  const signed = attempt.signedEnvelope;
  const admitted = await admitSignedAtomicEnvelope(
    signed.rawTransaction,
    attempt.prepared.transaction,
    attempt.prepared.envelope,
  );
  if (JSON.stringify(admitted) !== JSON.stringify(signed))
    throw new Error("Atomic recovery signed bytes changed.");
  const payload = admitAtomicRecoveryPayload(attempt.prepared, io.executor);
  if (attempt.prepared.transaction.chainId !== signed.chainId)
    throw new Error("Atomic recovery chain identity changed.");
  const storedPolicy =
    attempt.current.schemaVersion === 3 &&
    "finalityPolicy" in attempt.current &&
    attempt.current.finalityPolicy;
  const finalityOnly =
    payload.action === "swap" &&
    ([
      "receipt_passed",
      "receipt_failed",
      "receipt_observed",
      "finality_unknown",
    ].includes(attempt.current.state) ||
      (attempt.current.state === "finality_policy_readmitted" &&
        "policyReadmission" in attempt.current &&
        attempt.current.policyReadmission?.recoveryScope === "finality_only"));
  const policyChanged =
    !!storedPolicy &&
    JSON.stringify(storedPolicy) !== JSON.stringify(io.policy);
  if (policyChanged)
    assertAtomicFinalityPolicyReadmission(storedPolicy, io.policy);
  await preflightAtomicFinality(io.policy, io.chain, io.signal, io.now?.());
  if (policyChanged) {
    try {
      await io.journal.readmitFinalityPolicy(attempt, io.policy);
    } catch {
      return journalIncomplete(io);
    }
  }

  if (finalityOnly) return finalizeRecoverySwap(io, payload);
  const rpcChainId = await io.chain.chainId();
  if (
    !isHex(rpcChainId, { strict: true }) ||
    BigInt(rpcChainId).toString() !== signed.chainId ||
    !(await io.verifyExecutor())
  )
    throw new Error("Atomic recovery chain or ExecutorV2 identity changed.");

  const first = await inspectSubmission(io, payload);
  if (first) return first;
  const nonce = BigInt(signed.nonce);
  if (!(await nonceAvailable(io, nonce))) return manualReview(io);

  io.report({
    recovery: "consent_required",
    attemptId: attempt.current.attemptId,
    action: attempt.current.action,
    transactionHash: signed.transactionHash,
    authority: {
      type: signed.type,
      chainId: signed.chainId,
      nonce: signed.nonce,
      sender: signed.signer,
      target: signed.to,
      valueAtomic: signed.valueAtomic,
      data: signed.data,
      gasLimit: signed.gasLimit,
      maxFeePerGasAtomic: signed.maxFeePerGasAtomic,
      maxPriorityFeePerGasAtomic: signed.maxPriorityFeePerGasAtomic,
      accessList: signed.accessList,
      maxExecutionGasExposureAtomic: (
        BigInt(signed.gasLimit) * BigInt(signed.maxFeePerGasAtomic)
      ).toString(),
      totalMaximumAtomic: null,
    },
    warning:
      "This submits the exact stored signed bytes once. OP/Base L1-data and operator charges are not capped by these execution-gas fee caps; total maximum is unknown.",
  });
  if (!(await io.confirm(attempt))) {
    io.report({
      recovery: "canceled",
      transactionHash: signed.transactionHash,
    });
    return { kind: ExecutionOutcome.Canceled };
  }

  const changed = await inspectSubmission(io, payload);
  if (changed) return changed;
  if (!(await nonceAvailable(io, nonce))) return manualReview(io);
  await preflightAtomicFinality(io.policy, io.chain, io.signal, io.now?.());
  try {
    await io.journal.recoveryTransition(attempt, "recovery_handoff_started", {
      transactionHash: signed.transactionHash,
    });
  } catch {
    return journalIncomplete(io);
  }
  try {
    const returned = (
      await io.chain.submitRawTransaction(signed.rawTransaction)
    ).trim();
    if (!isHash(returned) || returned.toLowerCase() !== signed.transactionHash)
      throw new Error("RPC transaction hash differs from stored signed bytes.");
  } catch {
    try {
      await io.journal.recoveryTransition(attempt, "submission_unknown");
    } catch {
      return journalIncomplete(io);
    }
    io.report({
      recovery: "submission_unknown",
      transactionHash: signed.transactionHash,
      message:
        "Exact raw submission may have reached the network. Do not retry automatically; a later explicit recovery must repeat all chain checks.",
    });
    return {
      kind: ExecutionOutcome.Unknown,
      transactionHash: signed.transactionHash,
    };
  }
  try {
    await io.journal.recoveryTransition(attempt, "submitted", {
      transactionHash: signed.transactionHash,
    });
  } catch {
    return journalIncomplete(io);
  }
  return payload.action === "swap"
    ? finalizeRecoverySwap(io, payload)
    : followReceipt(io, payload);
}

async function inspectSubmission(
  io: AtomicRecoveryIO,
  payload: ReturnType<typeof admitAtomicRecoveryPayload>,
): Promise<ExecutionResult | undefined> {
  const hash = io.attempt.signedEnvelope.transactionHash;
  let receipt: unknown | null;
  let transaction: unknown | null;
  try {
    [receipt, transaction] = await Promise.all([
      io.chain.receiptByHash(hash),
      io.chain.transactionByHash(hash),
    ]);
  } catch {
    return manualReview(io);
  }
  if (transaction !== null)
    admitRpcAtomicTransaction(transaction, io.attempt.signedEnvelope);
  if (receipt)
    return payload.action === "swap"
      ? finalizeRecoverySwap(io, payload)
      : recordReceipt(
          io,
          payload,
          (await io.chain.canonicalReceipt(hash)) as Receipt,
        );
  if (transaction !== null) {
    try {
      await io.journal.recoveryTransition(io.attempt, "submission_observed", {
        transactionHash: hash,
      });
    } catch {
      return journalIncomplete(io);
    }
    return payload.action === "swap"
      ? finalizeRecoverySwap(io, payload)
      : followReceipt(io, payload);
  }
}

async function nonceAvailable(io: AtomicRecoveryIO, nonce: bigint) {
  try {
    const [latest, pending] = await Promise.all([
      io.chain.nonce(io.attempt.signedEnvelope.signer, "latest"),
      io.chain.nonce(io.attempt.signedEnvelope.signer, "pending"),
    ]);
    return latest === nonce && pending === nonce;
  } catch {
    return false;
  }
}

async function followReceipt(
  io: AtomicRecoveryIO,
  payload: ReturnType<typeof admitAtomicRecoveryPayload>,
) {
  try {
    return await recordReceipt(
      io,
      payload,
      await io.chain.waitCanonicalReceipt(
        io.attempt.signedEnvelope.transactionHash,
      ),
    );
  } catch {
    try {
      await io.journal.recoveryTransition(io.attempt, "receipt_unavailable", {
        transactionHash: io.attempt.signedEnvelope.transactionHash,
        verification: "unavailable",
      });
    } catch {
      return journalIncomplete(io);
    }
    io.report({
      recovery: "receipt_unavailable",
      transactionHash: io.attempt.signedEnvelope.transactionHash,
    });
    return {
      kind: ExecutionOutcome.Unknown,
      transactionHash: io.attempt.signedEnvelope.transactionHash,
    };
  }
}

async function finalizeRecoverySwap(
  io: AtomicRecoveryIO,
  payload: ReturnType<typeof admitAtomicRecoveryPayload>,
): Promise<ExecutionResult> {
  if (payload.action !== "swap")
    throw new Error("Atomic swap payload required.");
  const hash = io.attempt.signedEnvelope.transactionHash;
  const result = await finalizeAtomicSwap({
    policy: io.policy,
    hash,
    signedEnvelope: io.attempt.signedEnvelope,
    obligations: payload.receipt,
    chain: io.chain,
    signal: io.signal,
    report: io.report,
    recordObserved: (evidence) =>
      io.journal.recoveryTransition(io.attempt, "receipt_observed", {
        transactionHash: hash,
        provisionalEvidence: evidence,
        ...(io.attempt.current.schemaVersion === 2
          ? { finalityPolicy: io.policy }
          : {}),
      }),
    recordUnknown: (reason, evidence) =>
      io.journal.recoveryTransition(io.attempt, "finality_unknown", {
        transactionHash: hash,
        finalityReason: reason,
        ...(evidence ? { provisionalEvidence: evidence } : {}),
        ...(io.attempt.current.schemaVersion === 2
          ? { finalityPolicy: io.policy }
          : {}),
      }),
    recordFinal: (state, provisional, evidence) =>
      io.journal.recoveryTransition(
        io.attempt,
        state === "complete" ? "finalized_complete" : "finalized_failed",
        {
          transactionHash: hash,
          provisionalEvidence: provisional,
          finalityEvidence: evidence,
        },
      ),
  });
  return result.kind === "complete"
    ? { kind: ExecutionOutcome.SwapComplete, transactionHash: hash }
    : result.kind === "failed_final"
      ? { kind: ExecutionOutcome.Failed, transactionHash: hash }
      : { kind: ExecutionOutcome.Unknown, transactionHash: hash };
}

async function recordReceipt(
  io: AtomicRecoveryIO,
  payload: ReturnType<typeof admitAtomicRecoveryPayload>,
  receipt: Receipt,
): Promise<ExecutionResult> {
  const hash = io.attempt.signedEnvelope.transactionHash;
  let outcome: VerificationOutcome;
  let verification: unknown;
  if (payload.action === "approval") {
    outcome =
      receipt.transactionHash.toLowerCase() === hash && receipt.status === "0x1"
        ? VerificationOutcome.ReceiptSuccess
        : VerificationOutcome.Failed;
    verification = { outcome };
  } else {
    return finalizeRecoverySwap(io, payload);
  }
  const state =
    outcome === VerificationOutcome.ReceiptSuccess
      ? "receipt_passed"
      : "receipt_failed";
  try {
    await io.journal.recoveryTransition(io.attempt, state, {
      transactionHash: hash,
      verification: state === "receipt_passed" ? "receipt_success" : "failed",
    });
  } catch {
    return journalIncomplete(io);
  }
  io.report({ recovery: state, transactionHash: hash, verification });
  return {
    kind:
      state === "receipt_passed"
        ? ExecutionOutcome.ApprovalConfirmed
        : state === "receipt_failed"
          ? ExecutionOutcome.Failed
          : ExecutionOutcome.Unknown,
    transactionHash: hash,
  };
}

function manualReview(io: AtomicRecoveryIO): ExecutionResult {
  io.report({
    recovery: "manual_review",
    transactionHash: io.attempt.signedEnvelope.transactionHash,
    message:
      "Receipt, transaction, or nonce evidence is unavailable, inconsistent, consumed, or has a gap. Nothing submitted.",
  });
  return {
    kind: ExecutionOutcome.Unknown,
    transactionHash: io.attempt.signedEnvelope.transactionHash,
  };
}

function journalIncomplete(io: AtomicRecoveryIO): ExecutionResult {
  io.report({
    recovery: "journal_incomplete",
    transactionHash: io.attempt.signedEnvelope.transactionHash,
    message:
      "Journal state is incomplete. Do not submit again without a new explicit recovery and complete chain checks.",
  });
  return {
    kind: ExecutionOutcome.Unknown,
    transactionHash: io.attempt.signedEnvelope.transactionHash,
  };
}
