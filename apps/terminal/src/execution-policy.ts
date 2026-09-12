import { toJsonString } from "@bufbuild/protobuf";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isHex,
  maxUint256,
  size,
} from "viem";
import { permit2Abi } from "../../../generated/abi";
import {
  PreparationStatus,
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
  type UnsignedTransaction,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type { ReceiptObligations } from "./receipt";

export const ExecutionAction = {
  Approval: "approval",
  Swap: "swap",
} as const;
const permit2PermissionLifetime = 30n * 60n;
export type ExecutionAction =
  (typeof ExecutionAction)[keyof typeof ExecutionAction];

export type SwapTerms = {
  target: string;
  spender: string;
  data: string;
  quotedOutput: string;
  routeDetails: string[][];
  receipt: Pick<ReceiptObligations, "intermediate" | "touched">;
  permission?: { target: string; spender: string };
};

export type ExecutionImplementation = {
  plan: (prepared: PrepareExecutionResponse, tokens: string[]) => SwapTerms;
};

export type TrustedExecution = {
  tokens: string[];
  deployments: Record<string, ExecutionImplementation>;
  executor?: ExecutionImplementation;
};

export type ExecutionPlan = {
  transaction: UnsignedTransaction;
  spender: string;
  routeDetails: string[][];
} & (
  | { action: typeof ExecutionAction.Approval }
  | { action: typeof ExecutionAction.Swap; receipt: ReceiptObligations }
);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const uint256Decimal = (value: string, label: string) => {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must fit uint256.`);
  const parsed = BigInt(value);
  if (parsed > maxUint256) throw new Error(`${label} must fit uint256.`);
  return parsed;
};

export function assertPreparationUnchanged(
  prepared: PrepareExecutionResponse,
  checked: PrepareExecutionResponse,
  snapshot: string,
) {
  // A newer simulation block, estimate and message do not change executable terms.
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
}

export function assertPreparationCurrent(
  p: PrepareExecutionResponse,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    ![PreparationStatus.READY, PreparationStatus.APPROVAL_REQUIRED].includes(
      p.status,
    )
  )
    throw new Error(
      `Preparation rejected, expired, or requires a fresh quote. Rerun quote.${p.message ? ` Engine reason: ${JSON.stringify(p.message).replace(/[\p{Cc}\p{Cf}]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}` : ""}`,
    );
  const deadline = uint256Decimal(p.deadlineUnix, "Deadline");
  if (
    !/^[0-9]+$/.test(p.expiresAtUnix) ||
    BigInt(p.expiresAtUnix) <= BigInt(now) ||
    deadline <= BigInt(now)
  )
    throw new Error("Preparation expired. Rerun quote.");
}

export function validatePreparation(
  p: PrepareExecutionResponse,
  signer: string,
  expectedChainId: string,
  slippageBps: number,
  trusted: TrustedExecution,
  now = Math.floor(Date.now() / 1000),
): ExecutionPlan {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9999)
    throw new Error("Requested slippage must be 0 through 9999 bps.");
  assertPreparationCurrent(p, now);
  const approval = p.status === PreparationStatus.APPROVAL_REQUIRED;
  const permission = p.onChainPermission;
  const tx = approval
    ? (permission?.transaction ?? p.approvalTransaction)
    : p.transaction;
  if (
    !tx ||
    !p.preparationId ||
    !isAddress(signer, { strict: false }) ||
    !same(p.recipient, signer) ||
    !same(tx.from, signer)
  )
    throw new Error("Signer, transaction sender, and recipient must match.");
  if (tx.chainId !== expectedChainId)
    throw new Error(
      `Prepared transaction chain ID must match configured chain ID ${expectedChainId}.`,
    );
  if (
    !isAddress(tx.to, { strict: false }) ||
    !isHex(tx.data, { strict: true }) ||
    tx.data.length % 2 !== 0 ||
    size(tx.data) === 0 ||
    tx.valueAtomic !== "0" ||
    !/^[1-9][0-9]*$/.test(tx.gasLimit)
  )
    throw new Error("Invalid ERC20 transaction terms.");
  const amountIn = uint256Decimal(p.amountInAtomic, "Input amount");
  const minimum = uint256Decimal(
    p.amountOutMinimumAtomic,
    "Minimum output amount",
  );
  if (
    !isAddress(p.tokenIn, { strict: false }) ||
    !isAddress(p.tokenOut, { strict: false }) ||
    same(p.tokenIn, p.tokenOut) ||
    !/^[1-9][0-9]*$/.test(p.amountInAtomic) ||
    !/^[1-9][0-9]*$/.test(p.amountOutMinimumAtomic) ||
    ![p.tokenIn, p.tokenOut].every((token) =>
      trusted.tokens.some((configured) => same(token, configured)),
    )
  )
    throw new Error("Invalid swap amount or token terms.");
  const allocated = p.allocations.length > 0;
  if (allocated === !!p.route || p.allocations.length > 2)
    throw new Error("Provide either a direct route or executor allocations.");
  const implementation = p.route
    ? trusted.deployments[p.route.deploymentId]
    : trusted.executor;
  if (!implementation)
    throw new Error(
      "Route is not allowed by local token and deployment config.",
    );
  const terms = implementation.plan(p, trusted.tokens);
  if (!approval && permission)
    throw new Error(
      "READY preparation must not contain an approval permission.",
    );
  const quoted = uint256Decimal(terms.quotedOutput, "Aggregate output");
  if (quoted <= 0n) throw new Error("Route quoted output must be positive.");
  if (minimum !== (quoted * BigInt(10000 - slippageBps)) / 10000n)
    throw new Error(
      "Prepared slippage minimum does not match saved route quote.",
    );
  if (approval) {
    if (permission) {
      const expiration = uint256Decimal(
        permission.expirationUnix,
        "Permission expiration",
      );
      const deadline = uint256Decimal(p.deadlineUnix, "Deadline");
      const expected = encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [
          p.tokenIn as Address,
          terms.target as Address,
          amountIn,
          Number(expiration),
        ],
      });
      if (
        p.approvalTransaction ||
        p.approvalSpender ||
        !terms.permission ||
        !same(terms.permission.target, terms.spender) ||
        !same(terms.permission.spender, terms.target) ||
        !same(permission.target, terms.permission.target) ||
        !same(permission.token, p.tokenIn) ||
        !same(permission.spender, terms.permission.spender) ||
        permission.amountAtomic !== p.amountInAtomic ||
        expiration !== deadline + permit2PermissionLifetime ||
        expiration >= 1n << 48n ||
        !same(tx.to, permission.target) ||
        !same(tx.data, expected) ||
        p.transaction
      )
        throw new Error(
          "Permit2 permission must authorize only the displayed token, amount, spender, and expiration.",
        );
      return {
        action: ExecutionAction.Approval,
        transaction: tx,
        spender: permission.target,
        routeDetails: terms.routeDetails,
      };
    }
    const expected = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [terms.spender as Address, amountIn],
    });
    if (
      p.onChainPermission ||
      !isAddress(p.approvalSpender, { strict: false }) ||
      !same(p.approvalSpender, terms.spender) ||
      !same(tx.to, p.tokenIn) ||
      !same(tx.data, expected) ||
      p.transaction
    )
      throw new Error(
        "Approval must authorize only the displayed input amount and spender.",
      );
    return {
      action: ExecutionAction.Approval,
      transaction: tx,
      spender: terms.spender,
      routeDetails: terms.routeDetails,
    };
  }
  if (!same(tx.to, terms.target) || !same(tx.data, terms.data))
    throw new Error("Swap transaction does not match locally encoded route.");
  return {
    action: ExecutionAction.Swap,
    transaction: tx,
    spender: terms.spender,
    routeDetails: terms.routeDetails,
    receipt: {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      recipient: p.recipient,
      amountInAtomic: p.amountInAtomic,
      amountOutMinimumAtomic: p.amountOutMinimumAtomic,
      ...terms.receipt,
    },
  };
}
