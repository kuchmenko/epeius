import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getAddress } from "viem";

const VERSION = "epeius-atomic-nonce-lock-v1";

export type AtomicNonceLockHooks = {
  before?: (
    operation:
      | "create"
      | "write"
      | "sync_lock"
      | "sync_directory"
      | "close"
      | "unlink"
      | "sync_unlink",
  ) => void;
};

export class AtomicNonceLock {
  readonly #directory: FileHandle;
  readonly #file: FileHandle;
  readonly #path: string;
  readonly #identity: { dev: bigint; ino: bigint };
  readonly #hooks: AtomicNonceLockHooks;
  #closed = false;

  private constructor(
    directory: FileHandle,
    file: FileHandle,
    path: string,
    identity: { dev: bigint; ino: bigint },
    hooks: AtomicNonceLockHooks,
  ) {
    this.#directory = directory;
    this.#file = file;
    this.#path = path;
    this.#identity = identity;
    this.#hooks = hooks;
  }

  static async acquire(
    root: string,
    chainId: string,
    signer: string,
    hooks: AtomicNonceLockHooks = {},
  ) {
    if (!/^[1-9][0-9]*$/.test(chainId))
      throw new Error("Atomic nonce lock chain ID is invalid.");
    let normalizedSigner: string;
    try {
      normalizedSigner = getAddress(signer).toLowerCase();
    } catch {
      throw new Error("Atomic nonce lock signer is invalid.");
    }
    const rootStat = await lstat(root, { bigint: true }).catch(() => null);
    if (
      !rootStat?.isDirectory() ||
      (rootStat.mode & 0o777n) !== 0o700n ||
      (typeof process.getuid === "function" &&
        rootStat.uid !== BigInt(process.getuid()))
    )
      throw new Error(
        "Atomic nonce lock root must be an existing owner-owned directory with exact 0700 permissions and no symlink.",
      );
    const directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let directoryStat: BigIntStats;
    try {
      directoryStat = await directory.stat({ bigint: true });
    } catch (error) {
      await directory.close().catch(() => {});
      throw error;
    }
    if (
      directoryStat.dev !== rootStat.dev ||
      directoryStat.ino !== rootStat.ino
    ) {
      await directory.close();
      throw new Error("Atomic nonce lock root changed while opening.");
    }
    const path = join(root, `${chainId}-${normalizedSigner.slice(2)}.lock`);
    let file: FileHandle;
    try {
      // A crashed owner leaves this file behind deliberately: without external
      // authority, a later process cannot prove that taking the nonce is safe.
      hooks.before?.("create");
      file = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      const provenance = await contentionProvenance(path);
      await directory.close().catch(() => {});
      throw new Error(
        `Atomic nonce lock is held or unsafe: chain=${chainId} signer=${normalizedSigner} path=${path}${provenance ? ` holder=${provenance}` : ""}. Manual inspection is required; lock was not stolen.`,
      );
    }
    let identity: { dev: bigint; ino: bigint } | undefined;
    try {
      const stat = await file.stat({ bigint: true });
      identity = { dev: stat.dev, ino: stat.ino };
      const currentRoot = await lstat(root, { bigint: true });
      if (
        !stat.isFile() ||
        (stat.mode & 0o777n) !== 0o600n ||
        (typeof process.getuid === "function" &&
          stat.uid !== BigInt(process.getuid())) ||
        currentRoot.dev !== directoryStat.dev ||
        currentRoot.ino !== directoryStat.ino
      )
        throw new Error(
          "Atomic nonce lock file or root changed while acquiring.",
        );
      hooks.before?.("write");
      await file.writeFile(
        `${JSON.stringify({
          version: VERSION,
          chainId,
          signer: normalizedSigner,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
      hooks.before?.("sync_lock");
      await file.sync();
      hooks.before?.("sync_directory");
      await directory.sync();
      return new AtomicNonceLock(directory, file, path, identity, hooks);
    } catch (error) {
      await file.close().catch(() => {});
      if (identity) await unlinkSameFile(path, identity).catch(() => {});
      await directory.sync().catch(() => {});
      await directory.close().catch(() => {});
      throw error;
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#hooks.before?.("close");
    await this.#file.close();
    let removed: boolean;
    try {
      this.#hooks.before?.("unlink");
      removed = await unlinkSameFile(this.#path, this.#identity);
    } catch (error) {
      await this.#directory.close().catch(() => {});
      throw error;
    }
    if (!removed) {
      await this.#directory.close();
      throw new Error(
        "Atomic nonce lock path changed; foreign lock was not deleted.",
      );
    }
    try {
      this.#hooks.before?.("sync_unlink");
      await this.#directory.sync();
    } finally {
      await this.#directory.close();
    }
  }
}

async function contentionProvenance(path: string) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      return "unsafe";
    const raw = await file.readFile({ encoding: "utf8" });
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== VERSION ||
      typeof value.chainId !== "string" ||
      typeof value.signer !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.createdAt !== "string"
    )
      return "malformed";
    return JSON.stringify(value);
  } catch {
    return "unreadable";
  } finally {
    await file?.close().catch(() => {});
  }
}

async function unlinkSameFile(
  path: string,
  identity: { dev: bigint; ino: bigint },
) {
  // Never remove a lock that another process placed at our derived path.
  const current = await lstat(path, { bigint: true }).catch(() => null);
  if (
    !current?.isFile() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    return false;
  await unlink(path);
  return true;
}
