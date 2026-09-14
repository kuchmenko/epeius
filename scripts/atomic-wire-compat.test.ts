import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fromBinary,
  fromJson,
  type JsonValue,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import { atomicPlanClient } from "../apps/terminal/src/client";

const baselineRevision = "6beaeb3bdc39e65c41a4216232d0d452fe74c9bc";
const root = resolve(import.meta.dir, "..");
const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;

async function command(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command.join(" ")} failed (${code}): ${stderr}`);
  return stdout;
}

async function prepareBaseline(directory: string) {
  const archive = join(directory, "baseline.tar");
  const checkout = join(directory, "baseline");
  await mkdir(checkout);
  await command([
    "git",
    "archive",
    "--format=tar",
    `--output=${archive}`,
    baselineRevision,
  ]);
  await command(["tar", "-xf", archive, "-C", checkout]);
  await symlink(join(root, "node_modules"), join(checkout, "node_modules"));
  await symlink(join(root, ".tools"), join(checkout, ".tools"));
  await symlink(
    join(root, "apps/terminal/node_modules"),
    join(checkout, "apps/terminal/node_modules"),
  );
  await command(["bun", "scripts/tasks.ts", "generate"], checkout);
  await mkdir(join(checkout, "dist"));
  await command(
    [
      "bun",
      "build",
      "apps/terminal/src/main.ts",
      "--target=bun",
      "--outfile=dist/terminal-baseline.js",
    ],
    checkout,
  );
  await command(
    [
      "go",
      "build",
      "-C",
      "services/quote-engine",
      "-o",
      "../../dist/epeius-engine-baseline",
      "./cmd/epeius-engine",
    ],
    checkout,
  );
  return checkout;
}

async function runTerminal(
  entry: string,
  cwd: string,
  args: string[],
  env = process.env,
) {
  const child = Bun.spawn(["bun", entry, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

async function moduleAt(checkout: string) {
  return await import(
    `${pathToFileURL(join(checkout, "generated/ts/epeius/quote/v1/quote_pb.ts")).href}?revision=${encodeURIComponent(checkout)}`
  );
}

function encoded(schema: Parameters<typeof fromJson>[0], json: JsonValue) {
  const message = fromJson(schema, json);
  const binary = toBinary(schema, message);
  return { binary, json: toJson(schema, message) };
}

const legacySamples: Array<[string, JsonValue]> = [
  [
    "GetStatusResponseSchema",
    {
      chains: [
        {
          key: "base",
          chainId: "8453",
          connected: true,
          quotingSupported: true,
          executionEnabled: true,
          tokens: [{ address: address("1"), symbol: "AAA", decimals: 18 }],
          block: { number: "123", hash: hash("a") },
        },
      ],
    },
  ],
  [
    "QuoteRequestSchema",
    {
      tokenIn: address("1"),
      tokenOut: address("2"),
      amountInAtomic: "9007199254740993",
      searchBudgetMs: 2500,
      chain: "base",
      chainId: "8453",
    },
  ],
  [
    "QuoteFinalSchema",
    {
      quoteId: "quote",
      routes: [
        {
          routeId: "direct",
          provider: "uniswap-v3",
          deploymentId: "uni",
          amountOutAtomic: "123",
          legs: [
            {
              pool: address("3"),
              tokenIn: address("1"),
              tokenOut: address("2"),
              feePips: 500,
            },
          ],
          block: { number: "123", hash: hash("a") },
          latencyMs: 7,
        },
        {
          routeId: "v4",
          provider: "uniswap-v4",
          deploymentId: "v4",
          amountOutAtomic: "122",
          networkCostOutAtomic: "",
          effectiveOutAtomic: "122",
          legs: [
            {
              pool: hash("b"),
              tokenIn: address("1"),
              tokenOut: address("2"),
              uniswapV4PoolKey: {
                currency0: address("1"),
                currency1: address("2"),
                feePips: 500,
                tickSpacing: 10,
                hooks: address("0"),
              },
            },
          ],
          block: { number: "123", hash: hash("a") },
          latencyMs: 8,
        },
      ],
      errors: [{ provider: "other", routeId: "", message: "unavailable" }],
      bestRouteId: "direct",
      block: { number: "123", hash: hash("a") },
      searchComplete: false,
    },
  ],
  [
    "PrepareExecutionRequestSchema",
    {
      quoteId: "quote",
      sender: address("4"),
      slippageBps: 50,
      allocations: [
        { routeId: "a", amountInAtomic: "40" },
        { routeId: "b", amountInAtomic: "60" },
      ],
    },
  ],
  ["PrepareExecutionRequestSchema", { preparationId: "resume" }],
  [
    "PrepareExecutionResponseSchema",
    {
      status: "PREPARATION_STATUS_READY",
      transaction: {
        chainId: "8453",
        to: address("5"),
        data: "0x1234",
        valueAtomic: "0",
        from: address("4"),
        gasLimit: "500000",
      },
      preparationId: "ready",
      expiresAtUnix: "2000000000",
      amountOutMinimumAtomic: "100",
      amountInAtomic: "101",
      tokenIn: address("1"),
      tokenOut: address("2"),
      recipient: address("4"),
      deadlineUnix: "2000000100",
      simulationBlock: { number: "123", hash: hash("a") },
      simulatedAmountOutAtomic: "102",
      route: {
        routeId: "direct",
        provider: "uniswap-v3",
        deploymentId: "uni",
        amountOutAtomic: "103",
        legs: [
          {
            pool: address("3"),
            tokenIn: address("1"),
            tokenOut: address("2"),
            feePips: 500,
          },
        ],
        block: { number: "123", hash: hash("a") },
      },
    },
  ],
  [
    "PrepareExecutionResponseSchema",
    {
      status: "PREPARATION_STATUS_APPROVAL_REQUIRED",
      message: "approve",
      preparationId: "approval",
      approvalTransaction: {
        chainId: "8453",
        to: address("1"),
        data: "0x095ea7b3",
        valueAtomic: "0",
        from: address("4"),
        gasLimit: "100000",
      },
      approvalSpender: address("5"),
    },
  ],
  [
    "PrepareExecutionResponseSchema",
    {
      status: "PREPARATION_STATUS_APPROVAL_REQUIRED",
      preparationId: "permission",
      onChainPermission: {
        target: address("6"),
        token: address("1"),
        spender: address("5"),
        amountAtomic: "101",
        expirationUnix: "2000000100",
        transaction: {
          chainId: "8453",
          to: address("6"),
          data: "0x1234",
          valueAtomic: "0",
          from: address("4"),
          gasLimit: "100000",
        },
      },
    },
  ],
];

function responseBytes(
  schema: Parameters<typeof toBinary>[0],
  json: JsonValue,
) {
  return toBinary(schema, fromJson(schema, json));
}

async function startBaselineEngine(
  baseline: string,
  config: string,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn(
    [join(baseline, "dist/epeius-engine-baseline"), "--config", config],
    { cwd: baseline, env, stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("baseline engine stopped before ready");
    output += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  const ready = JSON.parse(output.slice(0, output.indexOf("\n")));
  return {
    child,
    ready,
    async stop() {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    },
  };
}

test("exact pre-Atomic main and current product prove additive-wire process compatibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-atomic-compat-"));
  const baseline = await prepareBaseline(directory);
  const terminal = join(baseline, "dist/terminal-baseline.js");
  const config = join(directory, "terminal.toml");
  const sideEffects: string[] = [];
  const sideEffectServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      sideEffects.push(new URL(request.url).pathname);
      return new Response(null, { status: 500 });
    },
  });
  const stops: Array<() => Promise<unknown> | unknown> = [
    () => sideEffectServer.stop(true),
  ];
  try {
    await Bun.write(
      config,
      `[terminal]\ndefault_chain='base'\nengine_url='${sideEffectServer.url}'\nsearch_budget_ms=2000\n`,
    );
    const rejected = [
      [
        "quote",
        "--in",
        "AAA",
        "--out",
        "BBB",
        "--amount-atomic",
        "1",
        "--execution-mode",
        "atomic-v1",
      ],
      [
        "trade",
        "--in",
        "AAA",
        "--out",
        "BBB",
        "--amount-atomic",
        "1",
        "--candidate-index",
        "1",
        "--keystore",
        "missing",
        "--password-file",
        "missing",
      ],
      [
        "prepare",
        "--quote-id",
        "q",
        "--route-id",
        "r",
        "--execution-mode",
        "atomic-v1",
        "--keystore",
        "missing",
        "--password-file",
        "missing",
      ],
    ];
    for (const args of rejected) {
      const result = await runTerminal(terminal, baseline, args);
      expect(result.code).toBe(1);
      expect(result.err).toContain("Invalid arguments");
    }
    expect(sideEffects).toEqual([]);

    const baselineBindings = await moduleAt(baseline);
    const currentBindings = await moduleAt(root);
    const binaryDigest = createHash("sha256");
    const jsonDigest = createHash("sha256");
    for (const [schemaName, json] of legacySamples) {
      const oldSchema = baselineBindings[schemaName];
      const newSchema = currentBindings[schemaName];
      const old = encoded(oldSchema, json);
      const current = encoded(newSchema, json);
      expect(Buffer.from(current.binary)).toEqual(Buffer.from(old.binary));
      expect(current.json).toEqual(old.json);
      expect(toJson(newSchema, fromBinary(newSchema, old.binary))).toEqual(
        old.json,
      );
      expect(toJson(oldSchema, fromBinary(oldSchema, current.binary))).toEqual(
        current.json,
      );
      expect(
        Buffer.from(toBinary(newSchema, fromBinary(newSchema, old.binary))),
      ).toEqual(Buffer.from(old.binary));
      binaryDigest.update(schemaName).update(old.binary);
      jsonDigest.update(schemaName).update(JSON.stringify(old.json));
    }
    expect(binaryDigest.digest("hex")).toBe(
      "dde11ce87798ca0a6415e6cf1bb14bd7caaaec2b85e4ce62c5d371786e211c4b",
    );
    expect(jsonDigest.digest("hex")).toBe(
      "49d82519f715d88515a49f5255cda7f9b1318d27c4313f1cb102856074e37d67",
    );

    const rpcMethods: string[] = [];
    const factory = address("7");
    const rpc = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id: number; method: string };
        rpcMethods.push(body.method);
        const result =
          body.method === "eth_chainId"
            ? "0x2105"
            : body.method === "eth_getBlockByNumber"
              ? {
                  parentHash: hash("0"),
                  sha3Uncles: hash("0"),
                  miner: address("0"),
                  stateRoot: hash("0"),
                  transactionsRoot: hash("0"),
                  receiptsRoot: hash("0"),
                  logsBloom: `0x${"00".repeat(256)}`,
                  difficulty: "0x0",
                  number: "0x7b",
                  gasLimit: "0x1c9c380",
                  gasUsed: "0x0",
                  timestamp: "0x6553f10d",
                  extraData: "0x",
                  mixHash: hash("0"),
                  nonce: `0x${"00".repeat(8)}`,
                }
              : body.method === "eth_getCode"
                ? "0x6000"
                : `0x${factory.slice(2).padStart(64, "0")}`;
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    stops.push(() => rpc.stop(true));
    const engineConfig = join(directory, "engine.toml");
    await Bun.write(
      engineConfig,
      `[terminal]\ndefault_chain='base'\nengine_url='http://127.0.0.1:0'\nsearch_budget_ms=2000\n[engine]\nlisten_addr='127.0.0.1:0'\nquote_concurrency=1\n[chains.base]\nchain_id=8453\nrpc_url_env='COMPAT_RPC'\nexecution_enabled=false\n[[chains.base.tokens]]\naddress='${address("1")}'\nsymbol='AAA'\ndecimals=18\n[[chains.base.tokens]]\naddress='${address("2")}'\nsymbol='BBB'\ndecimals=18\n[chains.base.deployments.uni]\nkind='uniswap-v3'\nfactory='${factory}'\nquoter='${address("8")}'\nrouter='${address("9")}'\nfees=[500]\n`,
    );
    const engine = await startBaselineEngine(baseline, engineConfig, {
      ...process.env,
      COMPAT_RPC: rpc.url.toString(),
    });
    stops.push(() => engine.stop());
    const paths: string[] = [];
    const atomicResponses: Array<{ status: number; body: string }> = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        paths.push(url.pathname);
        const response = await fetch(`${engine.ready.url}${url.pathname}`, {
          method: request.method,
          headers: request.headers,
          body: await request.arrayBuffer(),
        });
        const headers = new Headers(response.headers);
        // Bun decodes the upstream body, so these upstream headers no longer apply.
        headers.delete("content-encoding");
        headers.delete("content-length");
        const body = await response.arrayBuffer();
        if (url.pathname.includes("AtomicPlanService"))
          atomicResponses.push({
            status: response.status,
            body: new TextDecoder().decode(body),
          });
        return new Response(body, {
          status: response.status,
          headers,
        });
      },
    });
    stops.push(() => proxy.stop(true));
    try {
      await atomicPlanClient(proxy.url.toString()).getPlanQuote({});
      throw new Error("baseline server accepted Atomic service");
    } catch (error) {
      // Connect code 12 is UNIMPLEMENTED.
      expect((error as { code?: number }).code).toBe(12);
    }
    paths.length = 0;
    atomicResponses.length = 0;
    const currentConfig = join(directory, "current.toml");
    await Bun.write(
      currentConfig,
      `[terminal]\ndefault_chain='base'\nengine_url='${proxy.url}'\nsearch_budget_ms=2000\n[[chains.base.tokens]]\naddress='${address("1")}'\nsymbol='AAA'\ndecimals=18\n[[chains.base.tokens]]\naddress='${address("2")}'\nsymbol='BBB'\ndecimals=18\n`,
    );
    const currentResult = await runTerminal("apps/terminal/src/main.ts", root, [
      "quote",
      "--config",
      currentConfig,
      "--in",
      "AAA",
      "--out",
      "BBB",
      "--amount-atomic",
      "1",
      "--execution-mode",
      "atomic-v1",
      "--json",
    ]);
    expect(currentResult.code).toBe(1);
    if (paths.length !== 2) {
      throw new Error(
        `unexpected current terminal result: ${JSON.stringify({ paths, currentResult })}`,
      );
    }
    expect(paths).toEqual([
      "/epeius.quote.v1.QuoteService/GetStatus",
      "/epeius.atomic.v1.AtomicPlanService/GetPlanQuote",
    ]);
    expect(paths).not.toContain("/epeius.quote.v1.QuoteService/GetQuote");
    expect(atomicResponses).toEqual([
      {
        status: 404,
        body: "404 page not found\n",
      },
    ]);
    expect(currentResult.err).toContain("Engine request failed");
    const castCalls = join(directory, "cast-calls.jsonl");
    const cast = join(directory, "cast");
    await Bun.write(
      cast,
      `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(castCalls)},JSON.stringify(args)+'\\n');console.log(args[0]==='wallet'?'${address("4")}':'${hash("d")}');\n`,
    );
    await chmod(cast, 0o700);
    const oldSchema = baselineBindings.PrepareExecutionResponseSchema;
    const statusSchema = baselineBindings.GetStatusResponseSchema;
    const malicious = responseBytes(oldSchema, {
      status: "PREPARATION_STATUS_READY",
      preparationId: "resume",
      expiresAtUnix: "4102444800",
      amountOutMinimumAtomic: "1",
      amountInAtomic: "1",
      tokenIn: address("1"),
      tokenOut: address("2"),
      recipient: address("4"),
      deadlineUnix: "4102444800",
      simulatedAmountOutAtomic: "2",
      simulationBlock: { number: "123", hash: hash("a") },
      transaction: {
        chainId: "8453",
        from: address("4"),
        to: address("a"),
        data: "0x661983c5",
        valueAtomic: "0",
        gasLimit: "1000000",
      },
      route: {
        routeId: "direct",
        provider: "uniswap-v3",
        deploymentId: "uni",
        amountOutAtomic: "2",
        legs: [
          {
            pool: address("3"),
            tokenIn: address("1"),
            tokenOut: address("2"),
            feePips: 500,
          },
        ],
        block: { number: "123", hash: hash("a") },
      },
    });
    const unknownAtomicPlan = Uint8Array.of(0x9a, 0x01, 0x01, 0x00);
    const maliciousWithUnknown = new Uint8Array(
      malicious.length + unknownAtomicPlan.length,
    );
    maliciousWithUnknown.set(malicious);
    maliciousWithUnknown.set(unknownAtomicPlan, malicious.length);
    const oldStatus = responseBytes(statusSchema, {
      chains: [
        {
          key: "base",
          chainId: "8453",
          connected: true,
          quotingSupported: true,
          executionEnabled: true,
          tokens: [
            { address: address("1"), symbol: "AAA", decimals: 18 },
            { address: address("2"), symbol: "BBB", decimals: 18 },
          ],
          block: { number: "123", hash: hash("a") },
        },
      ],
    });
    const oldPaths: string[] = [];
    const oldServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        oldPaths.push(path);
        const body = path.endsWith("GetStatus")
          ? oldStatus
          : maliciousWithUnknown;
        return new Response(body, {
          headers: { "Content-Type": "application/proto" },
        });
      },
    });
    stops.push(() => oldServer.stop(true));
    const executionRPC = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id: number };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x2105" });
      },
    });
    stops.push(() => executionRPC.stop(true));
    const oldConfig = join(directory, "old-terminal.toml");
    await Bun.write(
      oldConfig,
      `[terminal]\ndefault_chain='base'\nengine_url='${oldServer.url}'\nsearch_budget_ms=2000\n[chains.base]\nchain_id=8453\nrpc_url_env='COMPAT_EXECUTION_RPC'\nexecution_enabled=true\n[[chains.base.tokens]]\naddress='${address("1")}'\nsymbol='AAA'\ndecimals=18\n[[chains.base.tokens]]\naddress='${address("2")}'\nsymbol='BBB'\ndecimals=18\n[chains.base.deployments.uni]\nkind='uniswap-v3'\nfactory='${factory}'\nquoter='${address("8")}'\nrouter='${address("9")}'\nfees=[500]\n`,
    );
    const oldResult = await runTerminal(
      terminal,
      baseline,
      [
        "execute",
        "--config",
        oldConfig,
        "--preparation-id",
        "resume",
        "--slippage-bps",
        "50",
        "--keystore",
        "fixture",
        "--password-file",
        "fixture",
        "--confirm-swap",
        "yes",
      ],
      {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        COMPAT_EXECUTION_RPC: executionRPC.url.toString(),
      },
    );
    expect(oldResult.code).toBe(1);
    expect(oldPaths).toEqual([
      "/epeius.quote.v1.QuoteService/GetStatus",
      "/epeius.quote.v1.QuoteService/PrepareExecution",
    ]);
    const calls = (await Bun.file(castCalls).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["wallet", "address"]);
    expect(oldResult.err).toContain(
      "Swap transaction does not match locally encoded route.",
    );
    expect(oldResult.err).not.toContain('"action":"swap"');
  } finally {
    for (const stop of stops.reverse()) await stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
