import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetStatusResponseSchema,
  PreparationStatus,
  PrepareExecutionRequestSchema,
  PrepareExecutionResponseSchema,
  QuoteFinalSchema,
  QuoteRequestSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  type ExecutionIO,
  executePrepared,
  expectedSwapData,
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
const expectedChainId = "11155111";
const expectedRpcChainId = "0xaa36a7";
const trusted = {
  tokens: [input, middle, output],
  deployments: {
    uni: { kind: "uniswap-v3" as const, router, fees: [500, 3000] },
    cake: { kind: "pancake-v3" as const, router, fees: [500, 3000] },
  },
};
function prepared() {
  const result = create(PrepareExecutionResponseSchema, {
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
      chainId: expectedChainId,
      from: sender,
      to: router,
      data: "0x00",
      valueAtomic: "0",
      gasLimit: "200000",
    },
    route: {
      routeId: "r1",
      provider: "uniswap-v3",
      deploymentId: "uni",
      amountOutAtomic: "198",
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
          selector: { case: "feePips", value: 3000 },
        },
      ],
    },
  });
  assert(result.transaction);
  result.transaction.data = expectedSwapData(result, "uniswap-v3");
  return result;
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
    expectedChainId,
    slippageBps: 50,
    trusted,
    chainId: async () => expectedRpcChainId,
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

test("READY approval calldata to the input token never sends, even when recheck terms match", async () => {
  const f = fixture();
  assert(f.p.transaction);
  f.p.transaction.to = input;
  f.p.transaction.data = `0x095ea7b3${router.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`;

  await expect(executePrepared(f.io)).rejects.toThrow(
    "Swap transaction does not match locally encoded route",
  );
  expect(f.sent).toHaveLength(0);
});

test("READY transfer calldata to a different recipient never sends", async () => {
  const f = fixture();
  assert(f.p.transaction);
  f.p.transaction.to = input;
  f.p.transaction.data = `0xa9059cbb${pool.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`;

  await expect(executePrepared(f.io)).rejects.toThrow(
    "Swap transaction does not match locally encoded route",
  );
  expect(f.sent).toHaveLength(0);
});

test("wrong RPC network before preparation or after confirmation never sends", async () => {
  for (const wrongAt of [1, 2]) {
    const f = fixture();
    let calls = 0;
    f.io.chainId = async () =>
      ++calls === wrongAt ? "0x14a34" : expectedRpcChainId;
    await expect(executePrepared(f.io)).rejects.toThrow(/network|configured/);
    expect(f.sent).toHaveLength(0);
  }
});

test("prepared transaction on a different chain never sends", async () => {
  const f = fixture();
  assert(f.p.transaction);
  f.p.transaction.chainId = "84532";
  await expect(executePrepared(f.io)).rejects.toThrow("configured chain ID");
  expect(f.sent).toHaveLength(0);
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
  expect(() =>
    validatePreparation(p, sender, expectedChainId, 50, trusted, 100),
  ).toThrow("expired");
  p.expiresAtUnix = "101";
  p.deadlineUnix = "100";
  expect(() =>
    validatePreparation(p, sender, expectedChainId, 50, trusted, 100),
  ).toThrow("expired");
});

test("approval confirms separately, sends only exact approval and requires fresh quote", async () => {
  const f = fixture();
  let approved = 0;
  f.io.onApprovalVerified = () => {
    approved++;
  };
  f.io.reportPreparation = true;
  f.p.status = PreparationStatus.APPROVAL_REQUIRED;
  f.p.approvalSpender = router;
  assert(f.p.transaction);
  f.p.approvalTransaction = {
    ...f.p.transaction,
    to: input,
    data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`,
  };
  f.p.transaction = undefined;
  f.io.swapOnly = true;
  await expect(executePrepared(f.io)).rejects.toThrow(
    "Approval is still required",
  );
  expect(f.sent).toHaveLength(0);
  expect(f.confirmations).toHaveLength(0);
  expect(f.reports).toHaveLength(1);
  expect(f.reports[0]).toMatchObject({
    preparation: {
      preparationId: "p1",
      status: "PREPARATION_STATUS_APPROVAL_REQUIRED",
    },
    sent: false,
  });
  f.io.swapOnly = false;
  f.requests.length = 0;
  f.reports.length = 0;
  expect(await executePrepared(f.io)).toBe(0);
  expect(approved).toBe(1);
  expect(f.reports[0]).toMatchObject({
    preparation: {
      preparationId: "p1",
      status: "PREPARATION_STATUS_APPROVAL_REQUIRED",
    },
    sent: false,
  });
  expect(f.confirmations).toEqual(["approval"]);
  expect(f.sent).toEqual([f.p.approvalTransaction]);
  expect(f.requests).toEqual([undefined, "p1"]);
  expect(f.reports.at(-1)).toMatchObject({
    nextAction: expect.stringContaining("Rerun quote"),
  });
  f.io.receipt = async () => ({ ...receipt(), status: "0x0" });
  expect(await executePrepared(f.io)).toBe(1);
  expect(approved).toBe(1);
  f.p.approvalTransaction.data = `0x095ea7b3${router.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
  expect(() =>
    validatePreparation(f.p, sender, expectedChainId, 50, trusted),
  ).toThrow("displayed input amount");
});

test("rejects uint256 overflow even when calldata matches the old encoder", () => {
  const overflow = (1n << 260n).toString();
  for (const status of [
    PreparationStatus.READY,
    PreparationStatus.APPROVAL_REQUIRED,
  ]) {
    const p = prepared();
    const oldData = p.transaction?.data;
    p.status = status;
    p.amountInAtomic = overflow;
    if (status === PreparationStatus.READY) {
      p.deadlineUnix = overflow;
      assert(p.transaction);
      assert(oldData);
      p.transaction.data = oldData
        .replace(
          (4102444800).toString(16).padStart(64, "0"),
          BigInt(overflow).toString(16),
        )
        .replace(
          (101).toString(16).padStart(64, "0"),
          BigInt(overflow).toString(16),
        );
    } else {
      p.approvalSpender = router;
      assert(p.transaction);
      p.approvalTransaction = {
        ...p.transaction,
        to: input,
        data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${BigInt(overflow).toString(16).padStart(64, "0")}`,
      };
      p.transaction = undefined;
    }
    expect(() =>
      validatePreparation(p, sender, expectedChainId, 50, trusted),
    ).toThrow("uint256");
  }
});

test("accepts uint256 maximum and enforces saved quote slippage with rounding", () => {
  const max = ((1n << 256n) - 1n).toString();
  const boundary = prepared();
  boundary.amountInAtomic = max;
  boundary.deadlineUnix = max;
  assert(boundary.transaction);
  boundary.transaction.data = expectedSwapData(boundary, "uniswap-v3");
  expect(
    validatePreparation(boundary, sender, expectedChainId, 50, trusted),
  ).toBe(boundary.transaction);

  for (const [bps, minimum, quotedOutput] of [
    [0, "198"],
    [50, "197"],
    [9999, "1", "10001"],
  ] as const) {
    const p = prepared();
    p.amountOutMinimumAtomic = minimum;
    if (quotedOutput) {
      assert(p.route);
      p.route.amountOutAtomic = quotedOutput;
    }
    assert(p.transaction);
    p.transaction.data = expectedSwapData(p, "uniswap-v3");
    expect(validatePreparation(p, sender, expectedChainId, bps, trusted)).toBe(
      p.transaction,
    );
  }
});

test("every encoded amount and deadline rejects the first out-of-range uint256", () => {
  for (const field of [
    "amountInAtomic",
    "amountOutMinimumAtomic",
    "deadlineUnix",
  ] as const) {
    const p = prepared();
    p[field] = (1n << 256n).toString();
    expect(() => expectedSwapData(p, "uniswap-v3")).toThrow("uint256");
    expect(() => expectedSwapData(p, "pancake-v3")).toThrow("uint256");
    expect(() =>
      validatePreparation(p, sender, expectedChainId, 50, trusted),
    ).toThrow("uint256");
  }
});

test("rejects malicious matching minimum, invalid bps, and invalid quoted output before send", async () => {
  for (const invalidBps of [-1, 10000]) {
    const f = fixture();
    f.io.slippageBps = invalidBps;
    await expect(executePrepared(f.io)).rejects.toThrow("slippage");
    expect(f.sent).toHaveLength(0);
  }
  for (const amountOutAtomic of ["0", (1n << 256n).toString()]) {
    const f = fixture();
    assert(f.p.route);
    f.p.route.amountOutAtomic = amountOutAtomic;
    await expect(executePrepared(f.io)).rejects.toThrow("quoted output");
    expect(f.sent).toHaveLength(0);
  }
  for (const status of [
    PreparationStatus.READY,
    PreparationStatus.APPROVAL_REQUIRED,
  ]) {
    const f = fixture();
    f.p.amountOutMinimumAtomic = "1";
    if (status === PreparationStatus.READY) {
      assert(f.p.transaction);
      f.p.transaction.data = expectedSwapData(f.p, "uniswap-v3");
    } else {
      f.p.status = status;
      f.p.approvalSpender = router;
      assert(f.p.transaction);
      f.p.approvalTransaction = {
        ...f.p.transaction,
        to: input,
        data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`,
      };
      f.p.transaction = undefined;
    }
    await expect(executePrepared(f.io)).rejects.toThrow("slippage minimum");
    expect(f.sent).toHaveLength(0);
  }
});

test("recheck cannot refresh saved route quote basis", async () => {
  const f = fixture();
  f.io.prepare = async (id) => {
    const p = prepared();
    if (id) p.simulatedAmountOutAtomic = "1000000";
    return p;
  };
  expect(await executePrepared(f.io)).toBe(0);
  expect(f.sent).toHaveLength(1);

  const changed = fixture();
  changed.io.prepare = async (id) => {
    const p = prepared();
    if (id) {
      assert(p.route && p.transaction);
      p.route.amountOutAtomic = "10000";
      p.amountOutMinimumAtomic = "9950";
      p.transaction.data = expectedSwapData(p, "uniswap-v3");
    }
    return p;
  };
  await expect(executePrepared(changed.io)).rejects.toThrow(
    "changed after confirmation",
  );
  expect(changed.sent).toHaveLength(0);
});

test("locally encodes both router ABIs for one and two hop routes", () => {
  for (const [deploymentId, kind] of [
    ["uni", "uniswap-v3"],
    ["cake", "pancake-v3"],
  ] as const) {
    for (const hops of [1, 2]) {
      const p = prepared();
      assert(p.route && p.transaction);
      p.route.deploymentId = deploymentId;
      p.route.provider = kind;
      if (hops === 1) p.route.legs = [{ ...p.route.legs[0], tokenOut: output }];
      p.transaction.data = expectedSwapData(p, kind);
      expect(validatePreparation(p, sender, expectedChainId, 50, trusted)).toBe(
        p.transaction,
      );
    }
  }
});

test("swap calldata matches independent router ABI fixtures", () => {
  // Fixed fixtures generated offline with Foundry cast 1.5.0 from these ABI entries:
  // Uniswap SwapRouter02: exactInput((bytes,address,uint256,uint256)) nested in
  // multicall(uint256,bytes[]); PancakeSwap V3 SwapRouter: exactInput((bytes,address,uint256,uint256,uint256)).
  // Hashes cover raw calldata bytes, not the hexadecimal text. Runtime needs no cast.
  const fixtures = [
    [
      "uni",
      "uniswap-v3",
      1,
      "2c39a3d04398e46bf93e75d80844549f0ad867bc0ba507413dbd401a31e78c25",
    ],
    [
      "uni",
      "uniswap-v3",
      2,
      "431c3032de3a86e622508accf84d27de4e8d35cda51efb2028ee02eb2c6f9783",
    ],
    [
      "cake",
      "pancake-v3",
      1,
      "019ea54cbe040f8a14d67f6f932609c82ce3c6e18e3ca65e64fb63db0151ecdd",
    ],
    [
      "cake",
      "pancake-v3",
      2,
      "b377cf0245f7e6e22c6dec8276753be693accaa742a0c5050a4106d237ec12f9",
    ],
  ] as const;

  for (const [deploymentId, kind, hops, expectedDigest] of fixtures) {
    const p = prepared();
    assert(p.route);
    p.route.deploymentId = deploymentId;
    p.route.provider = kind;
    if (hops === 1) p.route.legs = [{ ...p.route.legs[0], tokenOut: output }];
    const calldata = expectedSwapData(p, kind);
    const digest = createHash("sha256")
      .update(Buffer.from(calldata.slice(2), "hex"))
      .digest("hex");
    expect(digest).toBe(expectedDigest);
  }
});

test("rejects altered target, calldata, path, amount, deadline, recipient and approval spender", () => {
  const mutations: Array<(p: ReturnType<typeof prepared>) => void> = [
    (p) => {
      assert(p.transaction);
      p.transaction.to = pool;
    },
    (p) => {
      assert(p.transaction);
      p.transaction.data = `${p.transaction.data.slice(0, -2)}ff`;
    },
    (p) => {
      assert(p.route);
      p.route.legs[0].tokenIn = addr("9");
    },
    (p) => {
      assert(p.route);
      p.route.deploymentId = "unknown";
    },
    (p) => {
      assert(p.route);
      p.route.provider = "pancake-v3";
    },
    (p) => {
      assert(p.route);
      p.route.legs[0].selector = { case: "feePips", value: 100 };
    },
    (p) => {
      p.amountInAtomic = "102";
    },
    (p) => {
      p.deadlineUnix = "4102444799";
    },
    (p) => {
      p.recipient = addr("9");
    },
  ];
  for (const mutate of mutations) {
    const p = prepared();
    mutate(p);
    expect(() =>
      validatePreparation(p, sender, expectedChainId, 50, trusted),
    ).toThrow();
  }
  const p = prepared();
  p.status = PreparationStatus.APPROVAL_REQUIRED;
  p.approvalSpender = pool;
  assert(p.transaction);
  p.approvalTransaction = {
    ...p.transaction,
    to: input,
    data: `0x095ea7b3${pool.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`,
  };
  p.transaction = undefined;
  expect(() =>
    validatePreparation(p, sender, expectedChainId, 50, trusted),
  ).toThrow("spender");
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
  let remoteChainId = expectedChainId;
  let receiptReads = 0;
  let canonicalMismatch = false;
  let quoteCount = 0;
  let tradeApproval = false;
  let alterTradeAmount = false;
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
                  chainId: remoteChainId,
                  connected: true,
                  quotingSupported: true,
                  executionEnabled: enabled,
                  tokens: [
                    { address: input, symbol: "IN", decimals: 18 },
                    { address: middle, symbol: "MID", decimals: 6 },
                    { address: output, symbol: "OUT", decimals: 8 },
                  ],
                },
              ],
            }),
          ),
          { headers: { "content-type": "application/proto" } },
        );
      if (path.endsWith("/GetQuote")) {
        const requestBody = fromBinary(
          QuoteRequestSchema,
          new Uint8Array(await request.arrayBuffer()),
        );
        expect(requestBody).toMatchObject({
          tokenIn: input,
          tokenOut: output,
          amountInAtomic: "101",
        });
        quoteCount++;
        p = prepared();
        assert(p.route);
        p.preparationId = `trade-p${quoteCount}`;
        if (tradeApproval && quoteCount === 1) {
          p.status = PreparationStatus.APPROVAL_REQUIRED;
          p.approvalSpender = router;
          assert(p.transaction);
          p.approvalTransaction = {
            ...p.transaction,
            to: input,
            data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${(101).toString(16).padStart(64, "0")}`,
          };
          p.transaction = undefined;
        }
        return new Response(
          toBinary(
            QuoteFinalSchema,
            create(QuoteFinalSchema, {
              quoteId: `trade-q${quoteCount}`,
              bestRouteId: "r1",
              searchComplete: true,
              routes: [p.route],
            }),
          ),
          { headers: { "content-type": "application/proto" } },
        );
      }
      if (path.endsWith("/PrepareExecution")) {
        preparationTimeouts.push(request.headers.get("connect-timeout-ms"));
        requests.push(
          fromBinary(
            PrepareExecutionRequestSchema,
            new Uint8Array(await request.arrayBuffer()),
          ),
        );
        if (requests.length === 1) await Bun.sleep(5200);
        if (alterTradeAmount) p.amountInAtomic = "102";
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
            ? expectedRpcChainId
            : {
                ...receipt(),
                blockNumber: "0x123",
                // Preconfirmations can report success before the block is sealed.
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
    `[terminal]\ndefault_chain='testnet'\nengine_url='${server.url}'\nsearch_budget_ms=2000\n[chains.testnet]\nchain_id=${expectedChainId}\nexecution_enabled=true\nrpc_url_env='EPEIUS_FIXTURE_RPC'\n[[chains.testnet.tokens]]\naddress='${input.slice(2)}'\nsymbol='IN'\ndecimals=18\n[[chains.testnet.tokens]]\naddress='${middle.slice(2)}'\nsymbol='MID'\ndecimals=6\n[[chains.testnet.tokens]]\naddress='${output.slice(2)}'\nsymbol='OUT'\ndecimals=8\n[chains.testnet.deployments.uni]\nkind='uniswap-v3'\nrouter='${router.slice(2)}'\nfees=[500,3000]\n`,
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
        ...(args[0] === "trade"
          ? ["--in", "IN", "--out", "OUT", "--amount-atomic", "101"]
          : ["--quote-id", "q1", "--route-id", "r1"]),
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
    remoteChainId = "84532";
    expect((await run(["execute", "--confirm-swap", "yes"])).err).toContain(
      "Engine chain ID must match configured chain ID",
    );
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(0);
    remoteChainId = expectedChainId;
    expect((await run(["prepare", "--slippage-bps", "9999"])).err).toContain(
      "slippage minimum",
    );
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
    const expectedTransaction = prepared().transaction;
    assert(expectedTransaction);
    expect(send[0].args).toEqual([
      "send",
      router,
      expectedTransaction.data,
      "--value",
      "0",
      "--gas-limit",
      "200000",
      "--chain",
      expectedChainId,
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
    canonicalMismatch = false;
    const trade = await run(["trade", "--confirm-swap", "yes"]);
    expect(trade.code).toBe(0);
    const events = trade.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      quote: { quoteId: "trade-q1", bestRouteId: "r1" },
    });
    expect(events[1]).toMatchObject({
      selection: { routeId: "r1", source: "engine", afterApproval: false },
    });
    expect(events[2]).toMatchObject({
      preparation: { preparationId: "trade-p1", route: { routeId: "r1" } },
      sent: false,
    });
    expect(events.at(-1).verification.outcome).toBe("passed");
    quoteCount = 0;
    tradeApproval = true;
    const approved = await run(["trade", "--confirm-approval", "yes"]);
    expect(approved.code).toBe(1);
    expect(quoteCount).toBe(2);
    const approvalEvents = approved.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      approvalEvents
        .filter((e) => e.submission === "submitted")
        .map((e) => e.kind),
    ).toEqual(["approval"]);
    expect(
      approvalEvents
        .filter((e) => e.preparation)
        .map((e) => e.preparation.preparationId),
    ).toEqual(["trade-p1", "trade-p2"]);
    expect(approvalEvents.at(-1)).toEqual({ sent: false, outcome: "canceled" });
    expect(requests.at(-1)).toMatchObject({
      quoteId: "trade-q2",
      routeId: "r1",
      preparationId: "",
    });
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(4);
    alterTradeAmount = true;
    tradeApproval = false;
    const altered = await run(["trade", "--confirm-swap", "yes"]);
    expect(altered.err).toContain(
      "Preparation does not match the selected quote",
    );
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(4);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
}, 15000);
