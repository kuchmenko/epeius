import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine } from "./engine";
import { root } from "./tasks";

const zero = (bytes: number) => `0x${"00".repeat(bytes)}`;
const header = {
  parentHash: zero(32),
  sha3Uncles: zero(32),
  miner: zero(20),
  stateRoot: zero(32),
  transactionsRoot: zero(32),
  receiptsRoot: zero(32),
  logsBloom: zero(256),
  difficulty: "0x0",
  number: "0x12d687",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x6553f10d",
  extraData: "0x",
  mixHash: zero(32),
  nonce: zero(8),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "epeius-engine-"));
  const config = join(directory, "epeius.toml");
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: number; method: string };
      methods.push(body.method);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "eth_chainId" ? "0x14a34" : header,
      });
    },
  });
  await Bun.write(
    config,
    `[terminal]
default_chain = "testnet"
engine_url = "http://127.0.0.1:8080"
search_budget_ms = 2000
[engine]
listen_addr = "127.0.0.1:0"
[chains.testnet]
chain_id = 84532
rpc_url_env = "TEST_RPC"
[chains.unavailable]
chain_id = 8453
rpc_url_env = "MISSING_TEST_RPC"
`,
  );
  return {
    config,
    server,
    methods,
    env: {
      ...process.env,
      TEST_RPC: server.url.toString(),
      MISSING_TEST_RPC: "",
    },
    async close() {
      await server.stop(true);
      await rm(directory, { recursive: true });
    },
  };
}

async function cli(
  config: string,
  env: Record<string, string | undefined>,
  args: string[],
) {
  const child = Bun.spawn(
    ["bun", "apps/terminal/src/main.ts", "--config", config, ...args],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

test("one failed chain does not block startup; CLI reports reasons and shutdown preserves other services", async () => {
  const f = await fixture();
  const engine = await startEngine(f.env, undefined, ["--config", f.config]);
  try {
    expect(engine.ready.chains.map((c) => [c.key, c.connected])).toEqual([
      ["testnet", true],
      ["unavailable", false],
    ]);
    expect(engine.ready.chains[0].block?.number).toBe("1234567");
    expect(f.methods).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    const status = await cli(f.config, f.env, [
      "status",
      "--engine-url",
      engine.ready.url,
    ]);
    expect(status.code).toBe(1);
    expect(status.out).toContain("testnet (84532): connected");
    expect(status.out).toContain("RPC URL environment variable is not set");
    const quote = await cli(f.config, f.env, [
      "quote",
      "--engine-url",
      engine.ready.url,
      "--in",
      "WETH",
      "--out",
      "USDC",
      "--amount",
      "1",
    ]);
    expect(quote.code).toBe(1);
    expect(quote.err).toContain("Quoting is unsupported on chain testnet");
    await engine.stop();
    expect(await engine.child.exited).toBe(0);
    await expect(fetch(engine.ready.url)).rejects.toThrow();
    expect(
      (
        await fetch(f.server.url, {
          method: "POST",
          body: JSON.stringify({ id: 7, method: "eth_chainId" }),
        })
      ).status,
    ).toBe(200);
  } finally {
    await engine.stop();
    await f.close();
  }
});

test("chains is offline; chain check works without engine and returns failures as JSON", async () => {
  const f = await fixture();
  try {
    const list = await cli(f.config, f.env, ["chains", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).chains[0].rpcConfigured).toBe(true);
    expect(f.methods).toEqual([]);
    const check = await cli(f.config, f.env, [
      "chain",
      "check",
      "testnet",
      "--json",
    ]);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out).chain.chainId).toBe("84532");
    const failed = await cli(f.config, f.env, [
      "chain",
      "check",
      "unavailable",
      "--json",
    ]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out).chain.connected).toBe(false);
    await expect(
      startEngine({ ...f.env, TEST_RPC: "" }, undefined, [
        "--config",
        f.config,
      ]),
    ).rejects.toThrow("all configured chains failed");
  } finally {
    await f.close();
  }
});

test("named engine launcher shows all chains and Ctrl+C stops engine", async () => {
  const f = await fixture();
  const child = Bun.spawn(
    ["bun", "run", "engine", "--", "--config", f.config],
    {
      cwd: root,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGTERM"), 10000);
  try {
    let output = "";
    while (!output.includes("Press Ctrl+C")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`engine stopped: ${await errors}`);
      output += chunk.value;
    }
    expect(output).toContain("testnet (84532): connected");
    expect(output).toContain("unavailable (8453): unavailable");
    const url = output.match(/Engine: (http:\/\/[^\s]+)/)?.[1];
    expect(url).toBeDefined();
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
    await expect(fetch(url ?? "")).rejects.toThrow();
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await f.close();
  }
}, 15000);
