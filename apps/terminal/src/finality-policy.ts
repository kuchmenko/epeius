import { keccak256, stringToHex } from "viem";
import { readSettings } from "./config";

export const FINALITY_POLICY_VERSION = "epeius-finality-v1";
export const FINALITY_VERIFIER_VERSION = "epeius-finality-verifier-v1";

export class AtomicFinalityPolicyUnavailableError extends Error {}

export type FinalityMethod =
  | "ethereum_consensus"
  | "op_l1_derivation"
  | "nitro_parent_batches"
  | "polygon_heimdall";
export type SafeSignal =
  | "ethereum_safe"
  | "op_derived_safe"
  | "nitro_parent_safe"
  | "unused";

export type AtomicFinalityPolicy = {
  policyVersion: typeof FINALITY_POLICY_VERSION;
  finalityMethod: FinalityMethod;
  completionTag: "finalized";
  chainId: string;
  parentChainId?: string;
  safeSignal: SafeSignal;
  networkAnchorNumber: string;
  networkAnchorHash: string;
  rpcSourceId: string;
  capabilityRecord: string;
  capabilityValidUntil: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  waitTimeoutMs: number;
  stalledAfterMs: number;
  maxResponseAgeMs: number;
  configDigest: string;
};

const fields = [
  "policy_version",
  "finality_method",
  "completion_tag",
  "parent_chain_id",
  "safe_signal",
  "network_anchor_number",
  "network_anchor_hash",
  "rpc_source_id",
  "capability_record",
  "capability_valid_until",
  "request_timeout_ms",
  "poll_interval_ms",
  "wait_timeout_ms",
  "stalled_after_ms",
  "max_response_age_ms",
] as const;

const mappings = new Map<
  string,
  {
    method: FinalityMethod;
    safe: SafeSignal;
    parent?: string;
  }
>([
  ["1", { method: "ethereum_consensus", safe: "ethereum_safe" }],
  [
    "8453",
    { method: "op_l1_derivation", safe: "op_derived_safe", parent: "1" },
  ],
  ["10", { method: "op_l1_derivation", safe: "op_derived_safe", parent: "1" }],
  [
    "42161",
    {
      method: "nitro_parent_batches",
      safe: "nitro_parent_safe",
      parent: "1",
    },
  ],
  ["137", { method: "polygon_heimdall", safe: "unused" }],
]);

export async function readAtomicFinalityPolicy(
  configPath: string,
  chain: string,
  now = Date.now(),
) {
  const settings = await readSettings(configPath);
  const localChain = settings.chains?.[chain];
  if (!localChain || !Number.isSafeInteger(localChain.chain_id))
    throw new Error("Atomic finality chain configuration is invalid.");
  return parseAtomicFinalityPolicy(
    localChain.finality,
    String(localChain.chain_id),
    now,
  );
}

export function parseAtomicFinalityPolicy(
  value: unknown,
  chainId: string,
  now = Date.now(),
): AtomicFinalityPolicy {
  if (!plainObject(value))
    throw new AtomicFinalityPolicyUnavailableError(
      "Atomic finality configuration is required.",
    );
  if (Object.keys(value).some((key) => !fields.includes(key as never)))
    throw new Error("Atomic finality configuration contains unknown fields.");
  if (!fields.every((field) => Object.hasOwn(value, field))) {
    const mapping = mappings.get(chainId);
    const expectedFields = mapping?.parent
      ? fields
      : fields.filter((field) => field !== "parent_chain_id");
    if (!expectedFields.every((field) => Object.hasOwn(value, field)))
      throw new Error("Atomic finality configuration is incomplete.");
  }

  const mapping = mappings.get(chainId);
  if (!mapping)
    throw new Error("Atomic finality chain has no reviewed method mapping.");
  const parent = value.parent_chain_id;
  if (
    value.policy_version !== FINALITY_POLICY_VERSION ||
    value.finality_method !== mapping.method ||
    value.completion_tag !== "finalized" ||
    value.safe_signal !== mapping.safe ||
    (mapping.parent
      ? !Number.isSafeInteger(parent) || String(parent) !== mapping.parent
      : parent !== undefined)
  )
    throw new Error("Atomic finality method mapping is invalid.");

  const anchorNumber = decimalInteger(
    value.network_anchor_number,
    "network anchor number",
    true,
  );
  const anchorHash = hash(value.network_anchor_hash, "network anchor hash");
  const rpcSourceId = identifier(value.rpc_source_id, "RPC source ID");
  const capabilityRecord = identifier(
    value.capability_record,
    "capability record",
  );
  const capabilityValidUntil = timestamp(value.capability_valid_until);
  if (Date.parse(capabilityValidUntil) <= now)
    throw new AtomicFinalityPolicyUnavailableError(
      "Atomic finality capability record is expired.",
    );

  const canonical = {
    policyVersion: FINALITY_POLICY_VERSION as typeof FINALITY_POLICY_VERSION,
    finalityMethod: mapping.method,
    completionTag: "finalized" as const,
    chainId,
    ...(mapping.parent ? { parentChainId: mapping.parent } : {}),
    safeSignal: mapping.safe,
    networkAnchorNumber: anchorNumber,
    networkAnchorHash: anchorHash,
    rpcSourceId,
    capabilityRecord,
    capabilityValidUntil,
    requestTimeoutMs: positiveBudget(
      value.request_timeout_ms,
      "request timeout",
    ),
    pollIntervalMs: positiveBudget(value.poll_interval_ms, "poll interval"),
    waitTimeoutMs: positiveBudget(value.wait_timeout_ms, "wait timeout"),
    stalledAfterMs: positiveBudget(value.stalled_after_ms, "stall timeout"),
    maxResponseAgeMs: positiveBudget(
      value.max_response_age_ms,
      "response freshness",
    ),
  };
  return {
    ...canonical,
    configDigest: keccak256(stringToHex(JSON.stringify(canonical))),
  };
}

export function assertAtomicFinalityPolicyReadmission(
  previous: AtomicFinalityPolicy,
  current: AtomicFinalityPolicy,
) {
  for (const field of [
    "policyVersion",
    "finalityMethod",
    "completionTag",
    "chainId",
    "parentChainId",
    "safeSignal",
    "networkAnchorNumber",
    "networkAnchorHash",
  ] as const)
    if (previous[field] !== current[field])
      throw new Error(
        "Atomic finality policy renewal changed chain authority.",
      );
  if (previous.configDigest === current.configDigest)
    throw new Error("Atomic finality policy renewal did not change.");
}

export function validateStoredFinalityPolicy(
  value: unknown,
): asserts value is AtomicFinalityPolicy {
  if (!plainObject(value))
    throw new Error("Stored Atomic finality policy is invalid.");
  const allowed = [
    "policyVersion",
    "finalityMethod",
    "completionTag",
    "chainId",
    "parentChainId",
    "safeSignal",
    "networkAnchorNumber",
    "networkAnchorHash",
    "rpcSourceId",
    "capabilityRecord",
    "capabilityValidUntil",
    "requestTimeoutMs",
    "pollIntervalMs",
    "waitTimeoutMs",
    "stalledAfterMs",
    "maxResponseAgeMs",
    "configDigest",
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !allowed
      .filter((key) => key !== "parentChainId")
      .every((key) => Object.hasOwn(value, key)) ||
    typeof value.chainId !== "string" ||
    !/^[1-9][0-9]*$/.test(value.chainId) ||
    typeof value.networkAnchorNumber !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.networkAnchorNumber) ||
    !Number.isSafeInteger(Number(value.networkAnchorNumber))
  )
    throw new Error("Stored Atomic finality policy is invalid.");
  const parsed = parseAtomicFinalityPolicy(
    {
      policy_version: value.policyVersion,
      finality_method: value.finalityMethod,
      completion_tag: value.completionTag,
      ...(value.parentChainId !== undefined
        ? { parent_chain_id: Number(value.parentChainId) }
        : {}),
      safe_signal: value.safeSignal,
      network_anchor_number: Number(value.networkAnchorNumber),
      network_anchor_hash: value.networkAnchorHash,
      rpc_source_id: value.rpcSourceId,
      capability_record: value.capabilityRecord,
      capability_valid_until: value.capabilityValidUntil,
      request_timeout_ms: value.requestTimeoutMs,
      poll_interval_ms: value.pollIntervalMs,
      wait_timeout_ms: value.waitTimeoutMs,
      stalled_after_ms: value.stalledAfterMs,
      max_response_age_ms: value.maxResponseAgeMs,
    },
    value.chainId,
    0,
  );
  for (const key of allowed) {
    if (parsed[key as keyof AtomicFinalityPolicy] !== value[key])
      throw new Error(
        "Stored Atomic finality policy digest or fields changed.",
      );
  }
}

function positiveBudget(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`Atomic finality ${name} must be a positive integer.`);
  return value as number;
}

function decimalInteger(value: unknown, name: string, zero: boolean) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (zero ? 0 : 1)
  )
    throw new Error(`Atomic finality ${name} is invalid.`);
  return String(value);
}

function hash(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value) ||
    /^0x0{64}$/.test(value)
  )
    throw new Error(`Atomic finality ${name} is invalid.`);
  return value;
}

function identifier(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    throw new Error(`Atomic finality ${name} is invalid.`);
  return value;
}

function timestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Atomic finality capability expiry is invalid.");
  return value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
