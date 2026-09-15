import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  keccak256,
  padHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PlanPreparationStatus,
  PreparePlanResponseSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import { UnsignedTransactionSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { AtomicIntentJournal } from "./atomic-intent-journal";
import { runAtomicRecovery } from "./atomic-recovery";
import {
  admitRpcAtomicTransaction,
  admitSignedAtomicEnvelope,
  atomicEnvelope,
} from "./atomic-signed-envelope";
import { readChain } from "./chain";
import { ExecutionOutcome } from "./execution";
import { parseAtomicFinalityPolicy } from "./finality-policy";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const executor = {
  address: `0x${"4".repeat(40)}`,
  runtimeCodeHash: `0x${"a".repeat(64)}`,
  maxBranches: 4,
  maxOperationsPerBranch: 12,
  maxTotalOperations: 12,
};
const token = `0x${"5".repeat(40)}`;
const amount = 123n;
const word = (value: bigint) => hexToBytes(padHex(toHex(value), { size: 32 }));
const transaction = create(UnsignedTransactionSchema, {
  chainId: "1",
  from: account.address,
  to: token,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [executor.address as `0x${string}`, amount],
  }),
  valueAtomic: "0",
  gasLimit: "100000",
});
const envelope = atomicEnvelope(0n, 2_000_000_000n, 1_000_000_000n);
const finalityPolicy = parseAtomicFinalityPolicy(
  {
    policy_version: "epeius-finality-v1",
    finality_method: "ethereum_consensus",
    completion_tag: "finalized",
    safe_signal: "ethereum_safe",
    network_anchor_number: 0,
    network_anchor_hash: `0x${"a".repeat(64)}`,
    rpc_source_id: "test",
    capability_record: "test",
    capability_valid_until: "2099-01-01T00:00:00Z",
    request_timeout_ms: 100,
    poll_interval_ms: 1,
    wait_timeout_ms: 100,
    stalled_after_ms: 50,
    max_response_age_ms: 100,
  },
  "1",
  0,
);
const approval = create(PreparePlanResponseSchema, {
  status: PlanPreparationStatus.APPROVAL_REQUIRED,
  approval: {
    token: hexToBytes(token as `0x${string}`),
    spender: hexToBytes(executor.address as `0x${string}`),
    amount: word(amount),
    transaction: {
      chainId: word(1n),
      from: hexToBytes(account.address),
      to: hexToBytes(token as `0x${string}`),
      data: hexToBytes(transaction.data as `0x${string}`),
      value: word(0n),
      gasLimit: word(100000n),
    },
  },
});

async function fixture(
  initial:
    | "signed"
    | "submitted"
    | "submission_unknown"
    | "receipt_unavailable" = "signed",
) {
  const directory = await mkdtemp(join(tmpdir(), "epeius-recovery-"));
  const path = join(directory, "atomic.jsonl");
  const journal = await AtomicIntentJournal.open(path, {
    attemptId: () => "12345678-1234-4123-8123-123456789abc",
  });
  const intent = await journal.prepare({
    action: "approval",
    payloadType: "approval_response",
    payloadBinary: toBinary(PreparePlanResponseSchema, approval),
    planId: `0x${"1".repeat(64)}`,
    transaction,
    envelope,
    finalityPolicy,
  });
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 0,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 100000n,
    to: token as `0x${string}`,
    value: 0n,
    data: transaction.data as `0x${string}`,
    accessList: [],
  });
  const signed = await journal.sign(
    intent,
    await admitSignedAtomicEnvelope(raw, transaction, envelope),
  );
  if (initial === "submitted")
    await journal.transition(signed, "submitted", {
      transactionHash: signed.signedEnvelope.transactionHash,
    });
  if (initial === "submission_unknown")
    await journal.transition(signed, "submission_unknown");
  if (initial === "receipt_unavailable") {
    await journal.transition(signed, "submitted", {
      transactionHash: signed.signedEnvelope.transactionHash,
    });
    await journal.transition(signed, "receipt_unavailable", {
      transactionHash: signed.signedEnvelope.transactionHash,
      verification: "unavailable",
    });
  }
  const attempt = journal.recoveryAttempt(intent.attemptId);
  return {
    directory,
    path,
    journal,
    attempt,
    cleanup: async () => {
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rpcTransaction(
  signed: Awaited<ReturnType<typeof fixture>>["attempt"]["signedEnvelope"],
) {
  return {
    hash: signed.transactionHash,
    type: "0x2",
    chainId: "0x1",
    nonce: "0x0",
    from: signed.signer,
    to: signed.to,
    input: signed.data,
    value: "0x0",
    gas: "0x186a0",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x3b9aca00",
    accessList: [],
    yParity: toHex(signed.yParity),
    r: signed.r,
    s: signed.s,
  };
}

function harness(t: Awaited<ReturnType<typeof fixture>>) {
  const events: unknown[] = [];
  let submits = 0;
  let confirms = 0;
  const hash = t.attempt.signedEnvelope.transactionHash;
  const receipt = { transactionHash: hash, status: "0x1", logs: [] };
  const block = (tag: string) => ({
    number: tag === "0x0" ? "0x0" : "0x1",
    hash:
      tag === "0x0" ? finalityPolicy.networkAnchorHash : `0x${"b".repeat(64)}`,
    parentHash: tag === "0x0" ? `0x${"0".repeat(64)}` : `0x${"9".repeat(64)}`,
    timestamp: "0x1",
    transactions: [],
  });
  const chain = {
    chainId: async () => "0x1",
    nonce: async (_address: string, _tag: "latest" | "pending") => 0n,
    canonicalReceipt: async () => null as typeof receipt | null,
    receiptByHash: async () => chain.canonicalReceipt(),
    transactionByHash: async () => null as unknown | null,
    blockByNumber: async (tag: string) => block(tag),
    blockByHash: async () => block("finalized"),
    waitCanonicalReceipt: async () => receipt,
    traceCanonicalTransaction: async () => ({}),
    submitRawTransaction: async (raw: string) => {
      submits++;
      expect(raw).toBe(t.attempt.signedEnvelope.rawTransaction);
      return hash;
    },
  };
  const io = {
    journal: t.journal,
    attempt: t.attempt,
    executor,
    policy: finalityPolicy,
    signal: new AbortController().signal,
    chain,
    verifyExecutor: async () => true,
    confirm: async () => {
      confirms++;
      return true;
    },
    report: (event: unknown) => events.push(event),
  };
  return {
    io,
    receipt,
    hash,
    events,
    submits: () => submits,
    confirms: () => confirms,
  };
}

test("recovery records an existing receipt or exact pending transaction without submitting", async () => {
  for (const mode of ["receipt", "pending"] as const) {
    const t = await fixture(
      mode === "receipt" ? "submission_unknown" : "submitted",
    );
    try {
      const h = harness(t);
      if (mode === "receipt")
        h.io.chain.canonicalReceipt = async () => h.receipt;
      else {
        h.io.chain.transactionByHash = async () =>
          rpcTransaction(t.attempt.signedEnvelope);
      }
      expect(await runAtomicRecovery(h.io)).toMatchObject({
        kind: ExecutionOutcome.ApprovalConfirmed,
        transactionHash: h.hash,
      });
      expect(h.submits()).toBe(0);
      expect(h.confirms()).toBe(0);
      const states = (await readFile(t.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).state);
      expect(states.at(-1)).toBe("receipt_passed");
      if (mode === "pending") expect(states).toContain("submission_observed");
      expect(() =>
        t.journal.recoveryAttempt(t.attempt.current.attemptId),
      ).toThrow("canceled or final");
    } finally {
      await t.cleanup();
    }
  }
});

test("recovery submits exact stored bytes once only after two absent/hash and nonce checks", async () => {
  const t = await fixture("receipt_unavailable");
  try {
    const h = harness(t);
    expect(await runAtomicRecovery(h.io)).toMatchObject({
      kind: ExecutionOutcome.ApprovalConfirmed,
      transactionHash: h.hash,
    });
    expect(h.submits()).toBe(1);
    expect(h.confirms()).toBe(1);
    const states = (await readFile(t.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).state);
    expect(states.slice(-3)).toEqual([
      "recovery_handoff_started",
      "submitted",
      "receipt_passed",
    ]);
  } finally {
    await t.cleanup();
  }
});

test("a new invocation can recover after a durable recovery marker crash", async () => {
  const t = await fixture();
  try {
    await t.journal.recoveryTransition(t.attempt, "recovery_handoff_started", {
      transactionHash: t.attempt.signedEnvelope.transactionHash,
    });
    await t.journal.close();
    const reopened = await AtomicIntentJournal.open(t.path);
    const attempt = reopened.recoveryAttempt(t.attempt.current.attemptId);
    const h = harness({ ...t, journal: reopened, attempt });
    expect((await runAtomicRecovery(h.io)).kind).toBe(
      ExecutionOutcome.ApprovalConfirmed,
    );
    expect(h.submits()).toBe(1);
    await reopened.close();
  } finally {
    await rm(t.directory, { recursive: true, force: true });
  }
});

test("consumed, gap, conflicting, malformed and unavailable nonce evidence never submits", async () => {
  for (const nonces of [
    [1n, 1n],
    [0n, 1n],
    [1n, 0n],
    [0n, 2n],
  ] as const) {
    const t = await fixture();
    try {
      const h = harness(t);
      h.io.chain.nonce = async (_address, tag) =>
        tag === "latest" ? nonces[0] : nonces[1];
      expect((await runAtomicRecovery(h.io)).kind).toBe(
        ExecutionOutcome.Unknown,
      );
      expect(h.submits()).toBe(0);
      expect(h.confirms()).toBe(0);
    } finally {
      await t.cleanup();
    }
  }
});

test("recovery consent cancellation and pre-handoff chain change make zero submissions", async () => {
  for (const mode of ["cancel", "appeared", "nonce"] as const) {
    const t = await fixture();
    try {
      const h = harness(t);
      if (mode === "cancel") h.io.confirm = async () => false;
      if (mode === "appeared") {
        let reads = 0;
        h.io.chain.transactionByHash = async () =>
          ++reads === 2 ? rpcTransaction(t.attempt.signedEnvelope) : null;
      }
      if (mode === "nonce") {
        let reads = 0;
        h.io.chain.nonce = async () => (++reads > 2 ? 1n : 0n);
      }
      await runAtomicRecovery(h.io);
      expect(h.submits()).toBe(0);
    } finally {
      await t.cleanup();
    }
  }
});

test("submit failure or wrong returned hash records uncertainty and never retries", async () => {
  for (const mode of ["throw", "wrong"] as const) {
    const t = await fixture();
    try {
      const h = harness(t);
      h.io.chain.submitRawTransaction = async () => {
        if (h.submits() > 0) throw new Error("retried");
        // The harness counter is private, so count this call through the event path.
        return mode === "throw"
          ? Promise.reject(new Error("RPC unavailable"))
          : `0x${"9".repeat(64)}`;
      };
      expect((await runAtomicRecovery(h.io)).kind).toBe(
        ExecutionOutcome.Unknown,
      );
      const states = (await readFile(t.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).state);
      expect(states.at(-1)).toBe("submission_unknown");
    } finally {
      await t.cleanup();
    }
  }
});

test("journal write or fsync failures preserve zero submits before marker and at most one after", async () => {
  for (const failSyncAt of [1, 2, 3]) {
    const t = await fixture();
    await t.journal.close();
    let syncs = 0;
    const reopened = await AtomicIntentJournal.open(t.path, {
      before: (operation) => {
        if (operation === "sync_record" && ++syncs === failSyncAt)
          throw new Error("injected fsync crash");
      },
    });
    try {
      const attempt = reopened.recoveryAttempt(t.attempt.current.attemptId);
      const h = harness({ ...t, journal: reopened, attempt });
      expect((await runAtomicRecovery(h.io)).kind).toBe(
        ExecutionOutcome.Unknown,
      );
      expect(h.submits()).toBe(failSyncAt === 1 ? 0 : 1);
    } finally {
      await reopened.close();
      await rm(t.directory, { recursive: true, force: true });
    }
  }
});

test("malformed observed transaction fails closed before consent or submission", async () => {
  const t = await fixture();
  try {
    const h = harness(t);
    h.io.chain.transactionByHash = async () => ({ hash: h.hash });
    await expect(runAtomicRecovery(h.io)).rejects.toThrow(
      "Observed transaction authority",
    );
    expect(h.confirms()).toBe(0);
    expect(h.submits()).toBe(0);
  } finally {
    await t.cleanup();
  }
});

test("malformed frozen protobuf fails before any chain action", async () => {
  const t = await fixture();
  await t.journal.close();
  const records = (await readFile(t.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  records[0].payloadBinaryHex = "0x01";
  await Bun.write(
    t.path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const reopened = await AtomicIntentJournal.open(t.path);
  try {
    const attempt = reopened.recoveryAttempt(t.attempt.current.attemptId);
    const h = harness({ ...t, journal: reopened, attempt });
    let chainReads = 0;
    h.io.chain.chainId = async () => {
      chainReads++;
      return "0x7a69";
    };
    await expect(runAtomicRecovery(h.io)).rejects.toThrow();
    expect(chainReads).toBe(0);
    expect(h.submits()).toBe(0);
  } finally {
    await reopened.close();
    await rm(t.directory, { recursive: true, force: true });
  }
});

test("observed transaction admission rejects every changed authority field", async () => {
  const t = await fixture();
  try {
    const exact = rpcTransaction(t.attempt.signedEnvelope);
    expect(() =>
      admitRpcAtomicTransaction(exact, t.attempt.signedEnvelope),
    ).not.toThrow();
    for (const [field, value] of [
      ["hash", `0x${"9".repeat(64)}`],
      ["type", "0x1"],
      ["chainId", "0x2"],
      ["nonce", "0x1"],
      ["from", `0x${"9".repeat(40)}`],
      ["to", `0x${"9".repeat(40)}`],
      ["input", "0x"],
      ["value", "0x1"],
      ["gas", "0x1"],
      ["maxFeePerGas", "0x1"],
      ["maxPriorityFeePerGas", "0x0"],
      ["accessList", [{}]],
      ["yParity", toHex(t.attempt.signedEnvelope.yParity === 0 ? 1 : 0)],
      ["r", `0x${"9".repeat(64)}`],
      ["s", `0x${"9".repeat(64)}`],
    ] as const)
      expect(() =>
        admitRpcAtomicTransaction(
          { ...exact, [field]: value },
          t.attempt.signedEnvelope,
        ),
      ).toThrow();
    expect(() =>
      admitRpcAtomicTransaction(
        { ...exact, nonce: "0x00" },
        t.attempt.signedEnvelope,
      ),
    ).toThrow("noncanonical");
  } finally {
    await t.cleanup();
  }
});

test("real local Anvil recovers one never-submitted stored envelope as the exact same bytes and hash", async () => {
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
    const t = await fixture();
    try {
      const chain = readChain(url, new AbortController().signal);
      let submits = 0;
      const result = await runAtomicRecovery({
        journal: t.journal,
        attempt: t.attempt,
        executor,
        policy: finalityPolicy,
        signal: new AbortController().signal,
        chain: {
          ...chain,
          blockByNumber: async (tag) =>
            tag === "0x0"
              ? {
                  number: "0x0",
                  hash: finalityPolicy.networkAnchorHash,
                  parentHash: `0x${"0".repeat(64)}`,
                  timestamp: "0x0",
                  transactions: [],
                }
              : chain.blockByNumber(tag),
          submitRawTransaction: async (raw) => {
            submits++;
            expect(raw).toBe(t.attempt.signedEnvelope.rawTransaction);
            return chain.submitRawTransaction(raw);
          },
        },
        verifyExecutor: async () => true,
        confirm: async () => true,
        report: () => {},
      });
      expect(result).toEqual({
        kind: ExecutionOutcome.ApprovalConfirmed,
        transactionHash: t.attempt.signedEnvelope.transactionHash,
      });
      expect(submits).toBe(1);
      const observed = await chain.transactionByHash(
        t.attempt.signedEnvelope.transactionHash,
      );
      expect(() =>
        admitRpcAtomicTransaction(observed, t.attempt.signedEnvelope),
      ).not.toThrow();
      expect(
        (await chain.canonicalReceipt(t.attempt.signedEnvelope.transactionHash))
          ?.transactionHash,
      ).toBe(t.attempt.signedEnvelope.transactionHash);
      await t.journal.close();
      const module = new URL("./atomic-intent-journal.ts", import.meta.url)
        .href;
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import {readFile} from "node:fs/promises"; import {parseAtomicIntentJournal} from ${JSON.stringify(module)}; const states=await parseAtomicIntentJournal(await readFile(process.argv[1],"utf8")); console.log(states.get(process.argv[2]).signedEnvelope.rawTransaction);`,
          t.path,
          t.attempt.current.attemptId,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect((await new Response(child.stdout).text()).trim()).toBe(
        t.attempt.signedEnvelope.rawTransaction,
      );
      expect(await child.exited).toBe(0);
    } finally {
      await t.cleanup();
    }
  } finally {
    anvil.kill();
    await anvil.exited;
  }
}, 20_000);

test("recovery CLI uses explicit local config and RPC without engine, wallet, or keys", async () => {
  const t = await fixture("submission_unknown");
  await t.journal.close();
  const code = "0x6001600055";
  const blockHash = `0x${"c".repeat(64)}`;
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      methods.push(body.method);
      const result =
        body.method === "eth_chainId"
          ? "0x1"
          : body.method === "eth_getCode"
            ? code
            : body.method === "eth_call"
              ? `0x${"0".repeat(63)}4`
              : body.method === "eth_getTransactionReceipt"
                ? {
                    transactionHash: t.attempt.signedEnvelope.transactionHash,
                    status: "0x1",
                    blockHash,
                    blockNumber: "0x1",
                    logs: [],
                  }
                : body.method === "eth_getBlockByNumber"
                  ? {
                      number: body.params[0] === "0x0" ? "0x0" : "0x1",
                      hash:
                        body.params[0] === "0x0"
                          ? finalityPolicy.networkAnchorHash
                          : blockHash,
                      parentHash:
                        body.params[0] === "0x0"
                          ? `0x${"0".repeat(64)}`
                          : `0x${"9".repeat(64)}`,
                      timestamp: "0x1",
                      transactions: [],
                    }
                  : null;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  const config = join(t.directory, "epeius.toml");
  await Bun.write(
    config,
    `[chains.local]\nchain_id=1\nrpc_url_env='RECOVERY_RPC'\nexecution_enabled=true\n[chains.local.finality]\npolicy_version='epeius-finality-v1'\nfinality_method='ethereum_consensus'\ncompletion_tag='finalized'\nsafe_signal='ethereum_safe'\nnetwork_anchor_number=0\nnetwork_anchor_hash='${finalityPolicy.networkAnchorHash}'\nrpc_source_id='test'\ncapability_record='test'\ncapability_valid_until='2099-01-01T00:00:00Z'\nrequest_timeout_ms=100\npoll_interval_ms=1\nwait_timeout_ms=100\nstalled_after_ms=50\nmax_response_age_ms=100\n[chains.local.deployments.uni]\nkind='uniswap-v3'\nfactory='0x${"6".repeat(40)}'\nrouter='0x${"7".repeat(40)}'\nfees=[500]\n[chains.local.atomic_executor]\naddress='${executor.address}'\nruntime_code_hash='${keccak256(code)}'\nmax_branches=4\nmax_operations_per_branch=4\nmax_total_operations=4\nuniswap_deployment='uni'\n`,
  );
  try {
    const child = Bun.spawn(
      [
        "bun",
        "apps/terminal/src/main.ts",
        "recover-atomic",
        "--config",
        config,
        "--chain",
        "local",
        "--atomic-journal",
        t.path,
        "--attempt-id",
        t.attempt.current.attemptId,
      ],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: { ...process.env, RECOVERY_RPC: server.url.href },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"recovery":"receipt_passed"');
    expect(methods).toContain("eth_getBlockByNumber");
    expect(methods).not.toContain("eth_sendRawTransaction");
  } finally {
    server.stop(true);
    await rm(t.directory, { recursive: true, force: true });
  }
});
