import { expect, test } from "bun:test";
import { keccak256 } from "viem";
import { readChain } from "./chain";

const hash = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"cd".repeat(32)}`;

test("RPC reads one exact pending nonce and submits one exact raw type-2 transaction", async () => {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const raw = `0x02${"11".repeat(100)}`;
  const account = `0x${"1".repeat(40)}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "eth_getTransactionCount" ? "0x9" : hash,
      });
    },
  });
  try {
    const chain = readChain(server.url.href, new AbortController().signal);
    expect(await chain.pendingNonce(account)).toBe(9n);
    expect(await chain.submitRawTransaction(raw)).toBe(hash);
    expect(requests).toMatchObject([
      {
        method: "eth_getTransactionCount",
        params: [account, "pending"],
      },
      { method: "eth_sendRawTransaction", params: [raw] },
    ]);
  } finally {
    server.stop(true);
  }
});

test("RPC rejects malformed and oversized pending nonces", async () => {
  for (const result of ["0x", "0x00", "0x01", "0x10000000000000000"]) {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      expect(
        readChain(server.url.href, new AbortController().signal).pendingNonce(
          `0x${"1".repeat(40)}`,
        ),
      ).rejects.toThrow("nonce");
    } finally {
      server.stop(true);
    }
  }
});

test("RPC derives configured contract runtime code hash without batching", async () => {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const code = "0x6001600055";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: code });
    },
  });
  try {
    expect(
      await readChain(server.url.href, new AbortController().signal).codeHash(
        `0x${"1".repeat(40)}`,
      ),
    ).toBe(keccak256(code));
    expect(requests).toMatchObject([
      {
        method: "eth_getCode",
        params: [`0x${"1".repeat(40)}`, "latest"],
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("RPC reads exact ExecutorV2 uint32 limit getters", async () => {
  const requests: Array<{
    method: string;
    params: [{ data: string }, string];
  }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: `0x${"0".repeat(63)}c`,
      });
    },
  });
  try {
    const chain = readChain(server.url.href, new AbortController().signal);
    const target = `0x${"1".repeat(40)}`;
    expect(await chain.uint32Getter(target, "maxBranches")).toBe(12);
    expect(await chain.uint32Getter(target, "maxOperationsPerBranch")).toBe(12);
    expect(await chain.uint32Getter(target, "maxTotalOperations")).toBe(12);
    expect(requests.map((request) => request.method)).toEqual([
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
    expect(
      new Set(requests.map((request) => request.params[0]?.data)).size,
    ).toBe(3);
  } finally {
    server.stop(true);
  }
});

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

test("transaction trace is hash-bound and followed by canonical receipt identity recheck", async () => {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockHash,
    blockNumber: "0x10",
    logs: [],
  };
  const trace = {
    type: "CALL",
    from: `0x${"1".repeat(40)}`,
    to: `0x${"2".repeat(40)}`,
    value: "0x0",
    input: "0x12",
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "debug_traceTransaction"
            ? trace
            : body.method === "eth_getTransactionReceipt"
              ? receipt
              : { hash: blockHash },
      });
    },
  });
  try {
    expect(
      await readChain(
        server.url.href,
        new AbortController().signal,
      ).traceCanonicalTransaction(hash, receipt),
    ).toEqual(trace);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "debug_traceTransaction",
        params: [hash, { tracer: "callTracer" }],
      },
      { method: "eth_getTransactionReceipt", params: [hash] },
      { method: "eth_getBlockByNumber", params: ["0x10", false] },
    ]);
  } finally {
    server.stop(true);
  }
});

test("transaction trace fails closed when RPC or canonical identity changes", async () => {
  const receipt = {
    transactionHash: hash,
    status: "0x1",
    blockHash,
    blockNumber: "0x10",
    logs: [],
  };
  for (const mode of [
    "unsupported",
    "transaction",
    "receipt-block",
    "canonical-block",
  ] as const) {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json();
        if (mode === "unsupported" && body.method === "debug_traceTransaction")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "method unavailable" },
          });
        const result =
          body.method === "debug_traceTransaction"
            ? {}
            : body.method === "eth_getTransactionReceipt"
              ? {
                  ...receipt,
                  ...(mode === "transaction"
                    ? { transactionHash: `0x${"ee".repeat(32)}` }
                    : mode === "receipt-block"
                      ? { blockHash: `0x${"dd".repeat(32)}` }
                      : {}),
                }
              : {
                  hash:
                    mode === "canonical-block"
                      ? `0x${"dd".repeat(32)}`
                      : blockHash,
                };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      expect(
        readChain(
          server.url.href,
          new AbortController().signal,
        ).traceCanonicalTransaction(hash, receipt),
      ).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  }
});

test("canonical polling rejects short, odd and zero hashes before reading the block", async () => {
  const unsealed = [
    undefined,
    `0x${"0".repeat(64)}`,
    `0x${"a".repeat(63)}`,
    `0x${"a".repeat(65)}`,
  ];
  let reads = 0,
    blocks = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      if (body.method === "eth_getBlockByNumber") {
        blocks++;
        expect(reads).toBe(5);
        return Response.json({ id: body.id, result: { hash: blockHash } });
      }
      const block = reads < unsealed.length ? unsealed[reads] : blockHash;
      reads++;
      return Response.json({
        id: body.id,
        result: {
          transactionHash: hash,
          status: "0x1",
          blockNumber: "0x1",
          blockHash: block,
          logs: [],
        },
      });
    },
  });
  try {
    expect(
      (
        await readChain(
          server.url.href,
          new AbortController().signal,
        ).waitCanonicalReceipt(hash)
      ).blockHash,
    ).toBe(blockHash);
    expect(blocks).toBe(1);
  } finally {
    server.stop(true);
  }
}, 7000);

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
