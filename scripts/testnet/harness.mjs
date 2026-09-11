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
import {
  createClient,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getContractAddress,
  http,
  isAddress,
  isHash,
  isHex,
  keccak256,
  maxUint128,
  maxUint256,
  parseUnits,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  liquiditySeederAbi,
  pancakeBootstrapAbi,
  pancakePoolDeployerAbi,
  pancakeQuoterV2Abi,
  pancakeV3FactoryAbi,
  pancakeV3PoolAbi,
  pancakeV3RouterAbi,
  testTokenAbi,
  uniswapPeripheryStateAbi,
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
} from "../../generated/abi/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultConfig = resolve(root, "scripts/testnet/harness.toml");
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const confirmedHash = (hash) => isHash(hash ?? "") && !same(hash, zeroHash);

export function createRpc(url) {
  const client = createClient({
    transport: http(url, {
      raw: true,
      retryCount: 0,
      timeout: 60000,
      // Viem's timeout ends at headers. This fresh signal also covers the body.
      fetchFn: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(60000),
        }),
    }),
  });
  return async (method, params = []) => {
    let body;
    try {
      body = await client.request({ method, params });
    } catch {
      throw new Error(`${method}: network request failed (URL withheld)`);
    }
    if (!body || body.error || body.result === undefined)
      throw new Error(`${method}: RPC rejected request (details withheld)`);
    return body.result;
  };
}

export function decodeResult(abi, functionName, data) {
  try {
    if (!isHex(data, { strict: true })) throw new Error();
    const result = decodeFunctionResult({ abi, functionName, data });
    // Decoding alone accepts extra bytes and noncanonical address/integer words.
    if (!same(encodeFunctionResult({ abi, functionName, result }), data))
      throw new Error();
    return result;
  } catch {
    throw new Error(`Invalid ${functionName} returndata`);
  }
}

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
  if (!isAddress(value ?? "", { strict: false }) || same(value, zeroAddress))
    throw new Error("Expected nonzero 20-byte address");
  return value;
}
export function options(args) {
  const result = {
    command: args[0],
    broadcast: false,
    config: defaultConfig,
    manifest: resolve(root, ".testnet/manifest.json"),
    recipients: [],
  };
  if (!["deploy", "seed", "check", "config"].includes(result.command))
    throw new Error("Expected deploy, seed, check, or config");
  const names = {
    "--config": "config",
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
    else if (result[names[name]] && !["--manifest", "--config"].includes(name))
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
export async function loadProfile(path) {
  let raw;
  try {
    raw = Bun.TOML.parse(await Bun.file(path).text());
  } catch {
    throw new Error(`Cannot read harness config: ${path}`);
  }
  const chain = raw.chain;
  const uni = raw.uniswap;
  const fixtures = raw.fixtures;
  const artifacts = raw.artifacts;
  const engine = raw.engine;
  if (
    !Number.isSafeInteger(engine?.quote_concurrency) ||
    engine.quote_concurrency <= 0 ||
    typeof chain?.key !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(chain.key) ||
    !Number.isSafeInteger(chain.id) ||
    chain.id <= 0 ||
    typeof chain.rpc_url_env !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chain.rpc_url_env) ||
    !fixtures?.tokens ||
    !fixtures.pairs ||
    Array.isArray(fixtures.pairs) ||
    !Number.isInteger(fixtures.broad_fee) ||
    !Array.isArray(fixtures.uniswap_fees) ||
    !Array.isArray(fixtures.pancake_fees) ||
    !artifacts ||
    [
      "token",
      "seeder",
      "pancake_bootstrap",
      "pancake_router",
      "pancake_quoter",
    ].some((name) => typeof artifacts[name] !== "string" || !artifacts[name])
  )
    throw new Error("Malformed harness config");
  const addresses = {
    weth: chain.weth,
    factory: uni?.factory,
    quoter: uni?.quoter,
    router: uni?.router,
    npm: uni?.npm,
  };
  for (const [name, value] of Object.entries(addresses)) {
    try {
      address(value);
    } catch {
      throw new Error(`Invalid harness config address: ${name}`);
    }
  }
  const decimals = fixtures.tokens;
  if (
    !Object.keys(decimals).length ||
    Object.keys(decimals).some((symbol) => !symbol) ||
    Object.values(decimals).some(
      (value) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255 ||
        parseUnits("1000000", value) > maxUint256,
    ) ||
    Object.entries(fixtures.pairs).some(
      ([id, pair]) =>
        !id ||
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair[0] === pair[1] ||
        pair.some((symbol) => !(symbol in decimals)),
    ) ||
    [...fixtures.uniswap_fees, ...fixtures.pancake_fees].some(
      (fee) => !Number.isInteger(fee) || fee < 0 || fee >= 1000000,
    )
  )
    throw new Error("Malformed harness fixture config");
  return { chain, uni, fixtures, decimals, artifacts, engine };
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
export const createAddress = (sender, nonce) =>
  address(getContractAddress({ from: sender, nonce: BigInt(nonce) }));
function code(path) {
  const artifact = JSON.parse(readFileSync(resolve(root, path)));
  const bytes =
    artifact.evm?.bytecode?.object ??
    artifact.bytecode?.object ??
    artifact.bytecode;
  const hex =
    typeof bytes === "string" &&
    (bytes.startsWith("0x") ? bytes : `0x${bytes}`);
  if (!hex || !isHex(hex, { strict: true }) || hex.length <= 2)
    throw new Error(`Invalid or unlinked artifact: ${path}`);
  return hex;
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
  if (!Number.isInteger(spacing) || spacing <= 0)
    throw new Error("V3 tick spacing must be a positive integer");
  // One whole token0 = one whole token1. Keep raw-unit decimal asymmetry.
  const sqrtPriceX96 = sqrt(
    (parseUnits("1", token1Decimals) << 192n) / parseUnits("1", token0Decimals),
  );
  const tick = Math.floor(
    Math.log(10 ** (token1Decimals - token0Decimals)) / Math.log(1.0001),
  );
  const center = Math.floor(tick / spacing) * spacing;
  const width = narrow ? 2 * spacing : Math.ceil(12000 / spacing) * spacing;
  const lower = center - width;
  const upper = center + width;
  // ~100 whole tokens for narrow pools, ~10,000 for wide pools.
  const liquidity =
    sqrt(parseUnits("1", token0Decimals + token1Decimals)) * 10000n;
  if (
    sqrtPriceX96 < 4295128739n ||
    sqrtPriceX96 >= 1461446703485210103287273052203988822378723970342n ||
    !Number.isSafeInteger(lower) ||
    !Number.isSafeInteger(upper) ||
    lower < -887272 ||
    upper > 887272 ||
    lower >= upper ||
    lower % spacing !== 0 ||
    upper % spacing !== 0 ||
    liquidity <= 0n ||
    liquidity > maxUint128
  )
    throw new Error("Generated V3 fixture exceeds protocol bounds");
  return {
    sqrtPriceX96: String(sqrtPriceX96),
    lower,
    upper,
    liquidity: String(liquidity),
  };
}

export async function run(o) {
  const { chain, uni, fixtures, decimals, artifacts, engine } =
    await loadProfile(o.config);
  const weth = chain.weth;
  const url = process.env[chain.rpc_url_env];
  if (!url || !/^https?:\/\//.test(url))
    throw new Error(`${chain.rpc_url_env} must be an HTTP(S) URL`);
  const rpc = createRpc(url);
  if (BigInt(await rpc("eth_chainId")) !== BigInt(chain.id))
    throw new Error(`Chain guard: expected ${chain.key} ${chain.id}`);
  const manifestExists = existsSync(o.manifest);
  if (o.command === "check" && !manifestExists)
    throw new Error(`Deployment manifest not found: ${o.manifest}`);
  const manifest = manifestExists
    ? JSON.parse(readFileSync(o.manifest))
    : {
        version: 1,
        chainId: chain.id,
        sender: o.sender,
        transactions: {},
        tokens: {},
        pancake: {},
        pools: [],
      };
  if (
    manifest.version !== 1 ||
    manifest.chainId !== chain.id ||
    !manifest.transactions ||
    !manifest.tokens ||
    !manifest.pancake ||
    !Array.isArray(manifest.pools)
  )
    throw new Error("Malformed deployment manifest");
  if (
    manifestExists &&
    (!manifest.uni ||
      Object.entries(uni).some(
        ([name, target]) =>
          typeof manifest.uni[name] !== "string" ||
          !same(manifest.uni[name], target),
      ))
  )
    throw new Error(
      "Manifest deployment identity does not match harness config",
    );
  const call = async (to, abi, functionName, args = []) =>
    decodeResult(
      abi,
      functionName,
      await rpc("eth_call", [
        { to, data: encodeFunctionData({ abi, functionName, args }) },
        "latest",
      ]),
    );
  const addr = async (to, abi, functionName, args = []) =>
    address((await call(to, abi, functionName, args)).toLowerCase());
  async function verifyCode(target) {
    const bytes = await rpc("eth_getCode", [address(target), "latest"]);
    if (bytes === "0x") throw new Error(`Missing bytecode at ${target}`);
    return keccak256(bytes);
  }
  const officialHashes = {};
  for (const [name, target] of Object.entries(uni))
    officialHashes[name] = await verifyCode(target);
  await verifyCode(weth);
  for (const name of ["quoter", "router", "npm"]) {
    if (
      !same(
        await addr(uni[name], uniswapPeripheryStateAbi, "factory"),
        uni.factory,
      )
    )
      throw new Error(`Official ${name} factory link mismatch`);
    if (!same(await addr(uni[name], uniswapPeripheryStateAbi, "WETH9"), weth))
      throw new Error(`Official ${name} WETH link mismatch`);
  }
  console.log(
    `${chain.key} guard and configured Uniswap bytecode/factory/WETH links verified.`,
  );
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
        String(chain.id),
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
      record = { to, data, nonce, raw, hash: keccak256(raw) };
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
  const deploy = async (key, path, abi, args = []) =>
    transact(key, null, encodeDeployData({ abi, bytecode: code(path), args }));
  const write = (key, target, abi, functionName, args) =>
    transact(key, target, encodeFunctionData({ abi, functionName, args }));
  if (o.command === "deploy") {
    for (const [symbol, d] of Object.entries(decimals)) {
      manifest.tokens[symbol] = {
        address: await deploy(
          `token-${symbol}`,
          artifacts.token,
          testTokenAbi,
          [symbol, d],
        ),
        decimals: d,
      };
    }
    manifest.seeder = await deploy(
      "seeder",
      artifacts.seeder,
      liquiditySeederAbi,
    );
    const bootstrap = await deploy(
      "pancake-bootstrap",
      artifacts.pancake_bootstrap,
      pancakeBootstrapAbi,
    );
    manifest.pancake.bootstrap = bootstrap;
    // CREATE nonces in a contract start at one. These predictions are used only in dry-run.
    const child = (nonce) => createAddress(bootstrap, nonce);
    manifest.pancake.deployer = o.broadcast
      ? await addr(bootstrap, pancakeBootstrapAbi, "deployer")
      : child(1);
    manifest.pancake.factory = o.broadcast
      ? await addr(bootstrap, pancakeBootstrapAbi, "factory")
      : child(2);
    const args = [manifest.pancake.deployer, manifest.pancake.factory, weth];
    manifest.pancake.router = await deploy(
      "pancake-router",
      artifacts.pancake_router,
      pancakeV3RouterAbi,
      args,
    );
    manifest.pancake.quoter = await deploy(
      "pancake-quoter",
      artifacts.pancake_quoter,
      pancakeQuoterV2Abi,
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
        BigInt(await call(token.address, erc20Abi, "decimals")) !==
        BigInt(decimals[symbol])
      )
        throw new Error(`Wrong decimals: ${symbol}`);
    }
    for (const name of ["deployer", "factory", "router", "quoter"])
      await verifyCode(manifest.pancake[name]);
    if (
      !same(
        await addr(
          manifest.pancake.deployer,
          pancakePoolDeployerAbi,
          "factoryAddress",
        ),
        manifest.pancake.factory,
      )
    )
      throw new Error("Pancake deployer not initialized to factory");
    for (const [name, abi] of [
      ["router", pancakeV3RouterAbi],
      ["quoter", pancakeQuoterV2Abi],
    ]) {
      for (const [getter, expected] of [
        ["factory", manifest.pancake.factory],
        ["deployer", manifest.pancake.deployer],
        ["WETH9", weth],
      ]) {
        if (!same(await addr(manifest.pancake[name], abi, getter), expected))
          throw new Error(`Pancake ${name} ${getter} mismatch`);
      }
    }
  }
  if (o.command === "seed") {
    if (!o.recipients.some((r) => same(r, o.sender)))
      throw new Error(
        "Explicit recipients must include --sender to pay for liquidity",
      );
    const tokenAmounts = Object.entries(manifest.tokens).map(
      ([symbol, token]) => {
        const amount = parseUnits("1000000", token.decimals);
        if (amount <= 0n || amount > maxUint256)
          throw new Error(`Mint amount exceeds uint256: ${symbol}`);
        return { symbol, token, amount };
      },
    );
    const poolPlans = [];
    for (const [provider, factory, fees, factoryAbi, poolAbi] of [
      [
        "uni",
        uni.factory,
        fixtures.uniswap_fees,
        uniswapV3FactoryAbi,
        uniswapV3PoolAbi,
      ],
      [
        "pancake",
        manifest.pancake.factory,
        fixtures.pancake_fees,
        pancakeV3FactoryAbi,
        pancakeV3PoolAbi,
      ],
    ]) {
      for (const fee of fees) {
        const spacing = Number(
          await call(factory, factoryAbi, "feeAmountTickSpacing", [fee]),
        );
        if (!Number.isSafeInteger(spacing) || spacing <= 0)
          throw new Error(
            `Unsupported ${provider} fee ${fee}: invalid tick spacing`,
          );
        for (const [pairID, pair] of Object.entries(fixtures.pairs)) {
          const key = `${provider}-${pairID}-${fee}`;
          const [t0, t1] = pair
            .map((s) => manifest.tokens[s])
            .sort((a, b) =>
              a.address.toLowerCase().localeCompare(b.address.toLowerCase()),
            );
          const values = fixture(
            t0.decimals,
            t1.decimals,
            spacing,
            fee !== fixtures.broad_fee,
          );
          const pool = (
            await call(factory, factoryAbi, "getPool", [
              t0.address,
              t1.address,
              fee,
            ])
          ).toLowerCase();
          poolPlans.push({
            provider,
            factory,
            factoryAbi,
            poolAbi,
            fee,
            pairID,
            pair,
            key,
            t0,
            t1,
            pool,
            values,
          });
        }
      }
    }
    for (const { symbol, token, amount } of tokenAmounts) {
      for (const recipient of [
        ...new Set(o.recipients.map((r) => r.toLowerCase())),
      ]) {
        await write(
          `mint-${symbol}-${recipient}`,
          token.address,
          testTokenAbi,
          "mint",
          [recipient, amount],
        );
      }
      await write(`approve-${symbol}`, token.address, erc20Abi, "approve", [
        manifest.seeder,
        amount,
      ]);
    }
    for (const plan of poolPlans) {
      const {
        provider,
        factory,
        factoryAbi,
        poolAbi,
        fee,
        pair,
        key,
        t0,
        t1,
        values: f,
      } = plan;
      let { pool } = plan;
      if (same(pool, zeroAddress)) {
        await write(`create-${key}`, factory, factoryAbi, "createPool", [
          t0.address,
          t1.address,
          fee,
        ]);
        if (!o.broadcast) {
          console.log(
            `DRY ${key}: initialize and seed after creation (narrow=${fee !== fixtures.broad_fee})`,
          );
          continue;
        }
        pool = await addr(factory, factoryAbi, "getPool", [
          t0.address,
          t1.address,
          fee,
        ]);
      }
      const slot = await call(pool, poolAbi, "slot0");
      if (slot[0] === 0n)
        await write(`initialize-${key}`, pool, poolAbi, "initialize", [
          f.sqrtPriceX96,
        ]);
      await write(`seed-${key}`, manifest.seeder, liquiditySeederAbi, "seed", [
        factory,
        pool,
        f.lower,
        f.upper,
        f.liquidity,
      ]);
      const entry = {
        key,
        provider,
        pair,
        fee,
        address: pool,
        token0: t0.address,
        token1: t1.address,
        ...f,
        narrow: fee !== fixtures.broad_fee,
      };
      manifest.pools = manifest.pools
        .filter((p) => p.key !== key)
        .concat(entry);
      save();
    }
  }
  if (o.command === "check") {
    for (const pool of manifest.pools) {
      await verifyCode(pool.address);
      const poolAbi =
        pool.provider === "uni" ? uniswapV3PoolAbi : pancakeV3PoolAbi;
      const liquidity = await call(pool.address, poolAbi, "liquidity");
      console.log(`${pool.key}: active liquidity ${liquidity}`);
    }
    console.log(
      `Read checks complete; ${manifest.pools.length} manifest pools. No writes.`,
    );
  }
  if (o.command === "config") {
    const lines = [
      "[terminal]",
      `default_chain = "${chain.key}"`,
      'engine_url = "http://127.0.0.1:8080"',
      "search_budget_ms = 3000",
      "",
      "[engine]",
      'listen_addr = "127.0.0.1:8080"',
      `quote_concurrency = ${engine.quote_concurrency}`,
      "",
      `[chains.${chain.key}]`,
      `chain_id = ${chain.id}`,
      `rpc_url_env = "${chain.rpc_url_env}"`,
      "execution_enabled = true",
    ];
    for (const [symbol, token] of Object.entries(manifest.tokens))
      lines.push(
        "",
        `[[chains.${chain.key}.tokens]]`,
        `address = "${token.address}"`,
        `symbol = ${JSON.stringify(symbol)}`,
        `decimals = ${token.decimals}`,
      );
    for (const [name, deployment, kind, fees] of [
      ["uni", uni, "uniswap-v3", JSON.stringify(fixtures.uniswap_fees)],
      [
        "pancake",
        manifest.pancake,
        "pancake-v3",
        JSON.stringify(fixtures.pancake_fees),
      ],
    ]) {
      lines.push(
        "",
        `[chains.${chain.key}.deployments.${name}]`,
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
