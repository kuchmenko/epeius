import { toJsonString } from "@bufbuild/protobuf";
import {
  PreparationStatus,
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
  type UnsignedTransaction,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  type Receipt,
  type TrustedExecution,
  validatePreparation,
  verifyReceipt,
} from "./execution-policy";

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type ExecutionIO = {
  signer: string;
  expectedChainId: string;
  slippageBps: number;
  trusted: TrustedExecution;
  chainId: () => Promise<string>;
  prepare: (preparationId?: string) => Promise<PrepareExecutionResponse>;
  confirm: (
    kind: "approval" | "swap",
    p: PrepareExecutionResponse,
  ) => Promise<boolean>;
  send: (tx: UnsignedTransaction) => Promise<string>;
  receipt: (hash: string) => Promise<Receipt>;
  report: (result: unknown) => void;
  reportPreparation?: boolean;
  swapOnly?: boolean;
  onApprovalVerified?: () => void;
};

export async function executePrepared(io: ExecutionIO, preview = false) {
  const rpcMatchesExpectedChain = async () => {
    const chainId = await io.chainId();
    return (
      /^0x[0-9a-f]+$/.test(chainId) &&
      BigInt(chainId).toString() === io.expectedChainId
    );
  };
  if (!(await rpcMatchesExpectedChain()))
    throw new Error(
      `RPC network must match configured chain ID ${io.expectedChainId}.`,
    );
  const prepared = await io.prepare();
  const tx = validatePreparation(
    prepared,
    io.signer,
    io.expectedChainId,
    io.slippageBps,
    io.trusted,
  );
  const snapshot = toJsonString(PrepareExecutionResponseSchema, prepared);
  const kind =
    prepared.status === PreparationStatus.APPROVAL_REQUIRED
      ? "approval"
      : "swap";
  if (preview || io.reportPreparation)
    io.report({ preparation: JSON.parse(snapshot), sent: false });
  if (io.swapOnly && kind === "approval")
    throw new Error(
      "Approval is still required. Start a new trade; nothing retried.",
    );
  if (preview) {
    return 0;
  }
  if (!(await io.confirm(kind, prepared))) {
    io.report({ sent: false, outcome: "canceled" });
    return 1;
  }
  const checked = await io.prepare(prepared.preparationId);
  validatePreparation(
    checked,
    io.signer,
    io.expectedChainId,
    io.slippageBps,
    io.trusted,
  );
  // Compare all executable terms, including route, minimum, deadline and approval.
  // A newer simulation block and output estimate do not change signed terms.
  const immutable = (p: PrepareExecutionResponse) =>
    toJsonString(PrepareExecutionResponseSchema, {
      ...p,
      simulationBlock: undefined,
      simulatedAmountOutAtomic: "",
      message: "",
    });
  if (
    immutable(checked) !== immutable(prepared) ||
    snapshot !== toJsonString(PrepareExecutionResponseSchema, prepared)
  )
    throw new Error(
      "Preparation changed after confirmation. Nothing sent; rerun quote.",
    );
  if (!(await rpcMatchesExpectedChain()))
    throw new Error("RPC network changed. Nothing sent.");
  validatePreparation(
    prepared,
    io.signer,
    io.expectedChainId,
    io.slippageBps,
    io.trusted,
  );
  let hash: string;
  try {
    hash = (await io.send(tx)).trim();
    if (!hashPattern.test(hash)) throw new Error("Invalid transaction hash.");
  } catch {
    io.report({
      transactionHash: null,
      submission: "unknown",
      verification: { outcome: "unavailable" },
      message:
        "Send attempt may have reached the network. Inspect wallet transactions; do not automatically resend.",
    });
    return 1;
  }
  io.report({
    transactionHash: hash,
    submission: "submitted",
    kind,
    verification: { outcome: "pending" },
  });
  try {
    const receipt = await io.receipt(hash);
    const verification =
      kind === "swap"
        ? verifyReceipt(receipt, hash, prepared, io.trusted)
        : {
            outcome:
              same(receipt.transactionHash, hash) && receipt.status === "0x1"
                ? "receipt_success"
                : "failed",
          };
    io.report({
      transactionHash: hash,
      verification,
      ...(kind === "approval"
        ? {
            nextAction:
              "Rerun quote, then execute with the new quote and selected route. Approval never executes the old quote.",
          }
        : {}),
    });
    if (kind === "approval" && verification.outcome === "receipt_success")
      io.onApprovalVerified?.();
    return verification.outcome === "passed" ||
      verification.outcome === "receipt_success"
      ? 0
      : 1;
  } catch {
    io.report({
      transactionHash: hash,
      submission: "pending_or_unknown",
      verification: { outcome: "unavailable" },
      message: "Receipt unavailable. Do not resend automatically.",
    });
    return 1;
  }
}
