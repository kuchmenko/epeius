import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const zero = `0x${"0".repeat(40)}`;
const weth = "0x4200000000000000000000000000000000000006";
export const uni = {
  factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  npm: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
};
const decimals = { A: 18, B: 6, C: 8 };
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const confirmedHash = (hash) =>
  /^0x[\da-fA-F]{64}$/.test(hash ?? "") && !/^0x0{64}$/.test(hash);

export async function canonicalReceipt(rpc, hash, previous) {
  const receipt = await rpc("eth_getTransactionReceipt", [hash]);
  if (
    receipt &&
    (!receipt.transactionHash || !same(receipt.transactionHash, hash))
  ) {
    throw new Error(`Receipt transaction mismatch: ${hash}`);
  }
  if (
    !receipt ||
    !confirmedHash(receipt.blockHash) ||
    receipt.blockNumber == null
  )
    return null;
  if (
    confirmedHash(previous?.blockHash) &&
    !same(previous.blockHash, receipt.blockHash)
  ) {
    throw new Error(`Receipt changed: ${hash}`);
  }
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!block || !confirmedHash(block.hash)) return null;
  if (!same(block.hash, receipt.blockHash))
    throw new Error(`Receipt block mismatch: ${hash}`);
  return receipt;
}

export function address(value) {
  if (!/^0x[\da-fA-F]{40}$/.test(value ?? "") || same(value, zero))
    throw new Error("Expected nonzero 20-byte address");
  return value;
}
export function options(args) {
  const result = {
    command: args[0],
    broadcast: false,
    manifest: resolve(root, ".testnet/manifest.json"),
    recipients: [],
  };
  if (!["deploy", "seed", "check", "config"].includes(result.command))
    throw new Error("Expected deploy, seed, check, or config");
  const names = {
    "--manifest": "manifest",
    "--sender": "sender",
    "--keystore": "keystore",
    "--password-file": "passwordFile",
  };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--broadcast") {
      result.broadcast = true;
      continue;
    }
    const name = args[i];
    if (!(name in names) && name !== "--recipient")
      throw new Error(`Unknown option ${name}`);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${name}`);
    if (name === "--recipient") result.recipients.push(address(value));
    else if (result[names[name]] && name !== "--manifest")
      throw new Error(`Duplicate option ${name}`);
    else result[names[name]] = value;
  }
  if (result.sender) address(result.sender);
  if (result.broadcast && !["deploy", "seed"].includes(result.command))
    throw new Error("Read-only command cannot broadcast");
  if (["deploy", "seed"].includes(result.command) && !result.sender)
    throw new Error("--sender required even for dry-run");
  if (result.command === "seed" && !result.recipients.length)
    throw new Error(
      "seed requires explicit --recipient inputs (including liquidity payer)",
    );
  if (result.broadcast && (!result.keystore || !result.passwordFile))
    throw new Error(
      "Broadcast requires encrypted --keystore and --password-file",
    );
  return result;
}
function cast(args) {
  try {
    // Never inherit ETH_PRIVATE_KEY, ETH_PASSWORD, or other implicit wallet selections.
    return execFileSync("cast", args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    throw new Error(`cast ${args[0]} failed; arguments/output withheld`);
  }
}
const encode = (signature, args = []) =>
  cast(["calldata", signature, ...args.map(String)]);
const createAddress = (sender, nonce) =>
  address(
    cast(["compute-address", sender, "--nonce", String(nonce)]).match(
      /0x[\da-fA-F]{40}/,
    )?.[0],
  );
function code(path) {
  const artifact = JSON.parse(readFileSync(resolve(root, path)));
  const bytes =
    artifact.evm?.bytecode?.object ??
    artifact.bytecode?.object ??
    artifact.bytecode;
  if (typeof bytes !== "string" || !/^(0x)?[\da-fA-F]+$/.test(bytes))
    throw new Error(`Invalid or unlinked artifact: ${path}`);
  return bytes.startsWith("0x") ? bytes : `0x${bytes}`;
}
export function sqrt(value) {
  if (value < 0n) throw new Error("Negative square root");
  if (value < 2n) return value;
  let x = value,
    y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}
export function fixture(
  token0Decimals,
  token1Decimals,
  spacing,
  narrow = false,
) {
  // One whole token0 = one whole token1. Keep raw-unit decimal asymmetry.
  const sqrtPriceX96 = sqrt(
    ((10n ** BigInt(token1Decimals)) << 192n) / 10n ** BigInt(token0Decimals),
  );
  const tick = Math.floor(
    Math.log(10 ** (token1Decimals - token0Decimals)) / Math.log(1.0001),
  );
  const center = Math.floor(tick / spacing) * spacing;
  const width = narrow ? 2 * spacing : Math.ceil(12000 / spacing) * spacing;
  // ~100 whole tokens for narrow pools, ~10,000 for wide pools.
  const liquidity =
    sqrt(10n ** BigInt(token0Decimals + token1Decimals)) * 10000n;
  return {
    sqrtPriceX96: String(sqrtPriceX96),
    lower: center - width,
    upper: center + width,
    liquidity: String(liquidity),
  };
}

export async function run(o) {
  const url = process.env.BASE_SEPOLIA_RPC_URL;
  if (!url || !/^https?:\/\//.test(url))
    throw new Error("BASE_SEPOLIA_RPC_URL must be an HTTP(S) URL");
  async function rpc(method, params = []) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error(`${method}: network request failed (URL withheld)`);
    }
    const body = await response.json();
    if (!response.ok || body.error || !("result" in body))
      throw new Error(`${method}: RPC rejected request (details withheld)`);
    return body.result;
  }
  if (BigInt(await rpc("eth_chainId")) !== 84532n)
    throw new Error("Chain guard: expected Base Sepolia 84532");
  const call = async (to, signature, args = []) =>
    rpc("eth_call", [{ to, data: encode(signature, args) }, "latest"]);
  const addr = async (to, signature, args = []) =>
    address(`0x${(await call(to, signature, args)).slice(-40)}`);
  async function verifyCode(target) {
    const bytes = await rpc("eth_getCode", [address(target), "latest"]);
    if (bytes === "0x") throw new Error(`Missing bytecode at ${target}`);
    return cast(["keccak", bytes]);
  }
  const officialHashes = {};
  for (const [name, target] of Object.entries(uni))
    officialHashes[name] = await verifyCode(target);
  await verifyCode(weth);
  for (const [name, getter] of [
    ["quoter", "factory()"],
    ["router", "factory()"],
    ["npm", "factory()"],
  ]) {
    if (!same(await addr(uni[name], getter), uni.factory))
      throw new Error(`Official ${name} factory link mismatch`);
    if (!same(await addr(uni[name], "WETH9()"), weth))
      throw new Error(`Official ${name} WETH link mismatch`);
  }
  console.log(
    "Base Sepolia guard and official Uniswap bytecode/factory/WETH links verified.",
  );
  const manifest = existsSync(o.manifest)
    ? JSON.parse(readFileSync(o.manifest))
    : {
        version: 1,
        chainId: 84532,
        sender: o.sender,
        transactions: {},
        tokens: {},
        pancake: {},
        pools: [],
      };
  if (
    manifest.version !== 1 ||
    manifest.chainId !== 84532 ||
    !manifest.transactions ||
    !manifest.tokens ||
    !manifest.pancake ||
    !Array.isArray(manifest.pools)
  )
    throw new Error("Malformed deployment manifest");
  if (o.sender && manifest.sender && !same(o.sender, manifest.sender))
    throw new Error("Manifest signer mismatch");
  manifest.sender ??= o.sender;
  manifest.uni = uni;
  manifest.officialCodeHashes = officialHashes;
  const save = () => {
    if (!o.broadcast) return;
    mkdirSync(dirname(resolve(o.manifest)), { recursive: true });
    writeFileSync(
      `${o.manifest}.tmp`,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(`${o.manifest}.tmp`, o.manifest);
  };
  if (o.broadcast) {
    for (const path of [o.keystore, o.passwordFile])
      if (!statSync(path).isFile())
        throw new Error("Signer paths must be files");
    if ((statSync(o.passwordFile).mode & 0o077) !== 0)
      throw new Error("Password file must not be group/world accessible");
    const signer = cast([
      "wallet",
      "address",
      "--keystore",
      o.keystore,
      "--password-file",
      o.passwordFile,
    ]);
    if (!same(address(signer), o.sender))
      throw new Error("Keystore does not match --sender");
  }
  let plannedNonce = o.sender
    ? BigInt(await rpc("eth_getTransactionCount", [o.sender, "pending"]))
    : 0n;
  let estimatedGas = 0n;
  async function waitReceipt(key, record) {
    for (let i = 0; i < 120; i++) {
      const receipt = await canonicalReceipt(rpc, record.hash, record.receipt);
      if (receipt) {
        if (BigInt(receipt.status) !== 1n)
          throw new Error(
            `Reverted ${key}: ${record.hash}; inspect before changing manifest`,
          );
        record.receipt = receipt;
        save();
        return receipt;
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`Pending ${key}: ${record.hash}; rerun same command`);
  }
  async function transact(key, to, data) {
    const prior = manifest.transactions[key];
    if (prior && (prior.to !== to || prior.data !== data))
      throw new Error(`Transaction definition changed: ${key}`);
    if (prior?.receipt) {
      // Old journals may contain Base preconfirmations with a zero block hash.
      // Refresh the same transaction only; never sign or resend this branch.
      const current = await waitReceipt(key, prior);
      return current.contractAddress;
    }
    const predicted = !to ? createAddress(o.sender, plannedNonce) : null;
    if (!o.broadcast) {
      if (prior)
        throw new Error(
          `Unconfirmed transaction ${key}; resume with broadcast to check/rebroadcast exact signed bytes`,
        );
      try {
        const gas = BigInt(
          await rpc("eth_estimateGas", [
            { from: o.sender, ...(to ? { to } : {}), data },
          ]),
        );
        estimatedGas += gas;
        console.log(
          `DRY ${key}: ${gas} gas${predicted ? `, predicted ${predicted}` : ""}`,
        );
      } catch {
        console.log(
          `DRY ${key}: estimate unavailable until preceding deployments/writes exist`,
        );
      }
      plannedNonce++;
      return predicted;
    }
    let record = prior;
    if (!record) {
      const gas = BigInt(
        await rpc("eth_estimateGas", [
          { from: o.sender, ...(to ? { to } : {}), data },
        ]),
      );
      const gasLimit = (gas * 120n) / 100n;
      const price = BigInt(await rpc("eth_gasPrice")) * 2n;
      const balance = BigInt(await rpc("eth_getBalance", [o.sender, "latest"]));
      if (balance < gasLimit * price)
        throw new Error(`Insufficient balance for ${key}`);
      console.log(
        `${key}: estimated ${gas} gas; L2 ceiling ${gasLimit * price} wei (L1 data fee extra)`,
      );
      const nonce = await rpc("eth_getTransactionCount", [o.sender, "pending"]);
      const raw = cast([
        "mktx",
        "--legacy",
        "--chain",
        "84532",
        "--nonce",
        String(BigInt(nonce)),
        "--gas-limit",
        String(gasLimit),
        "--gas-price",
        String(price),
        "--keystore",
        o.keystore,
        "--password-file",
        o.passwordFile,
        ...(to ? [to, data] : ["--create", data]),
      ]);
      record = { to, data, nonce, raw, hash: cast(["keccak", raw]) };
      manifest.transactions[key] = record;
      // Persist signed bytes and hash BEFORE submission. Restart can only resubmit this exact transaction.
      save();
    }
    const observed = await rpc("eth_getTransactionReceipt", [record.hash]);
    if (!observed && !(await rpc("eth_getTransactionByHash", [record.hash]))) {
      if (
        BigInt(await rpc("eth_getTransactionCount", [o.sender, "latest"])) >
        BigInt(record.nonce)
      )
        throw new Error(
          `Nonce used by another transaction: ${key}; inspect manually`,
        );
      const hash = await rpc("eth_sendRawTransaction", [record.raw]);
      if (!same(hash, record.hash))
        throw new Error("Unexpected transaction hash");
    }
    const receipt = await waitReceipt(key, record);
    console.log(`${key}: ${record.hash}`);
    return receipt.contractAddress;
  }
  const deploy = async (key, path, signature, args = []) =>
    transact(
      key,
      null,
      code(path) +
        (signature
          ? cast(["abi-encode", signature, ...args.map(String)]).slice(2)
          : ""),
    );
  const write = (key, target, signature, args) =>
    transact(key, target, encode(signature, args));
  if (o.command === "deploy") {
    for (const [symbol, d] of Object.entries(decimals)) {
      manifest.tokens[symbol] = {
        address: await deploy(
          `token-${symbol}`,
          "contracts/out/TestToken.sol/TestToken.json",
          "constructor(string,uint8)",
          [symbol, d],
        ),
        decimals: d,
      };
    }
    manifest.seeder = await deploy(
      "seeder",
      "contracts/out/LiquiditySeeder.sol/LiquiditySeeder.json",
    );
    const bootstrap = await deploy(
      "pancake-bootstrap",
      ".testnet/PancakeBootstrap.json",
    );
    manifest.pancake.bootstrap = bootstrap;
    // CREATE nonces in a contract start at one. These predictions are used only in dry-run.
    const child = (nonce) => createAddress(bootstrap, nonce);
    manifest.pancake.deployer = o.broadcast
      ? await addr(bootstrap, "deployer()")
      : child(1);
    manifest.pancake.factory = o.broadcast
      ? await addr(bootstrap, "factory()")
      : child(2);
    const args = [manifest.pancake.deployer, manifest.pancake.factory, weth];
    manifest.pancake.router = await deploy(
      "pancake-router",
      "scripts/testnet/node_modules/@pancakeswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
      "constructor(address,address,address)",
      args,
    );
    manifest.pancake.quoter = await deploy(
      "pancake-quoter",
      "scripts/testnet/node_modules/@pancakeswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json",
      "constructor(address,address,address)",
      args,
    );
    save();
  }
  if (
    ["seed", "config"].includes(o.command) ||
    (o.command === "check" && existsSync(o.manifest))
  ) {
    for (const symbol of Object.keys(decimals)) {
      const token = manifest.tokens[symbol];
      if (!token || token.decimals !== decimals[symbol])
        throw new Error(`Missing or invalid ${symbol} deployment`);
      await verifyCode(token.address);
      if (
        BigInt(await call(token.address, "decimals()")) !==
        BigInt(decimals[symbol])
      )
        throw new Error(`Wrong decimals: ${symbol}`);
    }
    for (const name of ["deployer", "factory", "router", "quoter"])
      await verifyCode(manifest.pancake[name]);
    if (
      !same(
        await addr(manifest.pancake.deployer, "factoryAddress()"),
        manifest.pancake.factory,
      )
    )
      throw new Error("Pancake deployer not initialized to factory");
    for (const name of ["router", "quoter"]) {
      for (const [getter, expected] of [
        ["factory()", manifest.pancake.factory],
        ["deployer()", manifest.pancake.deployer],
        ["WETH9()", weth],
      ]) {
        if (!same(await addr(manifest.pancake[name], getter), expected))
          throw new Error(`Pancake ${name} ${getter} mismatch`);
      }
    }
  }
  if (o.command === "seed") {
    if (!o.recipients.some((r) => same(r, o.sender)))
      throw new Error(
        "Explicit recipients must include --sender to pay for liquidity",
      );
    for (const [symbol, token] of Object.entries(manifest.tokens)) {
      for (const recipient of [
        ...new Set(o.recipients.map((r) => r.toLowerCase())),
      ]) {
        await write(
          `mint-${symbol}-${recipient}`,
          token.address,
          "mint(address,uint256)",
          [recipient, 1000000n * 10n ** BigInt(token.decimals)],
        );
      }
      await write(
        `approve-${symbol}`,
        token.address,
        "approve(address,uint256)",
        [manifest.seeder, 1000000n * 10n ** BigInt(token.decimals)],
      );
    }
    for (const [provider, factory, fees] of [
      ["uni", uni.factory, [500, 3000]],
      ["pancake", manifest.pancake.factory, [500, 2500]],
    ]) {
      for (const pair of [
        ["A", "B"],
        ["B", "C"],
        ["A", "C"],
      ])
        for (const fee of fees) {
          const key = `${provider}-${pair.join("")}-${fee}`;
          const [t0, t1] = pair
            .map((s) => manifest.tokens[s])
            .sort((a, b) =>
              a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
            );
          let pool = `0x${(await call(factory, "getPool(address,address,uint24)", [t0.address, t1.address, fee])).slice(-40)}`;
          if (same(pool, zero)) {
            await write(
              `create-${key}`,
              factory,
              "createPool(address,address,uint24)",
              [t0.address, t1.address, fee],
            );
            if (!o.broadcast) {
              console.log(
                `DRY ${key}: initialize and seed after creation (narrow=${fee !== 500})`,
              );
              continue;
            }
            pool = await addr(factory, "getPool(address,address,uint24)", [
              t0.address,
              t1.address,
              fee,
            ]);
          }
          const spacing = Number(
            BigInt(await call(factory, "feeAmountTickSpacing(uint24)", [fee])),
          );
          const f = fixture(t0.decimals, t1.decimals, spacing, fee !== 500);
          const slot = await call(pool, "slot0()");
          if (BigInt(`0x${slot.slice(2, 66)}`) === 0n)
            await write(`initialize-${key}`, pool, "initialize(uint160)", [
              f.sqrtPriceX96,
            ]);
          await write(
            `seed-${key}`,
            manifest.seeder,
            "seed(address,address,int24,int24,uint128)",
            [factory, pool, f.lower, f.upper, f.liquidity],
          );
          const entry = {
            key,
            provider,
            pair,
            fee,
            address: pool,
            token0: t0.address,
            token1: t1.address,
            ...f,
            narrow: fee !== 500,
          };
          manifest.pools = manifest.pools
            .filter((p) => p.key !== key)
            .concat(entry);
          save();
        }
    }
  }
  if (o.command === "check") {
    for (const pool of manifest.pools) {
      await verifyCode(pool.address);
      const liquidity = BigInt(await call(pool.address, "liquidity()"));
      console.log(`${pool.key}: active liquidity ${liquidity}`);
    }
    console.log(
      `Read checks complete; ${manifest.pools.length} manifest pools. No writes.`,
    );
  }
  if (o.command === "config") {
    const lines = [
      "[terminal]",
      'default_chain = "base-sepolia"',
      'engine_url = "http://127.0.0.1:8080"',
      "search_budget_ms = 3000",
      "",
      "[engine]",
      'listen_addr = "127.0.0.1:8080"',
      "",
      "[chains.base-sepolia]",
      "chain_id = 84532",
      'rpc_url_env = "BASE_SEPOLIA_RPC_URL"',
      "execution_enabled = true",
    ];
    for (const [symbol, token] of Object.entries(manifest.tokens))
      lines.push(
        "",
        "[[chains.base-sepolia.tokens]]",
        `address = "${token.address}"`,
        `symbol = "${symbol}"`,
        `decimals = ${token.decimals}`,
      );
    for (const [name, deployment, kind, fees] of [
      ["uni", uni, "uniswap-v3", "[500, 3000]"],
      ["pancake", manifest.pancake, "pancake-v3", "[500, 2500]"],
    ]) {
      lines.push(
        "",
        `[chains.base-sepolia.deployments.${name}]`,
        `kind = "${kind}"`,
        ...["factory", "quoter", "router"].map(
          (key) => `${key} = "${deployment[key]}"`,
        ),
        `fees = ${fees}`,
      );
    }
    const path = resolve(dirname(o.manifest), "runtime.toml");
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    console.log(`Runtime config: ${path}`);
  }
  if (!o.broadcast && estimatedGas) {
    const price = BigInt(await rpc("eth_gasPrice"));
    console.log(
      `Available estimates: ${estimatedGas} gas, ${estimatedGas * price} wei L2 at current gas price; excludes unavailable steps and L1 data fee. No broadcasts.`,
    );
  }
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await run(options(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
