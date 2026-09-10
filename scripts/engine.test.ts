import { expect, test } from "bun:test";
import { startEngine } from "./engine";
import { smokeQuoteArgs } from "./smoke";
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

function rpcFixture(chain = "0x14a34") {
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
        result: body.method === "eth_chainId" ? chain : header,
      });
    },
  });
  return {
    server,
    methods,
    env: {
      ...process.env,
      EPEIUS_ENVIRONMENT: "base-sepolia",
      EPEIUS_RPC_URL: server.url.toString(),
      EPEIUS_LISTEN_ADDR: "127.0.0.1:0",
    },
  };
}

test("real engine verifies RPC, serves CLI, and releases its port without stopping other services", async () => {
  const fixture = rpcFixture();
  const engine = await startEngine(fixture.env);
  try {
    expect(engine.ready.environment).toBe("base-sepolia");
    expect(engine.ready.chainId).toBe("84532");
    expect(engine.ready.blockNumber).toBe("1234567");
    expect(engine.ready.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fixture.methods).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    const cli = Bun.spawn(
      ["bun", "apps/terminal/src/main.ts", ...smokeQuoteArgs],
      {
        cwd: root,
        env: { ...fixture.env, EPEIUS_ENGINE_URL: engine.ready.url },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await new Response(cli.stdout).text()).toBe("");
    expect(await new Response(cli.stderr).text()).toContain(
      "Quoting is unsupported on Base Sepolia",
    );
    expect(await cli.exited).toBe(1);
    await engine.stop();
    expect(await engine.child.exited).toBe(0);
    await expect(fetch(engine.ready.url)).rejects.toThrow();
    const response = await fetch(fixture.server.url, {
      method: "POST",
      body: JSON.stringify({ id: 7, method: "eth_chainId" }),
    });
    expect(response.status).toBe(200);
  } finally {
    await engine.stop();
    await fixture.server.stop(true);
  }
});

test("wrong network and invalid configuration fail before readiness", async () => {
  const fixture = rpcFixture("0x2105");
  try {
    await expect(startEngine(fixture.env)).rejects.toThrow(
      "does not match base-sepolia",
    );
    await expect(
      startEngine({ ...fixture.env, EPEIUS_ENVIRONMENT: "" }),
    ).rejects.toThrow("EPEIUS_ENVIRONMENT");
    await expect(
      startEngine({ ...fixture.env, EPEIUS_LISTEN_ADDR: "0.0.0.0:8080" }),
    ).rejects.toThrow("loopback");
  } finally {
    await fixture.server.stop(true);
  }
});

test("dev shows the verified environment and Ctrl+C stops its engine", async () => {
  const fixture = rpcFixture();
  const dev = Bun.spawn(["bun", "scripts/dev.ts"], {
    cwd: root,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = dev.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errors = new Response(dev.stderr).text();
  let output = "";
  const timeout = setTimeout(() => dev.kill("SIGTERM"), 10000);
  try {
    while (!output.includes("Press Ctrl+C")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`dev stopped: ${await errors}`);
      output += chunk.value;
    }
    expect(output).toContain("base-sepolia (read-only)");
    const url = output.match(/Engine: (http:\/\/[^\s]+)/)?.[1];
    expect(url).toBeDefined();
    dev.kill("SIGINT");
    expect(await dev.exited).toBe(0);
    await expect(fetch(url ?? "")).rejects.toThrow();
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    if (dev.exitCode === null) dev.kill("SIGTERM");
    await dev.exited;
    await fixture.server.stop(true);
  }
}, 15000);
