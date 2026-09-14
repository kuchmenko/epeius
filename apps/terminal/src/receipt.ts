import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Hex,
  isAddress,
} from "viem";
import { executorV2Abi } from "../../../generated/abi";

export const VerificationOutcome = {
  Pending: "pending",
  ReceiptSuccess: "receipt_success",
  Passed: "passed",
  Failed: "failed",
  Unavailable: "unavailable",
} as const;
export type VerificationOutcome =
  (typeof VerificationOutcome)[keyof typeof VerificationOutcome];

export type Receipt = {
  transactionHash: string;
  status: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    removed?: boolean;
  }>;
};

export type ReceiptObligations = {
  tokenIn: string;
  tokenOut: string;
  recipient: string;
  amountInAtomic: string;
  amountOutMinimumAtomic: string;
  intermediate: Array<{ token: string; owner: string }>;
  touched?: Array<{ token: string; owner: string }>;
  atomicPlan?: {
    executor: string;
    planHash: string;
    planId: string;
    transactionFingerprint: string;
    operation: {
      kind: number;
      tokenIn: string;
      tokenOut: string;
      amountInAtomic: string;
      branchMinimumAtomic: string;
    };
  };
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const transfer = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0];
const operationExecuted = encodeEventTopics({
  abi: executorV2Abi,
  eventName: "OperationExecuted",
})[0];
const branchExecuted = encodeEventTopics({
  abi: executorV2Abi,
  eventName: "BranchExecuted",
})[0];
const planExecuted = encodeEventTopics({
  abi: executorV2Abi,
  eventName: "PlanExecuted",
})[0];

export type SwapVerification =
  | {
      outcome:
        | typeof VerificationOutcome.Unavailable
        | typeof VerificationOutcome.Failed;
      reason: string;
    }
  | {
      outcome:
        | typeof VerificationOutcome.Passed
        | typeof VerificationOutcome.Failed;
      inputSpentAtomic: string;
      outputReceivedAtomic: string;
      routerIntermediateDeltas: Record<string, string>;
      touchedTokenOwnerDeltas?: Record<string, string>;
      reason: string;
    };

export function verifyReceipt(
  receipt: Receipt,
  hash: string,
  obligations: ReceiptObligations,
): SwapVerification {
  if (!same(receipt.transactionHash, hash))
    return {
      outcome: VerificationOutcome.Unavailable,
      reason: "Receipt transaction hash mismatch.",
    };
  if (receipt.status !== "0x1")
    return {
      outcome: VerificationOutcome.Failed,
      reason: "Transaction reverted or receipt status is not successful.",
    };
  try {
    const deltas = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (!same(log.transactionHash, hash) || log.removed)
        throw new Error("Invalid receipt log identity.");
      if (!same(log.topics[0] ?? "", transfer)) continue;
      if (!isAddress(log.address, { strict: false }))
        throw new Error("Nonstandard Transfer log.");
      const { args } = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        strict: true,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      const topics = encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: args.from, to: args.to },
      });
      const data = encodeAbiParameters([{ type: "uint256" }], [args.value]);
      if (
        topics.length !== log.topics.length ||
        topics.some((topic, i) => !same(String(topic), log.topics[i])) ||
        !same(data, log.data)
      )
        throw new Error("Nonstandard Transfer log.");
      for (const [owner, sign] of [
        [args.from, -1n],
        [args.to, 1n],
      ] as const) {
        const key = `${log.address.toLowerCase()}:${owner.toLowerCase()}`;
        deltas.set(key, (deltas.get(key) ?? 0n) + sign * args.value);
      }
    }
    const delta = (token: string, owner: string) =>
      deltas.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? 0n;
    const input = -delta(obligations.tokenIn, obligations.recipient);
    const output = delta(obligations.tokenOut, obligations.recipient);
    const intermediate = Object.fromEntries(
      obligations.intermediate.map(({ token, owner }) => [
        token,
        delta(token, owner).toString(),
      ]),
    );
    const touched = Object.fromEntries(
      (obligations.touched ?? []).map(({ token, owner }) => [
        `${token}:${owner}`,
        delta(token, owner).toString(),
      ]),
    );
    const residue = [
      ...obligations.intermediate,
      ...(obligations.touched ?? []),
    ].some(({ token, owner }) => delta(token, owner) !== 0n);
    let atomicEventValid = true;
    if (obligations.atomicPlan) {
      const events = receipt.logs.filter(
        (log) =>
          same(log.address, obligations.atomicPlan?.executor ?? "") &&
          [operationExecuted, branchExecuted, planExecuted].some((topic) =>
            same(log.topics[0] ?? "", topic),
          ),
      );
      if (
        events.length !== 3 ||
        !same(events[0].topics[0] ?? "", operationExecuted) ||
        !same(events[1].topics[0] ?? "", branchExecuted) ||
        !same(events[2].topics[0] ?? "", planExecuted)
      )
        atomicEventValid = false;
      else {
        const operation = decodeEventLog({
          abi: executorV2Abi,
          eventName: "OperationExecuted",
          strict: true,
          topics: events[0].topics as [Hex, ...Hex[]],
          data: events[0].data as Hex,
        });
        const branch = decodeEventLog({
          abi: executorV2Abi,
          eventName: "BranchExecuted",
          strict: true,
          topics: events[1].topics as [Hex, ...Hex[]],
          data: events[1].data as Hex,
        });
        const plan = decodeEventLog({
          abi: executorV2Abi,
          eventName: "PlanExecuted",
          strict: true,
          topics: events[2].topics as [Hex, ...Hex[]],
          data: events[2].data as Hex,
        });
        const expected = obligations.atomicPlan.operation;
        atomicEventValid =
          same(operation.args.planHash, obligations.atomicPlan.planHash) &&
          operation.args.branchIndex === 0n &&
          operation.args.operationIndex === 0n &&
          operation.args.kind === expected.kind &&
          same(operation.args.tokenIn, expected.tokenIn) &&
          same(operation.args.tokenOut, expected.tokenOut) &&
          operation.args.amountIn === BigInt(expected.amountInAtomic) &&
          operation.args.amountOut === output &&
          same(branch.args.planHash, obligations.atomicPlan.planHash) &&
          branch.args.branchIndex === 0n &&
          branch.args.amountIn === BigInt(expected.amountInAtomic) &&
          branch.args.amountOut === output &&
          branch.args.amountOut >= BigInt(expected.branchMinimumAtomic) &&
          same(plan.args.planHash, obligations.atomicPlan.planHash) &&
          same(plan.args.caller, obligations.recipient) &&
          same(plan.args.tokenIn, obligations.tokenIn) &&
          same(plan.args.tokenOut, obligations.tokenOut) &&
          plan.args.amountIn === BigInt(obligations.amountInAtomic) &&
          plan.args.amountOut === output;
      }
    }
    return {
      outcome:
        input === BigInt(obligations.amountInAtomic) &&
        output >= BigInt(obligations.amountOutMinimumAtomic) &&
        !residue &&
        atomicEventValid
          ? VerificationOutcome.Passed
          : VerificationOutcome.Failed,
      inputSpentAtomic: input.toString(),
      outputReceivedAtomic: output.toString(),
      routerIntermediateDeltas: intermediate,
      ...(obligations.touched ? { touchedTokenOwnerDeltas: touched } : {}),
      reason: obligations.atomicPlan
        ? "Ordered Atomic V1 executor events and standard ERC20 Transfer net deltas; no pre-existing balances counted."
        : "Exact-transaction standard ERC20 Transfer net deltas; no pre-existing balances counted.",
    };
  } catch {
    return {
      outcome: VerificationOutcome.Unavailable,
      reason: "Receipt cannot establish standard ERC20 transfer invariants.",
    };
  }
}
