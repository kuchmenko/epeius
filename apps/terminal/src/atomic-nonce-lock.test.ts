import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GetStatusResponseSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { AtomicNonceLock } from "./atomic-nonce-lock";

const signer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
).address;
const otherSigner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
).address;
const lockName = (chainId: string, address = signer) =>
  `${chainId}-${address.slice(2).toLowerCase()}.lock`;

async function temporaryRoot() {
  const parent = await mkdtemp(join(tmpdir(), "epeius-nonce-lock-"));
  const root = join(parent, "root");
  await mkdir(root, { mode: 0o700 });
  return {
    parent,
    root,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

test("nonce lock uses exact chain and normalized signer identity", async () => {
  const t = await temporaryRoot();
  try {
    const first = await AtomicNonceLock.acquire(
      t.root,
      "1",
      signer.toLowerCase(),
    );
    const path = join(t.root, lockName("1"));
    const stat = await lstat(path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: "epeius-atomic-nonce-lock-v1",
      chainId: "1",
      signer: signer.toLowerCase(),
      pid: process.pid,
    });
    await expect(AtomicNonceLock.acquire(t.root, "1", signer)).rejects.toThrow(
      `chain=1 signer=${signer.toLowerCase()} path=${path}`,
    );
    const anotherChain = await AtomicNonceLock.acquire(t.root, "8453", signer);
    const anotherSigner = await AtomicNonceLock.acquire(
      t.root,
      "1",
      otherSigner,
    );
    await anotherSigner.close();
    await anotherChain.close();
    await first.close();
    expect(await lstat(path).catch(() => null)).toBeNull();
  } finally {
    await t.cleanup();
  }
});

test("distinct child processes contend across distinct trade and recovery journals", async () => {
  const module = new URL("./atomic-nonce-lock.ts", import.meta.url).href;
  const source = `
    import { AtomicNonceLock } from ${JSON.stringify(module)};
    try {
      const lock = await AtomicNonceLock.acquire(process.argv[1], process.argv[2], process.argv[3]);
      console.log(JSON.stringify({ role: process.argv[4], journal: process.argv[5], locked: true }));
      if (process.argv[6] === "hold") await Bun.sleep(30000);
      await lock.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  `;
  for (const [holderRole, contenderRole] of [
    ["trade", "trade"],
    ["trade", "recovery"],
    ["recovery", "recovery"],
  ] as const) {
    const t = await temporaryRoot();
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        source,
        t.root,
        "1",
        signer,
        holderRole,
        join(t.parent, `${holderRole}-one.jsonl`),
        "hold",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"locked":true');
      const contender = Bun.spawn(
        [
          process.execPath,
          "-e",
          source,
          t.root,
          "1",
          signer,
          contenderRole,
          join(t.parent, `${contenderRole}-two.jsonl`),
          "exit",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await contender.exited).toBe(2);
      expect(await new Response(contender.stderr).text()).toContain(
        "Manual inspection is required; lock was not stolen",
      );
      holder.kill();
      await holder.exited;
      const stalePath = join(t.root, lockName("1"));
      expect(await lstat(stalePath)).toBeDefined();
      await expect(
        AtomicNonceLock.acquire(t.root, "1", signer),
      ).rejects.toThrow("lock was not stolen");
      await unlink(stalePath);
    } finally {
      holder.kill();
      await holder.exited;
      await t.cleanup();
    }
  }
});

test("actual Atomic trade contention stops before nonce, signing, journal, or submission", async () => {
  const t = await temporaryRoot();
  const holder = await AtomicNonceLock.acquire(t.root, "1", signer);
  const callsPath = join(t.parent, "cast-calls.jsonl");
  const castPath = join(t.parent, "cast");
  const journalPath = join(t.parent, "trade.jsonl");
  const configPath = join(t.parent, "epeius.toml");
  const tokenIn = `0x${"1".repeat(40)}`;
  const tokenOut = `0x${"2".repeat(40)}`;
  const executor = `0x${"4".repeat(40)}`;
  const code = "0x6001600055";
  const methods: string[] = [];
  await writeFile(
    castPath,
    `#!${process.execPath}\nimport {appendFileSync} from "node:fs"; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args)+"\\n"); console.log(${JSON.stringify(signer)});\n`,
    { mode: 0o700 },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/GetStatus"))
        return new Response(
          toBinary(
            GetStatusResponseSchema,
            create(GetStatusResponseSchema, {
              chains: [
                {
                  key: "local",
                  chainId: "1",
                  connected: true,
                  quotingSupported: true,
                  executionEnabled: true,
                  tokens: [
                    { address: tokenIn, symbol: "IN", decimals: 18 },
                    { address: tokenOut, symbol: "OUT", decimals: 18 },
                  ],
                },
              ],
            }),
          ),
          { headers: { "content-type": "application/proto" } },
        );
      const body = (await request.json()) as {
        id: number;
        method: string;
      };
      methods.push(body.method);
      const result =
        body.method === "eth_chainId"
          ? "0x1"
          : body.method === "eth_getCode"
            ? code
            : body.method === "eth_call"
              ? `0x${"0".repeat(63)}4`
              : null;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  await writeFile(
    configPath,
    `[terminal]\ndefault_chain='local'\nengine_url='${server.url}'\nsearch_budget_ms=100\n[terminal.atomic]\nnonce_lock_root='${t.root}'\n[chains.local]\nchain_id=1\nrpc_url_env='ATOMIC_LOCK_RPC'\nexecution_enabled=true\n[[chains.local.tokens]]\naddress='${tokenIn}'\nsymbol='IN'\ndecimals=18\n[[chains.local.tokens]]\naddress='${tokenOut}'\nsymbol='OUT'\ndecimals=18\n[chains.local.finality]\npolicy_version='epeius-finality-v1'\nfinality_method='ethereum_consensus'\ncompletion_tag='finalized'\nsafe_signal='ethereum_safe'\nnetwork_anchor_number=0\nnetwork_anchor_hash='0x${"a".repeat(64)}'\nrpc_source_id='test'\ncapability_record='test'\ncapability_valid_until='2099-01-01T00:00:00Z'\nrequest_timeout_ms=100\npoll_interval_ms=1\nwait_timeout_ms=100\nstalled_after_ms=50\nmax_response_age_ms=100\n[chains.local.deployments.uni]\nkind='uniswap-v3'\nfactory='0x${"6".repeat(40)}'\nrouter='0x${"7".repeat(40)}'\nfees=[500]\n[chains.local.atomic_executor]\naddress='${executor}'\nruntime_code_hash='${keccak256(code)}'\nmax_branches=4\nmax_operations_per_branch=4\nmax_total_operations=4\nuniswap_deployment='uni'\n`,
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "apps/terminal/src/main.ts",
        "trade",
        "--config",
        configPath,
        "--chain",
        "local",
        "--in",
        "IN",
        "--out",
        "OUT",
        "--amount-atomic",
        "1",
        "--execution-mode",
        "atomic-v1",
        "--candidate-index",
        "1",
        "--atomic-journal",
        journalPath,
        "--max-fee-per-gas-atomic",
        "2",
        "--max-priority-fee-per-gas-atomic",
        "1",
        "--keystore",
        "/fixture/keystore",
        "--password-file",
        "/fixture/password",
      ],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          PATH: `${t.parent}:${process.env.PATH ?? ""}`,
          ATOMIC_LOCK_RPC: server.url.href,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exit] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(1);
    expect(stderr).toContain("Atomic nonce lock is held or unsafe");
    expect(methods).toContain("eth_chainId");
    expect(methods).not.toContain("eth_getTransactionCount");
    expect(methods).not.toContain("eth_sendRawTransaction");
    const castCalls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(castCalls).toHaveLength(1);
    expect(castCalls[0].slice(0, 2)).toEqual(["wallet", "address"]);
    expect(await lstat(journalPath).catch(() => null)).toBeNull();
  } finally {
    server.stop(true);
    await holder.close();
    await t.cleanup();
  }
});

test("nonce lock rejects missing, unsafe, symlink and non-directory roots", async () => {
  const t = await temporaryRoot();
  try {
    const missing = join(t.parent, "missing");
    const file = join(t.parent, "file");
    const link = join(t.parent, "link");
    await writeFile(file, "not a directory", { mode: 0o600 });
    await symlink(t.root, link);
    for (const root of [missing, file, link])
      await expect(AtomicNonceLock.acquire(root, "1", signer)).rejects.toThrow(
        "exact 0700",
      );
    await chmod(t.root, 0o750);
    await expect(AtomicNonceLock.acquire(t.root, "1", signer)).rejects.toThrow(
      "exact 0700",
    );
  } finally {
    await t.cleanup();
  }
});

test("acquire failures clean only the lock inode created by this process", async () => {
  for (const operation of [
    "create",
    "write",
    "sync_lock",
    "sync_directory",
  ] as const) {
    const t = await temporaryRoot();
    try {
      await expect(
        AtomicNonceLock.acquire(t.root, "1", signer, {
          before: (current) => {
            if (current === operation) throw new Error(`failed ${operation}`);
          },
        }),
      ).rejects.toThrow();
      expect(
        await lstat(join(t.root, lockName("1"))).catch(() => null),
      ).toBeNull();
    } finally {
      await t.cleanup();
    }
  }
});

test("close failures leave stale ownership except after unlink", async () => {
  for (const operation of ["close", "unlink", "sync_unlink"] as const) {
    const t = await temporaryRoot();
    const path = join(t.root, lockName("1"));
    try {
      const lock = await AtomicNonceLock.acquire(t.root, "1", signer, {
        before: (current) => {
          if (current === operation) throw new Error(`failed ${operation}`);
        },
      });
      await expect(lock.close()).rejects.toThrow(`failed ${operation}`);
      const remaining = await lstat(path).catch(() => null);
      if (operation === "sync_unlink") expect(remaining).toBeNull();
      else expect(remaining).not.toBeNull();
    } finally {
      await t.cleanup();
    }
  }
});

test("close never deletes a replacement lock path", async () => {
  const t = await temporaryRoot();
  const path = join(t.root, lockName("1"));
  try {
    const lock = await AtomicNonceLock.acquire(t.root, "1", signer);
    await unlink(path);
    await writeFile(path, "foreign\n", { mode: 0o600 });
    await expect(lock.close()).rejects.toThrow("foreign lock was not deleted");
    expect(await readFile(path, "utf8")).toBe("foreign\n");
  } finally {
    await t.cleanup();
  }
});
