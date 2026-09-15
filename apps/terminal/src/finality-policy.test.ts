import { expect, test } from "bun:test";
import {
  assertAtomicFinalityPolicyReadmission,
  parseAtomicFinalityPolicy,
} from "./finality-policy";

const future = "2099-01-01T00:00:00Z";
const hash = `0x${"1".repeat(64)}`;

function policy(chainId = "1") {
  const mappings = {
    "1": ["ethereum_consensus", "ethereum_safe", undefined],
    "8453": ["op_l1_derivation", "op_derived_safe", 1],
    "10": ["op_l1_derivation", "op_derived_safe", 1],
    "42161": ["nitro_parent_batches", "nitro_parent_safe", 1],
    "137": ["polygon_heimdall", "unused", undefined],
  } as const;
  const [method, safe, parent] = mappings[chainId as keyof typeof mappings];
  return {
    policy_version: "epeius-finality-v1",
    finality_method: method,
    completion_tag: "finalized",
    ...(parent ? { parent_chain_id: parent } : {}),
    safe_signal: safe,
    network_anchor_number: 0,
    network_anchor_hash: hash,
    rpc_source_id: "local-anvil-reviewed",
    capability_record: "fixture-2026-09-15",
    capability_valid_until: future,
    request_timeout_ms: 100,
    poll_interval_ms: 1,
    wait_timeout_ms: 1000,
    stalled_after_ms: 500,
    max_response_age_ms: 100,
  };
}

test("strict finality policy admits only reviewed chain method mappings", () => {
  for (const chainId of ["1", "8453", "10", "42161", "137"])
    expect(
      parseAtomicFinalityPolicy(policy(chainId), chainId, 0),
    ).toMatchObject({
      chainId,
      policyVersion: "epeius-finality-v1",
      completionTag: "finalized",
      networkAnchorNumber: "0",
    });
  expect(parseAtomicFinalityPolicy(policy("1"), "1", 0).configDigest).toMatch(
    /^0x[0-9a-f]{64}$/,
  );
});

test("strict finality policy rejects missing, empty, unknown, expired and fallback fields", () => {
  for (const mutate of [
    (value: Record<string, unknown>) => delete value.rpc_source_id,
    (value: Record<string, unknown>) => (value.rpc_source_id = ""),
    (value: Record<string, unknown>) => (value.confirmations = 64),
    (value: Record<string, unknown>) =>
      (value.capability_valid_until = "2000-01-01T00:00:00Z"),
    (value: Record<string, unknown>) => (value.wait_timeout_ms = 0),
    (value: Record<string, unknown>) => (value.completion_tag = "latest"),
  ]) {
    const value = { ...policy("1") } as Record<string, unknown>;
    mutate(value);
    expect(() => parseAtomicFinalityPolicy(value, "1")).toThrow();
  }
});

test("strict finality policy rejects inapplicable and mismatched parent/safe/method fields", () => {
  expect(() =>
    parseAtomicFinalityPolicy({ ...policy("1"), parent_chain_id: 1 }, "1", 0),
  ).toThrow();
  expect(() =>
    parseAtomicFinalityPolicy(
      { ...policy("8453"), parent_chain_id: undefined },
      "8453",
      0,
    ),
  ).toThrow();
  expect(() =>
    parseAtomicFinalityPolicy(
      { ...policy("137"), safe_signal: "ethereum_safe" },
      "137",
      0,
    ),
  ).toThrow();
  expect(() => parseAtomicFinalityPolicy(policy("1"), "31337", 0)).toThrow(
    "no reviewed method mapping",
  );
});

test("policy readmission changes capability only, never chain authority", () => {
  const previous = parseAtomicFinalityPolicy(policy("1"), "1", 0);
  const renewed = parseAtomicFinalityPolicy(
    {
      ...policy("1"),
      rpc_source_id: "explicit-renewed-source",
      capability_record: "fixture-2026-09-16",
      capability_valid_until: "2100-01-01T00:00:00Z",
    },
    "1",
    0,
  );
  expect(() =>
    assertAtomicFinalityPolicyReadmission(previous, renewed),
  ).not.toThrow();
  expect(() =>
    assertAtomicFinalityPolicyReadmission(previous, previous),
  ).toThrow("did not change");
  for (const changed of [
    { ...renewed, chainId: "8453" },
    { ...renewed, finalityMethod: "op_l1_derivation" as const },
    { ...renewed, networkAnchorHash: `0x${"2".repeat(64)}` },
  ])
    expect(() =>
      assertAtomicFinalityPolicyReadmission(previous, changed),
    ).toThrow("changed chain authority");
});
