import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  decodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  toFunctionSelector,
} from "viem";
import {
  pancakeV3PoolAbi,
  uniswapPeripheryStateAbi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
  uniswapV4PositionManagerAbi,
  uniswapV4StateViewAbi,
} from "../../generated/abi/index.ts";
import {
  address,
  canonicalReceipt,
  createAddress,
  createRpc,
  decodeResult,
  fixture,
  loadProfile,
  options,
  run,
  sqrt,
  v4PoolPlan,
} from "./harness.mjs";

const sender = "0x0000000000000000000000000000000000000001";
const defaultProfilePath = new URL("./harness.toml", import.meta.url).pathname;
const { uni, uniV4 } = await loadProfile(defaultProfilePath);
const v4TestProfile = async () =>
  (await Bun.file(defaultProfilePath).text())
    .replace("BASE_SEPOLIA_RPC_URL", "HARNESS_ISOLATED_RPC")
    .replace(uniV4.permit2_code_hash, keccak256("0x6000"))
    .replace(uniV4.router_code_hash, keccak256("0x6000"));
test("pinned Uniswap artifacts are deployable without external library links", async () => {
  for (const [name, version, contract] of [
    ["@uniswap/v3-core", "1.0.1", "UniswapV3Factory"],
    ["@uniswap/swap-router-contracts", "1.1.0", "SwapRouter02"],
  ]) {
    const root = new URL(`./node_modules/${name}/`, import.meta.url);
    const pkg = await Bun.file(new URL("package.json", root)).json();
    assert.equal(pkg.version, version);
    const artifact = await Bun.file(
      new URL(`artifacts/contracts/${contract}.sol/${contract}.json`, root),
    ).json();
    assert.match(artifact.bytecode, /^0x[0-9a-fA-F]+$/);
    assert.ok(artifact.bytecode.length > 2);
    assert.deepEqual(artifact.linkReferences, {});
    assert.equal(artifact.contractName, contract);
  }
});

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
  assert.equal(options(["seed-v4", "--sender", sender]).broadcast, false);
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
  assert.equal(profile.engine.quote_concurrency, 4);
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
  assert.deepEqual(profile.fixtures.uniswap_v4, {
    pair: ["A", "C"],
    fee: 500,
    tick_spacing: 10,
  });
  assert.equal(
    profile.uniV4.pool_manager,
    "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
  );
  assert.equal(
    profile.uniV4.position_manager,
    "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
  );
});

test("profile reads custom quote concurrency and rejects absent or zero values", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-quote-concurrency-"));
  try {
    const source = await Bun.file(defaultProfilePath).text();
    const custom = resolve(dir, "custom.toml");
    const absent = resolve(dir, "absent.toml");
    const zero = resolve(dir, "zero.toml");
    writeFileSync(
      custom,
      source.replace("quote_concurrency = 4", "quote_concurrency = 3"),
    );
    writeFileSync(absent, source.replace("quote_concurrency = 4\n", ""));
    writeFileSync(
      zero,
      source.replace("quote_concurrency = 4", "quote_concurrency = 0"),
    );

    assert.equal((await loadProfile(custom)).engine.quote_concurrency, 3);
    await assert.rejects(loadProfile(absent), /Malformed harness config/);
    await assert.rejects(loadProfile(zero), /Malformed harness config/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("custom profile selects another network and tokens but cannot reuse a mismatched journal", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-profile-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_OTHER_RPC;
  const methods = [];
  process.env.HARNESS_OTHER_RPC = "https://example.invalid";
  globalThis.fetch = async (_url, request) => {
    methods.push(JSON.parse(request.body).method);
    return Response.json({ result: "0xaa36a7" });
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

test("equal-decimal V3 fixture stays valid and derives each bound independently", () => {
  const spacing = 60;
  const result = fixture(18, 18, spacing);
  const minSqrtRatio = 4295128739n;
  const maxSqrtRatio = 1461446703485210103287273052203988822378723970342n;
  const sqrtPriceX96 = BigInt(result.sqrtPriceX96);

  assert.equal(sqrtPriceX96, 1n << 96n);
  assert.ok(sqrtPriceX96 >= minSqrtRatio);
  assert.ok(sqrtPriceX96 < maxSqrtRatio);
  assert.equal(result.lower, -12000);
  assert.equal(result.upper, 12000);
  assert.equal(result.lower % spacing, -0);
  assert.equal(result.upper % spacing, 0);
  assert.ok(result.lower >= -887272);
  assert.ok(result.upper <= 887272);
  assert.equal(BigInt(result.liquidity), 10n ** 22n);
  assert.ok(BigInt(result.liquidity) <= (1n << 128n) - 1n);
});

test("V4 fixture derives canonical pool ID and PositionManager action payload", () => {
  const owner = "0x22D8382B5B49Bb0cc8156EC572CC581F154e042E";
  const tokenA = {
    address: "0x14ddd6cca49ed2ff37ede2d2ea336812eef51434",
    decimals: 18,
  };
  const tokenC = {
    address: "0xca7ad770c3ca045aed82e0669d0246c069675311",
    decimals: 8,
  };
  const plan = v4PoolPlan(
    tokenC,
    tokenA,
    { fee: 500, tick_spacing: 10 },
    owner,
  );
  // Independently derived with Cast abi-encode plus keccak.
  assert.equal(
    plan.poolId,
    "0xd5c73e110d9b56bad25071372c615a08f5c34636b6b92a82088297b95ea71ba3",
  );
  assert.deepEqual(plan.key, {
    currency0: tokenA.address,
    currency1: tokenC.address,
    fee: 500,
    tickSpacing: 10,
    hooks: "0x0000000000000000000000000000000000000000",
  });
  assert.equal(plan.amount0Max, 10000n * 10n ** 18n);
  assert.equal(plan.amount1Max, 10000n * 10n ** 8n);
  const [actions, params] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    plan.unlockData,
  );
  assert.equal(actions, "0x020d");
  assert.equal(params.length, 2);
  const [mintKey, lower, upper, liquidity, max0, max1, recipient, hookData] =
    decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { type: "int24" },
        { type: "int24" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "address" },
        { type: "bytes" },
      ],
      params[0],
    );
  assert.deepEqual(
    {
      currency0: mintKey.currency0.toLowerCase(),
      currency1: mintKey.currency1.toLowerCase(),
      fee: mintKey.fee,
      tickSpacing: mintKey.tickSpacing,
      hooks: mintKey.hooks.toLowerCase(),
    },
    plan.key,
  );
  assert.equal(lower, plan.lower);
  assert.equal(upper, plan.upper);
  assert.ok(lower < upper);
  assert.equal(liquidity, BigInt(plan.liquidity));
  assert.equal(max0, plan.amount0Max);
  assert.equal(max1, plan.amount1Max);
  assert.equal(recipient.toLowerCase(), owner.toLowerCase());
  assert.equal(hookData, "0x");
  const [settle0, settle1] = decodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    params[1],
  );
  assert.equal(settle0.toLowerCase(), tokenA.address);
  assert.equal(settle1.toLowerCase(), tokenC.address);
});

test("V4 seed validates existing pool before estimating approvals", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-v4-preflight-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_ISOLATED_RPC;
  const token = (digit, decimals) => ({
    address: `0x${digit.repeat(40)}`,
    decimals,
  });
  const tokens = { A: token("1", 18), B: token("2", 6), C: token("3", 8) };
  const plan = v4PoolPlan(
    tokens.A,
    tokens.C,
    { fee: 500, tick_spacing: 10 },
    sender,
  );
  let poolChecked = false;
  let routerLinked = false;
  let estimated = false;
  let validPool = false;
  process.env.HARNESS_ISOLATED_RPC = "https://isolated.invalid/rpc";
  globalThis.fetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    let result;
    if (method === "eth_chainId") result = "0x14a34";
    else if (method === "eth_getCode") result = "0x6000";
    else if (method === "eth_getTransactionCount") result = "0x0";
    else if (method === "eth_getBlockByNumber") result = { timestamp: "0x64" };
    else if (method === "eth_estimateGas") {
      estimated = true;
      assert.ok(
        poolChecked,
        "pool state must be checked before approval estimate",
      );
      result = "0x10000";
    } else if (method === "eth_call") {
      const { to, data } = params[0];
      const selector = data.slice(0, 10);
      const word = (value) => `0x${value.replace(/^0x/, "").padStart(64, "0")}`;
      if (selector === toFunctionSelector("factory()"))
        result = word(uni.factory);
      else if (selector === toFunctionSelector("WETH9()"))
        result = word("0x4200000000000000000000000000000000000006");
      else if (selector === toFunctionSelector("poolManager()")) {
        if (to.toLowerCase() === uniV4.router.toLowerCase())
          routerLinked = true;
        result = word(uniV4.pool_manager);
      } else if (selector === toFunctionSelector("permit2()"))
        result = word(uniV4.permit2);
      else if (selector === toFunctionSelector("decimals()"))
        result = word(
          BigInt(
            Object.values(tokens).find((candidate) => candidate.address === to)
              .decimals,
          ).toString(16),
        );
      else if (selector === toFunctionSelector("getSlot0(bytes32)")) {
        assert.equal(to.toLowerCase(), uniV4.state_view.toLowerCase());
        poolChecked = true;
        result = encodeFunctionResult({
          abi: uniswapV4StateViewAbi,
          functionName: "getSlot0",
          result: [validPool ? BigInt(plan.sqrtPriceX96) : 1n, 0, 0, 0],
        });
      } else if (selector === toFunctionSelector("balanceOf(address)"))
        result = word((to === tokens.C.address ? 0n : 1n << 255n).toString(16));
      else if (selector === toFunctionSelector("allowance(address,address)"))
        result = word("0");
      else if (
        selector === toFunctionSelector("allowance(address,address,address)")
      )
        result = `${word("0")}${word("0").slice(2)}${word("0").slice(2)}`;
      else throw new Error(`Unexpected eth_call selector ${selector}`);
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  try {
    const config = resolve(dir, "profile.toml");
    const manifestPath = resolve(dir, "manifest.json");
    writeFileSync(
      config,
      (await Bun.file(defaultProfilePath).text()).replace(
        "BASE_SEPOLIA_RPC_URL",
        "HARNESS_ISOLATED_RPC",
      ),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        chainId: 84532,
        sender,
        transactions: {},
        tokens,
        pancake: {},
        pools: [],
        uni,
      }),
    );
    await assert.rejects(
      run(
        options([
          "seed-v4",
          "--sender",
          sender,
          "--config",
          config,
          "--manifest",
          manifestPath,
        ]),
      ),
      /router code hash mismatch/,
    );
    assert.equal(routerLinked, true);
    assert.equal(estimated, false);
    writeFileSync(config, await v4TestProfile());
    await assert.rejects(
      run(
        options([
          "seed-v4",
          "--sender",
          sender,
          "--config",
          config,
          "--manifest",
          manifestPath,
        ]),
      ),
      /different price/,
    );
    assert.equal(poolChecked, true);
    assert.equal(estimated, false);
    validPool = true;
    await assert.rejects(
      run(
        options([
          "seed-v4",
          "--sender",
          sender,
          "--config",
          config,
          "--manifest",
          manifestPath,
        ]),
      ),
      /Insufficient .* fixture balance/,
    );
    assert.equal(estimated, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_ISOLATED_RPC;
    else process.env.HARNESS_ISOLATED_RPC = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("V4 seed refreshes sufficient Permit2 allowance that expires before mint deadline", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-v4-permission-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_ISOLATED_RPC;
  const token = (digit, decimals) => ({
    address: `0x${digit.repeat(40)}`,
    decimals,
  });
  const tokens = { A: token("1", 18), B: token("2", 6), C: token("3", 8) };
  const plan = v4PoolPlan(
    tokens.A,
    tokens.C,
    { fee: 500, tick_spacing: 10 },
    sender,
  );
  const estimates = [];
  process.env.HARNESS_ISOLATED_RPC = "https://isolated.invalid/rpc";
  globalThis.fetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
    let result;
    if (method === "eth_chainId") result = "0x14a34";
    else if (method === "eth_getCode") result = "0x6000";
    else if (method === "eth_getTransactionCount") result = "0x0";
    else if (method === "eth_gasPrice") result = "0x1";
    else if (method === "eth_getBlockByNumber") result = { timestamp: "0x64" };
    else if (method === "eth_estimateGas") {
      estimates.push(params[0]);
      result = "0x10000";
    } else if (method === "eth_call") {
      const { to, data } = params[0];
      const selector = data.slice(0, 10);
      if (selector === toFunctionSelector("factory()"))
        result = `0x${uni.factory.slice(2).padStart(64, "0")}`;
      else if (selector === toFunctionSelector("WETH9()"))
        result = `0x${"4200000000000000000000000000000000000006".padStart(64, "0")}`;
      else if (selector === toFunctionSelector("poolManager()"))
        result = `0x${uniV4.pool_manager.slice(2).padStart(64, "0")}`;
      else if (selector === toFunctionSelector("permit2()"))
        result = `0x${uniV4.permit2.slice(2).padStart(64, "0")}`;
      else if (selector === toFunctionSelector("decimals()"))
        result = word(
          Object.values(tokens).find((candidate) => candidate.address === to)
            .decimals,
        );
      else if (selector === toFunctionSelector("getSlot0(bytes32)"))
        result = encodeFunctionResult({
          abi: uniswapV4StateViewAbi,
          functionName: "getSlot0",
          result: [BigInt(plan.sqrtPriceX96), 0, 0, 0],
        });
      else if (selector === toFunctionSelector("balanceOf(address)"))
        result = word(1n << 255n);
      else if (selector === toFunctionSelector("allowance(address,address)"))
        result = word(1n << 255n);
      else if (
        selector === toFunctionSelector("allowance(address,address,address)")
      )
        result = `${word((1n << 160n) - 1n)}${word(99).slice(2)}${word(0).slice(2)}`;
      else if (selector === toFunctionSelector("nextTokenId()"))
        result = word(1);
      else throw new Error(`Unexpected eth_call selector ${selector}`);
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  try {
    const config = resolve(dir, "profile.toml");
    const manifestPath = resolve(dir, "manifest.json");
    writeFileSync(config, await v4TestProfile());
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        chainId: 84532,
        sender,
        transactions: {},
        tokens,
        pancake: {},
        pools: [],
        uni,
      }),
    );
    await run(
      options([
        "seed-v4",
        "--sender",
        sender,
        "--config",
        config,
        "--manifest",
        manifestPath,
      ]),
    );
    const permissionWrites = estimates.filter(
      ({ to, data }) =>
        to.toLowerCase() === uniV4.permit2.toLowerCase() &&
        data.startsWith(
          toFunctionSelector("approve(address,address,uint160,uint48)"),
        ),
    );
    assert.equal(permissionWrites.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_ISOLATED_RPC;
    else process.env.HARNESS_ISOLATED_RPC = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("V4 seed recovers a journaled mint after the pool price moves", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-v4-recovery-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_ISOLATED_RPC;
  const previousPath = process.env.PATH;
  const token = (digit, decimals) => ({
    address: `0x${digit.repeat(40)}`,
    decimals,
  });
  const tokens = { A: token("1", 18), B: token("2", 6), C: token("3", 8) };
  const plan = v4PoolPlan(
    tokens.A,
    tokens.C,
    { fee: 500, tick_spacing: 10 },
    sender,
  );
  const hash = `0x${"a".repeat(64)}`;
  const blockHash = `0x${"b".repeat(64)}`;
  const deadline = "1000";
  const data = encodeFunctionData({
    abi: uniswapV4PositionManagerAbi,
    functionName: "modifyLiquidities",
    args: [plan.unlockData, BigInt(deadline)],
  });
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockNumber: "0x42",
    blockHash,
    logs: [
      {
        address: uniV4.position_manager,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          `0x${"0".repeat(64)}`,
          `0x${sender.slice(2).padStart(64, "0")}`,
          `0x${"1".padStart(64, "0")}`,
        ],
        data: "0x",
      },
    ],
  };
  process.env.HARNESS_ISOLATED_RPC = "https://isolated.invalid/rpc";
  globalThis.fetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
    let result;
    if (method === "eth_chainId") result = "0x14a34";
    else if (method === "eth_getCode") result = "0x6000";
    else if (method === "eth_getTransactionCount") result = "0x0";
    else if (method === "eth_getTransactionReceipt") result = receipt;
    else if (method === "eth_getBlockByNumber") result = { hash: blockHash };
    else if (method === "eth_call") {
      const { to, data: callData } = params[0];
      const selector = callData.slice(0, 10);
      if (selector === toFunctionSelector("factory()"))
        result = word(uni.factory);
      else if (selector === toFunctionSelector("WETH9()"))
        result = word("0x4200000000000000000000000000000000000006");
      else if (selector === toFunctionSelector("poolManager()"))
        result = word(uniV4.pool_manager);
      else if (selector === toFunctionSelector("permit2()"))
        result = word(uniV4.permit2);
      else if (selector === toFunctionSelector("decimals()"))
        result = word(
          Object.values(tokens).find((candidate) => candidate.address === to)
            .decimals,
        );
      else if (selector === toFunctionSelector("getSlot0(bytes32)"))
        result = encodeFunctionResult({
          abi: uniswapV4StateViewAbi,
          functionName: "getSlot0",
          result: [BigInt(plan.sqrtPriceX96) + 1n, 0, 0, 0],
        });
      else if (selector === toFunctionSelector("ownerOf(uint256)"))
        result = word(sender);
      else if (selector === toFunctionSelector("getPositionLiquidity(uint256)"))
        result = word(plan.liquidity);
      else throw new Error(`Unexpected eth_call selector ${selector}`);
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  try {
    const config = resolve(dir, "profile.toml");
    const manifestPath = resolve(dir, "manifest.json");
    const keystore = resolve(dir, "keystore");
    const password = resolve(dir, "password");
    writeFileSync(config, await v4TestProfile());
    writeFileSync(keystore, "{}");
    writeFileSync(password, "test-only", { mode: 0o600 });
    writeFileSync(
      resolve(dir, "cast"),
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "wallet" && args[1] === "address") console.log(${JSON.stringify(sender)});
else throw new Error("Only signer identity should be requested");
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}:${previousPath}`;
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        chainId: 84532,
        sender,
        transactions: {
          "v4-mint-position-A-C-500": {
            to: uniV4.position_manager,
            data,
            hash,
            receipt,
          },
        },
        tokens,
        pancake: {},
        pools: [],
        uni,
        v4Fixture: {
          pair: ["A", "C"],
          fee: 500,
          tickSpacing: 10,
          poolId: plan.poolId,
          token0: plan.token0.address,
          token1: plan.token1.address,
          lower: plan.lower,
          upper: plan.upper,
          liquidity: plan.liquidity,
          positionDeadline: deadline,
        },
      }),
    );
    await run(
      options([
        "seed-v4",
        "--sender",
        sender,
        "--config",
        config,
        "--manifest",
        manifestPath,
        "--keystore",
        keystore,
        "--password-file",
        password,
        "--broadcast",
      ]),
    );
    const saved = JSON.parse(await Bun.file(manifestPath).text());
    assert.equal(saved.v4Fixture.positionTokenId, "1");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_ISOLATED_RPC;
    else process.env.HARNESS_ISOLATED_RPC = previousURL;
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true });
  }
});

test("V3 fixture rejects 0/255 decimals whose generated values exceed protocol bounds", () => {
  assert.throws(() => fixture(0, 255, 10), /V3|bound|decimal/i);
});

test("V3 fixture rejects 255/0 decimals whose generated values exceed protocol bounds", () => {
  assert.throws(() => fixture(255, 0, 10), /V3|bound|decimal/i);
});

test("V3 fixture requires positive integer tick spacing", () => {
  for (const spacing of [0, -1, 1.5, Number.NaN])
    assert.throws(() => fixture(18, 18, spacing), /tick spacing/i);
});

test("profile rejects decimals whose seed mint exceeds uint256", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-mint-bound-"));
  try {
    const config = resolve(dir, "profile.toml");
    writeFileSync(
      config,
      (await Bun.file(defaultProfilePath).text()).replace(
        "A = 18, B = 6, C = 8",
        "A = 255, B = 6, C = 8",
      ),
    );
    await assert.rejects(loadProfile(config), /fixture config/i);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("seed preflights every pool before estimating an earlier createPool", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-seed-preflight-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_ISOLATED_RPC;
  const methods = [];
  let spacingCalls = 0;
  let valid = false;
  const estimates = [];
  const pool = "0x0000000000000000000000000000000000000024";
  process.env.HARNESS_ISOLATED_RPC = "https://isolated.invalid/rpc";
  const word = (value) => `0x${value.replace(/^0x/, "").padStart(64, "0")}`;
  const numberWord = (value) => word(BigInt(value).toString(16));
  const pancake = {
    deployer: "0x0000000000000000000000000000000000000011",
    factory: "0x0000000000000000000000000000000000000012",
    router: "0x0000000000000000000000000000000000000013",
    quoter: "0x0000000000000000000000000000000000000014",
  };
  const tokens = {
    A: { address: "0x0000000000000000000000000000000000000021", decimals: 18 },
    B: { address: "0x0000000000000000000000000000000000000022", decimals: 6 },
  };
  globalThis.fetch = async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    methods.push(method);
    let result;
    if (method === "eth_chainId") result = "0x14a34";
    else if (method === "eth_getCode") result = "0x6000";
    else if (method === "eth_getTransactionCount") result = "0x0";
    else if (method === "eth_estimateGas") {
      assert.ok(valid, "preflight must finish before any estimate");
      estimates.push(params[0]);
      result = "0x10000";
    } else if (method === "eth_gasPrice") result = "0x1";
    else if (method === "eth_call") {
      const { to, data } = params[0];
      const selector = data.slice(0, 10);
      if (selector === "0xc45a0155")
        result = word(
          to === uni.router || to === uni.quoter || to === uni.npm
            ? uni.factory
            : pancake.factory,
        );
      else if (selector === "0x4aa4a4fc")
        result = word("0x4200000000000000000000000000000000000006");
      else if (selector === "0x313ce567")
        result = numberWord(
          Object.values(tokens).find((token) => token.address === to).decimals,
        );
      else if (selector === "0x966dae0e") result = word(pancake.factory);
      else if (selector === "0xd5f39488") result = word(pancake.deployer);
      else if (selector === "0x22afcccb") {
        spacingCalls++;
        result = numberWord(valid || spacingCalls === 1 ? 60 : 0);
      } else if (selector === "0x1698ee82") result = word(valid ? pool : "0");
      else if (selector === "0x3850c7bd")
        result = `0x${"0".repeat(64 * 6)}${"0".repeat(63)}1`;
      else throw new Error(`Unexpected eth_call selector ${selector}`);
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  try {
    const config = resolve(dir, "profile.toml");
    const manifestPath = resolve(dir, "manifest.json");
    const source = (await Bun.file(defaultProfilePath).text())
      .replace("BASE_SEPOLIA_RPC_URL", "HARNESS_ISOLATED_RPC")
      .replace(
        "tokens = { A = 18, B = 6, C = 8 }",
        "tokens = { A = 18, B = 6 }",
      )
      .replace(
        'AB = ["A", "B"]\nBC = ["B", "C"]\nAC = ["A", "C"]',
        'AB = ["A", "B"]',
      )
      .replace('pair = ["A", "C"]', 'pair = ["A", "B"]')
      .replace("pancake_fees = [500, 2500]", "pancake_fees = []");
    const manifest = {
      version: 1,
      chainId: 84532,
      sender,
      transactions: {},
      tokens,
      seeder: "0x0000000000000000000000000000000000000023",
      pancake,
      pools: [],
      uni,
    };
    writeFileSync(config, source);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = await Bun.file(manifestPath).text();
    const args = options([
      "seed",
      "--sender",
      sender,
      "--recipient",
      sender,
      "--config",
      config,
      "--manifest",
      manifestPath,
    ]);
    await assert.rejects(run(args), /invalid tick spacing/);

    assert.equal(spacingCalls, 2);
    assert.equal(methods.includes("eth_estimateGas"), false);
    assert.equal(
      methods.some((method) => /sign|send/i.test(method)),
      false,
    );
    assert.equal(await Bun.file(manifestPath).text(), before);
    valid = true;
    await run(args);
    // The profile's 500 fee is wide; 3000 is narrow. For 18/6 decimals,
    // the aligned center is -276360; widths are 12000 and 120 ticks.
    const vectors = [
      [
        tokens.A.address,
        "mint(address,uint256)",
        sender,
        "1000000000000000000000000",
      ],
      [
        tokens.A.address,
        "approve(address,uint256)",
        manifest.seeder,
        "1000000000000000000000000",
      ],
      [tokens.B.address, "mint(address,uint256)", sender, "1000000000000"],
      [
        tokens.B.address,
        "approve(address,uint256)",
        manifest.seeder,
        "1000000000000",
      ],
      [pool, "initialize(uint160)", String((1n << 96n) / 1000000n)],
      [
        manifest.seeder,
        "seed(address,address,int24,int24,uint128)",
        uni.factory,
        pool,
        "-288360",
        "-264360",
        "10000000000000000",
      ],
      [pool, "initialize(uint160)", String((1n << 96n) / 1000000n)],
      [
        manifest.seeder,
        "seed(address,address,int24,int24,uint128)",
        uni.factory,
        pool,
        "-276480",
        "-276240",
        "10000000000000000",
      ],
    ];
    assert.equal(estimates.length, vectors.length);
    for (const [index, [to, signature, ...values]] of vectors.entries()) {
      const oracle = spawnSync("cast", ["calldata", signature, ...values], {
        encoding: "utf8",
      });
      assert.equal(oracle.status, 0, oracle.stderr);
      assert.deepEqual(estimates[index], {
        from: sender,
        to,
        data: oracle.stdout.trim(),
      });
    }
    assert.equal(await Bun.file(manifestPath).text(), before);
    assert.ok(methods.every((method) => !/send|sign/i.test(method)));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_ISOLATED_RPC;
    else process.env.HARNESS_ISOLATED_RPC = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("check without a manifest rejects instead of reporting zero pools checked", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-missing-manifest-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.HARNESS_ISOLATED_RPC;
  const methods = [];
  const logs = [];
  const previousLog = console.log;
  process.env.HARNESS_ISOLATED_RPC = "https://isolated.invalid/rpc";
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
    } else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const config = resolve(dir, "profile.toml");
    const manifest = resolve(dir, "missing.json");
    writeFileSync(
      config,
      (await Bun.file(defaultProfilePath).text()).replace(
        "BASE_SEPOLIA_RPC_URL",
        "HARNESS_ISOLATED_RPC",
      ),
    );
    await assert.rejects(
      run(options(["check", "--config", config, "--manifest", manifest])),
      /manifest/i,
    );
    assert.equal(existsSync(manifest), false);
    assert.ok(!logs.join("\n").includes("Read checks complete"));
    assert.ok(methods.every((method) => method.startsWith("eth_")));
    assert.ok(methods.every((method) => !/send|sign/i.test(method)));
  } finally {
    console.log = previousLog;
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.HARNESS_ISOLATED_RPC;
    else process.env.HARNESS_ISOLATED_RPC = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("configured HTTPS and loopback HTTP remain accepted transport controls", async () => {
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return Response.json({ result: "0x1" });
  };
  try {
    for (const url of [
      "https://rpc.example.invalid",
      "http://127.0.0.1:8545",
    ]) {
      process.env.BASE_SEPOLIA_RPC_URL = url;
      await assert.rejects(run(options(["check"])), /Chain guard/);
    }
    assert.deepEqual(seen, [
      "https://rpc.example.invalid",
      "http://127.0.0.1:8545",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
    else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
  }
});

test("wrong chain stops before any contract, wallet or write request", async () => {
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  const methods = [];
  process.env.BASE_SEPOLIA_RPC_URL = "https://example.invalid";
  globalThis.fetch = async (_url, request) => {
    methods.push(JSON.parse(request.body).method);
    return Response.json({ result: "0x2105" });
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

async function deploymentProfile(dir) {
  // Synthetic bytecode exercises transaction planning, not EVM deployment.
  const artifact = resolve(dir, "artifact.json");
  writeFileSync(artifact, JSON.stringify({ bytecode: "0x6000" }));
  const config = resolve(dir, "profile.toml");
  writeFileSync(
    config,
    (await Bun.file(defaultProfilePath).text()).replace(
      /^(token|seeder|pancake_bootstrap|pancake_router|pancake_quoter) = .+$/gm,
      `$1 = ${JSON.stringify(artifact)}`,
    ),
  );
  return config;
}

test("full dry deploy estimates every transaction without signing, broadcasting or writing manifest", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-harness-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  process.env.BASE_SEPOLIA_RPC_URL = "https://example.invalid";
  const methods = [];
  const deployments = [];
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
    else if (method === "eth_estimateGas") {
      deployments.push(params[0].data);
      result = "0x100000";
    } else if (method === "eth_gasPrice") result = "0x1000";
    else throw new Error(`Unexpected method ${method}`);
    return Response.json({ result });
  };
  try {
    const path = resolve(dir, "manifest.json");
    const config = await deploymentProfile(dir);
    const args = options([
      "deploy",
      "--sender",
      sender,
      "--manifest",
      path,
      "--config",
      config,
    ]);
    const planned = await run(args);
    assert.equal(methods.filter((m) => m === "eth_estimateGas").length, 7);
    for (const [index, symbol, decimals] of [
      [0, "A", 18],
      [1, "B", 6],
      [2, "C", 8],
    ]) {
      const oracle = spawnSync(
        "cast",
        ["abi-encode", "constructor(string,uint8)", symbol, String(decimals)],
        { encoding: "utf8" },
      );
      assert.equal(oracle.status, 0, oracle.stderr);
      assert.equal(
        deployments[index],
        `0x6000${oracle.stdout.trim().slice(2)}`,
      );
    }
    assert.deepEqual(deployments.slice(3, 5), ["0x6000", "0x6000"]);
    const oracle = spawnSync(
      "cast",
      [
        "abi-encode",
        "constructor(address,address,address)",
        planned.pancake.deployer,
        planned.pancake.factory,
        "0x4200000000000000000000000000000000000006",
      ],
      { encoding: "utf8" },
    );
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.deepEqual(
      deployments.slice(5),
      Array(2).fill(`0x6000${oracle.stdout.trim().slice(2)}`),
    );
    assert.ok(methods.every((m) => !m.includes("send") && !m.includes("sign")));
    assert.equal(existsSync(path), false);
    writeFileSync(path, "{}");
    await assert.rejects(run(args), /Malformed deployment manifest/);
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
    await assert.rejects(run(args), /signer mismatch/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
    else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("signed bytes and hash are journaled before submission and reused after restart", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-journal-"));
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  const previousPath = process.env.PATH;
  const journal = resolve(dir, "manifest.json");
  const signedLog = resolve(dir, "signed.jsonl");
  // Synthetic signer output, never a real key or transaction. Hash independently
  // obtained with `cast keccak 0x010203`.
  const raw = "0x010203";
  const hash =
    "0xf1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c9239";
  const blockHash = `0x${"a".repeat(64)}`;
  let mode = "first";
  const submissions = [];
  const methods = [];
  try {
    const config = await deploymentProfile(dir);
    const keystore = resolve(dir, "keystore");
    const password = resolve(dir, "password");
    writeFileSync(keystore, "{}");
    writeFileSync(password, "test-only", { mode: 0o600 });
    writeFileSync(
      resolve(dir, "cast"),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "wallet" && args[1] === "address") console.log(${JSON.stringify(sender)});
else if (args[0] === "mktx") {
  appendFileSync(${JSON.stringify(signedLog)}, JSON.stringify(args) + "\\n");
  console.log(${JSON.stringify(raw)});
} else throw new Error("Only encrypted signer operations may use Cast");
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}:${previousPath}`;
    process.env.BASE_SEPOLIA_RPC_URL = "https://journal.invalid";
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
      } else if (method === "eth_estimateGas") {
        if (mode === "observed")
          return Response.json({
            error: { code: -32000, message: "stop after resumed receipt" },
          });
        result = "0x65";
      } else if (method === "eth_gasPrice") result = "0x7";
      else if (method === "eth_getBalance") result = "0x69e";
      else if (method === "eth_getTransactionCount") {
        result =
          params[1] === "pending"
            ? mode === "first"
              ? "0x9"
              : "0xd"
            : mode === "nonce used"
              ? "0xa"
              : "0x9";
      } else if (method === "eth_getTransactionReceipt") {
        assert.deepEqual(params, [hash]);
        result =
          mode === "observed"
            ? {
                transactionHash: hash,
                blockHash,
                blockNumber: "0x42",
                status: "0x1",
                contractAddress: sender,
              }
            : null;
      } else if (method === "eth_getTransactionByHash") result = null;
      else if (method === "eth_getBlockByNumber") result = { hash: blockHash };
      else if (method === "eth_sendRawTransaction") {
        const saved = await Bun.file(journal).json();
        assert.deepEqual(saved.transactions["token-A"], {
          to: null,
          data: saved.transactions["token-A"].data,
          nonce: "0x9",
          raw,
          hash,
        });
        assert.deepEqual(params, [raw]);
        submissions.push(params[0]);
        throw new Error("submission interrupted after persistence");
      } else throw new Error(`Unexpected RPC method ${method}`);
      return Response.json({ result });
    };
    const args = options([
      "deploy",
      "--sender",
      sender,
      "--manifest",
      journal,
      "--config",
      config,
      "--broadcast",
      "--keystore",
      keystore,
      "--password-file",
      password,
    ]);
    await assert.rejects(run(args), /request failed/);
    const first = await Bun.file(journal).text();
    const signed = JSON.parse((await Bun.file(signedLog).text()).trim());
    assert.deepEqual(signed.slice(0, 11), [
      "mktx",
      "--legacy",
      "--chain",
      "84532",
      "--nonce",
      "9",
      "--gas-limit",
      "121",
      "--gas-price",
      "14",
      "--keystore",
    ]);
    mode = "resume";
    await assert.rejects(run(args), /request failed/);
    assert.equal(await Bun.file(journal).text(), first);
    assert.deepEqual(submissions, [raw, raw]);
    mode = "nonce used";
    await assert.rejects(run(args), /Nonce used by another transaction/);
    assert.equal(submissions.length, 2);
    mode = "observed";
    await assert.rejects(run(args), /request/);
    assert.equal(submissions.length, 2, "observed receipt must not resubmit");
    assert.equal(
      (await Bun.file(signedLog).text()).trim().split("\n").length,
      1,
    );
    assert.equal(
      (await Bun.file(journal).json()).transactions["token-A"].receipt
        .blockHash,
      blockHash,
    );
    assert.ok(methods.includes("eth_getBlockByNumber"));
  } finally {
    globalThis.fetch = previousFetch;
    process.env.PATH = previousPath;
    if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
    else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
    rmSync(dir, { recursive: true });
  }
});

test("CREATE prediction matches independent Cast at RLP nonce boundaries", () => {
  for (const nonce of [
    0n,
    1n,
    127n,
    128n,
    255n,
    256n,
    65535n,
    65536n,
    (1n << 64n) - 1n,
  ]) {
    const oracle = spawnSync(
      "cast",
      ["compute-address", sender, "--nonce", String(nonce)],
      { encoding: "utf8" },
    );
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.equal(
      createAddress(sender, nonce),
      oracle.stdout.match(/0x[0-9a-fA-F]{40}/)?.[0],
    );
  }
});

test("raw RPC preserves receipt values and never retries failures", async () => {
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  const rpc = createRpc("https://secret.invalid/private-token");
  try {
    const receipt = {
      status: "0x01",
      blockNumber: "0x00",
      extra: "unformatted",
    };
    globalThis.fetch = async (_url, request) => {
      const payload = JSON.parse(request.body);
      assert.equal(payload.method, "eth_getTransactionReceipt");
      assert.deepEqual(payload.params, ["0xabc"]);
      return Response.json({ result: receipt });
    };
    assert.deepEqual(
      await rpc("eth_getTransactionReceipt", ["0xabc"]),
      receipt,
    );
    for (const fail of [
      () => {
        throw new Error("private-token network failure");
      },
      () => new Response("private-token", { status: 503 }),
      () =>
        Response.json({
          error: { code: -32005, message: "private-token rate limit" },
        }),
      () => Response.json({}),
    ]) {
      attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return fail();
      };
      await assert.rejects(
        rpc("eth_sendRawTransaction", ["0x010203"]),
        (error) => !error.message.includes("private-token"),
      );
      assert.equal(attempts, 1);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("each RPC has a fresh 60-second abort covering body consumption", async () => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = AbortSignal.timeout;
  const controllers = [];
  let headersReceived = false;
  try {
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 60000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    };
    const rpc = createRpc("https://timeout.invalid");
    globalThis.fetch = async (_url, request) => {
      headersReceived = true;
      assert.equal(request.signal, controllers[0].signal);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"result":'));
            request.signal.addEventListener(
              "abort",
              () => stream.error(request.signal.reason),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const pending = rpc("eth_chainId");
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(headersReceived, true);
    controllers[0].abort(new Error("private body timeout"));
    await assert.rejects(pending, /network request failed \(URL withheld\)/);
    globalThis.fetch = async (_url, request) => {
      assert.equal(request.signal, controllers[1].signal);
      assert.equal(request.signal.aborted, false);
      return Response.json({ result: "0x14a34" });
    };
    assert.equal(await rpc("eth_chainId"), "0x14a34");
    assert.equal(controllers.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    AbortSignal.timeout = previousTimeout;
  }
});

test("static returndata requires exact canonical words including signed int24", () => {
  // Independent ABI words, not serialized with the production encoder.
  const word = (n) =>
    (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");
  for (const value of [-8388608n, -60n, -1n, 0n, 60n, 8388607n])
    assert.equal(
      decodeResult(
        uniswapV3FactoryAbi,
        "feeAmountTickSpacing",
        `0x${word(value)}`,
      ),
      Number(value),
    );
  assert.equal(decodeResult(erc20Abi, "decimals", `0x${word(255n)}`), 255);
  assert.equal(
    decodeResult(uniswapPeripheryStateAbi, "factory", `0x${word(1n)}`),
    sender,
  );
  const slot = [(1n << 96n) + 7n, -60n, 1n, 2n, 3n, 255n, 1n]
    .map(word)
    .join("");
  assert.deepEqual(decodeResult(uniswapV3PoolAbi, "slot0", `0x${slot}`), [
    (1n << 96n) + 7n,
    -60,
    1,
    2,
    3,
    255,
    true,
  ]);
  const pancakeSlot = [1n << 96n, -1n, 0n, 0n, 0n, 65536n, 0n]
    .map(word)
    .join("");
  assert.deepEqual(
    decodeResult(pancakeV3PoolAbi, "slot0", `0x${pancakeSlot}`),
    [1n << 96n, -1, 0, 0, 0, 65536, false],
  );
  for (const [abi, name, data] of [
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", "0x"],
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", `0x${"00".repeat(31)}`],
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", `0x${word(60n)}00`],
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", `0x${word(8388608n)}`],
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", `0x${word(-8388609n)}`],
    [uniswapV3FactoryAbi, "feeAmountTickSpacing", `0x${word(0xffffffn)}`],
    [uniswapPeripheryStateAbi, "factory", `0x${word((1n << 160n) + 1n)}`],
    [erc20Abi, "decimals", `0x${word(256n)}`],
    [uniswapV3PoolAbi, "slot0", `0x${slot.slice(0, -64)}`],
    [uniswapV3PoolAbi, "slot0", `0x${slot}${word(0n)}`],
    [uniswapV3PoolAbi, "slot0", `0x${slot.slice(0, -64)}${word(2n)}`],
    [uniswapV3PoolAbi, "slot0", `0x${pancakeSlot}`],
    [uniswapPeripheryStateAbi, "factory", "private malformed body"],
  ]) {
    assert.throws(() => decodeResult(abi, name, data), {
      message: `Invalid ${name} returndata`,
    });
  }
});

test("malformed linkage returndata stops before wallet, nonce or transaction planning", async () => {
  const previousFetch = globalThis.fetch;
  const previousURL = process.env.BASE_SEPOLIA_RPC_URL;
  const dir = mkdtempSync(resolve(tmpdir(), "epeius-linkage-"));
  const methods = [];
  process.env.BASE_SEPOLIA_RPC_URL = "https://linkage.invalid";
  globalThis.fetch = async (_url, request) => {
    const { method } = JSON.parse(request.body);
    methods.push(method);
    if (method === "eth_chainId") return Response.json({ result: "0x14a34" });
    if (method === "eth_getCode") return Response.json({ result: "0x6000" });
    assert.equal(method, "eth_call");
    // Correct low 20 bytes, but nonzero address padding was previously sliced away.
    return Response.json({
      result: `0x${"1".repeat(24)}${uni.factory.slice(2)}`,
    });
  };
  try {
    const path = resolve(dir, "manifest.json");
    await assert.rejects(
      run(options(["deploy", "--sender", sender, "--manifest", path])),
      /Invalid factory returndata/,
    );
    assert.equal(existsSync(path), false);
    assert.ok(
      methods.every((method) =>
        ["eth_chainId", "eth_getCode", "eth_call"].includes(method),
      ),
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousURL === undefined) delete process.env.BASE_SEPOLIA_RPC_URL;
    else process.env.BASE_SEPOLIA_RPC_URL = previousURL;
    rmSync(dir, { recursive: true });
  }
});
