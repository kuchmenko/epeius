import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isAddress, isHash, isHex } from "viem";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";

export const ATOMIC_INTENT_JOURNAL_VERSION = 1;

export type AtomicIntentAction = "approval" | "swap";
export type AtomicIntentState =
  | "prepared"
  | "canceled"
  | "handoff_started"
  | "submitted"
  | "receipt_passed"
  | "receipt_failed"
  | "receipt_unavailable"
  | "submission_unknown";

type Intent = {
  attemptId: string;
  action: AtomicIntentAction;
  planId?: string;
  executorPlanHash?: string;
  transactionFingerprint?: string;
  transaction: UnsignedTransaction;
};

export type AtomicIntentAttempt = Intent;

export type AtomicIntentJournalWriter = Pick<
  AtomicIntentJournal,
  "prepare" | "transition"
>;

type Prepared = Intent & {
  schemaVersion: typeof ATOMIC_INTENT_JOURNAL_VERSION;
  state: "prepared";
  payloadType: "approval_response" | "unsigned_preparation";
  payloadBinaryHex: string;
};

type Transition = Intent & {
  schemaVersion: typeof ATOMIC_INTENT_JOURNAL_VERSION;
  state: Exclude<AtomicIntentState, "prepared">;
  transactionHash?: string;
  verification?: "receipt_success" | "economic_pass" | "failed" | "unavailable";
};

type JournalRecord = Prepared | Transition;

export type AtomicIntentJournalHooks = {
  before?: (
    operation:
      | "create_lock"
      | "open_journal"
      | "sync_created_file"
      | "sync_directory"
      | "write"
      | "sync_record",
  ) => void;
  attemptId?: () => string;
};

const baseKeys = [
  "schemaVersion",
  "attemptId",
  "action",
  "state",
  "planId",
  "executorPlanHash",
  "transactionFingerprint",
  "transaction",
] as const;
const preparedKeys = [...baseKeys, "payloadType", "payloadBinaryHex"];
const transitionKeys = [...baseKeys, "transactionHash", "verification"];
const transactionKeys = [
  "chainId",
  "from",
  "to",
  "data",
  "valueAtomic",
  "gasLimit",
];
const transitions: Record<AtomicIntentState, AtomicIntentState[]> = {
  prepared: ["canceled", "handoff_started"],
  canceled: [],
  handoff_started: ["submitted", "submission_unknown"],
  submitted: ["receipt_passed", "receipt_failed", "receipt_unavailable"],
  receipt_passed: [],
  receipt_failed: [],
  receipt_unavailable: [],
  submission_unknown: [],
};
const blocksNewAttempt = new Set<AtomicIntentState>([
  "handoff_started",
  "submitted",
  "receipt_unavailable",
  "submission_unknown",
]);

export class AtomicIntentJournal {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #lockPath: string;
  readonly #lockIdentity: { dev: bigint; ino: bigint };
  readonly #hooks: AtomicIntentJournalHooks;
  readonly #states: Map<string, JournalRecord>;
  #closed = false;

  private constructor(
    file: FileHandle,
    lockPath: string,
    lock: FileHandle,
    lockIdentity: { dev: bigint; ino: bigint },
    hooks: AtomicIntentJournalHooks,
    states: Map<string, JournalRecord>,
  ) {
    this.#file = file;
    this.#lockPath = lockPath;
    this.#lock = lock;
    this.#lockIdentity = lockIdentity;
    this.#hooks = hooks;
    this.#states = states;
  }

  static async open(path: string, hooks: AtomicIntentJournalHooks = {}) {
    if (!path) throw new Error("Atomic intent journal path is required.");
    const lockPath = `${path}.lock`;
    hooks.before?.("create_lock");
    let lock: FileHandle;
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error(
        "Atomic intent journal is already owned or its lock path is unsafe.",
      );
    }
    let lockStat: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      lockStat = await lock.stat({ bigint: true });
    } catch (error) {
      await lock.close().catch(() => {});
      throw error;
    }
    let file: FileHandle | undefined;
    try {
      hooks.before?.("open_journal");
      let created = false;
      try {
        file = await open(
          path,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_APPEND |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        file = await open(
          path,
          constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
        );
      }
      const stat = await file.stat();
      if (!stat.isFile())
        throw new Error("Atomic intent journal must be a regular file.");
      if ((stat.mode & 0o777) !== 0o600)
        throw new Error("Atomic intent journal permissions must be 0600.");
      if (created) {
        hooks.before?.("sync_created_file");
        await file.sync();
        hooks.before?.("sync_directory");
        const directory = await open(
          dirname(path),
          constants.O_RDONLY | constants.O_DIRECTORY,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      const raw = await file.readFile({ encoding: "utf8" });
      const states = parseAtomicIntentJournal(raw);
      return new AtomicIntentJournal(
        file,
        lockPath,
        lock,
        { dev: lockStat.dev, ino: lockStat.ino },
        hooks,
        states,
      );
    } catch (error) {
      await file?.close().catch(() => {});
      await lock.close().catch(() => {});
      await unlinkSameFile(lockPath, {
        dev: lockStat.dev,
        ino: lockStat.ino,
      });
      throw error instanceof Error
        ? error
        : new Error("Atomic intent journal could not be opened safely.");
    }
  }

  async prepare(input: {
    action: AtomicIntentAction;
    payloadType: Prepared["payloadType"];
    payloadBinary: Uint8Array;
    planId?: string;
    executorPlanHash?: string;
    transactionFingerprint?: string;
    transaction: UnsignedTransaction;
  }): Promise<AtomicIntentAttempt> {
    this.#assertOpen();
    if (
      [...this.#states.values()].some((record) =>
        blocksNewAttempt.has(record.state),
      )
    )
      throw new Error(
        "Atomic intent journal contains an unresolved handoff; do not resend.",
      );
    const attempt: AtomicIntentAttempt = {
      attemptId: (this.#hooks.attemptId ?? randomUUID)(),
      action: input.action,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.executorPlanHash
        ? { executorPlanHash: input.executorPlanHash }
        : {}),
      ...(input.transactionFingerprint
        ? { transactionFingerprint: input.transactionFingerprint }
        : {}),
      transaction: journalTransaction(input.transaction),
    };
    const record: Prepared = {
      schemaVersion: ATOMIC_INTENT_JOURNAL_VERSION,
      ...attempt,
      state: "prepared",
      payloadType: input.payloadType,
      payloadBinaryHex: `0x${Buffer.from(input.payloadBinary).toString("hex")}`,
    };
    validateRecord(record);
    if (this.#states.has(attempt.attemptId))
      throw new Error("Atomic intent journal attempt ID is already present.");
    await this.#append(record);
    this.#states.set(attempt.attemptId, record);
    return attempt;
  }

  async transition(
    attempt: AtomicIntentAttempt,
    state: Exclude<AtomicIntentState, "prepared">,
    details: Pick<Transition, "transactionHash" | "verification"> = {},
  ) {
    this.#assertOpen();
    const previous = this.#states.get(attempt.attemptId);
    if (!previous || !transitions[previous.state].includes(state))
      throw new Error("Atomic intent journal transition is invalid.");
    const record: Transition = {
      schemaVersion: ATOMIC_INTENT_JOURNAL_VERSION,
      ...structuredClone(attempt),
      state,
      ...details,
    };
    validateRecord(record);
    assertSameIntent(previous, record);
    assertSameTransactionHash(previous, record);
    await this.#append(record);
    this.#states.set(attempt.attemptId, record);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#file.close().catch(() => {});
    await this.#lock.close().catch(() => {});
    await unlinkSameFile(this.#lockPath, this.#lockIdentity);
  }

  async #append(record: JournalRecord) {
    this.#hooks.before?.("write");
    await this.#file.writeFile(`${JSON.stringify(record)}\n`, {
      encoding: "utf8",
    });
    this.#hooks.before?.("sync_record");
    await this.#file.sync();
  }

  #assertOpen() {
    if (this.#closed)
      throw new Error("Atomic intent journal is already closed.");
  }
}

export function parseAtomicIntentJournal(raw: string) {
  const states = new Map<string, JournalRecord>();
  if (!raw) return states;
  if (!raw.endsWith("\n"))
    throw new Error("Atomic intent journal has a partial final record.");
  for (const line of raw.slice(0, -1).split("\n")) {
    if (!line)
      throw new Error("Atomic intent journal contains an empty record.");
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Atomic intent journal contains malformed JSON.");
    }
    validateRecord(record);
    const current = record as JournalRecord;
    const previous = states.get(current.attemptId);
    if (current.state === "prepared") {
      if (previous)
        throw new Error("Atomic intent journal contains a duplicate attempt.");
    } else {
      if (!previous || !transitions[previous.state].includes(current.state))
        throw new Error(
          "Atomic intent journal transition sequence is invalid.",
        );
      assertSameIntent(previous, current);
      assertSameTransactionHash(previous, current);
    }
    states.set(current.attemptId, current);
  }
  return states;
}

function validateRecord(value: unknown): asserts value is JournalRecord {
  if (!plainObject(value))
    throw new Error("Atomic intent journal record must be an object.");
  if (value.schemaVersion !== ATOMIC_INTENT_JOURNAL_VERSION)
    throw new Error("Atomic intent journal schema version is unsupported.");
  if (
    typeof value.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.attemptId,
    ) ||
    (value.action !== "approval" && value.action !== "swap") ||
    typeof value.state !== "string" ||
    !Object.hasOwn(transitions, value.state)
  )
    throw new Error("Atomic intent journal record identity is invalid.");
  const state = value.state as AtomicIntentState;
  exactKeys(value, state === "prepared" ? preparedKeys : transitionKeys);
  for (const name of [
    "planId",
    "executorPlanHash",
    "transactionFingerprint",
  ] as const)
    if (value[name] !== undefined && !isHash(value[name] as string))
      throw new Error("Atomic intent journal hash identity is invalid.");
  validateTransaction(value.transaction);
  if (state === "prepared") {
    if (
      (value.payloadType !== "approval_response" &&
        value.payloadType !== "unsigned_preparation") ||
      typeof value.payloadBinaryHex !== "string" ||
      !isHex(value.payloadBinaryHex, { strict: true }) ||
      value.payloadBinaryHex.length <= 2 ||
      value.payloadBinaryHex.length % 2 !== 0 ||
      (value.action === "approval") !==
        (value.payloadType === "approval_response") ||
      (value.action === "swap") !==
        (value.payloadType === "unsigned_preparation") ||
      (value.action === "swap" &&
        (!value.planId ||
          !value.executorPlanHash ||
          !value.transactionFingerprint))
    )
      throw new Error("Atomic intent journal prepared payload is invalid.");
    return;
  }
  const hashRequired = [
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
  ].includes(state);
  if (
    (hashRequired && !isHash(value.transactionHash as string)) ||
    (!hashRequired && value.transactionHash !== undefined) ||
    ["receipt_passed", "receipt_failed", "receipt_unavailable"].includes(
      state,
    ) !==
      (value.verification !== undefined) ||
    (state === "receipt_passed" &&
      !["receipt_success", "economic_pass"].includes(
        value.verification as string,
      )) ||
    (state === "receipt_failed" && value.verification !== "failed") ||
    (state === "receipt_unavailable" && value.verification !== "unavailable")
  )
    throw new Error("Atomic intent journal transition details are invalid.");
  if (
    state === "receipt_passed" &&
    (value.action === "approval") !== (value.verification === "receipt_success")
  )
    throw new Error("Atomic intent journal receipt meaning is invalid.");
}

function validateTransaction(value: unknown) {
  if (!plainObject(value))
    throw new Error("Atomic intent journal transaction is invalid.");
  exactKeys(value, transactionKeys);
  if (
    typeof value.chainId !== "string" ||
    !/^[1-9][0-9]*$/.test(value.chainId) ||
    typeof value.from !== "string" ||
    !isAddress(value.from, { strict: false }) ||
    typeof value.to !== "string" ||
    !isAddress(value.to, { strict: false }) ||
    typeof value.data !== "string" ||
    !isHex(value.data, { strict: true }) ||
    value.data.length <= 2 ||
    value.data.length % 2 !== 0 ||
    typeof value.valueAtomic !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.valueAtomic) ||
    typeof value.gasLimit !== "string" ||
    !/^[1-9][0-9]*$/.test(value.gasLimit)
  )
    throw new Error("Atomic intent journal transaction fields are invalid.");
}

function journalTransaction(
  transaction: UnsignedTransaction,
): UnsignedTransaction {
  const result = {
    chainId: transaction.chainId,
    from: transaction.from,
    to: transaction.to,
    data: transaction.data,
    valueAtomic: transaction.valueAtomic,
    gasLimit: transaction.gasLimit,
  } as UnsignedTransaction;
  Object.defineProperty(result, "$typeName", {
    value: transaction.$typeName,
    enumerable: false,
  });
  return result;
}

function assertSameIntent(previous: JournalRecord, current: JournalRecord) {
  for (const name of [
    "attemptId",
    "action",
    "planId",
    "executorPlanHash",
    "transactionFingerprint",
  ] as const)
    if (previous[name] !== current[name])
      throw new Error(
        "Atomic intent journal identity changed within an attempt.",
      );
  if (
    JSON.stringify(previous.transaction) !== JSON.stringify(current.transaction)
  )
    throw new Error(
      "Atomic intent journal transaction changed within an attempt.",
    );
}

function assertSameTransactionHash(
  previous: JournalRecord,
  current: JournalRecord,
) {
  if (
    current.state.startsWith("receipt_") &&
    previous.state === "submitted" &&
    "transactionHash" in current &&
    previous.transactionHash !== current.transactionHash
  )
    throw new Error(
      "Atomic intent journal transaction hash changed within an attempt.",
    );
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Atomic intent journal record contains unknown fields.");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function unlinkSameFile(
  path: string,
  identity: { dev: bigint; ino: bigint },
) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.dev === identity.dev && stat.ino === identity.ino)
      await unlink(path);
  } catch {
    // A missing or replaced lock is not safe to remove.
  }
}
