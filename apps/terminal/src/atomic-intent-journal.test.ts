import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { privateKeyToAccount } from "viem/accounts";
import { UnsignedTransactionSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  AtomicIntentJournal,
  parseAtomicIntentJournal,
} from "./atomic-intent-journal";
import {
  admitSignedAtomicEnvelope,
  atomicEnvelope,
} from "./atomic-signed-envelope";
import { parseAtomicFinalityPolicy } from "./finality-policy";

const id = "12345678-1234-4123-8123-123456789abc";
const planId = `0x${"1".repeat(64)}`;
const executorPlanHash = `0x${"2".repeat(64)}`;
const transactionFingerprint = `0x${"3".repeat(64)}`;
const transactionHash = `0x${"4".repeat(64)}`;
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const transaction = create(UnsignedTransactionSchema, {
  chainId: "8453",
  from: account.address,
  to: `0x${"6".repeat(40)}`,
  valueAtomic: "0",
  data: "0x123456",
  gasLimit: "987654",
});
const envelope = atomicEnvelope(9n, 30n, 2n);
const finalityPolicy = parseAtomicFinalityPolicy(
  {
    policy_version: "epeius-finality-v1",
    finality_method: "op_l1_derivation",
    completion_tag: "finalized",
    parent_chain_id: 1,
    safe_signal: "op_derived_safe",
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
  "8453",
  0,
);

async function signedEnvelope() {
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: 8453,
    nonce: 9,
    maxFeePerGas: 30n,
    maxPriorityFeePerGas: 2n,
    gas: 987654n,
    to: transaction.to as `0x${string}`,
    value: 0n,
    data: transaction.data as `0x${string}`,
    accessList: [],
  });
  return admitSignedAtomicEnvelope(raw, transaction, envelope);
}

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "epeius-atomic-journal-"));
  return {
    directory,
    path: join(directory, "intent.jsonl"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const lines = (raw: string) =>
  raw
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("journal creates mode 0600, fsyncs file and directory, and preserves exact intent bytes", async () => {
  const t = await temporary();
  const operations: string[] = [];
  try {
    const journal = await AtomicIntentJournal.open(t.path, {
      before: (operation) => operations.push(operation),
      attemptId: () => id,
    });
    const binary = Uint8Array.of(0, 1, 2, 127, 128, 255);
    const attempt = await journal.prepare({
      action: "swap",
      payloadType: "unsigned_preparation",
      payloadBinary: binary,
      planId,
      executorPlanHash,
      transactionFingerprint,
      transaction,
      envelope,
      finalityPolicy,
    });
    const signed = await journal.sign(attempt, await signedEnvelope());
    await journal.transition(signed, "submitted", {
      transactionHash: signed.signedEnvelope.transactionHash,
    });
    await journal.close();

    expect((await lstat(t.path)).mode & 0o777).toBe(0o600);
    expect(operations).toEqual([
      "create_lock",
      "open_journal",
      "sync_created_file",
      "sync_directory",
      "write",
      "sync_record",
      "write",
      "sync_record",
      "write",
      "sync_record",
    ]);
    const records = lines(await readFile(t.path, "utf8"));
    expect(records.map((record) => record.state)).toEqual([
      "prepared",
      "signed",
      "submitted",
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        schemaVersion: 3,
        attemptId: id,
        action: "swap",
        planId,
        executorPlanHash,
        transactionFingerprint,
        transaction: {
          chainId: "8453",
          from: transaction.from,
          to: transaction.to,
          valueAtomic: "0",
          data: "0x123456",
          gasLimit: "987654",
        },
        envelope,
      });
      expect(record.transaction).not.toHaveProperty("$typeName");
    }
    expect(records[0]).toMatchObject({
      payloadType: "unsigned_preparation",
      payloadBinaryHex: "0x0001027f80ff",
    });
    expect(records[2]).toMatchObject({
      transactionHash: signed.signedEnvelope.transactionHash,
    });
    const raw = await readFile(t.path, "utf8");
    await expect(parseAtomicIntentJournal(raw)).resolves.toBeDefined();
    expect(await Bun.file(`${t.path}.lock`).exists()).toBe(false);
  } finally {
    await t.cleanup();
  }
});

test("journal rejects symlinks, non-regular files, and unsafe existing permissions", async () => {
  const t = await temporary();
  try {
    const target = join(t.directory, "target");
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, t.path);
    await expect(AtomicIntentJournal.open(t.path)).rejects.toThrow();
    await rm(t.path);
    await writeFile(t.path, "", { mode: 0o600 });
    await chmod(t.path, 0o640);
    await expect(AtomicIntentJournal.open(t.path)).rejects.toThrow("0600");
    await rm(t.path);
    await expect(AtomicIntentJournal.open(t.directory)).rejects.toThrow();
  } finally {
    await t.cleanup();
  }
});

test("exclusive lock rejects concurrent process ownership without interleaving", async () => {
  const t = await temporary();
  try {
    const module = new URL("./atomic-intent-journal.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {AtomicIntentJournal} from ${JSON.stringify(module)}; const j=await AtomicIntentJournal.open(process.argv[1]); console.log("locked"); await Bun.sleep(30000); await j.close();`,
        t.path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    await expect(AtomicIntentJournal.open(t.path)).rejects.toThrow(
      "already owned",
    );
    child.kill();
    await child.exited;
    reader.releaseLock();
    expect(await readFile(t.path, "utf8")).toBe("");
  } finally {
    await t.cleanup();
  }
});

test("parser rejects malformed, partial, unknown, reordered, duplicate, and mismatched records", async () => {
  const t = await temporary();
  try {
    const journal = await AtomicIntentJournal.open(t.path, {
      attemptId: () => id,
    });
    const attempt = await journal.prepare({
      action: "swap",
      payloadType: "unsigned_preparation",
      payloadBinary: Uint8Array.of(1),
      planId,
      executorPlanHash,
      transactionFingerprint,
      transaction,
      envelope,
      finalityPolicy,
    });
    const signed = await journal.sign(attempt, await signedEnvelope());
    await journal.transition(signed, "submitted", {
      transactionHash: signed.signedEnvelope.transactionHash,
    });
    await journal.close();
    const valid = lines(await readFile(t.path, "utf8"));
    const encode = (records: unknown[]) =>
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const mutations: string[] = [
      "{",
      JSON.stringify(valid[0]),
      encode([{ ...valid[0], schemaVersion: 4 }]),
      encode([{ ...valid[0], mode: "atomic-v2" }]),
      encode([valid[1]]),
      encode([valid[0], valid[0]]),
      encode([valid[0], valid[1], valid[1]]),
      encode([valid[0], valid[2]]),
      encode([
        valid[0],
        valid[1],
        { ...valid[2], planId: `0x${"9".repeat(64)}` },
      ]),
      encode([valid[0], valid[1], { ...valid[2], action: "approval" }]),
      encode([
        valid[0],
        valid[1],
        { ...valid[2], executorPlanHash: `0x${"9".repeat(64)}` },
      ]),
      encode([
        valid[0],
        valid[1],
        { ...valid[2], transactionFingerprint: `0x${"9".repeat(64)}` },
      ]),
      encode([
        valid[0],
        valid[1],
        {
          ...valid[2],
          transaction: { ...valid[2].transaction, gasLimit: "987655" },
        },
      ]),
      encode([valid[0], valid[1], { ...valid[2], transactionHash: "0x12" }]),
      encode([
        valid[0],
        valid[1],
        valid[2],
        {
          ...valid[2],
          state: "receipt_passed",
          transactionHash: `0x${"8".repeat(64)}`,
          verification: "economic_pass",
        },
      ]),
    ];
    const signedMutations: Record<string, unknown>[] = [
      { type: 3 },
      { nonce: "10" },
      { maxFeePerGasAtomic: "31" },
      { maxPriorityFeePerGasAtomic: "3" },
      { accessList: [{}] },
      { chainId: "1" },
      { signer: `0x${"9".repeat(40)}` },
      { to: `0x${"9".repeat(40)}` },
      { valueAtomic: "1" },
      { data: "0x12" },
      { gasLimit: "987655" },
      { yParity: valid[1].signedEnvelope.yParity === 0 ? 1 : 0 },
      { r: `0x${"0".repeat(64)}` },
      { s: `0x${"0".repeat(64)}` },
      {
        rawTransaction: `${valid[1].signedEnvelope.rawTransaction.slice(0, -2)}00`,
      },
      { transactionHash: `0x${"9".repeat(64)}` },
    ];
    for (const mutation of signedMutations)
      mutations.push(
        encode([
          valid[0],
          {
            ...valid[1],
            signedEnvelope: { ...valid[1].signedEnvelope, ...mutation },
          },
        ]),
      );
    for (const mutation of mutations)
      await expect(parseAtomicIntentJournal(mutation)).rejects.toThrow();
  } finally {
    await t.cleanup();
  }
});

test("open and append failures stop before authority can advance", async () => {
  for (const failAt of [
    "create_lock",
    "open_journal",
    "sync_created_file",
    "sync_directory",
  ] as const) {
    const t = await temporary();
    try {
      await expect(
        AtomicIntentJournal.open(t.path, {
          before: (operation) => {
            if (operation === failAt) throw new Error(`fail ${failAt}`);
          },
        }),
      ).rejects.toThrow(`fail ${failAt}`);
      expect(await Bun.file(`${t.path}.lock`).exists()).toBe(false);
    } finally {
      await t.cleanup();
    }
  }

  for (const failAt of ["write", "sync_record"] as const) {
    const t = await temporary();
    try {
      const journal = await AtomicIntentJournal.open(t.path, {
        attemptId: () => id,
        before: (operation) => {
          if (operation === failAt) throw new Error(`fail ${failAt}`);
        },
      });
      await expect(
        journal.prepare({
          action: "approval",
          payloadType: "approval_response",
          payloadBinary: Uint8Array.of(1),
          planId,
          transaction,
          envelope,
          finalityPolicy,
        }),
      ).rejects.toThrow(`fail ${failAt}`);
      await journal.close();
    } finally {
      await t.cleanup();
    }
  }
});

test("unresolved handoff history blocks every new attempt on reopen", async () => {
  const t = await temporary();
  try {
    const journal = await AtomicIntentJournal.open(t.path, {
      attemptId: () => id,
    });
    const attempt = await journal.prepare({
      action: "approval",
      payloadType: "approval_response",
      payloadBinary: Uint8Array.of(1),
      planId,
      transaction,
      envelope,
      finalityPolicy,
    });
    await journal.sign(attempt, await signedEnvelope());
    await journal.close();
    const reopened = await AtomicIntentJournal.open(t.path);
    await expect(
      reopened.prepare({
        action: "approval",
        payloadType: "approval_response",
        payloadBinary: Uint8Array.of(2),
        planId,
        transaction,
        envelope,
        finalityPolicy,
      }),
    ).rejects.toThrow("do not resend");
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test("complete schema-v1 history remains valid without reinterpretation", async () => {
  const t = await temporary();
  try {
    const base = {
      schemaVersion: 1,
      attemptId: id,
      action: "swap",
      planId,
      executorPlanHash,
      transactionFingerprint,
      transaction: {
        chainId: transaction.chainId,
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        valueAtomic: transaction.valueAtomic,
        gasLimit: transaction.gasLimit,
      },
    };
    const records = [
      {
        ...base,
        state: "prepared",
        payloadType: "unsigned_preparation",
        payloadBinaryHex: "0x01",
      },
      { ...base, state: "handoff_started" },
      { ...base, state: "submitted", transactionHash },
      {
        ...base,
        state: "receipt_failed",
        transactionHash,
        verification: "failed",
      },
    ];
    const raw = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await expect(parseAtomicIntentJournal(raw)).resolves.toBeDefined();
    await writeFile(t.path, raw, { mode: 0o600 });
    const journal = await AtomicIntentJournal.open(t.path, {
      attemptId: () => "abcdefab-cdef-4abc-8def-abcdefabcdef",
    });
    expect(() => journal.recoveryAttempt(id)).toThrow("inspect-only");
    await expect(
      journal.prepare({
        action: "approval",
        payloadType: "approval_response",
        payloadBinary: Uint8Array.of(2),
        planId,
        transaction,
        envelope,
        finalityPolicy,
      }),
    ).resolves.toBeDefined();
    await journal.close();
    const appended = lines(await readFile(t.path, "utf8"));
    expect(appended.map(({ schemaVersion }) => schemaVersion)).toEqual([
      1, 1, 1, 1, 3,
    ]);
  } finally {
    await t.cleanup();
  }
});

test("historical schema-2 swap receipt is explicitly migrated before finality retry", async () => {
  const t = await temporary();
  try {
    let journal = await AtomicIntentJournal.open(t.path, {
      attemptId: () => id,
    });
    const attempt = await journal.prepare({
      action: "swap",
      payloadType: "unsigned_preparation",
      payloadBinary: Uint8Array.of(1),
      planId,
      executorPlanHash,
      transactionFingerprint,
      transaction,
      envelope,
      finalityPolicy,
    });
    const signed = await journal.sign(attempt, await signedEnvelope());
    await journal.transition(signed, "submitted", {
      transactionHash: signed.signedEnvelope.transactionHash,
    });
    await journal.close();
    const historical = lines(await readFile(t.path, "utf8")).map(
      ({ finalityPolicy: _, ...record }) => ({ ...record, schemaVersion: 2 }),
    );
    historical.push({
      ...historical.at(-1),
      state: "receipt_passed",
      transactionHash: signed.signedEnvelope.transactionHash,
      verification: "economic_pass",
    });
    await writeFile(
      t.path,
      `${historical.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { mode: 0o600 },
    );
    journal = await AtomicIntentJournal.open(t.path);
    const recovery = journal.recoveryAttempt(id);
    await journal.recoveryTransition(recovery, "finality_unknown", {
      transactionHash: signed.signedEnvelope.transactionHash,
      finalityReason: "wait_timeout",
      finalityPolicy,
    });
    await journal.close();
    const records = lines(await readFile(t.path, "utf8"));
    expect(records.at(-2)).toMatchObject({
      schemaVersion: 2,
      state: "receipt_passed",
      verification: "economic_pass",
    });
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 3,
      state: "finality_unknown",
      finalityReason: "wait_timeout",
      finalityPolicy,
    });
  } finally {
    await t.cleanup();
  }
});
