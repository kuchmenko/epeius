import { expect, test } from "bun:test";
import { readChain } from "./chain";

const hash = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"cd".repeat(32)}`;

test("RPC preserves raw receipt, null polling and canonical block identity without batching", async () => {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockHash,
    blockNumber: "0x10",
    logs: [],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      expect(Array.isArray(body)).toBe(false);
      requests.push(body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "eth_getBlockByNumber"
            ? { hash: blockHash }
            : requests.length === 1
              ? null
              : receipt,
      });
    },
  });
  try {
    const result = await readChain(
      server.url.href,
      new AbortController().signal,
    ).waitCanonicalReceipt(hash);
    expect(result).toEqual(receipt);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "eth_getTransactionReceipt", params: [hash] },
      { method: "eth_getTransactionReceipt", params: [hash] },
      { method: "eth_getBlockByNumber", params: ["0x10", false] },
    ]);
  } finally {
    server.stop(true);
  }
});

test("RPC malformed JSON, error and 503 fail once without exposing diagnostics", async () => {
  for (const response of [
    new Response("not json"),
    Response.json({ error: { code: -32000, message: "secret" } }),
    new Response("secret", { status: 503 }),
  ]) {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return response;
      },
    });
    try {
      await expect(
        readChain(server.url.href, new AbortController().signal).chainId(),
      ).rejects.toThrow(
        "RPC request failed or timed out. Check the configured RPC provider.",
      );
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  }
});

test("caller abort covers slow headers and body, with no retry", async () => {
  for (const bodyStarted of [false, true]) {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        calls++;
        if (!bodyStarted) {
          await Bun.sleep(150);
          return Response.json({ result: "0x1" });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 50);
    try {
      await expect(
        readChain(server.url.href, abort.signal).chainId(),
      ).rejects.toThrow("RPC request failed or timed out.");
      expect(calls).toBe(1);
    } finally {
      clearTimeout(timer);
      server.stop(true);
    }
  }
});

test.each([false, true])(
  "15s request deadline covers body started=%s",
  async (bodyStarted) => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 30,
      fetch() {
        calls++;
        if (!bodyStarted) return new Promise<Response>(() => {});
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const started = Date.now();
    try {
      await expect(
        readChain(server.url.href, new AbortController().signal).chainId(),
      ).rejects.toThrow("RPC request failed or timed out.");
      expect(Date.now() - started).toBeGreaterThanOrEqual(14500);
      expect(Date.now() - started).toBeLessThan(18000);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  },
  20000,
);
