import { type JsonValue, toJsonString } from "@bufbuild/protobuf";
import { hexToBigInt, isHash, isHex } from "viem";
import {
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
  type UnsignedTransaction,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  assertPreparationCurrent,
  assertPreparationUnchanged,
  ExecutionAction,
  type ExecutionPlan,
  type TrustedExecution,
  validatePreparation,
} from "./execution-policy";
import {
  type Receipt,
  type SwapVerification,
  VerificationOutcome,
  verifyReceipt,
} from "./receipt";

export { ExecutionAction } from "./execution-policy";
export { VerificationOutcome } from "./receipt";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type Verification =
  | {
      action: typeof ExecutionAction.Approval;
      evidence: {
        outcome:
          | typeof VerificationOutcome.ReceiptSuccess
          | typeof VerificationOutcome.Failed
          | typeof VerificationOutcome.Unavailable;
      };
    }
  | { action: typeof ExecutionAction.Swap; evidence: SwapVerification };

export const ExecutionOutcome = {
  Preview: "preview",
  Canceled: "canceled",
  ApprovalConfirmed: "approval-confirmed",
  SwapVerified: "swap-verified",
  Failed: "failed",
  Unknown: "unknown",
} as const;

const Submission = {
  Submitted: "submitted",
  Unknown: "unknown",
  PendingOrUnknown: "pending_or_unknown",
} as const;

export type ExecutionResult =
  | { kind: typeof ExecutionOutcome.Preview | typeof ExecutionOutcome.Canceled }
  | {
      kind:
        | typeof ExecutionOutcome.ApprovalConfirmed
        | typeof ExecutionOutcome.SwapVerified
        | typeof ExecutionOutcome.Failed;
      transactionHash: string;
    }
  | { kind: typeof ExecutionOutcome.Unknown; transactionHash: string | null };
export type ExecutionOutcome = ExecutionResult["kind"];

// Existing JSONL payloads; the internal result discriminator is not serialized.
export type ExecutionEvent =
  | { preparation: JsonValue; sent: false }
  | { sent: false; outcome: typeof ExecutionOutcome.Canceled }
  | {
      transactionHash: string;
      submission: typeof Submission.Submitted;
      kind: ExecutionAction;
      verification: { outcome: typeof VerificationOutcome.Pending };
    }
  | {
      transactionHash: string;
      verification: Verification["evidence"];
      nextAction?: string;
    }
  | {
      transactionHash: null;
      submission: typeof Submission.Unknown;
      verification: { outcome: typeof VerificationOutcome.Unavailable };
      message: string;
    }
  | {
      transactionHash: string;
      submission: typeof Submission.PendingOrUnknown;
      verification: { outcome: typeof VerificationOutcome.Unavailable };
      message: string;
    };

export type ExecutionIO = {
  signer: string;
  expectedChainId: string;
  slippageBps: number;
  trusted: TrustedExecution;
  chainId: () => Promise<string>;
  prepare: (preparationId?: string) => Promise<PrepareExecutionResponse>;
  confirm: (
    kind: ExecutionAction,
    p: PrepareExecutionResponse,
    plan: ExecutionPlan,
  ) => Promise<boolean>;
  send: (tx: UnsignedTransaction) => Promise<string>;
  // Use chain.waitCanonicalReceipt: wallet/SDK success alone is not canonical evidence.
  receipt: (hash: string) => Promise<Receipt>;
  report: (event: ExecutionEvent) => void;
  reportPreparation?: boolean;
  swapOnly?: boolean;
};

function verifiedResult(
  verification: Verification,
  transactionHash: string,
): ExecutionResult {
  switch (verification.action) {
    case ExecutionAction.Approval: {
      const outcome = verification.evidence.outcome;
      switch (outcome) {
        case VerificationOutcome.ReceiptSuccess:
          return { kind: ExecutionOutcome.ApprovalConfirmed, transactionHash };
        case VerificationOutcome.Failed:
          return { kind: ExecutionOutcome.Failed, transactionHash };
        case VerificationOutcome.Unavailable:
          return { kind: ExecutionOutcome.Unknown, transactionHash };
        default:
          return impossible(outcome);
      }
    }
    case ExecutionAction.Swap: {
      const outcome = verification.evidence.outcome;
      switch (outcome) {
        case VerificationOutcome.Passed:
          return { kind: ExecutionOutcome.SwapVerified, transactionHash };
        case VerificationOutcome.Failed:
          return { kind: ExecutionOutcome.Failed, transactionHash };
        case VerificationOutcome.Unavailable:
          return { kind: ExecutionOutcome.Unknown, transactionHash };
        default:
          return impossible(outcome);
      }
    }
    default:
      return impossible(verification);
  }
}

function impossible(value: never): never {
  throw new Error(`Unhandled execution state: ${String(value)}`);
}

export async function executePrepared(
  io: ExecutionIO,
  preview = false,
): Promise<ExecutionResult> {
  const rpcMatchesExpectedChain = async () => {
    const chainId = await io.chainId();
    return (
      isHex(chainId, { strict: true }) &&
      chainId.length > 2 &&
      hexToBigInt(chainId).toString() === io.expectedChainId
    );
  };
  if (!(await rpcMatchesExpectedChain()))
    throw new Error(
      `RPC network must match configured chain ID ${io.expectedChainId}.`,
    );
  const prepared = await io.prepare();
  const plan = validatePreparation(
    prepared,
    io.signer,
    io.expectedChainId,
    io.slippageBps,
    io.trusted,
  );
  const snapshot = toJsonString(PrepareExecutionResponseSchema, prepared);
  const kind = plan.action;
  if (preview || io.reportPreparation)
    io.report({ preparation: JSON.parse(snapshot), sent: false });
  if (io.swapOnly && kind === ExecutionAction.Approval)
    throw new Error(
      "Approval is still required. Start a new trade; nothing retried.",
    );
  if (preview) {
    return { kind: ExecutionOutcome.Preview };
  }
  if (!(await io.confirm(kind, prepared, structuredClone(plan)))) {
    io.report({ sent: false, outcome: ExecutionOutcome.Canceled });
    return { kind: ExecutionOutcome.Canceled };
  }
  const checked = await io.prepare(prepared.preparationId);
  assertPreparationCurrent(checked);
  assertPreparationUnchanged(prepared, checked, snapshot);
  if (!(await rpcMatchesExpectedChain()))
    throw new Error("RPC network changed. Nothing sent.");
  assertPreparationUnchanged(prepared, checked, snapshot);
  assertPreparationCurrent(prepared);
  let hash: string;
  try {
    hash = (await io.send(plan.transaction)).trim();
    if (hash.length !== 66 || !isHash(hash))
      throw new Error("Invalid transaction hash.");
  } catch {
    io.report({
      transactionHash: null,
      submission: Submission.Unknown,
      verification: { outcome: VerificationOutcome.Unavailable },
      message:
        "Send attempt may have reached the network. Inspect wallet transactions; do not automatically resend.",
    });
    return { kind: ExecutionOutcome.Unknown, transactionHash: null };
  }
  io.report({
    transactionHash: hash,
    submission: Submission.Submitted,
    kind,
    verification: { outcome: VerificationOutcome.Pending },
  });
  try {
    const receipt = await io.receipt(hash);
    let verification: Verification;
    switch (plan.action) {
      case ExecutionAction.Swap:
        verification = {
          action: ExecutionAction.Swap,
          evidence: verifyReceipt(receipt, hash, plan.receipt),
        };
        break;
      case ExecutionAction.Approval:
        if (!same(receipt.transactionHash, hash))
          throw new Error("Receipt transaction hash mismatch.");
        verification = {
          action: ExecutionAction.Approval,
          evidence: {
            outcome:
              receipt.status === "0x1"
                ? VerificationOutcome.ReceiptSuccess
                : VerificationOutcome.Failed,
          },
        };
        break;
      default:
        return impossible(plan);
    }
    io.report({
      transactionHash: hash,
      verification: verification.evidence,
      ...(kind === ExecutionAction.Approval
        ? {
            nextAction:
              "Rerun quote, then execute with the new quote and selected route. Approval never executes the old quote.",
          }
        : {}),
    });
    return verifiedResult(verification, hash);
  } catch {
    io.report({
      transactionHash: hash,
      submission: Submission.PendingOrUnknown,
      verification: { outcome: VerificationOutcome.Unavailable },
      message: "Receipt unavailable. Do not resend automatically.",
    });
    return { kind: ExecutionOutcome.Unknown, transactionHash: hash };
  }
}
