import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetStatusResponseSchema,
  PreparationStatus,
  PrepareExecutionRequestSchema,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  type ExecutionIO,
  executePrepared,
  type Receipt,
  validatePreparation,
  verifyReceipt,
} from "./execution";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const sender = addr("1"),
  router = addr("2"),
  input = addr("3"),
  middle = addr("4"),
  output = addr("5"),
  pool = addr("6");
const hash = `0x${"a".repeat(64)}`;
function prepared() {
  return create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "p1",
    expiresAtUnix: "4102444800",
    deadlineUnix: "4102444800",
    amountInAtomic: "101",
    amountOutMinimumAtomic: "197",
    tokenIn: input,
    tokenOut: output,
    recipient: sender,
    transaction: {
      chainId: "84532",
      from: sender,
      to: router,
      data: "0x1234",
      valueAtomic: "0",
      gasLimit: "200000",
    },
    route: {
      routeId: "r1",
      legs: [
        {
          tokenIn: input,
          tokenOut: middle,
          pool,
          selector: { case: "feePips", value: 500 },
        },
        {
          tokenIn: middle,
          tokenOut: output,
          pool,
          selector: { case: "tickSpacing", value: 200 },
        },
      ],
    },
  });
}
function log(
  token: string,
  from: string,
  to: string,
  amount: number,
): Receipt["logs"][number] {
  return {
    address: token,
    transactionHash: hash,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${from.slice(2).padStart(64, "0")}`,
      `0x${to.slice(2).padStart(64, "0")}`,
    ],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}
function receipt(): Receipt {
  return {
    transactionHash: hash,
    status: "0x1",
    logs: [
      log(input, sender, pool, 101),
      log(middle, pool, router, 301),
      log(middle, router, pool, 301),
      log(output, pool, sender, 199),
    ],
  };
}
function fixture() {
  const p = prepared();
  const reports: unknown[] = [],
    sent: unknown[] = [],
    requests: Array<string | undefined> = [],
    confirmations: string[] = [];
  const io: ExecutionIO = {
    signer: sender,
    chainId: async () => "0x14a34",
    prepare: async (id) => {
      requests.push(id);
      return structuredClone(p);
    },
    confirm: async (kind) => {
      confirmations.push(kind);
      return true;
    },
    send: async (tx) => {
      sent.push(tx);
      return hash;
    },
    receipt: async () => receipt(),
    report: (result) => reports.push(result),
  };
  return { io, p, sent, requests, reports, confirmations };
}

test("preview and canceled confirmation never send or recheck", async () => {
  for (const preview of [true, false]) {
    const f = fixture();
    f.io.confirm = async () => false;
    expect(await executePrepared(f.io, preview)).toBe(preview ? 0 : 1);
    expect(f.sent).toHaveLength(0);
    expect(f.requests).toEqual([undefined]);
  }
});

test("swap rechecks by preparation ID and reports hash separately from verification", async () => {
  const f = fixture();
  expect(await executePrepared(f.io)).toBe(0);
  expect(f.requests).toEqual([undefined, "p1"]);
  expect(f.confirmations).toEqual(["swap"]);
  expect(f.sent).toHaveLength(1);
  expect(f.reports).toEqual([
    expect.objectContaining({
      transactionHash: hash,
      verification: { outcome: "pending" },
    }),
    expect.objectContaining({
      transactionHash: hash,
      verification: expect.objectContaining({
        outcome: "passed",
        inputSpentAtomic: "101",
        outputReceivedAtomic: "199",
      }),
    }),
  ]);
});

test("wrong RPC network before preparation or after confirmation never sends", async () => {
  for (const wrongAt of [1, 2]) {
    const f = fixture();
    let calls = 0;
    f.io.chainId = async () => (++calls === wrongAt ? "0x2105" : "0x14a34");
    await expect(executePrepared(f.io)).rejects.toThrow(/network|84532/);
    expect(f.sent).toHaveLength(0);
  }
});

test("changed transaction, route, minimum, deadline or identity after confirmation never sends", async () => {
  const changes: Array<(p: ReturnType<typeof prepared>) => void> = [
    (p) => {
      assert(p.transaction);
      p.transaction.to = pool;
    },
    (p) => {
      assert(p.transaction);
      p.transaction.data = "0x5678";
    },
    (p) => {
      assert(p.transaction);
      p.transaction.valueAtomic = "1";
    },
    (p) => {
      assert(p.transaction);
      p.transaction.gasLimit = "300000";
    },
    (p) => {
      assert(p.transaction);
      p.transaction.from = pool;
    },
    (p) => {
      p.recipient = pool;
    },
    (p) => {
      assert(p.transaction);
      p.transaction.chainId = "8453";
    },
    (p) => {
      p.amountOutMinimumAtomic = "196";
    },
    (p) => {
      p.deadlineUnix = "4102444799";
    },
    (p) => {
      assert(p.route);
      p.route.legs[0].pool = router;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    f.io.prepare = async (id) => {
      const p = prepared();
      if (id) change(p);
      return p;
    };
    await expect(executePrepared(f.io)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  }
});

test("expired, rejected, and requote preparations fail closed", async () => {
  for (const status of [
    PreparationStatus.REJECTED,
    PreparationStatus.REQUOTE_REQUIRED,
    PreparationStatus.UNSPECIFIED,
  ]) {
    const f = fixture();
    f.p.status = status;
    await expect(executePrepared(f.io)).rejects.toThrow("fresh quote");
    expect(f.sent).toHaveLength(0);
  }
  const p = prepared();
  p.expiresAtUnix = "100";
  expect(() => validatePreparation(p, sender, 100)).toThrow("expired");
  p.expiresAtUnix = "101";
  p.deadlineUnix = "100";
  expect(() => validatePreparation(p, sender, 100)).toThrow("expired");
});

test("approval confirms separately, sends only exact approval and requires fresh quote", async () => {
  const f = fixture();
  f.p.status = PreparationStatus.APPROVAL_REQUIRED;
  f.p.approvalSpender = router;
  assert(f.p.transaction);
  f.p.approvalTransaction = {
    ...f.p.transaction,
    to: input,
    data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`,
  };
  f.p.transaction = undefined;
  expect(await executePrepared(f.io)).toBe(0);
  expect(f.confirmations).toEqual(["approval"]);
  expect(f.sent).toEqual([f.p.approvalTransaction]);
  expect(f.requests).toEqual([undefined, "p1"]);
  expect(f.reports.at(-1)).toMatchObject({
    nextAction: expect.stringContaining("Rerun quote"),
  });
  f.p.approvalTransaction.data = `0x095ea7b3${router.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
  expect(() => validatePreparation(f.p, sender)).toThrow(
    "displayed input amount",
  );
});

test("send or receipt timeout reports unknown or pending and never retries", async () => {
  for (const stage of ["send", "receipt"] as const) {
    const f = fixture();
    let calls = 0;
    if (stage === "send")
      f.io.send = async () => {
        calls++;
        throw new Error("timeout");
      };
    else
      f.io.receipt = async () => {
        calls++;
        throw new Error("timeout");
      };
    expect(await executePrepared(f.io)).toBe(1);
    expect(calls).toBe(1);
    expect(f.reports.at(-1)).toMatchObject({
      submission: stage === "send" ? "unknown" : "pending_or_unknown",
      verification: { outcome: "unavailable" },
    });
  }
});

test("receipt success alone cannot pass; partial input, low output, and intermediate residue fail", () => {
  for (const logs of [
    [],
    [log(input, sender, pool, 100), log(output, pool, sender, 199)],
    [log(input, sender, pool, 101), log(output, pool, sender, 196)],
    [...receipt().logs, log(middle, pool, router, 1)],
    [...receipt().logs, log(middle, router, pool, 1)],
  ]) {
    expect(
      verifyReceipt({ ...receipt(), logs }, hash, prepared()).outcome,
    ).toBe("failed");
  }
  expect(
    verifyReceipt({ ...receipt(), status: "0x0" }, hash, prepared()).outcome,
  ).toBe("failed");
});

test("net transfers exclude prior balances, refund consumption, and unrelated transactions", () => {
  const r = receipt();
  // Multiple transfers sum, but no starting wallet/router balance enters the result.
  r.logs[3] = log(output, pool, sender, 99);
  r.logs.push(log(output, pool, sender, 100));
  expect(verifyReceipt(r, hash, prepared())).toMatchObject({
    outcome: "passed",
    outputReceivedAtomic: "199",
  });
  r.logs.push(log(input, pool, sender, 1));
  expect(verifyReceipt(r, hash, prepared())).toMatchObject({
    outcome: "failed",
    inputSpentAtomic: "100",
  });
  r.logs.push({
    ...log(output, pool, sender, 1000000),
    transactionHash: `0x${"b".repeat(64)}`,
  });
  expect(verifyReceipt(r, hash, prepared()).outcome).toBe("unavailable");
});

test("direct route needs no intermediate balance; malformed transfer evidence is unavailable", () => {
  const p = prepared();
  assert(p.route);
  p.route.legs = [{ ...p.route.legs[0], tokenOut: output }];
  expect(verifyReceipt(receipt(), hash, p).outcome).toBe("passed");
  const r = receipt();
  r.logs[0].data = "0x1";
  expect(verifyReceipt(r, hash, p).outcome).toBe("unavailable");
});

test("actual CLI gates cast sends, preserves terms, and keeps RPC secrets out of argv and diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-execute-"));
  const callsPath = join(directory, "calls.jsonl");
  const castPath = join(directory, "cast");
  // Stub cast only; the real CLI, Connect client, and HTTP RPC paths run.
  await Bun.write(
    castPath,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, rpc: process.env.ETH_RPC_URL, privateKey: process.env.ETH_PRIVATE_KEY}) + '\\n');
console.log(args[0] === 'wallet' ? '${sender}' : '${hash}');
`,
  );
  await chmod(castPath, 0o700);
  let p = prepared();
  let enabled = true;
  let receiptReads = 0;
  let canonicalMismatch = false;
  const blockHash = `0x${"b".repeat(64)}`;
  const blockRequests: unknown[] = [];
  const requests: unknown[] = [];
  const preparationTimeouts: Array<string | null> = [];
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
                  key: "testnet",
                  chainId: "84532",
                  connected: true,
                  executionEnabled: enabled,
                },
              ],
            }),
          ),
          { headers: { "content-type": "application/proto" } },
        );
      if (path.endsWith("/PrepareExecution")) {
        preparationTimeouts.push(request.headers.get("connect-timeout-ms"));
        requests.push(
          fromBinary(
            PrepareExecutionRequestSchema,
            new Uint8Array(await request.arrayBuffer()),
          ),
        );
        if (requests.length === 1) await Bun.sleep(5200);
        return new Response(toBinary(PrepareExecutionResponseSchema, p), {
          headers: { "content-type": "application/proto" },
        });
      }
      const body = (await request.json()) as {
        method: string;
        params: unknown[];
      };
      if (body.method === "eth_getBlockByNumber") {
        blockRequests.push(body.params);
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            hash: canonicalMismatch ? `0x${"c".repeat(64)}` : blockHash,
          },
        });
      }
      if (body.method === "eth_getTransactionReceipt") receiptReads++;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result:
          body.method === "eth_chainId"
            ? "0x14a34"
            : {
                ...receipt(),
                blockNumber: "0x123",
                // Base preconfirmations can report success before the block is sealed.
                ...(receiptReads === 2
                  ? {}
                  : {
                      blockHash:
                        receiptReads === 1 ? `0x${"0".repeat(64)}` : blockHash,
                    }),
              },
      });
    },
  });
  const config = join(directory, "epeius.toml");
  await Bun.write(
    config,
    `[terminal]\ndefault_chain='testnet'\nengine_url='${server.url}'\nsearch_budget_ms=2000\n[chains.testnet]\nchain_id=84532\nexecution_enabled=true\nrpc_url_env='EPEIUS_FIXTURE_RPC'\n`,
  );
  const rpc = `${server.url}secret-api-key`;
  const run = async (args: string[], rpcOverride = rpc) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "apps/terminal/src/main.ts",
        ...args,
        "--config",
        config,
        "--quote-id",
        "q1",
        "--route-id",
        "r1",
        "--keystore",
        "/fixture/keystore",
        "--password-file",
        "/fixture/password",
      ],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          EPEIUS_FIXTURE_RPC: rpcOverride,
          ETH_PRIVATE_KEY: "must-not-reach-cast",
        },
        stdin: "ignore",
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
  };
  const calls = async () =>
    (await Bun.file(callsPath).text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            rpc?: string;
            privateKey?: string;
          },
      );
  try {
    const slowPreview = await run(["prepare"]);
    expect(slowPreview.code).toBe(0);
    expect(slowPreview.out).toContain('"status":"PREPARATION_STATUS_READY"');
    expect(slowPreview.out).toContain('"sent":false');
    expect((await run(["prepare", "--slippage-bps", "9999"])).code).toBe(0);
    expect((await run(["prepare", "--slippage-bps", "10000"])).err).toContain(
      "0 through 9999",
    );
    expect((await run(["execute"])).out).toContain('"canceled"');
    expect((await run(["execute", "--confirm-approval", "yes"])).out).toContain(
      '"canceled"',
    );
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(0);
    const success = await run(["execute", "--confirm-swap", "yes"]);
    expect(success.code).toBe(0);
    expect(success.out).toContain('"outcome":"passed"');
    expect(receiptReads).toBe(3);
    expect(blockRequests).toEqual([["0x123", false]]);
    const send = (await calls()).filter((call) => call.args[0] === "send");
    expect(send).toHaveLength(1);
    expect(send[0].args).toEqual([
      "send",
      router,
      "0x1234",
      "--value",
      "0",
      "--gas-limit",
      "200000",
      "--chain",
      "84532",
      "--from",
      sender,
      "--async",
      "--keystore",
      "/fixture/keystore",
      "--password-file",
      "/fixture/password",
    ]);
    expect(send[0].rpc).toBe(rpc);
    expect(send[0].privateKey).toBeUndefined();
    expect(send[0].args.join(" ")).not.toContain("secret-api-key");
    expect(requests.at(-1)).toMatchObject({
      preparationId: "p1",
      quoteId: "",
      routeId: "",
      sender: "",
      slippageBps: 0,
    });
    // Both initial preparation and preparation-ID recheck override the 5s client default.
    expect(preparationTimeouts.every((timeout) => timeout === "25000")).toBe(
      true,
    );
    expect(requests.at(-2)).toMatchObject({
      quoteId: "q1",
      routeId: "r1",
      sender,
      slippageBps: 50,
    });
    canonicalMismatch = true;
    const mismatch = await run(["execute", "--confirm-swap", "yes"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).not.toContain('"outcome":"passed"');
    expect(mismatch.out).toContain('"submission":"pending_or_unknown"');
    expect(mismatch.out).toContain('"outcome":"unavailable"');
    expect(receiptReads).toBe(4);
    expect(blockRequests).toEqual([
      ["0x123", false],
      ["0x123", false],
    ]);
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(2);
    const failure = await run(["prepare"], "http://127.0.0.1:1/secret-api-key");
    expect(failure.code).toBe(1);
    expect(failure.err).toContain("RPC request failed");
    expect(failure.err).not.toContain("secret-api-key");
    enabled = false;
    expect((await run(["execute", "--confirm-swap", "yes"])).err).toContain(
      "Engine must enable execution",
    );
    enabled = true;
    p = prepared();
    assert(p.route);
    p.route.routeId = "other-route";
    expect((await run(["execute", "--confirm-swap", "yes"])).err).toContain(
      "different route",
    );
    expect(
      (
        await run([
          "execute",
          "--confirm-swap",
          "yes",
          "--confirm-approval",
          "yes",
        ])
      ).err,
    ).toContain("Confirm only one action");
    expect(
      (await run(["execute", "--private-key", "forbidden"])).err,
    ).toContain("Invalid arguments");
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(2);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
}, 15000);
