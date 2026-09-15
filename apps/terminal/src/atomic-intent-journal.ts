import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isAddress, isHash, isHex } from "viem";
import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type {
  AtomicFinalityEvidence,
  AtomicProvisionalEvidence,
} from "./atomic-finality";
import {
  validateStoredFinalityEvidence,
  validateStoredProvisionalEvidence,
} from "./atomic-finality";
import type {
  AtomicEnvelope,
  SignedAtomicEnvelope,
} from "./atomic-signed-envelope";
import { admitSignedAtomicEnvelope } from "./atomic-signed-envelope";
import type { AtomicFinalityPolicy } from "./finality-policy";
import { validateStoredFinalityPolicy } from "./finality-policy";

export const ATOMIC_INTENT_JOURNAL_VERSION = 3;

export type AtomicIntentAction = "approval" | "swap";
export type AtomicIntentState =
  | "prepared"
  | "canceled"
  | "handoff_started"
  | "signed"
  | "submission_observed"
  | "recovery_handoff_started"
  | "submitted"
  | "receipt_passed"
  | "receipt_failed"
  | "receipt_unavailable"
  | "receipt_observed"
  | "finality_unknown"
  | "finalized_complete"
  | "finalized_failed"
  | "submission_unknown";

type Intent = {
  attemptId: string;
  action: AtomicIntentAction;
  planId?: string;
  executorPlanHash?: string;
  transactionFingerprint?: string;
  transaction: UnsignedTransaction;
  envelope: AtomicEnvelope;
  finalityPolicy: AtomicFinalityPolicy;
};

export type AtomicIntentAttempt = Intent;
export type SignedAtomicIntentAttempt = Intent & {
  signedEnvelope: SignedAtomicEnvelope;
};

export type AtomicIntentJournalWriter = Pick<
  AtomicIntentJournal,
  "prepare" | "sign" | "transition"
>;

type Prepared = Intent & {
  schemaVersion: typeof ATOMIC_INTENT_JOURNAL_VERSION;
  state: "prepared";
  payloadType: "approval_response" | "unsigned_preparation";
  payloadBinaryHex: string;
};

export type AtomicRecoveryAttempt = {
  prepared: Prepared | V2Prepared;
  current: JournalRecord;
  signedEnvelope: SignedAtomicEnvelope;
};

type Transition = Intent & {
  schemaVersion: typeof ATOMIC_INTENT_JOURNAL_VERSION;
  state: Exclude<AtomicIntentState, "prepared">;
  signedEnvelope?: SignedAtomicEnvelope;
  transactionHash?: string;
  verification?: "receipt_success" | "economic_pass" | "failed" | "unavailable";
  provisionalEvidence?: AtomicProvisionalEvidence;
  finalityEvidence?: AtomicFinalityEvidence;
  finalityReason?: string;
};

type WithoutV3<T> = T extends unknown
  ? Omit<
      T,
      | "schemaVersion"
      | "finalityPolicy"
      | "provisionalEvidence"
      | "finalityEvidence"
      | "finalityReason"
    > & { schemaVersion: 2 }
  : never;
type V2JournalRecord = WithoutV3<Prepared | Transition>;
type V2Prepared = Extract<V2JournalRecord, { state: "prepared" }>;
type V1JournalRecord = Omit<
  V2JournalRecord,
  "schemaVersion" | "envelope" | "signedEnvelope"
> & {
  schemaVersion: 1;
  signedEnvelope?: never;
};
type JournalRecord = Prepared | Transition | V2JournalRecord | V1JournalRecord;

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
  "envelope",
  "finalityPolicy",
] as const;
const preparedKeys = [...baseKeys, "payloadType", "payloadBinaryHex"];
const transitionKeys = [
  ...baseKeys,
  "signedEnvelope",
  "transactionHash",
  "verification",
  "provisionalEvidence",
  "finalityEvidence",
  "finalityReason",
];
const v2BaseKeys = baseKeys.filter((key) => key !== "finalityPolicy");
const v2PreparedKeys = [...v2BaseKeys, "payloadType", "payloadBinaryHex"];
const v2TransitionKeys = [
  ...v2BaseKeys,
  "signedEnvelope",
  "transactionHash",
  "verification",
];
const v1BaseKeys = v2BaseKeys.filter((key) => key !== "envelope");
const v1PreparedKeys = [...v1BaseKeys, "payloadType", "payloadBinaryHex"];
const v1TransitionKeys = [...v1BaseKeys, "transactionHash", "verification"];
const transactionKeys = [
  "chainId",
  "from",
  "to",
  "data",
  "valueAtomic",
  "gasLimit",
];
const envelopeKeys = [
  "type",
  "nonce",
  "maxFeePerGasAtomic",
  "maxPriorityFeePerGasAtomic",
  "accessList",
];
const signedEnvelopeKeys = [
  ...envelopeKeys,
  "chainId",
  "signer",
  "to",
  "valueAtomic",
  "data",
  "gasLimit",
  "yParity",
  "r",
  "s",
  "rawTransaction",
  "transactionHash",
];
const transitionsV1: Partial<Record<AtomicIntentState, AtomicIntentState[]>> = {
  prepared: ["canceled", "handoff_started"],
  canceled: [],
  handoff_started: ["submitted", "submission_unknown"],
  submitted: ["receipt_passed", "receipt_failed", "receipt_unavailable"],
  receipt_passed: [],
  receipt_failed: [],
  receipt_unavailable: [],
  submission_unknown: [],
};
const transitionsV2: Partial<Record<AtomicIntentState, AtomicIntentState[]>> = {
  prepared: ["canceled", "signed"],
  canceled: [],
  signed: [
    "submission_observed",
    "recovery_handoff_started",
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "submission_unknown",
  ],
  submission_observed: [
    "submission_observed",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
  ],
  recovery_handoff_started: [
    "submission_observed",
    "recovery_handoff_started",
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "submission_unknown",
  ],
  submitted: [
    "submission_observed",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
  ],
  receipt_passed: [],
  receipt_failed: [],
  receipt_unavailable: [
    "submission_observed",
    "recovery_handoff_started",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
  ],
  submission_unknown: [
    "submission_observed",
    "recovery_handoff_started",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
  ],
};
const transitionsV3: Partial<Record<AtomicIntentState, AtomicIntentState[]>> = {
  prepared: ["canceled", "signed"],
  canceled: [],
  signed: [
    "submission_observed",
    "recovery_handoff_started",
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
    "submission_unknown",
  ],
  submission_observed: [
    "submission_observed",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
  ],
  recovery_handoff_started: [
    "submission_observed",
    "recovery_handoff_started",
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
    "submission_unknown",
  ],
  submitted: [
    "submission_observed",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
  ],
  receipt_passed: [],
  receipt_failed: [],
  receipt_unavailable: [
    "submission_observed",
    "recovery_handoff_started",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
  ],
  receipt_observed: [
    "receipt_observed",
    "finality_unknown",
    "finalized_complete",
    "finalized_failed",
  ],
  finality_unknown: [
    "receipt_observed",
    "finality_unknown",
    "finalized_complete",
    "finalized_failed",
  ],
  finalized_complete: [],
  finalized_failed: [],
  submission_unknown: [
    "submission_observed",
    "recovery_handoff_started",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
  ],
};
const blocksNewAttempt = new Set<AtomicIntentState>([
  "handoff_started",
  "signed",
  "submission_observed",
  "recovery_handoff_started",
  "submitted",
  "receipt_unavailable",
  "submission_unknown",
  "receipt_observed",
  "finality_unknown",
]);

export class AtomicIntentJournal {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #lockPath: string;
  readonly #lockIdentity: { dev: bigint; ino: bigint };
  readonly #hooks: AtomicIntentJournalHooks;
  readonly #states: Map<string, JournalRecord>;
  readonly #prepared: Map<string, Prepared | V2Prepared | V1JournalRecord>;
  #closed = false;

  private constructor(
    file: FileHandle,
    lockPath: string,
    lock: FileHandle,
    lockIdentity: { dev: bigint; ino: bigint },
    hooks: AtomicIntentJournalHooks,
    states: Map<string, JournalRecord>,
    prepared: Map<string, Prepared | V2Prepared | V1JournalRecord>,
  ) {
    this.#file = file;
    this.#lockPath = lockPath;
    this.#lock = lock;
    this.#lockIdentity = lockIdentity;
    this.#hooks = hooks;
    this.#states = states;
    this.#prepared = prepared;
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
      const { states, prepared } = await parseAtomicIntentJournalHistory(raw);
      return new AtomicIntentJournal(
        file,
        lockPath,
        lock,
        { dev: lockStat.dev, ino: lockStat.ino },
        hooks,
        states,
        prepared,
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
    envelope: AtomicEnvelope;
    finalityPolicy: AtomicFinalityPolicy;
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
      envelope: structuredClone(input.envelope),
      finalityPolicy: structuredClone(input.finalityPolicy),
    };
    const record: Prepared = {
      schemaVersion: ATOMIC_INTENT_JOURNAL_VERSION,
      ...attempt,
      state: "prepared",
      payloadType: input.payloadType,
      payloadBinaryHex: `0x${Buffer.from(input.payloadBinary).toString("hex")}`,
    };
    await validateRecord(record);
    if (this.#states.has(attempt.attemptId))
      throw new Error("Atomic intent journal attempt ID is already present.");
    await this.#append(record);
    this.#states.set(attempt.attemptId, record);
    this.#prepared.set(attempt.attemptId, record);
    return attempt;
  }

  async sign(
    attempt: AtomicIntentAttempt,
    signedEnvelope: SignedAtomicEnvelope,
  ): Promise<SignedAtomicIntentAttempt> {
    this.#assertOpen();
    const previous = this.#states.get(attempt.attemptId);
    if (
      !previous ||
      previous.schemaVersion !== ATOMIC_INTENT_JOURNAL_VERSION ||
      previous.state !== "prepared"
    )
      throw new Error("Atomic intent journal signed transition is invalid.");
    const signedAttempt = {
      ...structuredClone(attempt),
      signedEnvelope: structuredClone(signedEnvelope),
    };
    const record: Transition = {
      schemaVersion: ATOMIC_INTENT_JOURNAL_VERSION,
      ...signedAttempt,
      state: "signed",
    };
    await validateRecord(record);
    assertSameIntent(previous, record);
    await this.#append(record);
    this.#states.set(attempt.attemptId, record);
    return signedAttempt;
  }

  async transition(
    attempt: AtomicIntentAttempt | SignedAtomicIntentAttempt,
    state: Exclude<
      AtomicIntentState,
      "prepared" | "handoff_started" | "signed"
    >,
    details: Pick<
      Transition,
      | "transactionHash"
      | "verification"
      | "provisionalEvidence"
      | "finalityEvidence"
      | "finalityReason"
    > = {},
  ) {
    this.#assertOpen();
    const previous = this.#states.get(attempt.attemptId);
    if (
      !previous ||
      previous.schemaVersion !== ATOMIC_INTENT_JOURNAL_VERSION ||
      !(transitionsV3[previous.state] ?? []).includes(state)
    )
      throw new Error("Atomic intent journal transition is invalid.");
    const record: Transition = {
      schemaVersion: ATOMIC_INTENT_JOURNAL_VERSION,
      ...structuredClone(attempt),
      state,
      ...details,
    };
    await validateRecord(record);
    assertSameIntent(previous, record);
    assertSameSignedEnvelope(previous, record);
    assertSameTransactionHash(previous, record);
    await this.#append(record);
    this.#states.set(attempt.attemptId, record);
  }

  recoveryAttempt(attemptId: string): AtomicRecoveryAttempt {
    this.#assertOpen();
    const prepared = this.#prepared.get(attemptId);
    const current = this.#states.get(attemptId);
    if (!prepared || !current)
      throw new Error("Atomic recovery attempt was not found.");
    if (
      ![2, 3].includes(prepared.schemaVersion) ||
      ![2, 3].includes(current.schemaVersion)
    )
      throw new Error(
        "Atomic journal schema 1 is inspect-only and unrecoverable.",
      );
    if (
      current.state === "canceled" ||
      ["finalized_complete", "finalized_failed"].includes(current.state) ||
      (current.action === "approval" &&
        ["receipt_passed", "receipt_failed"].includes(current.state))
    )
      throw new Error("Atomic recovery attempt is canceled or final.");
    if (
      ![
        "signed",
        "submission_observed",
        "recovery_handoff_started",
        "submission_unknown",
        "submitted",
        "receipt_unavailable",
        "receipt_passed",
        "receipt_failed",
        "receipt_observed",
        "finality_unknown",
      ].includes(current.state) ||
      !("signedEnvelope" in current) ||
      !current.signedEnvelope
    )
      throw new Error(
        "Atomic recovery attempt has no recoverable signed bytes.",
      );
    return {
      prepared: structuredClone(prepared) as Prepared | V2Prepared,
      current: structuredClone(current),
      signedEnvelope: structuredClone(current.signedEnvelope),
    };
  }

  async recoveryTransition(
    attempt: AtomicRecoveryAttempt,
    state:
      | "submission_observed"
      | "recovery_handoff_started"
      | "submitted"
      | "receipt_passed"
      | "receipt_failed"
      | "receipt_unavailable"
      | "receipt_observed"
      | "finality_unknown"
      | "finalized_complete"
      | "finalized_failed"
      | "submission_unknown",
    details: Partial<
      Pick<
        Transition,
        | "transactionHash"
        | "verification"
        | "provisionalEvidence"
        | "finalityEvidence"
        | "finalityReason"
        | "finalityPolicy"
      >
    > = {},
  ) {
    this.#assertOpen();
    const previous = this.#states.get(attempt.current.attemptId);
    if (
      !previous ||
      ![2, 3].includes(previous.schemaVersion) ||
      JSON.stringify(previous) !== JSON.stringify(attempt.current) ||
      (!(transitionsFor(previous.schemaVersion)[previous.state] ?? []).includes(
        state,
      ) &&
        !(
          previous.schemaVersion === 2 &&
          ["receipt_observed", "finality_unknown"].includes(state)
        ))
    )
      throw new Error("Atomic recovery journal transition is invalid.");
    const migrate =
      previous.schemaVersion === 2 &&
      ["receipt_observed", "finality_unknown"].includes(state);
    const record = {
      schemaVersion: migrate ? 3 : previous.schemaVersion,
      attemptId: previous.attemptId,
      action: previous.action,
      ...(previous.planId ? { planId: previous.planId } : {}),
      ...(previous.executorPlanHash
        ? { executorPlanHash: previous.executorPlanHash }
        : {}),
      ...(previous.transactionFingerprint
        ? { transactionFingerprint: previous.transactionFingerprint }
        : {}),
      transaction: structuredClone(previous.transaction),
      envelope: structuredClone(
        (previous as Prepared | Transition | V2JournalRecord).envelope,
      ),
      ...(previous.schemaVersion === 3
        ? { finalityPolicy: structuredClone(previous.finalityPolicy) }
        : migrate && details.finalityPolicy
          ? { finalityPolicy: structuredClone(details.finalityPolicy) }
          : {}),
      signedEnvelope: structuredClone(attempt.signedEnvelope),
      state,
      ...details,
    } as Transition | V2JournalRecord;
    await validateRecord(record);
    assertSameIntent(previous, record);
    assertSameSignedEnvelope(previous, record);
    assertSameTransactionHash(previous, record);
    await this.#append(record);
    this.#states.set(record.attemptId, record);
    attempt.current = structuredClone(record);
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

export async function parseAtomicIntentJournal(raw: string) {
  return (await parseAtomicIntentJournalHistory(raw)).states;
}

async function parseAtomicIntentJournalHistory(raw: string) {
  const states = new Map<string, JournalRecord>();
  const prepared = new Map<string, Prepared | V2Prepared | V1JournalRecord>();
  if (!raw) return { states, prepared };
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
    await validateRecord(record);
    const current = record as JournalRecord;
    const previous = states.get(current.attemptId);
    if (current.state === "prepared") {
      if (previous)
        throw new Error("Atomic intent journal contains a duplicate attempt.");
      prepared.set(
        current.attemptId,
        current as Prepared | V2Prepared | V1JournalRecord,
      );
    } else {
      if (
        !previous ||
        (previous.schemaVersion !== current.schemaVersion
          ? !(
              previous.schemaVersion === 2 &&
              current.schemaVersion === 3 &&
              ["receipt_observed", "finality_unknown"].includes(current.state)
            )
          : !(
              transitionsFor(current.schemaVersion)[previous.state] ?? []
            ).includes(current.state))
      )
        throw new Error(
          "Atomic intent journal transition sequence is invalid.",
        );
      assertSameIntent(previous, current);
      assertSameSignedEnvelope(previous, current);
      assertSameTransactionHash(previous, current);
    }
    states.set(current.attemptId, current);
  }
  return { states, prepared };
}

async function validateRecord(value: unknown): Promise<void> {
  if (!plainObject(value))
    throw new Error("Atomic intent journal record must be an object.");
  if (![1, 2, 3].includes(value.schemaVersion as number))
    throw new Error("Atomic intent journal schema version is unsupported.");
  const version = value.schemaVersion as 1 | 2 | 3;
  const validStates = transitionsFor(version);
  if (
    typeof value.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.attemptId,
    ) ||
    (value.action !== "approval" && value.action !== "swap") ||
    typeof value.state !== "string" ||
    !Object.hasOwn(validStates, value.state)
  )
    throw new Error("Atomic intent journal record identity is invalid.");
  const state = value.state as AtomicIntentState;
  exactKeys(
    value,
    state === "prepared"
      ? version === 1
        ? v1PreparedKeys
        : version === 2
          ? v2PreparedKeys
          : preparedKeys
      : version === 1
        ? v1TransitionKeys
        : version === 2
          ? v2TransitionKeys
          : transitionKeys,
  );
  for (const name of [
    "planId",
    "executorPlanHash",
    "transactionFingerprint",
  ] as const)
    if (value[name] !== undefined && !isHash(value[name] as string))
      throw new Error("Atomic intent journal hash identity is invalid.");
  validateTransaction(value.transaction);
  if (version >= 2) validateEnvelope(value.envelope);
  if (version === 3) {
    validateStoredFinalityPolicy(value.finalityPolicy);
    if (
      (value.finalityPolicy as AtomicFinalityPolicy).chainId !==
      (value.transaction as Record<string, unknown>).chainId
    )
      throw new Error("Atomic finality policy chain identity changed.");
  }
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
  if (version >= 2) {
    const signedRequired = state !== "canceled";
    if (signedRequired !== (value.signedEnvelope !== undefined))
      throw new Error("Atomic intent journal signed envelope is missing.");
    if (value.signedEnvelope !== undefined) {
      const record = value as unknown as Transition;
      validateSignedEnvelope(record.signedEnvelope);
      assertEnvelopeMatchesRecord(record, record.signedEnvelope);
      const admitted = await admitSignedAtomicEnvelope(
        record.signedEnvelope.rawTransaction,
        record.transaction,
        record.envelope,
      );
      if (JSON.stringify(admitted) !== JSON.stringify(record.signedEnvelope))
        throw new Error(
          "Atomic intent journal signed envelope is inconsistent.",
        );
    }
  }
  const hashRequired = [
    "submission_observed",
    "recovery_handoff_started",
    "submitted",
    "receipt_passed",
    "receipt_failed",
    "receipt_unavailable",
    "receipt_observed",
    "finality_unknown",
    "finalized_complete",
    "finalized_failed",
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

  if (version === 3) {
    if (
      value.action === "approval" &&
      [
        "receipt_observed",
        "finality_unknown",
        "finalized_complete",
        "finalized_failed",
      ].includes(state)
    )
      throw new Error("Atomic approval cannot use swap finality states.");
    if (
      value.action === "swap" &&
      ["receipt_passed", "receipt_failed"].includes(state)
    )
      throw new Error(
        "Atomic swap receipt cannot be terminal before finality.",
      );
    const hasProvisional = value.provisionalEvidence !== undefined;
    const hasFinality = value.finalityEvidence !== undefined;
    const needsProvisional = [
      "receipt_observed",
      "finalized_complete",
      "finalized_failed",
    ].includes(state);
    if (
      (needsProvisional && !hasProvisional) ||
      (!needsProvisional && state !== "finality_unknown" && hasProvisional) ||
      ["finalized_complete", "finalized_failed"].includes(state) !==
        hasFinality ||
      (state === "finality_unknown") !== (value.finalityReason !== undefined) ||
      (value.finalityReason !== undefined &&
        (typeof value.finalityReason !== "string" || !value.finalityReason))
    )
      throw new Error(
        "Atomic finality journal transition details are invalid.",
      );
    if (hasProvisional)
      validateStoredProvisionalEvidence(value.provisionalEvidence);
    if (hasFinality) {
      validateStoredFinalityEvidence(
        value.finalityEvidence,
        value.provisionalEvidence as AtomicProvisionalEvidence,
        value.finalityPolicy as AtomicFinalityPolicy,
      );
      const provisional =
        value.provisionalEvidence as AtomicProvisionalEvidence;
      if (
        (state === "finalized_complete") !==
        (provisional.execution === "success" &&
          provisional.economics === "passed")
      )
        throw new Error("Atomic finalized result meaning is invalid.");
    }
  }
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

function validateEnvelope(value: unknown): asserts value is AtomicEnvelope {
  if (!plainObject(value))
    throw new Error("Atomic intent journal envelope is invalid.");
  exactKeys(value, envelopeKeys);
  validateEnvelopeFields(value);
}

function validateEnvelopeFields(value: Record<string, unknown>) {
  if (
    value.type !== 2 ||
    typeof value.nonce !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.nonce) ||
    BigInt(value.nonce) > 0xffff_ffff_ffff_ffffn ||
    typeof value.maxFeePerGasAtomic !== "string" ||
    !/^[1-9][0-9]*$/.test(value.maxFeePerGasAtomic) ||
    BigInt(value.maxFeePerGasAtomic) >
      0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn ||
    typeof value.maxPriorityFeePerGasAtomic !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.maxPriorityFeePerGasAtomic) ||
    BigInt(value.maxPriorityFeePerGasAtomic) >
      BigInt(value.maxFeePerGasAtomic) ||
    !Array.isArray(value.accessList) ||
    value.accessList.length !== 0
  )
    throw new Error("Atomic intent journal envelope fields are invalid.");
}

function validateSignedEnvelope(
  value: unknown,
): asserts value is SignedAtomicEnvelope {
  if (!plainObject(value))
    throw new Error("Atomic intent journal signed envelope is invalid.");
  exactKeys(value, signedEnvelopeKeys);
  validateEnvelopeFields(value);
  if (
    typeof value.chainId !== "string" ||
    !/^[1-9][0-9]*$/.test(value.chainId) ||
    typeof value.signer !== "string" ||
    !isAddress(value.signer, { strict: false }) ||
    typeof value.to !== "string" ||
    !isAddress(value.to, { strict: false }) ||
    typeof value.valueAtomic !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.valueAtomic) ||
    typeof value.data !== "string" ||
    !isHex(value.data, { strict: true }) ||
    typeof value.gasLimit !== "string" ||
    !/^[1-9][0-9]*$/.test(value.gasLimit) ||
    (value.yParity !== 0 && value.yParity !== 1) ||
    typeof value.r !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.r) ||
    typeof value.s !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.s) ||
    typeof value.rawTransaction !== "string" ||
    !/^0x02[0-9a-f]+$/.test(value.rawTransaction) ||
    typeof value.transactionHash !== "string" ||
    !isHash(value.transactionHash)
  )
    throw new Error(
      "Atomic intent journal signed envelope fields are invalid.",
    );
}

function assertEnvelopeMatchesRecord(
  record: Transition,
  signed: SignedAtomicEnvelope,
) {
  const same = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  if (
    JSON.stringify(record.envelope) !==
      JSON.stringify({
        type: signed.type,
        nonce: signed.nonce,
        maxFeePerGasAtomic: signed.maxFeePerGasAtomic,
        maxPriorityFeePerGasAtomic: signed.maxPriorityFeePerGasAtomic,
        accessList: signed.accessList,
      }) ||
    record.transaction.chainId !== signed.chainId ||
    !same(record.transaction.from, signed.signer) ||
    !same(record.transaction.to, signed.to) ||
    record.transaction.valueAtomic !== signed.valueAtomic ||
    record.transaction.data.toLowerCase() !== signed.data ||
    record.transaction.gasLimit !== signed.gasLimit
  )
    throw new Error("Atomic intent journal signed envelope changed authority.");
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
  if (
    previous.schemaVersion >= 2 &&
    current.schemaVersion >= 2 &&
    JSON.stringify(
      (previous as Prepared | Transition | V2JournalRecord).envelope,
    ) !==
      JSON.stringify(
        (current as Prepared | Transition | V2JournalRecord).envelope,
      )
  )
    throw new Error(
      "Atomic intent journal envelope changed within an attempt.",
    );
  if (
    previous.schemaVersion === 3 &&
    current.schemaVersion === 3 &&
    JSON.stringify(previous.finalityPolicy) !==
      JSON.stringify(current.finalityPolicy)
  )
    throw new Error(
      "Atomic intent journal finality policy changed within an attempt.",
    );
}

function assertSameSignedEnvelope(
  previous: JournalRecord,
  current: JournalRecord,
) {
  const prior =
    "signedEnvelope" in previous ? previous.signedEnvelope : undefined;
  const next = "signedEnvelope" in current ? current.signedEnvelope : undefined;
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(next))
    throw new Error(
      "Atomic intent journal signed bytes changed within an attempt.",
    );
}

function assertSameTransactionHash(
  previous: JournalRecord,
  current: JournalRecord,
) {
  if (
    current.schemaVersion >= 2 &&
    [
      "submission_observed",
      "recovery_handoff_started",
      "submitted",
      "receipt_passed",
      "receipt_failed",
      "receipt_unavailable",
      "receipt_observed",
      "finality_unknown",
      "finalized_complete",
      "finalized_failed",
    ].includes(current.state) &&
    "signedEnvelope" in current &&
    current.signedEnvelope?.transactionHash !==
      (current as unknown as Record<string, unknown>).transactionHash
  )
    throw new Error(
      "Atomic intent journal submitted hash differs from signed bytes.",
    );
  if (
    (current.state.startsWith("receipt_") ||
      current.state.startsWith("finality_") ||
      current.state.startsWith("finalized_")) &&
    [
      "signed",
      "submission_observed",
      "submitted",
      "receipt_unavailable",
      "submission_unknown",
    ].includes(previous.state) &&
    "transactionHash" in previous &&
    "transactionHash" in current &&
    previous.transactionHash !== current.transactionHash
  )
    throw new Error(
      "Atomic intent journal transaction hash changed within an attempt.",
    );
}

function transitionsFor(version: 1 | 2 | 3) {
  return version === 1
    ? transitionsV1
    : version === 2
      ? transitionsV2
      : transitionsV3;
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
