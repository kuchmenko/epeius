import { isAddress, isHash, isHex, toHex } from "viem";
import type {
  AtomicIntentJournal,
  AtomicRecoveryAttempt,
} from "./atomic-intent-journal";
import type { AtomicExecutorIdentity } from "./atomic-plan-execution";
import { admitAtomicRecoveryPayload } from "./atomic-plan-execution";
import { admitSignedAtomicEnvelope } from "./atomic-signed-envelope";
import type { readChain } from "./chain";
import { ExecutionOutcome, type ExecutionResult } from "./execution";
import {
  type Receipt,
  requiresNativeRefundTrace,
  VerificationOutcome,
  verifyReceipt,
} from "./receipt";

type RecoveryChain = Pick<
  ReturnType<typeof readChain>,
  | "chainId"
  | "nonce"
  | "canonicalReceipt"
  | "transactionByHash"
  | "waitCanonicalReceipt"
  | "traceCanonicalTransaction"
  | "submitRawTransaction"
>;

export type AtomicRecoveryIO = {
  journal: Pick<AtomicIntentJournal, "recoveryTransition">;
  attempt: AtomicRecoveryAttempt;
  executor: AtomicExecutorIdentity;
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
  return followReceipt(io, payload);
}

async function inspectSubmission(
  io: AtomicRecoveryIO,
  payload: ReturnType<typeof admitAtomicRecoveryPayload>,
): Promise<ExecutionResult | undefined> {
  const hash = io.attempt.signedEnvelope.transactionHash;
  let receipt: Receipt | null;
  let transaction: unknown | null;
  try {
    [receipt, transaction] = await Promise.all([
      io.chain.canonicalReceipt(hash),
      io.chain.transactionByHash(hash),
    ]);
  } catch {
    return manualReview(io);
  }
  if (transaction !== null)
    admitRpcTransaction(transaction, io.attempt.signedEnvelope);
  if (receipt) return recordReceipt(io, payload, receipt);
  if (transaction !== null) {
    try {
      await io.journal.recoveryTransition(io.attempt, "submission_observed", {
        transactionHash: hash,
      });
    } catch {
      return journalIncomplete(io);
    }
    return followReceipt(io, payload);
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
    let evidence = verifyReceipt(receipt, hash, payload.receipt);
    if (requiresNativeRefundTrace(evidence)) {
      try {
        const trace = await io.chain.traceCanonicalTransaction(hash, receipt);
        evidence = verifyReceipt(receipt, hash, payload.receipt, trace);
      } catch {
        // The exact receipt remains known, but economic verification does not.
      }
    }
    outcome = evidence.outcome;
    verification = evidence;
  }
  const state =
    outcome === VerificationOutcome.ReceiptSuccess ||
    outcome === VerificationOutcome.Passed
      ? "receipt_passed"
      : outcome === VerificationOutcome.Failed
        ? "receipt_failed"
        : "receipt_unavailable";
  try {
    await io.journal.recoveryTransition(io.attempt, state, {
      transactionHash: hash,
      verification:
        state === "receipt_passed"
          ? payload.action === "approval"
            ? "receipt_success"
            : "economic_pass"
          : state === "receipt_failed"
            ? "failed"
            : "unavailable",
    });
  } catch {
    return journalIncomplete(io);
  }
  io.report({ recovery: state, transactionHash: hash, verification });
  return {
    kind:
      state === "receipt_passed"
        ? payload.action === "approval"
          ? ExecutionOutcome.ApprovalConfirmed
          : ExecutionOutcome.SwapVerified
        : state === "receipt_failed"
          ? ExecutionOutcome.Failed
          : ExecutionOutcome.Unknown,
    transactionHash: hash,
  };
}

export function admitRpcTransaction(
  value: unknown,
  expected: AtomicRecoveryAttempt["signedEnvelope"],
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Observed transaction is malformed.");
  const tx = value as Record<string, unknown>;
  const quantity = (name: string) => {
    const raw = tx[name];
    if (
      typeof raw !== "string" ||
      !isHex(raw, { strict: true }) ||
      raw === "0x"
    )
      throw new Error("Observed transaction authority is malformed.");
    const number = BigInt(raw);
    if (toHex(number) !== raw.toLowerCase())
      throw new Error("Observed transaction authority is noncanonical.");
    return number.toString();
  };
  const same = (left: unknown, right: string) =>
    typeof left === "string" && left.toLowerCase() === right.toLowerCase();
  if (
    !same(tx.hash, expected.transactionHash) ||
    quantity("type") !== "2" ||
    quantity("chainId") !== expected.chainId ||
    quantity("nonce") !== expected.nonce ||
    !same(tx.from, expected.signer) ||
    !isAddress(String(tx.from), { strict: false }) ||
    !same(tx.to, expected.to) ||
    !isAddress(String(tx.to), { strict: false }) ||
    !same(tx.input, expected.data) ||
    quantity("value") !== expected.valueAtomic ||
    quantity("gas") !== expected.gasLimit ||
    quantity("maxFeePerGas") !== expected.maxFeePerGasAtomic ||
    quantity("maxPriorityFeePerGas") !== expected.maxPriorityFeePerGasAtomic ||
    !Array.isArray(tx.accessList) ||
    tx.accessList.length !== 0 ||
    quantity("yParity") !== String(expected.yParity) ||
    !same(tx.r, expected.r) ||
    !same(tx.s, expected.s)
  )
    throw new Error("Observed transaction differs from stored signed bytes.");
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
