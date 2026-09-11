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
  type ExecutionPlan,
  type TrustedExecution,
  validatePreparation,
} from "./execution-policy";
import { type Receipt, type SwapVerification, verifyReceipt } from "./receipt";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type ExecutionAction = ExecutionPlan["action"];
export type Verification =
  | {
      action: "approval";
      evidence: { outcome: "receipt_success" | "failed" | "unavailable" };
    }
  | { action: "swap"; evidence: SwapVerification };
export type VerificationOutcome =
  | Verification["evidence"]["outcome"]
  | "pending";

export type ExecutionResult =
  | { kind: "preview" | "canceled" }
  | {
      kind: "approval-confirmed" | "swap-verified" | "failed";
      transactionHash: string;
    }
  | { kind: "unknown"; transactionHash: string | null };
export type ExecutionOutcome = ExecutionResult["kind"];

// Existing JSONL payloads; the internal result discriminator is not serialized.
export type ExecutionEvent =
  | { preparation: JsonValue; sent: false }
  | { sent: false; outcome: "canceled" }
  | {
      transactionHash: string;
      submission: "submitted";
      kind: ExecutionAction;
      verification: { outcome: Extract<VerificationOutcome, "pending"> };
    }
  | {
      transactionHash: string;
      verification: Verification["evidence"];
      nextAction?: string;
    }
  | {
      transactionHash: null;
      submission: "unknown";
      verification: { outcome: "unavailable" };
      message: string;
    }
  | {
      transactionHash: string;
      submission: "pending_or_unknown";
      verification: { outcome: "unavailable" };
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
    case "approval": {
      const outcome = verification.evidence.outcome;
      switch (outcome) {
        case "receipt_success":
          return { kind: "approval-confirmed", transactionHash };
        case "failed":
          return { kind: "failed", transactionHash };
        case "unavailable":
          return { kind: "unknown", transactionHash };
        default:
          return impossible(outcome);
      }
    }
    case "swap": {
      const outcome = verification.evidence.outcome;
      switch (outcome) {
        case "passed":
          return { kind: "swap-verified", transactionHash };
        case "failed":
          return { kind: "failed", transactionHash };
        case "unavailable":
          return { kind: "unknown", transactionHash };
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
  if (io.swapOnly && kind === "approval")
    throw new Error(
      "Approval is still required. Start a new trade; nothing retried.",
    );
  if (preview) {
    return { kind: "preview" };
  }
  if (!(await io.confirm(kind, prepared, structuredClone(plan)))) {
    io.report({ sent: false, outcome: "canceled" });
    return { kind: "canceled" };
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
      submission: "unknown",
      verification: { outcome: "unavailable" },
      message:
        "Send attempt may have reached the network. Inspect wallet transactions; do not automatically resend.",
    });
    return { kind: "unknown", transactionHash: null };
  }
  io.report({
    transactionHash: hash,
    submission: "submitted",
    kind,
    verification: { outcome: "pending" },
  });
  try {
    const receipt = await io.receipt(hash);
    let verification: Verification;
    switch (plan.action) {
      case "swap":
        verification = {
          action: "swap",
          evidence: verifyReceipt(receipt, hash, plan.receipt),
        };
        break;
      case "approval":
        if (!same(receipt.transactionHash, hash))
          throw new Error("Receipt transaction hash mismatch.");
        verification = {
          action: "approval",
          evidence: {
            outcome: receipt.status === "0x1" ? "receipt_success" : "failed",
          },
        };
        break;
      default:
        return impossible(plan);
    }
    io.report({
      transactionHash: hash,
      verification: verification.evidence,
      ...(kind === "approval"
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
      submission: "pending_or_unknown",
      verification: { outcome: "unavailable" },
      message: "Receipt unavailable. Do not resend automatically.",
    });
    return { kind: "unknown", transactionHash: hash };
  }
}
