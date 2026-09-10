import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  address,
  canonicalReceipt,
  fixture,
  loadProfile,
  options,
  run,
  sqrt,
} from "./harness.mjs";

const sender = "0x0000000000000000000000000000000000000001";
const defaultProfilePath = new URL("./harness.toml", import.meta.url).pathname;
const { uni } = await loadProfile(defaultProfilePath);
test("Bun env files reach the CLI while exported RPC values take precedence", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-env-"));
  const paths = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      paths.push(new URL(request.url).pathname);
      assert.equal((await request.json()).method, "eth_chainId");
      return Response.json({ result: "0x2105" });
    },
  });
  try {
    const envFile = resolve(dir, "test.env");
    writeFileSync(envFile, `BASE_SEPOLIA_RPC_URL=${server.url}from-file\n`);
    for (const exported of [false, true]) {
      const env = { ...process.env };
      delete env.BASE_SEPOLIA_RPC_URL;
      if (exported) env.BASE_SEPOLIA_RPC_URL = `${server.url}from-export`;
      const child = Bun.spawn(
        [
          process.execPath,
          `--env-file=${envFile}`,
          new URL("harness.mjs", import.meta.url).pathname,
          "check",
        ],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 1);
      assert.match(stderr, /Chain guard/);
      assert.equal(stdout, "");
      assert.ok(!stderr.includes(String(server.url)));
    }
    assert.deepEqual(paths, ["/from-file", "/from-export"]);
    assert.throws(() => options(["check", "--env", envFile]), /Unknown option/);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("preconfirmed receipts wait for a matching canonical block and refresh old zero hashes", async () => {
  const zeroHash = `0x${"0".repeat(64)}`;
  const blockHash = `0x${"a".repeat(64)}`;
  const txHash = `0x${"b".repeat(64)}`;
  const old = {
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x42",
    blockHash: zeroHash,
    contractAddress: sender,
  };
  let current = old;
  let block = null;
  const methods = [];
  const rpc = async (method, params) => {
    methods.push(method);
    if (method === "eth_getTransactionReceipt") {
      assert.deepEqual(params, [txHash]);
      return current;
    }
    assert.equal(method, "eth_getBlockByNumber");
    assert.deepEqual(params, ["0x42", false]);
    return block;
  };
  assert.equal(await canonicalReceipt(rpc, txHash, old), null);
  assert.deepEqual(methods, ["eth_getTransactionReceipt"]);
  current = { ...old, blockHash: undefined };
  assert.equal(await canonicalReceipt(rpc, txHash, old), null);
  current = { ...old, blockHash };
  assert.equal(await canonicalReceipt(rpc, txHash, old), null);
  block = { hash: blockHash };
  assert.deepEqual(await canonicalReceipt(rpc, txHash, old), current);
  assert.equal(old.blockHash, zeroHash);
  assert.ok(methods.every((method) => method.startsWith("eth_get")));
});

test("canonical receipt hash changes and block disagreement are rejected", async () => {
  const first = `0x${"1".repeat(64)}`;
  const second = `0x${"2".repeat(64)}`;
  const txHash = `0x${"b".repeat(64)}`;
  const current = {
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x42",
    blockHash: second,
  };
  const rpc = async (method) =>
    method === "eth_getTransactionReceipt" ? current : { hash: first };
  await assert.rejects(
    canonicalReceipt(rpc, txHash, { blockHash: first }),
    /Receipt changed/,
  );
  await assert.rejects(canonicalReceipt(rpc, txHash), /Receipt block mismatch/);
  await assert.rejects(
    canonicalReceipt(rpc, first),
    /Receipt transaction mismatch/,
  );
  delete current.transactionHash;
  await assert.rejects(
    canonicalReceipt(rpc, txHash),
    /Receipt transaction mismatch/,
  );
});

test("only explicit broadcast with explicit encrypted signer is accepted", () => {
  assert.equal(options(["deploy", "--sender", sender]).broadcast, false);
  assert.equal(
    options([
      "deploy",
      "--sender",
      sender,
      "--keystore",
      "/wallet",
      "--password-file",
      "/password",
    ]).broadcast,
    false,
  );
  assert.throws(
    () => options(["deploy", "--sender", sender, "--broadcast"]),
    /encrypted/,
  );
  assert.throws(
    () => options(["deploy", "--sender", sender, "--private-key", "not-a-key"]),
    /Unknown option/,
  );
  assert.throws(() => options(["check", "--broadcast"]), /Read-only/);
  assert.throws(
    () => options(["seed", "--sender", sender]),
    /explicit --recipient/,
  );
  assert.throws(() => options(["deploy", "--sender"]), /Missing value/);
  assert.throws(() => address("0x00"), /20-byte/);
  assert.throws(() => address(`0x${"0".repeat(40)}`), /nonzero/);
  assert.equal(options(["check"]).config, defaultProfilePath);
});

test("checked-in profile owns chain, contracts, fixture tokens and fee limits", async () => {
  const profile = await loadProfile(defaultProfilePath);
  assert.equal(profile.chain.key, "base-sepolia");
  assert.equal(profile.chain.id, 84532);
  assert.equal(profile.chain.rpc_url_env, "BASE_SEPOLIA_RPC_URL");
  assert.equal(
    profile.chain.weth,
    "0x4200000000000000000000000000000000000006",
  );
  assert.deepEqual(profile.decimals, { A: 18, B: 6, C: 8 });
  assert.deepEqual(profile.fixtures.uniswap_fees, [500, 3000]);
  assert.deepEqual(profile.fixtures.pancake_fees, [500, 2500]);
});

test("custom profile selects another network and tokens but cannot reuse a mismatched journal", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-profile-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_OTHER_RPC;
  const methods = [];
  process.env.HARNESS_OTHER_RPC = "https://example.invalid";
  globalThis.fetch = async (_url, request) => {
    methods.push(JSON.parse(request.body).method);
    return { ok: true, json: async () => ({ result: "0xaa36a7" }) };
  };
  try {
    const config = resolve(dir, "profile.toml");
    const source = (await Bun.file(defaultProfilePath).text())
      .replace('key = "base-sepolia"', 'key = "another-network"')
      .replace("id = 84532", "id = 11155111")
      .replace("BASE_SEPOLIA_RPC_URL", "HARNESS_OTHER_RPC")
      .replace("A = 18, B = 6, C = 8", "A = 18, B = 6, C = 8, Extra = 12")
      .replace('AC = ["A", "C"]', 'AC = ["A", "C"]\nextra = ["A", "Extra"]')
      .replace(
        "uniswap_fees = [500, 3000]",
        "uniswap_fees = [0, 1, 2, 3, 4, 5, 6, 7, 8]",
      );
    writeFileSync(config, source);
    const profile = await loadProfile(config);
    assert.equal(profile.chain.id, 11155111);
    assert.equal(profile.decimals.Extra, 12);
    assert.deepEqual(profile.fixtures.pairs.extra, ["A", "Extra"]);
    const path = resolve(dir, "manifest.json");
    const journal = {
      version: 1,
      chainId: 84532,
      transactions: {},
      tokens: {},
      pancake: {},
      pools: [],
      uni,
    };
    const args = options(["check", "--config", config, "--manifest", path]);
    writeFileSync(path, JSON.stringify(journal));
    await assert.rejects(run(args), /Malformed deployment manifest/);
    journal.chainId = 11155111;
    journal.uni = { ...uni, router: sender };
    writeFileSync(path, JSON.stringify(journal));
    await assert.rejects(run(args), /deployment identity/);
    assert.deepEqual(methods, ["eth_chainId", "eth_chainId"]);
    assert.deepEqual(await Bun.file(path).json(), journal);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_OTHER_RPC;
    else process.env.HARNESS_OTHER_RPC = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("normalized asymmetric prices use integer square roots and aligned concentrated ranges", () => {
  const ab = fixture(18, 6, 50, true);
  assert.equal(BigInt(ab.sqrtPriceX96), (1n << 96n) / 1000000n);
  assert.equal(fixture(6, 18, 10).sqrtPriceX96, String((1n << 96n) * 1000000n));
  assert.equal(fixture(6, 8, 10).sqrtPriceX96, String((1n << 96n) * 10n));
  assert.equal(ab.lower % 50, -0);
  assert.equal(ab.upper - ab.lower, 200);
  assert.equal(ab.liquidity, "10000000000000000");
  assert.ok(fixture(18, 6, 10).upper - fixture(18, 6, 10).lower > 20000);
  assert.equal(sqrt(999999999999999999n), 999999999n);
});

test("wrong chain stops before any contract, wallet or write request", async () => {
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  const methods = [];
  process.env.BASE_SEPOLIA_RPC_URL = "https://example.invalid";
  globalThis.fetch = async (_url, request) => {
    methods.push(JSON.parse(request.body).method);
    return { ok: true, json: async () => ({ result: "0x2105" }) };
  };
  try {
    await assert.rejects(
      run(options(["deploy", "--sender", sender])),
      /Chain guard/,
    );
    assert.deepEqual(methods, ["eth_chainId"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
    else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
  }
});

const prepared =
  existsSync(
    new URL("../../.testnet/PancakeBootstrap.json", import.meta.url),
  ) &&
  existsSync(
    new URL(
      "../../contracts/out/TestToken.sol/TestToken.json",
      import.meta.url,
    ),
  ) &&
  spawnSync("cast", ["--version"], { stdio: "ignore" }).status === 0;
(prepared ? test : test.skip)(
  "full dry deploy estimates every transaction without signing, broadcasting or writing manifest",
  async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "epeius-harness-"));
    const previousFetch = globalThis.fetch;
    const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
    process.env.BASE_SEPOLIA_RPC_URL = "https://example.invalid";
    const methods = [];
    globalThis.fetch = async (_url, request) => {
      const { method, params } = JSON.parse(request.body);
      methods.push(method);
      let result;
      if (method === "eth_chainId") result = "0x14a34";
      else if (method === "eth_getCode") result = "0x6000";
      else if (method === "eth_call") {
        const target =
          params[0].data === "0xc45a0155"
            ? uni.factory
            : "0x4200000000000000000000000000000000000006";
        result = `0x${target.slice(2).padStart(64, "0")}`;
      } else if (method === "eth_getTransactionCount") result = "0x0";
      else if (method === "eth_estimateGas") result = "0x100000";
      else if (method === "eth_gasPrice") result = "0x1000";
      else throw new Error(`Unexpected method ${method}`);
      return { ok: true, json: async () => ({ result }) };
    };
    try {
      const path = resolve(dir, "manifest.json");
      await run(options(["deploy", "--sender", sender, "--manifest", path]));
      assert.equal(methods.filter((m) => m === "eth_estimateGas").length, 7);
      assert.ok(
        methods.every((m) => !m.includes("send") && !m.includes("sign")),
      );
      assert.equal(existsSync(path), false);
      writeFileSync(path, "{}");
      await assert.rejects(
        run(options(["deploy", "--sender", sender, "--manifest", path])),
        /Malformed deployment manifest/,
      );
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          chainId: 84532,
          transactions: {},
          tokens: {},
          pancake: {},
          pools: [],
          sender: "0x0000000000000000000000000000000000000002",
          uni,
        }),
      );
      await assert.rejects(
        run(options(["deploy", "--sender", sender, "--manifest", path])),
        /signer mismatch/,
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
      else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
      rmSync(dir, { recursive: true });
    }
  },
);
