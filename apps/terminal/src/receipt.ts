import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Hex,
  hexToBigInt,
  isAddress,
  isHex,
  toHex,
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
    branches: Array<{
      operations: Array<{
        kind: number;
        tokenIn: string;
        tokenOut: string;
      }>;
      amountInAtomic: string;
      minimumAtomic: string;
    }>;
  };
};

export type TransactionCallTrace = {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  input?: unknown;
  error?: unknown;
  calls?: unknown;
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
const nativeRefunded = encodeEventTopics({
  abi: executorV2Abi,
  eventName: "NativeRefunded",
})[0];
const planExecuted = encodeEventTopics({
  abi: executorV2Abi,
  eventName: "PlanExecuted",
})[0];
const nativeRefundTraceRequiredReason =
  "Atomic V1 native refund event is valid, but no transaction-specific native trace proves delivery.";

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
        | typeof VerificationOutcome.Unavailable
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
  trace?: TransactionCallTrace,
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
    let nativeRefundSeen = false;
    let nativeRefundAmount = 0n;
    if (obligations.atomicPlan) {
      const events = receipt.logs.filter(
        (log) =>
          same(log.address, obligations.atomicPlan?.executor ?? "") &&
          [
            operationExecuted,
            branchExecuted,
            nativeRefunded,
            planExecuted,
          ].some((topic) => same(log.topics[0] ?? "", topic)),
      );
      const expectedBranches = obligations.atomicPlan.branches;
      const allowsNativeRefund = expectedBranches.some((branch) =>
        branch.operations.some((operation) => operation.kind === 3),
      );
      const expectedEventCount = expectedBranches.reduce(
        (count, branch) => count + branch.operations.length + 1,
        1,
      );
      if (
        events.length !== expectedEventCount &&
        (!allowsNativeRefund || events.length !== expectedEventCount + 1)
      )
        atomicEventValid = false;
      else {
        let cursor = 0;
        let branchInputTotal = 0n;
        let branchOutputTotal = 0n;
        for (const [
          branchIndex,
          expectedBranch,
        ] of expectedBranches.entries()) {
          let previousOutput = 0n;
          for (const [
            operationIndex,
            expected,
          ] of expectedBranch.operations.entries()) {
            const event = events[cursor++];
            if (!same(event?.topics[0] ?? "", operationExecuted)) {
              atomicEventValid = false;
              break;
            }
            const operation = decodeEventLog({
              abi: executorV2Abi,
              eventName: "OperationExecuted",
              strict: true,
              topics: event.topics as [Hex, ...Hex[]],
              data: event.data as Hex,
            });
            const expectedInput =
              operationIndex === 0
                ? BigInt(expectedBranch.amountInAtomic)
                : previousOutput;
            atomicEventValid =
              atomicEventValid &&
              same(operation.args.planHash, obligations.atomicPlan.planHash) &&
              operation.args.branchIndex === BigInt(branchIndex) &&
              operation.args.operationIndex === BigInt(operationIndex) &&
              operation.args.kind === expected.kind &&
              same(operation.args.tokenIn, expected.tokenIn) &&
              same(operation.args.tokenOut, expected.tokenOut) &&
              operation.args.amountIn === expectedInput &&
              operation.args.amountOut > 0n;
            previousOutput = operation.args.amountOut;
          }
          if (!atomicEventValid) break;
          const event = events[cursor++];
          if (!same(event?.topics[0] ?? "", branchExecuted)) {
            atomicEventValid = false;
            break;
          }
          const branch = decodeEventLog({
            abi: executorV2Abi,
            eventName: "BranchExecuted",
            strict: true,
            topics: event.topics as [Hex, ...Hex[]],
            data: event.data as Hex,
          });
          atomicEventValid =
            atomicEventValid &&
            same(branch.args.planHash, obligations.atomicPlan.planHash) &&
            branch.args.branchIndex === BigInt(branchIndex) &&
            branch.args.amountIn === BigInt(expectedBranch.amountInAtomic) &&
            branch.args.amountOut === previousOutput &&
            branch.args.amountOut >= BigInt(expectedBranch.minimumAtomic);
          branchInputTotal += branch.args.amountIn;
          branchOutputTotal += branch.args.amountOut;
        }
        if (atomicEventValid) {
          if (
            allowsNativeRefund &&
            same(events[cursor]?.topics[0] ?? "", nativeRefunded)
          ) {
            const refund = decodeEventLog({
              abi: executorV2Abi,
              eventName: "NativeRefunded",
              strict: true,
              topics: events[cursor].topics as [Hex, ...Hex[]],
              data: events[cursor].data as Hex,
            });
            atomicEventValid =
              same(refund.args.planHash, obligations.atomicPlan.planHash) &&
              same(refund.args.caller, obligations.recipient) &&
              refund.args.amount > 0n;
            nativeRefundSeen = atomicEventValid;
            nativeRefundAmount = refund.args.amount;
            cursor++;
          }
          const planEvent = events[cursor];
          if (!same(planEvent?.topics[0] ?? "", planExecuted))
            atomicEventValid = false;
          else {
            const plan = decodeEventLog({
              abi: executorV2Abi,
              eventName: "PlanExecuted",
              strict: true,
              topics: planEvent.topics as [Hex, ...Hex[]],
              data: planEvent.data as Hex,
            });
            atomicEventValid =
              atomicEventValid &&
              branchInputTotal === BigInt(obligations.amountInAtomic) &&
              branchOutputTotal === output &&
              same(plan.args.planHash, obligations.atomicPlan.planHash) &&
              same(plan.args.caller, obligations.recipient) &&
              same(plan.args.tokenIn, obligations.tokenIn) &&
              same(plan.args.tokenOut, obligations.tokenOut) &&
              plan.args.amountIn === BigInt(obligations.amountInAtomic) &&
              plan.args.amountOut === branchOutputTotal;
          }
        }
      }
    }
    const tokenProofPassed =
      input === BigInt(obligations.amountInAtomic) &&
      output >= BigInt(obligations.amountOutMinimumAtomic) &&
      !residue &&
      atomicEventValid;
    const nativeRefundDelivered =
      nativeRefundSeen &&
      trace !== undefined &&
      validNativeRefundTrace(
        trace,
        obligations.recipient,
        obligations.atomicPlan?.executor ?? "",
        nativeRefundAmount,
      );
    return {
      outcome:
        tokenProofPassed && nativeRefundSeen
          ? nativeRefundDelivered
            ? VerificationOutcome.Passed
            : VerificationOutcome.Unavailable
          : tokenProofPassed
            ? VerificationOutcome.Passed
            : VerificationOutcome.Failed,
      inputSpentAtomic: input.toString(),
      outputReceivedAtomic: output.toString(),
      routerIntermediateDeltas: intermediate,
      ...(obligations.touched ? { touchedTokenOwnerDeltas: touched } : {}),
      reason:
        tokenProofPassed && nativeRefundSeen
          ? nativeRefundDelivered
            ? "Ordered Atomic V1 executor events, standard ERC20 Transfer net deltas, and exact transaction-specific native refund trace."
            : nativeRefundTraceRequiredReason
          : obligations.atomicPlan
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

export function requiresNativeRefundTrace(
  verification: SwapVerification,
): boolean {
  return (
    verification.outcome === VerificationOutcome.Unavailable &&
    verification.reason === nativeRefundTraceRequiredReason
  );
}

function validNativeRefundTrace(
  root: TransactionCallTrace,
  caller: string,
  executor: string,
  amount: bigint,
): boolean {
  if (
    !validCallFrame(root) ||
    root.type !== "CALL" ||
    !same(root.from, caller) ||
    !same(root.to, executor) ||
    root.value !== "0x0" ||
    root.error !== undefined
  )
    return false;
  const refunds: Array<{
    frame: TransactionCallTrace;
    ancestorsPassed: boolean;
  }> = [];
  const visit = (frame: TransactionCallTrace, ancestorsPassed: boolean) => {
    if (!validCallFrame(frame)) throw new Error("Malformed call trace.");
    const passed = ancestorsPassed && frame.error === undefined;
    if (
      frame !== root &&
      frame.type === "CALL" &&
      same(frame.from, executor) &&
      same(frame.to, caller) &&
      frame.input === "0x"
    )
      refunds.push({ frame, ancestorsPassed: passed });
    for (const child of frame.calls ?? []) visit(child, passed);
  };
  try {
    visit(root, true);
  } catch {
    return false;
  }
  return (
    refunds.length === 1 &&
    refunds[0].ancestorsPassed &&
    refunds[0].frame.value === toHex(amount)
  );
}

function validCallFrame(
  frame: TransactionCallTrace,
): frame is TransactionCallTrace & {
  type: string;
  from: string;
  to: string;
  value: Hex;
  input: Hex;
  calls?: TransactionCallTrace[];
} {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof frame.type !== "string" ||
    typeof frame.from !== "string" ||
    typeof frame.to !== "string" ||
    typeof frame.value !== "string" ||
    typeof frame.input !== "string" ||
    !isAddress(frame.from, { strict: false }) ||
    !isAddress(frame.to, { strict: false }) ||
    !isHex(frame.value, { strict: true }) ||
    !isHex(frame.input, { strict: true }) ||
    toHex(hexToBigInt(frame.value)) !== frame.value.toLowerCase() ||
    (frame.error !== undefined && typeof frame.error !== "string") ||
    (frame.calls !== undefined && !Array.isArray(frame.calls))
  )
    return false;
  return true;
}
