import { isAddress, isHash, isHex, toHex, zeroHash } from "viem";
import type { SignedAtomicEnvelope } from "./atomic-signed-envelope";
import { admitRpcAtomicTransaction } from "./atomic-signed-envelope";
import type { ReturnTypeOfReadChain } from "./chain";
import {
  type AtomicFinalityPolicy,
  FINALITY_VERIFIER_VERSION,
} from "./finality-policy";
import {
  type Receipt,
  type ReceiptObligations,
  requiresNativeRefundTrace,
  type SwapVerification,
  VerificationOutcome,
  verifyReceipt,
} from "./receipt";

type FinalityChain = Pick<
  ReturnTypeOfReadChain,
  | "chainId"
  | "receiptByHash"
  | "transactionByHash"
  | "blockByNumber"
  | "blockByHash"
  | "traceCanonicalTransaction"
>;

export type FinalityBlockEvidence = {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
};

export type FinalityReceiptEvidence = {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  transactionIndex: string;
  status: "0" | "1";
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: string;
    blockHash: string;
    transactionIndex: string;
    logIndex: string;
    removed: false;
  }>;
};

export type AtomicProvisionalEvidence = {
  verifierVersion: typeof FINALITY_VERIFIER_VERSION;
  observedAt: string;
  canonicalInclusion: "observed";
  execution: "success" | "reverted";
  economics: "passed" | "failed" | "unavailable";
  receipt: FinalityReceiptEvidence;
  canonicalBlock: FinalityBlockEvidence;
  verification: SwapVerification;
};

export type AtomicFinalityEvidence = {
  verifierVersion: typeof FINALITY_VERIFIER_VERSION;
  policyVersion: AtomicFinalityPolicy["policyVersion"];
  configDigest: string;
  chainId: string;
  parentChainId?: string;
  networkAnchorNumber: string;
  networkAnchorHash: string;
  finalityMethod: AtomicFinalityPolicy["finalityMethod"];
  safeSignal: AtomicFinalityPolicy["safeSignal"];
  rpcSourceId: string;
  capabilityRecord: string;
  capabilityValidUntil: string;
  transactionHash: string;
  receipt: FinalityReceiptEvidence;
  canonicalBlock: FinalityBlockEvidence;
  finalizedHead: FinalityBlockEvidence;
  safeHead?: FinalityBlockEvidence;
  latestHead: FinalityBlockEvidence;
  repeatedFinalizedHead: FinalityBlockEvidence;
  observedAt: string;
  completedAt: string;
};

export type AtomicFinalityResult =
  | {
      kind: "complete" | "failed_final";
      provisional: AtomicProvisionalEvidence;
      finality: AtomicFinalityEvidence;
    }
  | {
      kind: "unknown" | "persistence_failed";
      reason: string;
      provisional?: AtomicProvisionalEvidence;
      finality?: AtomicFinalityEvidence;
    };

type Clock = {
  wallNow: () => number;
  monotonicNow: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type AtomicFinalityIO = {
  policy: AtomicFinalityPolicy;
  hash: string;
  signedEnvelope: SignedAtomicEnvelope;
  obligations: ReceiptObligations;
  chain: FinalityChain;
  signal: AbortSignal;
  recordObserved: (evidence: AtomicProvisionalEvidence) => Promise<void>;
  recordFinal: (
    state: "complete" | "failed_final",
    provisional: AtomicProvisionalEvidence,
    finality: AtomicFinalityEvidence,
  ) => Promise<void>;
  recordUnknown: (
    reason: string,
    provisional?: AtomicProvisionalEvidence,
  ) => Promise<void>;
  report: (event: unknown) => void;
  clock?: Clock;
};

class InconsistentEvidence extends Error {}

export async function preflightAtomicFinality(
  policy: AtomicFinalityPolicy,
  chain: FinalityChain,
  signal: AbortSignal,
  now = Date.now(),
) {
  signal.throwIfAborted();
  if (Date.parse(policy.capabilityValidUntil) <= now)
    throw new Error("Atomic finality capability record is expired.");
  const chainId = await chain.chainId();
  if (
    !isHex(chainId, { strict: true }) ||
    BigInt(chainId).toString() !== policy.chainId
  )
    throw new Error("Atomic finality RPC chain identity is invalid.");
  const anchor = admitBlock(
    await chain.blockByNumber(toHex(BigInt(policy.networkAnchorNumber))),
    policy.networkAnchorNumber,
    policy.networkAnchorHash,
  );
  const finalized = admitBlock(await chain.blockByNumber("finalized"));
  const safe = await optionalSafe(policy, chain);
  const latest = admitBlock(await chain.blockByNumber("latest"));
  assertHeadOrder(finalized, safe, latest);
  return { anchor, finalized, ...(safe ? { safe } : {}), latest };
}

export async function finalizeAtomicSwap(
  io: AtomicFinalityIO,
): Promise<AtomicFinalityResult> {
  const clock: Clock = io.clock ?? {
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
    sleep: Bun.sleep,
  };
  const started = clock.monotonicNow();
  let raceRetried = false;
  let lastProvisional = "";
  let provisional: AtomicProvisionalEvidence | undefined;
  let stalledFinalized: string | undefined;
  let stalledLatest = -1n;
  let stalledSince: number | undefined;

  while (clock.monotonicNow() - started < io.policy.waitTimeoutMs) {
    if (io.signal.aborted) return unknown(io, "canceled", provisional);
    if (Date.parse(io.policy.capabilityValidUntil) <= clock.wallNow())
      return unknown(io, "capability_expired", provisional);
    try {
      const cycle = await observationCycle(io, clock);
      if (!cycle) {
        await clock.sleep(io.policy.pollIntervalMs);
        continue;
      }
      provisional = cycle.provisional;
      const serialized = JSON.stringify({ ...provisional, observedAt: "" });
      if (serialized !== lastProvisional) {
        try {
          await io.recordObserved(provisional);
        } catch {
          io.report(finalityEvent("persistence_failed", io, provisional));
          return {
            kind: "persistence_failed",
            reason: "provisional_record_not_saved",
            provisional,
          };
        }
        lastProvisional = serialized;
        io.report(finalityEvent("observed", io, provisional));
      }
      if (cycle.finality) {
        const state =
          provisional.execution === "success" &&
          provisional.economics === "passed"
            ? "complete"
            : provisional.execution === "reverted" ||
                provisional.economics === "failed"
              ? "failed_final"
              : undefined;
        if (!state)
          return unknown(io, "economic_evidence_unavailable", provisional);
        try {
          await io.recordFinal(state, provisional, cycle.finality);
        } catch {
          io.report(
            finalityEvent(
              "finalized_verified_not_recorded",
              io,
              provisional,
              cycle.finality,
            ),
          );
          return {
            kind: "persistence_failed",
            reason: "finality_record_not_saved",
            provisional,
            finality: cycle.finality,
          };
        }
        io.report(finalityEvent(state, io, provisional, cycle.finality));
        return { kind: state, provisional, finality: cycle.finality };
      }

      const key = `${cycle.finalized.number}:${cycle.finalized.hash}`;
      const latest = BigInt(cycle.latest.number);
      if (key !== stalledFinalized) {
        stalledFinalized = key;
        stalledLatest = latest;
        stalledSince = undefined;
      } else if (latest > stalledLatest) {
        stalledLatest = latest;
        stalledSince ??= clock.monotonicNow();
        if (clock.monotonicNow() - stalledSince >= io.policy.stalledAfterMs)
          return unknown(io, "finality_stalled", provisional);
      }
      await clock.sleep(io.policy.pollIntervalMs);
    } catch (error) {
      if (error instanceof InconsistentEvidence && !raceRetried) {
        raceRetried = true;
        continue;
      }
      return unknown(
        io,
        error instanceof InconsistentEvidence
          ? "evidence_inconsistent"
          : io.signal.aborted
            ? "canceled"
            : "finality_unavailable",
        provisional,
      );
    }
  }
  return unknown(io, "wait_timeout", provisional);
}

async function observationCycle(io: AtomicFinalityIO, clock: Clock) {
  const cycleStarted = clock.monotonicNow();
  const observedAt = new Date(clock.wallNow()).toISOString();
  const rawReceipt = await io.chain.receiptByHash(io.hash);
  if (rawReceipt === null) return undefined;
  const receipt = admitReceipt(rawReceipt, io.hash);
  const canonicalBlock = admitBlock(
    await io.chain.blockByNumber(toHex(BigInt(receipt.blockNumber))),
    receipt.blockNumber,
    receipt.blockHash,
  );
  const transactionIndex = Number(BigInt(receipt.transactionIndex));
  if (
    !Number.isSafeInteger(transactionIndex) ||
    canonicalBlock.transactions[transactionIndex]?.toLowerCase() !==
      io.hash.toLowerCase()
  )
    throw new InconsistentEvidence("Receipt transaction membership changed.");
  admitRpcAtomicTransaction(
    await io.chain.transactionByHash(io.hash),
    io.signedEnvelope,
  );
  const receiptForEconomics = receiptAsReceipt(receipt);
  let verification = verifyReceipt(
    receiptForEconomics,
    io.hash,
    io.obligations,
  );
  if (requiresNativeRefundTrace(verification)) {
    try {
      verification = verifyReceipt(
        receiptForEconomics,
        io.hash,
        io.obligations,
        await io.chain.traceCanonicalTransaction(io.hash, receiptForEconomics),
      );
    } catch {
      // Canonical receipt remains observed; native delivery stays unavailable.
    }
  }
  const provisional: AtomicProvisionalEvidence = {
    verifierVersion: FINALITY_VERIFIER_VERSION,
    observedAt,
    canonicalInclusion: "observed",
    execution: receipt.status === "1" ? "success" : "reverted",
    economics:
      receipt.status === "0" ||
      verification.outcome === VerificationOutcome.Unavailable
        ? "unavailable"
        : verification.outcome === VerificationOutcome.Passed
          ? "passed"
          : "failed",
    receipt,
    canonicalBlock: withoutTransactions(canonicalBlock),
    verification,
  };

  const finalized = admitBlock(await io.chain.blockByNumber("finalized"));
  const safe = await optionalSafe(io.policy, io.chain);
  const latest = admitBlock(await io.chain.blockByNumber("latest"));
  assertHeadOrder(finalized, safe, latest);
  if (BigInt(receipt.blockNumber) > BigInt(finalized.number))
    return { provisional, finalized, latest };

  const blockAgain = admitBlock(
    await io.chain.blockByNumber(toHex(BigInt(receipt.blockNumber))),
    receipt.blockNumber,
    receipt.blockHash,
  );
  const finalizedByNumber = admitBlock(
    await io.chain.blockByNumber(toHex(BigInt(finalized.number))),
    finalized.number,
    finalized.hash,
  );
  admitBlock(
    await io.chain.blockByHash(finalized.hash),
    finalized.number,
    finalized.hash,
  );
  const repeatedReceipt = admitReceipt(
    await io.chain.receiptByHash(io.hash),
    io.hash,
  );
  if (
    JSON.stringify(receipt) !== JSON.stringify(repeatedReceipt) ||
    JSON.stringify(canonicalBlock) !== JSON.stringify(blockAgain)
  )
    throw new InconsistentEvidence("Receipt or canonical block changed.");
  const repeatedFinalized = admitBlock(
    await io.chain.blockByNumber("finalized"),
  );
  if (
    BigInt(repeatedFinalized.number) < BigInt(finalized.number) ||
    JSON.stringify(finalizedByNumber) !==
      JSON.stringify(
        admitBlock(
          await io.chain.blockByNumber(toHex(BigInt(finalized.number))),
          finalized.number,
          finalized.hash,
        ),
      )
  )
    throw new InconsistentEvidence("Finalized mapping changed.");
  admitBlock(
    await io.chain.blockByNumber(toHex(BigInt(repeatedFinalized.number))),
    repeatedFinalized.number,
    repeatedFinalized.hash,
  );
  admitBlock(
    await io.chain.blockByHash(repeatedFinalized.hash),
    repeatedFinalized.number,
    repeatedFinalized.hash,
  );
  const finalBlock = admitBlock(
    await io.chain.blockByNumber(toHex(BigInt(receipt.blockNumber))),
    receipt.blockNumber,
    receipt.blockHash,
  );
  if (JSON.stringify(canonicalBlock) !== JSON.stringify(finalBlock))
    throw new InconsistentEvidence("Receipt block changed before completion.");
  if (clock.monotonicNow() - cycleStarted > io.policy.maxResponseAgeMs)
    throw new InconsistentEvidence("Finality observation became stale.");

  const completedAt = new Date(clock.wallNow()).toISOString();
  const finality: AtomicFinalityEvidence = {
    verifierVersion: FINALITY_VERIFIER_VERSION,
    policyVersion: io.policy.policyVersion,
    configDigest: io.policy.configDigest,
    chainId: io.policy.chainId,
    ...(io.policy.parentChainId
      ? { parentChainId: io.policy.parentChainId }
      : {}),
    networkAnchorNumber: io.policy.networkAnchorNumber,
    networkAnchorHash: io.policy.networkAnchorHash,
    finalityMethod: io.policy.finalityMethod,
    safeSignal: io.policy.safeSignal,
    rpcSourceId: io.policy.rpcSourceId,
    capabilityRecord: io.policy.capabilityRecord,
    capabilityValidUntil: io.policy.capabilityValidUntil,
    transactionHash: io.hash,
    receipt,
    canonicalBlock: withoutTransactions(canonicalBlock),
    finalizedHead: withoutTransactions(finalized),
    ...(safe ? { safeHead: withoutTransactions(safe) } : {}),
    latestHead: withoutTransactions(latest),
    repeatedFinalizedHead: withoutTransactions(repeatedFinalized),
    observedAt,
    completedAt,
  };
  return { provisional, finalized, latest, finality };
}

async function unknown(
  io: AtomicFinalityIO,
  reason: string,
  provisional?: AtomicProvisionalEvidence,
): Promise<AtomicFinalityResult> {
  try {
    await io.recordUnknown(reason, provisional);
  } catch {
    io.report(finalityEvent("persistence_failed", io, provisional));
    return {
      kind: "persistence_failed",
      reason,
      ...(provisional ? { provisional } : {}),
    };
  }
  io.report({
    ...finalityEvent("unknown", io, provisional),
    reason,
  });
  return { kind: "unknown", reason, ...(provisional ? { provisional } : {}) };
}

function finalityEvent(
  stage: string,
  io: AtomicFinalityIO,
  provisional?: AtomicProvisionalEvidence,
  finality?: AtomicFinalityEvidence,
) {
  return {
    machineOutputVersion: "epeius-atomic-finality-jsonl-v1",
    finality: {
      stage,
      policyVersion: io.policy.policyVersion,
      transactionHash: io.hash,
      canonicalInclusion: provisional?.canonicalInclusion ?? "unavailable",
      execution: provisional?.execution ?? "unknown",
      economics: provisional?.economics ?? "unavailable",
      ...(provisional ? { provisional } : {}),
      ...(finality ? { evidence: finality } : {}),
    },
  };
}

type AdmittedBlock = FinalityBlockEvidence & { transactions: string[] };

function admitBlock(
  value: unknown,
  expectedNumber?: string,
  expectedHash?: string,
): AdmittedBlock {
  if (!plainObject(value) || !Array.isArray(value.transactions))
    throw new Error("Finality block evidence is malformed.");
  const block = {
    number: quantity(value.number, "block number"),
    hash: hash(value.hash, "block hash"),
    parentHash: hash(value.parentHash, "block parent hash", true),
    timestamp: quantity(value.timestamp, "block timestamp"),
    transactions: value.transactions.map((transaction) =>
      hash(transaction, "block transaction hash"),
    ),
  };
  if (block.number !== "0" && block.parentHash === zeroHash)
    throw new Error("Finality block parent hash is malformed.");
  if (
    (expectedNumber !== undefined && block.number !== expectedNumber) ||
    (expectedHash !== undefined &&
      block.hash.toLowerCase() !== expectedHash.toLowerCase())
  )
    throw new InconsistentEvidence("Canonical block mapping changed.");
  return block;
}

async function optionalSafe(
  policy: AtomicFinalityPolicy,
  chain: FinalityChain,
) {
  if (policy.safeSignal === "unused") return undefined;
  let value: unknown;
  try {
    value = await chain.blockByNumber("safe");
  } catch {
    // Safe is progress evidence, not completion authority. An unsupported
    // optional tag may be absent, while any returned value is still admitted.
    return undefined;
  }
  return value === null ? undefined : admitBlock(value);
}

function admitReceipt(value: unknown, expectedHash: string) {
  if (!plainObject(value) || !Array.isArray(value.logs))
    throw new Error("Finality receipt evidence is malformed.");
  const transactionHash = hash(
    value.transactionHash,
    "receipt transaction hash",
  );
  const blockHash = hash(value.blockHash, "receipt block hash");
  const blockNumber = quantity(value.blockNumber, "receipt block number");
  const transactionIndex = quantity(
    value.transactionIndex,
    "receipt transaction index",
  );
  const status = quantity(value.status, "receipt status");
  if (
    transactionHash.toLowerCase() !== expectedHash.toLowerCase() ||
    (status !== "0" && status !== "1")
  )
    throw new Error("Finality receipt identity or status is invalid.");
  const indices = new Set<string>();
  const logs = value.logs.map((entry) => {
    if (
      !plainObject(entry) ||
      !Array.isArray(entry.topics) ||
      entry.removed !== false
    )
      throw new Error("Finality receipt log evidence is malformed.");
    const log = {
      address: address(entry.address),
      topics: entry.topics.map((topic) =>
        hash(topic, "receipt log topic", true),
      ),
      data: data(entry.data),
      transactionHash: hash(
        entry.transactionHash,
        "receipt log transaction hash",
      ),
      blockNumber: quantity(entry.blockNumber, "receipt log block number"),
      blockHash: hash(entry.blockHash, "receipt log block hash"),
      transactionIndex: quantity(
        entry.transactionIndex,
        "receipt log transaction index",
      ),
      logIndex: quantity(entry.logIndex, "receipt log index"),
      removed: false as const,
    };
    if (
      log.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      log.blockNumber !== blockNumber ||
      log.blockHash.toLowerCase() !== blockHash.toLowerCase() ||
      log.transactionIndex !== transactionIndex ||
      indices.has(log.logIndex)
    )
      throw new Error("Finality receipt log identity is inconsistent.");
    indices.add(log.logIndex);
    return log;
  });
  return {
    transactionHash,
    blockNumber,
    blockHash,
    transactionIndex,
    status: status as "0" | "1",
    logs,
  };
}

function assertHeadOrder(
  finalized: AdmittedBlock,
  safe: AdmittedBlock | undefined,
  latest: AdmittedBlock,
) {
  if (
    BigInt(finalized.number) > BigInt(latest.number) ||
    (safe &&
      (BigInt(finalized.number) > BigInt(safe.number) ||
        BigInt(safe.number) > BigInt(latest.number)))
  )
    throw new InconsistentEvidence(
      "Finalized, safe, and latest heads conflict.",
    );
}

function receiptAsReceipt(receipt: ReturnType<typeof admitReceipt>): Receipt {
  return {
    transactionHash: receipt.transactionHash,
    status: toHex(BigInt(receipt.status)),
    blockNumber: toHex(BigInt(receipt.blockNumber)),
    blockHash: receipt.blockHash,
    transactionIndex: toHex(BigInt(receipt.transactionIndex)),
    logs: receipt.logs.map((log) => ({
      ...log,
      blockNumber: toHex(BigInt(log.blockNumber)),
      transactionIndex: toHex(BigInt(log.transactionIndex)),
      logIndex: toHex(BigInt(log.logIndex)),
    })),
  };
}

function withoutTransactions(value: AdmittedBlock): FinalityBlockEvidence {
  const { transactions: _, ...header } = value;
  return header;
}

function quantity(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    value === "0x"
  )
    throw new Error(`Finality ${name} is malformed.`);
  const result = BigInt(value);
  if (toHex(result) !== value.toLowerCase())
    throw new Error(`Finality ${name} is noncanonical.`);
  return result.toString();
}

function hash(value: unknown, name: string, zeroAllowed = false) {
  if (
    typeof value !== "string" ||
    !isHash(value) ||
    (!zeroAllowed && value.toLowerCase() === zeroHash)
  )
    throw new Error(`Finality ${name} is malformed.`);
  return value.toLowerCase();
}

function address(value: unknown) {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new Error("Finality receipt log address is malformed.");
  return value.toLowerCase();
}

function data(value: unknown) {
  if (typeof value !== "string" || !isHex(value, { strict: true }))
    throw new Error("Finality receipt log data is malformed.");
  return value.toLowerCase();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateStoredProvisionalEvidence(
  value: unknown,
): asserts value is AtomicProvisionalEvidence {
  if (!plainObject(value))
    throw new Error("Stored provisional evidence is invalid.");
  exactKeys(value, [
    "verifierVersion",
    "observedAt",
    "canonicalInclusion",
    "execution",
    "economics",
    "receipt",
    "canonicalBlock",
    "verification",
  ]);
  if (
    value.verifierVersion !== FINALITY_VERIFIER_VERSION ||
    !validTimestamp(value.observedAt) ||
    value.canonicalInclusion !== "observed" ||
    !["success", "reverted"].includes(String(value.execution)) ||
    !["passed", "failed", "unavailable"].includes(String(value.economics))
  )
    throw new Error("Stored provisional evidence meaning is invalid.");
  validateStoredReceipt(value.receipt);
  validateStoredBlock(value.canonicalBlock);
  validateStoredVerification(value.verification);
  const receipt = value.receipt as FinalityReceiptEvidence;
  const block = value.canonicalBlock as FinalityBlockEvidence;
  if (
    receipt.blockNumber !== block.number ||
    receipt.blockHash !== block.hash ||
    (value.execution === "success") !== (receipt.status === "1") ||
    (value.economics === "passed") !==
      ((value.verification as SwapVerification).outcome ===
        VerificationOutcome.Passed) ||
    (value.economics === "failed") !==
      ((value.verification as SwapVerification).outcome ===
        VerificationOutcome.Failed && receipt.status === "1")
  )
    throw new Error("Stored provisional evidence is inconsistent.");
}

export function validateStoredFinalityEvidence(
  value: unknown,
  provisional: AtomicProvisionalEvidence,
  policy: AtomicFinalityPolicy,
): asserts value is AtomicFinalityEvidence {
  if (!plainObject(value))
    throw new Error("Stored finality evidence is invalid.");
  exactKeys(value, [
    "verifierVersion",
    "policyVersion",
    "configDigest",
    "chainId",
    "parentChainId",
    "networkAnchorNumber",
    "networkAnchorHash",
    "finalityMethod",
    "safeSignal",
    "rpcSourceId",
    "capabilityRecord",
    "capabilityValidUntil",
    "transactionHash",
    "receipt",
    "canonicalBlock",
    "finalizedHead",
    "safeHead",
    "latestHead",
    "repeatedFinalizedHead",
    "observedAt",
    "completedAt",
  ]);
  for (const name of [
    "policyVersion",
    "configDigest",
    "chainId",
    "parentChainId",
    "networkAnchorNumber",
    "networkAnchorHash",
    "finalityMethod",
    "safeSignal",
    "rpcSourceId",
    "capabilityRecord",
    "capabilityValidUntil",
  ] as const)
    if (value[name] !== policy[name])
      throw new Error("Stored finality policy evidence changed.");
  if (
    value.verifierVersion !== FINALITY_VERIFIER_VERSION ||
    !isHash(String(value.transactionHash)) ||
    !validTimestamp(value.observedAt) ||
    !validTimestamp(value.completedAt)
  )
    throw new Error("Stored finality evidence identity is invalid.");
  validateStoredReceipt(value.receipt);
  for (const name of [
    "canonicalBlock",
    "finalizedHead",
    "latestHead",
    "repeatedFinalizedHead",
  ] as const)
    validateStoredBlock(value[name]);
  if (policy.safeSignal === "unused" && value.safeHead !== undefined)
    throw new Error("Stored finality safe evidence is invalid.");
  if (value.safeHead !== undefined) validateStoredBlock(value.safeHead);
  const receipt = value.receipt as FinalityReceiptEvidence;
  const canonical = value.canonicalBlock as FinalityBlockEvidence;
  const finalized = value.finalizedHead as FinalityBlockEvidence;
  const latest = value.latestHead as FinalityBlockEvidence;
  const repeated = value.repeatedFinalizedHead as FinalityBlockEvidence;
  const safe = value.safeHead as FinalityBlockEvidence | undefined;
  if (
    JSON.stringify(receipt) !== JSON.stringify(provisional.receipt) ||
    JSON.stringify(canonical) !== JSON.stringify(provisional.canonicalBlock) ||
    value.transactionHash !== receipt.transactionHash ||
    value.observedAt !== provisional.observedAt ||
    BigInt(receipt.blockNumber) > BigInt(finalized.number) ||
    BigInt(finalized.number) > BigInt(repeated.number) ||
    BigInt(finalized.number) > BigInt(latest.number) ||
    (safe &&
      (BigInt(finalized.number) > BigInt(safe.number) ||
        BigInt(safe.number) > BigInt(latest.number)))
  )
    throw new Error("Stored finality evidence is inconsistent.");
}

function validateStoredBlock(
  value: unknown,
): asserts value is FinalityBlockEvidence {
  if (!plainObject(value)) throw new Error("Stored finality block is invalid.");
  exactKeys(value, ["number", "hash", "parentHash", "timestamp"]);
  if (
    !decimal(value.number) ||
    !isHash(String(value.hash)) ||
    String(value.hash).toLowerCase() === zeroHash ||
    !isHash(String(value.parentHash)) ||
    !decimal(value.timestamp)
  )
    throw new Error("Stored finality block fields are invalid.");
}

function validateStoredReceipt(
  value: unknown,
): asserts value is FinalityReceiptEvidence {
  if (!plainObject(value))
    throw new Error("Stored finality receipt is invalid.");
  exactKeys(value, [
    "transactionHash",
    "blockNumber",
    "blockHash",
    "transactionIndex",
    "status",
    "logs",
  ]);
  if (
    !isHash(String(value.transactionHash)) ||
    !decimal(value.blockNumber) ||
    !isHash(String(value.blockHash)) ||
    String(value.blockHash).toLowerCase() === zeroHash ||
    !decimal(value.transactionIndex) ||
    !["0", "1"].includes(String(value.status)) ||
    !Array.isArray(value.logs)
  )
    throw new Error("Stored finality receipt fields are invalid.");
  const indices = new Set<string>();
  for (const item of value.logs) {
    if (!plainObject(item)) throw new Error("Stored finality log is invalid.");
    exactKeys(item, [
      "address",
      "topics",
      "data",
      "transactionHash",
      "blockNumber",
      "blockHash",
      "transactionIndex",
      "logIndex",
      "removed",
    ]);
    if (
      !isAddress(String(item.address), { strict: false }) ||
      !Array.isArray(item.topics) ||
      item.topics.some((topic) => !isHash(String(topic))) ||
      typeof item.data !== "string" ||
      !isHex(item.data, { strict: true }) ||
      item.transactionHash !== value.transactionHash ||
      item.blockNumber !== value.blockNumber ||
      item.blockHash !== value.blockHash ||
      item.transactionIndex !== value.transactionIndex ||
      !decimal(item.logIndex) ||
      indices.has(item.logIndex as string) ||
      item.removed !== false
    )
      throw new Error("Stored finality log fields are invalid.");
    indices.add(item.logIndex as string);
  }
}

function validateStoredVerification(value: unknown) {
  if (!plainObject(value))
    throw new Error("Stored economic verification is invalid.");
  exactKeys(value, [
    "outcome",
    "reason",
    "inputSpentAtomic",
    "outputReceivedAtomic",
    "routerIntermediateDeltas",
    "touchedTokenOwnerDeltas",
  ]);
  if (
    !["passed", "failed", "unavailable"].includes(String(value.outcome)) ||
    typeof value.reason !== "string" ||
    !value.reason ||
    (value.inputSpentAtomic !== undefined &&
      !signedDecimal(value.inputSpentAtomic)) ||
    (value.outputReceivedAtomic !== undefined &&
      !signedDecimal(value.outputReceivedAtomic))
  )
    throw new Error("Stored economic verification fields are invalid.");
  for (const name of [
    "routerIntermediateDeltas",
    "touchedTokenOwnerDeltas",
  ] as const)
    if (value[name] !== undefined) {
      if (
        !plainObject(value[name]) ||
        Object.values(value[name]).some((amount) => !signedDecimal(amount))
      )
        throw new Error("Stored economic verification deltas are invalid.");
    }
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Stored finality evidence contains unknown fields.");
}

function decimal(value: unknown) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function signedDecimal(value: unknown) {
  return typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value);
}

function validTimestamp(value: unknown) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
