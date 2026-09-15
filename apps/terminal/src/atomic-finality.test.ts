import { expect, test } from "bun:test";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, toHex } from "viem";
import { finalizeAtomicSwap, preflightAtomicFinality } from "./atomic-finality";
import type { SignedAtomicEnvelope } from "./atomic-signed-envelope";
import { readChain } from "./chain";
import type { AtomicFinalityPolicy } from "./finality-policy";
import { parseAtomicFinalityPolicy } from "./finality-policy";

const h = (digit: string) => `0x${digit.repeat(64)}`;
const a = (digit: string) => `0x${digit.repeat(40)}`;
const txHash = h("1");
const blockHash = h("2");
const input = a("3");
const output = a("4");
const wallet = a("5");
const executor = a("6");

const policy: AtomicFinalityPolicy = {
  policyVersion: "epeius-finality-v1",
  finalityMethod: "ethereum_consensus",
  completionTag: "finalized",
  chainId: "1",
  safeSignal: "ethereum_safe",
  networkAnchorNumber: "0",
  networkAnchorHash: h("a"),
  rpcSourceId: "fixture",
  capabilityRecord: "fixture-1",
  capabilityValidUntil: "2099-01-01T00:00:00Z",
  requestTimeoutMs: 100,
  pollIntervalMs: 1,
  waitTimeoutMs: 3,
  stalledAfterMs: 2,
  maxResponseAgeMs: 100,
  configDigest: h("b"),
};

const signed: SignedAtomicEnvelope = {
  type: 2,
  chainId: "1",
  nonce: "9",
  signer: wallet,
  to: executor,
  valueAtomic: "0",
  data: "0x1234",
  gasLimit: "100000",
  maxFeePerGasAtomic: "2",
  maxPriorityFeePerGasAtomic: "1",
  accessList: [],
  yParity: 0,
  r: h("c"),
  s: h("d"),
  rawTransaction: "0x0201",
  transactionHash: txHash,
};

function transfer(
  token: string,
  from: string,
  to: string,
  value: bigint,
  logIndex: number,
) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    logIndex: toHex(logIndex),
    removed: false,
  };
}

function receipt(status = "0x1", outputAmount = 207n) {
  return {
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    status,
    logs:
      status === "0x1"
        ? [
            transfer(input, wallet, executor, 100n, 0),
            transfer(output, executor, wallet, outputAmount, 1),
          ]
        : [],
  };
}

function block(number: number, hash = h(String(number % 10))) {
  return {
    number: toHex(number),
    hash,
    parentHash: number === 0 ? h("0") : h("9"),
    timestamp: toHex(1_700_000_000 + number),
    transactions: number === 100 ? [txHash] : [],
  };
}

function rpcTransaction() {
  return {
    hash: txHash,
    type: "0x2",
    chainId: "0x1",
    nonce: "0x9",
    from: wallet,
    to: executor,
    input: "0x1234",
    value: "0x0",
    gas: "0x186a0",
    maxFeePerGas: "0x2",
    maxPriorityFeePerGas: "0x1",
    accessList: [],
    yParity: "0x0",
    r: h("c"),
    s: h("d"),
  };
}

function harness(finalizedNumber = 100) {
  let monotonic = 0;
  let rawReceipt: unknown = receipt();
  let finalizedHash = finalizedNumber === 100 ? blockHash : h("7");
  let latestNumber = Math.max(101, finalizedNumber);
  const records: string[] = [];
  const events: unknown[] = [];
  const byNumber = async (tag: string) => {
    if (tag === "finalized") return block(finalizedNumber, finalizedHash);
    if (tag === "safe") return block(Math.max(finalizedNumber, 100), h("8"));
    if (tag === "latest") return block(latestNumber, h("9"));
    const number = Number(BigInt(tag));
    if (number === 0) return block(0, policy.networkAnchorHash);
    if (number === 100) return block(100, blockHash);
    if (number === finalizedNumber) return block(number, finalizedHash);
    return block(number);
  };
  const chain = {
    chainId: async () => "0x1",
    receiptByHash: async () => rawReceipt,
    transactionByHash: async () => rpcTransaction(),
    blockByNumber: byNumber,
    blockByHash: async (hash: string) => {
      if (hash === finalizedHash) return block(finalizedNumber, finalizedHash);
      return null;
    },
    traceCanonicalTransaction: async () => ({}),
  };
  const io = {
    policy,
    hash: txHash,
    signedEnvelope: signed,
    obligations: {
      tokenIn: input,
      tokenOut: output,
      recipient: wallet,
      amountInAtomic: "100",
      amountOutMinimumAtomic: "200",
      intermediate: [],
    },
    chain,
    signal: new AbortController().signal,
    recordObserved: async () => {
      records.push("observed");
    },
    recordFinal: async (state: "complete" | "failed_final") => {
      records.push(state);
    },
    recordUnknown: async (reason: string) => {
      records.push(`unknown:${reason}`);
    },
    report: (event: unknown) => events.push(event),
    clock: {
      wallNow: () => Date.parse("2026-09-15T00:00:00Z") + monotonic,
      monotonicNow: () => monotonic,
      sleep: async (milliseconds: number) => {
        monotonic += milliseconds;
      },
    },
  };
  return {
    io,
    chain,
    records,
    events,
    setReceipt: (value: unknown) => {
      rawReceipt = value;
    },
    setFinalizedHash: (value: string) => {
      finalizedHash = value;
    },
    advanceLatest: () => {
      latestNumber++;
    },
    advanceTime: (milliseconds: number) => {
      monotonic += milliseconds;
    },
  };
}

test("finalized below stays observed; equality and above complete", async () => {
  const below = harness(99);
  expect(await finalizeAtomicSwap(below.io)).toMatchObject({
    kind: "unknown",
    reason: "wait_timeout",
  });
  expect(below.records).toEqual(["observed", "unknown:wait_timeout"]);

  for (const height of [100, 101]) {
    const exact = harness(height);
    expect(await finalizeAtomicSwap(exact.io)).toMatchObject({
      kind: "complete",
      provisional: { execution: "success", economics: "passed" },
      finality: { finalizedHead: { number: String(height) } },
    });
    expect(exact.records).toEqual(["observed", "complete"]);
  }
});

test("reverted and minimum-miss receipts become failed only after finality", async () => {
  for (const value of [receipt("0x0"), receipt("0x1", 199n)]) {
    const h = harness(100);
    h.setReceipt(value);
    expect(await finalizeAtomicSwap(h.io)).toMatchObject({
      kind: "failed_final",
    });
    expect(h.records).toEqual(["observed", "failed_final"]);
  }
});

test("preliminary and malformed receipt identities never become observed", async () => {
  for (const change of [
    { blockHash: null },
    { transactionIndex: "0x00" },
    { status: "0x2" },
  ]) {
    const h = harness();
    h.setReceipt({ ...receipt(), ...change });
    expect(await finalizeAtomicSwap(h.io)).toMatchObject({
      kind: "unknown",
      reason: "finality_unavailable",
    });
    expect(h.records).toEqual(["unknown:finality_unavailable"]);
  }
});

test("removed, duplicate, wrong-block and malformed log identities fail closed", async () => {
  const base = receipt();
  for (const logs of [
    base.logs.map((log, index) => (index ? log : { ...log, removed: true })),
    base.logs.map((log) => ({ ...log, logIndex: "0x0" })),
    base.logs.map((log, index) =>
      index ? log : { ...log, blockHash: h("f") },
    ),
    base.logs.map((log, index) =>
      index ? log : { ...log, transactionIndex: "0x00" },
    ),
  ]) {
    const h = harness();
    h.setReceipt({ ...base, logs });
    expect((await finalizeAtomicSwap(h.io)).kind).toBe("unknown");
    expect(h.records).toEqual(["unknown:finality_unavailable"]);
  }
});

test("wrong canonical B/F mappings get one complete retry then unknown", async () => {
  const wrongB = harness();
  let bReads = 0;
  const originalB = wrongB.chain.blockByNumber;
  wrongB.chain.blockByNumber = async (tag) =>
    tag === "0x64" && ++bReads <= 2 ? block(100, h("f")) : originalB(tag);
  expect(await finalizeAtomicSwap(wrongB.io)).toMatchObject({
    kind: "unknown",
    reason: "evidence_inconsistent",
  });

  const oneRace = harness();
  let reads = 0;
  const exactB = oneRace.chain.blockByNumber;
  oneRace.chain.blockByNumber = async (tag) =>
    tag === "0x64" && ++reads === 1 ? block(100, h("f")) : exactB(tag);
  expect((await finalizeAtomicSwap(oneRace.io)).kind).toBe("complete");
});

test("safe/finalized/latest order and changed repeated receipt stay unknown", async () => {
  const order = harness();
  const original = order.chain.blockByNumber;
  order.chain.blockByNumber = async (tag) =>
    tag === "safe" ? block(99, h("8")) : original(tag);
  expect(await finalizeAtomicSwap(order.io)).toMatchObject({
    kind: "unknown",
    reason: "evidence_inconsistent",
  });

  const changed = harness();
  let reads = 0;
  changed.chain.receiptByHash = async () =>
    ++reads % 2 === 0 ? { ...receipt(), status: "0x0" } : receipt();
  expect(await finalizeAtomicSwap(changed.io)).toMatchObject({
    kind: "unknown",
    reason: "evidence_inconsistent",
  });
});

test("stall with advancing latest and cancellation stay nonterminal", async () => {
  const stalled = harness(99);
  stalled.io.clock.sleep = async (milliseconds) => {
    stalled.advanceLatest();
    stalled.advanceTime(milliseconds);
  };
  expect((await finalizeAtomicSwap(stalled.io)).kind).toBe("unknown");

  const canceled = harness();
  const abort = new AbortController();
  abort.abort();
  canceled.io.signal = abort.signal;
  expect(await finalizeAtomicSwap(canceled.io)).toMatchObject({
    kind: "unknown",
    reason: "canceled",
  });
});

test("completion append failure emits no authoritative completion", async () => {
  const h = harness();
  h.io.recordFinal = async () => {
    throw new Error("fsync failed");
  };
  expect(await finalizeAtomicSwap(h.io)).toMatchObject({
    kind: "persistence_failed",
    reason: "finality_record_not_saved",
    finality: { transactionHash: txHash },
  });
  expect(JSON.stringify(h.events)).toContain("finalized_verified_not_recorded");
  expect(JSON.stringify(h.events)).not.toContain('"stage":"complete"');
});

test("preflight binds chain anchor and admitted finalized capability", async () => {
  const fixture = harness();
  expect(
    await preflightAtomicFinality(
      policy,
      fixture.chain,
      new AbortController().signal,
      Date.parse("2026-09-15T00:00:00Z"),
    ),
  ).toMatchObject({ anchor: { hash: policy.networkAnchorHash } });
  fixture.setFinalizedHash(h("f"));
  await expect(
    preflightAtomicFinality(
      { ...policy, networkAnchorHash: h("e") },
      fixture.chain,
      new AbortController().signal,
      Date.parse("2026-09-15T00:00:00Z"),
    ),
  ).rejects.toThrow();

  const withoutSafe = harness();
  const readBlock = withoutSafe.chain.blockByNumber;
  expect(
    await preflightAtomicFinality(
      policy,
      {
        ...withoutSafe.chain,
        blockByNumber: async (tag) => (tag === "safe" ? null : readBlock(tag)),
      },
      new AbortController().signal,
      Date.parse("2026-09-15T00:00:00Z"),
    ),
  ).not.toHaveProperty("safe");

  const unsupportedSafe = harness();
  const readWithoutUnsupportedSafe = unsupportedSafe.chain.blockByNumber;
  expect(
    await preflightAtomicFinality(
      policy,
      {
        ...unsupportedSafe.chain,
        blockByNumber: async (tag) => {
          if (tag === "safe") throw new Error("unsupported block tag");
          return readWithoutUnsupportedSafe(tag);
        },
      },
      new AbortController().signal,
      Date.parse("2026-09-15T00:00:00Z"),
    ),
  ).not.toHaveProperty("safe");

  const malformedSafe = harness();
  const readValidBlock = malformedSafe.chain.blockByNumber;
  await expect(
    preflightAtomicFinality(
      policy,
      {
        ...malformedSafe.chain,
        blockByNumber: async (tag) =>
          tag === "safe" ? { number: "0x00" } : readValidBlock(tag),
      },
      new AbortController().signal,
      Date.parse("2026-09-15T00:00:00Z"),
    ),
  ).rejects.toThrow();
});

test("finalized completion remains valid when optional safe is unavailable", async () => {
  const h = harness();
  const readBlock = h.chain.blockByNumber;
  h.chain.blockByNumber = async (tag) => {
    if (tag === "safe") throw new Error("unsupported block tag");
    return readBlock(tag);
  };
  expect(await finalizeAtomicSwap(h.io)).toMatchObject({
    kind: "complete",
    finality: { finalizedHead: { number: "100" } },
  });
  expect(h.records).toEqual(["observed", "complete"]);
});

test("real local Anvil exposes synthetic finalized/safe block shapes without writes", async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const anvil = Bun.spawn(
    ["anvil", "--silent", "--port", String(port), "--chain-id", "1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        if (response.ok) break;
      } catch {
        await Bun.sleep(20);
      }
    }
    const signal = new AbortController().signal;
    const chain = readChain(url, signal, 1000);
    const genesis = (await chain.blockByNumber("0x0")) as {
      hash: string;
    };
    const localPolicy = parseAtomicFinalityPolicy(
      {
        policy_version: "epeius-finality-v1",
        finality_method: "ethereum_consensus",
        completion_tag: "finalized",
        safe_signal: "ethereum_safe",
        network_anchor_number: 0,
        network_anchor_hash: genesis.hash,
        rpc_source_id: "local-anvil-synthetic",
        capability_record: "anvil-1.5.0-field-shape",
        capability_valid_until: "2099-01-01T00:00:00Z",
        request_timeout_ms: 1000,
        poll_interval_ms: 1,
        wait_timeout_ms: 100,
        stalled_after_ms: 50,
        max_response_age_ms: 1000,
      },
      "1",
      0,
    );
    const result = await preflightAtomicFinality(localPolicy, chain, signal, 0);
    expect(result.anchor.hash).toBe(genesis.hash);
    expect(result.finalized.number).toBe("0");
    expect(result.safe?.number).toBe("0");
    expect(result.latest.number).toBe("0");
  } finally {
    anvil.kill();
    await anvil.exited;
  }
}, 20_000);
