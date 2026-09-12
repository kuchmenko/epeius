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
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
  QuotedAllocationSchema,
  QuoteFinalSchema,
  QuoteRequestSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { type ExecutionIO, executePrepared } from "./execution";
import { uint256Decimal, validatePreparation } from "./execution-policy";
import { configureExecution } from "./protocols";
import { balancerData } from "./protocols/balancer-v2";
import { expectedExecutorData } from "./protocols/fixed-executor";
import { pancakeData } from "./protocols/pancake-v3";
import { uniswapData } from "./protocols/uniswap-v3";
import { type Receipt, verifyReceipt } from "./receipt";

const expectedSwapData = (
  p: PrepareExecutionResponse,
  kind: "uniswap-v3" | "pancake-v3",
) => (kind === "uniswap-v3" ? uniswapData(p) : pancakeData(p));

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
const settings = {
  tokens: [input, middle, output],
  deployments: {
    uni: { kind: "uniswap-v3" as const, router, fees: [500, 3000] },
    cake: { kind: "pancake-v3" as const, router, fees: [500, 3000] },
  },
};
const trusted = configureExecution(settings);
const obligations = (p = prepared()) => ({
  tokenIn: p.tokenIn,
  tokenOut: p.tokenOut,
  recipient: p.recipient,
  amountInAtomic: p.amountInAtomic,
  amountOutMinimumAtomic: p.amountOutMinimumAtomic,
  intermediate:
    p.route?.legs.length === 2 ? [{ token: middle, owner: router }] : [],
});
function prepared() {
  const result = create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "p1",
    expiresAtUnix: "4102444800",
    deadlineUnix: "4102444800",
    amountInAtomic: "101",
    amountOutMinimumAtomic: "197",
    simulatedAmountOutAtomic: "199",
    simulationBlock: { number: "124", hash: `0x${"b".repeat(64)}` },
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

test("uint256 decimal admission preserves zero and leading zeros without accepting other numeric syntax", () => {
  expect(uint256Decimal("0000", "Amount")).toBe(0n);
  expect(uint256Decimal("0009007199254740993", "Amount")).toBe(
    9007199254740993n,
  );
  expect(uint256Decimal(`000${(1n << 256n) - 1n}`, "Amount")).toBe(
    (1n << 256n) - 1n,
  );
  for (const value of [
    "",
    "+1",
    "-1",
    "1e3",
    "0x10",
    "1.0",
    " 1",
    (1n << 256n).toString(),
  ])
    expect(() => uint256Decimal(value, "Amount")).toThrow("uint256");
});

test("approval and swap map canonical success, revert and unavailable receipt explicitly", async () => {
  for (const approval of [false, true])
    for (const status of ["0x1", "0x0", "unavailable"]) {
      const f = fixture();
      if (approval) {
        assert(f.p.transaction);
        f.p.status = PreparationStatus.APPROVAL_REQUIRED;
        f.p.approvalSpender = router;
        f.p.approvalTransaction = {
          ...f.p.transaction,
          to: input,
          data: `0x095ea7b3${router.slice(2).padStart(64, "0")}${"65".padStart(64, "0")}`,
        };
        f.p.transaction = undefined;
      }
      f.io.receipt = async () => {
        if (status === "unavailable") throw new Error("offline");
        return { ...receipt(), status };
      };
      const result = await executePrepared(f.io);
      expect(result.kind).toBe(
        status === "unavailable"
          ? "unknown"
          : status === "0x0"
            ? "failed"
            : approval
              ? "approval-confirmed"
              : "swap-verified",
      );
      expect(f.reports.at(-1)).toMatchObject({
        transactionHash: hash,
        verification: {
          outcome:
            status === "unavailable"
              ? "unavailable"
              : status === "0x0"
                ? "failed"
                : approval
                  ? "receipt_success"
                  : "passed",
        },
      });
      expect(f.requests).toEqual([undefined, "p1"]);
      expect(f.sent).toHaveLength(1);
    }
});

test("submitted JSONL keys and order precede receipt observation", async () => {
  const f = fixture();
  f.io.reportPreparation = true;
  f.io.receipt = async () => {
    expect(f.reports).toHaveLength(2);
    expect(Object.keys(f.reports[0] as object)).toEqual([
      "preparation",
      "sent",
    ]);
    expect(Object.keys(f.reports[1] as object)).toEqual([
      "transactionHash",
      "submission",
      "kind",
      "verification",
    ]);
    expect(f.reports[1]).toEqual({
      transactionHash: hash,
      submission: "submitted",
      kind: "swap",
      verification: { outcome: "pending" },
    });
    return receipt();
  };
  await executePrepared(f.io);
  expect(Object.keys(f.reports[2] as object)).toEqual([
    "transactionHash",
    "verification",
  ]);
  expect(f.sent).toHaveLength(1);
});

test("preview and canceled confirmation never send or recheck", async () => {
  for (const preview of [true, false]) {
    const f = fixture();
    f.io.confirm = async () => false;
    expect(await executePrepared(f.io, preview)).toEqual({
      kind: preview ? "preview" : "canceled",
    });
    expect(f.sent).toHaveLength(0);
    expect(f.requests).toEqual([undefined]);
  }
});

test("swap rechecks by preparation ID and reports hash separately from verification", async () => {
  const f = fixture();
  expect(await executePrepared(f.io)).toEqual({
    kind: "swap-verified",
    transactionHash: hash,
  });
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
  expect(await executePrepared(f.io)).toEqual({
    kind: "approval-confirmed",
    transactionHash: hash,
  });
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
  expect(await executePrepared(f.io)).toEqual({
    kind: "failed",
    transactionHash: hash,
  });
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
    validatePreparation(boundary, sender, expectedChainId, 50, trusted)
      .transaction,
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
    expect(
      validatePreparation(p, sender, expectedChainId, bps, trusted).transaction,
    ).toBe(p.transaction);
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
  expect(await executePrepared(f.io)).toEqual({
    kind: "swap-verified",
    transactionHash: hash,
  });
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
      expect(
        validatePreparation(p, sender, expectedChainId, 50, trusted)
          .transaction,
      ).toBe(p.transaction);
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

test("Balancer binds full pool ID and matches independent Vault.swap calldata", () => {
  const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8";
  const poolId =
    "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063";
  const tokenIn = "0x6b175474e89094c44da98b954eedeac495271d0f";
  const tokenOut = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const p = create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "balancer-preparation",
    expiresAtUnix: "1700000100",
    deadlineUnix: "1700000000",
    amountInAtomic: "1000000000000000000",
    amountOutMinimumAtomic: "995022",
    tokenIn,
    tokenOut,
    recipient: sender,
    transaction: {
      chainId: "1",
      from: sender,
      to: vault,
      data: "0x00",
      valueAtomic: "0",
      gasLimit: "1500000",
    },
    route: {
      routeId: `balancer:${poolId}`,
      provider: "balancer-v2",
      deploymentId: "balancer",
      amountOutAtomic: "1000023",
      legs: [{ pool: poolId, tokenIn, tokenOut }],
    },
  });
  assert(p.transaction && p.route);
  p.transaction.data = balancerData(p);
  const castCalldata =
    "0x52bbbe2900000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f2ece000000000000000000000000000000000000000000000000000000006553f10006df3b2bbb68adc8b0e302443692037ed9f91b4200000000000000000000006300000000000000000000000000000000000000000000000000000000000000000000000000000000000000006b175474e89094c44da98b954eedeac495271d0f000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000";
  expect(p.transaction.data).toBe(castCalldata);
  const local = configureExecution({
    tokens: [tokenIn, tokenOut],
    deployments: {
      balancer: { kind: "balancer-v2", options: { vault, pools: [poolId] } },
    },
  });
  for (const field of ["factory", "quoter", "router", "fees"] as const) {
    const deployment: Record<string, unknown> = {
      kind: "balancer-v2",
      options: { vault, pools: [poolId] },
      [field]: field === "fees" ? [] : "",
    };
    expect(() =>
      configureExecution({
        tokens: [tokenIn, tokenOut],
        deployments: { balancer: deployment },
      }),
    ).toThrow("Local execution deployment is invalid.");
  }
  const plan = validatePreparation(p, sender, "1", 50, local, 1699999999);
  expect(plan.spender).toBe(vault);
  expect(plan.routeDetails).toEqual([
    [`Pool ID: ${poolId}; pool address: ${poolId.slice(0, 42)}`],
  ]);
  if (plan.action !== "swap") throw new Error("Expected swap plan");
  expect(plan.receipt.intermediate).toEqual([]);
  expect(plan.receipt.touched).toEqual([]);

  for (const mutate of [
    (changed: PrepareExecutionResponse) => {
      assert(changed.route);
      changed.route.provider = "uniswap-v3";
    },
    (changed: PrepareExecutionResponse) => {
      assert(changed.route);
      changed.route.deploymentId = "other";
    },
    (changed: PrepareExecutionResponse) => {
      assert(changed.route);
      changed.route.legs[0].tokenIn = tokenOut;
    },
    (changed: PrepareExecutionResponse) => {
      assert(changed.route);
      changed.route.legs[0].pool = `${poolId.slice(0, -1)}4`;
    },
    (changed: PrepareExecutionResponse) => {
      assert(changed.route);
      changed.route.legs[0].selector = { case: "feePips", value: 0 };
    },
    (changed: PrepareExecutionResponse) => {
      assert(changed.transaction);
      changed.transaction.to = poolId.slice(0, 42);
    },
  ]) {
    const changed = structuredClone(p);
    mutate(changed);
    expect(() =>
      validatePreparation(changed, sender, "1", 50, local, 1699999999),
    ).toThrow();
  }

  const bpt = poolId.slice(0, 42);
  const bptSwap = structuredClone(p);
  assert(bptSwap.route && bptSwap.transaction);
  bptSwap.tokenIn = bpt;
  bptSwap.route.legs[0].tokenIn = bpt;
  bptSwap.transaction.data = balancerData(bptSwap);
  const bptLocal = configureExecution({
    tokens: [bpt, tokenOut],
    deployments: {
      balancer: { kind: "balancer-v2", options: { vault, pools: [poolId] } },
    },
  });
  expect(() =>
    validatePreparation(bptSwap, sender, "1", 50, bptLocal, 1699999999),
  ).toThrow("Balancer BPT swaps are not supported.");
});

test("fee boundaries match independent Cast calldata and local admission", () => {
  // Offline cast calldata exactInput((bytes,address,uint256,uint256)), then
  // multicall(uint256,bytes[]): path IN / fee / OUT, sender, 101, 197, 4102444800.
  for (const [fee, digest] of [
    [0, "65a69c9134116b0c7be7482bc220c4ac2de0d3f477ab9da7dd7024ab69b39664"],
    [
      999999,
      "11e0deb064daa3eb436e0e30df24af833f8ae442a79f659ecf84cecb64b6ec5a",
    ],
  ] as const) {
    const p = prepared();
    assert(p.route && p.transaction);
    p.route.legs = [
      {
        ...p.route.legs[0],
        tokenOut: output,
        selector: { case: "feePips", value: fee },
      },
    ];
    p.transaction.data = expectedSwapData(p, "uniswap-v3");
    expect(
      createHash("sha256")
        .update(Buffer.from(p.transaction.data.slice(2), "hex"))
        .digest("hex"),
    ).toBe(digest);
    const config = structuredClone(settings);
    config.deployments.uni.fees = [fee];
    expect(
      validatePreparation(
        p,
        sender,
        expectedChainId,
        50,
        configureExecution(config),
      ).transaction,
    ).toBe(p.transaction);
    p.route.legs[0].selector = { case: "feePips", value: 1000000 };
    expect(() =>
      validatePreparation(
        p,
        sender,
        expectedChainId,
        50,
        configureExecution(config),
      ),
    ).toThrow("not allowed");
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
    expect(await executePrepared(f.io)).toMatchObject({ kind: "unknown" });
    expect(calls).toBe(1);
    expect(f.reports.at(-1)).toMatchObject({
      submission: stage === "send" ? "unknown" : "pending_or_unknown",
      verification: { outcome: "unavailable" },
    });
  }
});

test("review mutation prevents send; invalid submission hash remains unknown without receipt or retry", async () => {
  const mutated = fixture();
  mutated.io.confirm = async (_kind, p) => {
    assert(p.transaction);
    p.transaction.data = "0xdead";
    return true;
  };
  await expect(executePrepared(mutated.io)).rejects.toThrow(
    "changed after confirmation",
  );
  expect(mutated.sent).toHaveLength(0);
  const invalid = fixture();
  let sends = 0;
  let receipts = 0;
  invalid.io.send = async () => {
    sends++;
    return "invalid hash";
  };
  invalid.io.receipt = async () => {
    receipts++;
    return receipt();
  };
  expect(await executePrepared(invalid.io)).toEqual({
    kind: "unknown",
    transactionHash: null,
  });
  expect(sends).toBe(1);
  expect(receipts).toBe(0);
});

test("receipt identity and removed logs cannot establish token deltas", () => {
  const r = receipt();
  expect(
    verifyReceipt(
      { ...r, transactionHash: `0x${"b".repeat(64)}` },
      hash,
      obligations(),
    ).outcome,
  ).toBe("unavailable");
  r.logs[0].removed = true;
  expect(verifyReceipt(r, hash, obligations()).outcome).toBe("unavailable");
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
      verifyReceipt({ ...receipt(), logs }, hash, obligations()).outcome,
    ).toBe("failed");
  }
  expect(
    verifyReceipt({ ...receipt(), status: "0x0" }, hash, obligations()).outcome,
  ).toBe("failed");
});

test("net transfers exclude prior balances, refund consumption, and unrelated transactions", () => {
  const r = receipt();
  // Multiple transfers sum, but no starting wallet/router balance enters the result.
  r.logs[3] = log(output, pool, sender, 99);
  r.logs.push(log(output, pool, sender, 100));
  expect(verifyReceipt(r, hash, obligations())).toMatchObject({
    outcome: "passed",
    outputReceivedAtomic: "199",
  });
  r.logs.push(log(input, pool, sender, 1));
  expect(verifyReceipt(r, hash, obligations())).toMatchObject({
    outcome: "failed",
    inputSpentAtomic: "100",
  });
  r.logs.push({
    ...log(output, pool, sender, 1000000),
    transactionHash: `0x${"b".repeat(64)}`,
  });
  expect(verifyReceipt(r, hash, obligations()).outcome).toBe("unavailable");
});

test("direct route needs no intermediate balance; malformed transfer evidence is unavailable", () => {
  const p = prepared();
  assert(p.route);
  p.route.legs = [{ ...p.route.legs[0], tokenOut: output }];
  expect(verifyReceipt(receipt(), hash, obligations(p)).outcome).toBe("passed");
  const r = receipt();
  r.logs[0].data = "0x1";
  expect(verifyReceipt(r, hash, obligations(p)).outcome).toBe("unavailable");
});

test("consumer implementation dispatches once with distinct target/spender and explicit custody", async () => {
  for (const approval of [false, true]) {
    const f = fixture();
    assert(f.p.route && f.p.transaction);
    const target = addr("7"),
      spender = addr("8"),
      custody = addr("9");
    f.p.route.deploymentId = "test-only";
    f.p.route.provider = "test-only";
    f.p.route.legs[0].selector = { case: "tickSpacing", value: 17 };
    f.p.transaction.to = target;
    f.p.transaction.data = "0x1234";
    if (approval) {
      f.p.status = PreparationStatus.APPROVAL_REQUIRED;
      f.p.approvalSpender = spender;
      f.p.approvalTransaction = {
        ...f.p.transaction,
        to: input,
        data: `0x095ea7b3${spender.slice(2).padStart(64, "0")}${"65".padStart(64, "0")}`,
      };
      f.p.transaction = undefined;
    }
    let builds = 0;
    f.io.trusted = {
      tokens: [input, middle, output],
      deployments: {
        "test-only": {
          plan: () => {
            builds++;
            return {
              target,
              spender,
              data: "0x1234",
              quotedOutput: "198",
              routeDetails: [["custom selector 17", "custom selector 23"]],
              receipt: {
                intermediate: [],
                touched: [{ token: middle, owner: custody }],
              },
            };
          },
        },
      },
    };
    f.io.confirm = async (action, _p, plan) => {
      expect(action).toBe(approval ? "approval" : "swap");
      expect(plan.spender).toBe(spender);
      expect(plan.transaction.to).toBe(approval ? input : target);
      expect(plan.routeDetails[0][0]).toBe("custom selector 17");
      // Review receives a copy: mutation cannot change the signed transaction.
      plan.transaction.data = "0xdead";
      return true;
    };
    f.io.receipt = async () => ({
      ...receipt(),
      logs: [...receipt().logs, log(middle, pool, custody, 1)],
    });
    expect((await executePrepared(f.io)).kind).toBe(
      approval ? "approval-confirmed" : "failed",
    );
    expect(builds).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      data: approval ? f.p.approvalTransaction?.data : "0x1234",
    });
  }
  expect(() =>
    configureExecution({
      ...settings,
      deployments: { fake: { kind: "test-only", router, fees: [500] } },
    }),
  ).toThrow("Unsupported provider: test-only.");
});

test("Transfer decode rejects extra/missing words, topics and noncanonical address padding", () => {
  const mutations: Array<(log: Receipt["logs"][number]) => void> = [
    (log) => {
      log.data += "00".repeat(32);
    },
    (log) => {
      log.data = log.data.slice(0, -2);
    },
    (log) => {
      log.topics.push(`0x${"0".repeat(64)}`);
    },
    (log) => {
      log.topics.pop();
    },
    (log) => {
      log.topics[1] = `0x01${log.topics[1].slice(4)}`;
    },
    (log) => {
      log.topics[2] = log.topics[2].slice(0, -1);
    },
    (log) => {
      log.address = log.address.slice(0, -1);
    },
  ];
  for (const mutate of mutations) {
    const r = receipt();
    mutate(r.logs[0]);
    expect(verifyReceipt(r, hash, obligations()).outcome).toBe("unavailable");
  }
});

test("actual CLI gates cast sends, preserves terms, and keeps RPC secrets out of argv and diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-execute-"));
  const callsPath = join(directory, "calls.jsonl");
  const castPath = join(directory, "cast");
  const accountPath = join(directory, "account.txt");
  await Bun.write(accountPath, sender);
  // Stub cast only; the real CLI, Connect client, and HTTP RPC paths run.
  await Bun.write(
    castPath,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, rpc: process.env.ETH_RPC_URL, privateKey: process.env.ETH_PRIVATE_KEY}) + '\\n');
console.log(args[0] === 'wallet' ? readFileSync(${JSON.stringify(accountPath)}, 'utf8') : '${hash}');
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
  let rejection: PrepareExecutionResponse | undefined;
  let changeAccountOnQuote = false;
  let walletCallsBeforeRun = 0;
  let informationalQuote = false;
  const blockHash = `0x${"b".repeat(64)}`;
  const blockRequests: unknown[] = [];
  const requests: unknown[] = [];
  const preparationTimeouts: Array<string | null> = [];
  const trace: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      trace.push(
        path.includes("QuoteService") ? (path.split("/").at(-1) ?? "") : "rpc",
      );
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
        if (!informationalQuote) {
          const walletCalls = (await Bun.file(callsPath).text())
            .split("\n")
            .filter((line) => line.includes('"wallet"')).length;
          expect(walletCalls).toBeGreaterThan(walletCallsBeforeRun);
          expect(trace).toContain("eth_chainId");
          trace.push("account-and-chain-established-before-quote");
        }
        if (changeAccountOnQuote) await Bun.write(accountPath, router);
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
          p.simulatedAmountOutAtomic = "";
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
        return new Response(
          toBinary(PrepareExecutionResponseSchema, rejection ?? p),
          {
            headers: { "content-type": "application/proto" },
          },
        );
      }
      const body = (await request.json()) as {
        method: string;
        params: unknown[];
      };
      trace.push(body.method);
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
  const run = async (
    args: string[],
    rpcOverride = rpc,
    confirmation?: "approval" | "swap",
  ) => {
    trace.length = 0;
    walletCallsBeforeRun = (await Bun.file(callsPath).exists())
      ? (await Bun.file(callsPath).text())
          .split("\n")
          .filter((line) => line.includes('"wallet"')).length
      : 0;
    informationalQuote = args[0] === "quote";
    const command = [
      process.execPath,
      "apps/terminal/src/main.ts",
      ...args,
      "--config",
      config,
      ...(args[0] === "trade" || args[0] === "quote"
        ? ["--in", "IN", "--out", "OUT", "--amount-atomic", "101"]
        : args[0] === "status" || args[0] === "tokens"
          ? []
          : args.includes("--allocations")
            ? ["--quote-id", "q1"]
            : ["--quote-id", "q1", "--route-id", "r1"]),
      ...(["quote", "tokens", "status"].includes(args[0])
        ? []
        : [
            "--keystore",
            "/fixture/keystore",
            "--password-file",
            "/fixture/password",
          ]),
    ];
    const stdoutPath = join(directory, "tty.stdout.jsonl");
    const child = Bun.spawn(
      confirmation
        ? [
            "script",
            "-qefc",
            `${command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")} > '${stdoutPath}'`,
            "/dev/null",
          ]
        : command,
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          EPEIUS_FIXTURE_RPC: rpcOverride,
          ETH_PRIVATE_KEY: "must-not-reach-cast",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (!confirmation) child.stdin.end();
    let answered = false;
    const [out, err, code] = await Promise.all([
      (async () => {
        let output = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
          const text = decoder.decode(chunk, { stream: true });
          output += text;
          trace.push(`stdout:${text.trimEnd()}`);
          if (
            confirmation &&
            !answered &&
            output.includes("to sign and send this transaction:")
          ) {
            answered = true;
            child.stdin.write(`${confirmation}\n`);
            child.stdin.end();
          }
        }
        return output + decoder.decode();
      })(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return confirmation
      ? { out: await Bun.file(stdoutPath).text(), err: out + err, code }
      : { out, err, code };
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
  const capture = async (
    name: string,
    result: { out: string; err: string; code: number },
  ) => {
    const destination = process.env.EPEIUS_TERMINAL_CAPTURE_DIR;
    if (!destination) return;
    await Bun.write(join(destination, `${name}.stdout.jsonl`), result.out);
    await Bun.write(join(destination, `${name}.stderr.txt`), result.err);
    await Bun.write(
      join(destination, `${name}.trace.json`),
      JSON.stringify({ exitCode: result.code, trace }, null, 2),
    );
  };
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
    const nonTTY = await run(["execute"]);
    expect(nonTTY.out).toBe('{"sent":false,"outcome":"canceled"}\n');
    await capture("non-tty", nonTTY);
    expect((await run(["execute", "--confirm-approval", "yes"])).out).toContain(
      '"canceled"',
    );
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(0);
    const success = await run(["execute", "--confirm-swap", "yes"]);
    await capture("swap", success);
    expect(success.code).toBe(0);
    expect(success.out).toBe(
      `{"transactionHash":"${hash}","submission":"submitted","kind":"swap","verification":{"outcome":"pending"}}\n` +
        `{"transactionHash":"${hash}","verification":{"outcome":"passed","inputSpentAtomic":"101","outputReceivedAtomic":"199","routerIntermediateDeltas":{"${middle}":"0"},"reason":"Exact-transaction standard ERC20 Transfer net deltas; no pre-existing balances counted."}}\n`,
    );
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
    await capture("unknown", mismatch);
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
    await capture("approval", approved);
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
    alterTradeAmount = false;
    const executor = addr("9");
    await Bun.write(
      config,
      `${await Bun.file(config).text()}\n[chains.testnet.deployments.pan]\nkind='pancake-v3'\nrouter='${addr("8")}'\nfees=[0,2500]\n[chains.testnet.executor]\naddress='${executor}'\nuniswap_deployment='uni'\npancake_deployment='pan'\n`,
    );
    p = prepared();
    assert(p.route && p.transaction);
    p.route.block = {
      $typeName: "epeius.quote.v1.BlockContext",
      number: "123",
      hash: blockHash,
    };
    p.allocations = [
      create(QuotedAllocationSchema, { amountInAtomic: "101", route: p.route }),
    ];
    p.route = undefined;
    p.transaction.to = executor;
    p.transaction.data = expectedExecutorData(p);
    const allocationArgs = [
      "--allocations",
      '[{"routeId":"r1","amountInAtomic":"101"}]',
    ];
    const executable = p;
    for (const status of [
      PreparationStatus.REJECTED,
      PreparationStatus.REQUOTE_REQUIRED,
    ]) {
      rejection = create(PrepareExecutionResponseSchema, {
        status,
        message: "quote block unavailable\n\u001b[2J\u009b31m\u202euntrusted",
      });
      for (const args of [
        ["execute", ...allocationArgs],
        ["execute"],
        ["trade"],
      ]) {
        const blocked = await run([...args, "--confirm-swap", "yes"]);
        await capture(
          status === PreparationStatus.REJECTED ? "rejected" : "requote",
          blocked,
        );
        expect(blocked.code).toBe(1);
        expect(blocked.err).toContain(
          "quote block unavailable\\n\\u001b[2J\\u009b31m\\u202euntrusted",
        );
        expect(blocked.err).not.toContain("different allocations");
        expect(blocked.err).not.toContain("selected quote");
        expect(blocked.err).not.toContain("\u001b");
      }
    }
    p = executable;
    assert(p.transaction);
    rejection = undefined;
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(4);
    const executorPreview = await run(["prepare", ...allocationArgs]);
    expect(executorPreview.code).toBe(0);
    expect(executorPreview.out).toContain('"allocations"');
    expect(requests.at(-1)).toMatchObject({
      routeId: "",
      allocations: [{ routeId: "r1", amountInAtomic: "101" }],
    });
    const executed = await run([
      "execute",
      ...allocationArgs,
      "--confirm-swap",
      "yes",
    ]);
    expect(executed.code).toBe(0);
    const executorSends = (await calls()).filter(
      (call) => call.args[0] === "send",
    );
    expect(executorSends).toHaveLength(5);
    expect(executorSends.at(-1)?.args.slice(1, 3)).toEqual([
      executor,
      p.transaction.data,
    ]);
    p.allocations[0].amountInAtomic = "102";
    expect(
      (await run(["execute", ...allocationArgs, "--confirm-swap", "yes"])).err,
    ).toContain("different allocations");
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(5);
    // Two real configured venues and asymmetric allocations exercise the human split review.
    p.allocations[0].amountInAtomic = "37";
    assert(p.allocations[0].route);
    p.allocations[0].route.amountOutAtomic = "79";
    p.allocations.push(
      create(QuotedAllocationSchema, {
        amountInAtomic: "64",
        route: {
          ...p.allocations[0].route,
          routeId: "pan-direct",
          provider: "pancake-v3",
          deploymentId: "pan",
          amountOutAtomic: "119",
          legs: [
            {
              ...p.allocations[0].route.legs[0],
              tokenIn: input,
              tokenOut: output,
              pool,
              selector: { case: "feePips", value: 0 },
            },
          ],
        },
      }),
    );
    p.transaction.data = expectedExecutorData(p);
    const split = await run([
      "execute",
      "--allocations",
      '[{"routeId":"r1","amountInAtomic":"37"},{"routeId":"pan-direct","amountInAtomic":"64"}]',
      "--confirm-swap",
      "yes",
    ]);
    expect(split.code).toBe(0);
    expect(split.err).toContain("Allocation 2: pan-direct");
    expect(split.err).toContain("(37 atomic)");
    expect(split.err).toContain("(64 atomic)");
    await capture("split", split);
    p = prepared();
    const interactive = await run(["execute"], rpc, "swap");
    expect(interactive.code).toBe(0);
    expect(interactive.err).toContain(
      "Type swap to sign and send this transaction:",
    );
    expect(interactive.out).toContain('"outcome":"passed"');
    expect(interactive.out).not.toContain("Type swap");
    await capture("interactive-swap", interactive);
    const priorQuotes = quoteCount;
    const priorCalls = (await calls()).length;
    await Bun.write(accountPath, "invalid account");
    const invalidAccount = await run(["trade", "--confirm-swap", "yes"]);
    expect(invalidAccount.err).toContain("invalid wallet account");
    expect(quoteCount).toBe(priorQuotes);
    expect((await calls()).length).toBe(priorCalls + 1);
    await Bun.write(accountPath, sender);
    changeAccountOnQuote = true;
    const changedAccount = await run(["trade", "--confirm-swap", "yes"]);
    expect(changedAccount.err).toContain("Wallet account changed after quote");
    expect(trace).not.toContain("PrepareExecution");
    expect(
      (await calls()).filter((call) => call.args[0] === "send"),
    ).toHaveLength(7);
    changeAccountOnQuote = false;
    enabled = false;
    await Bun.write(
      config,
      (await Bun.file(config).text()).replace(
        "execution_enabled=true",
        "execution_enabled=false",
      ),
    );
    await Bun.write(accountPath, "invalid account");
    const beforeInfo = (await calls()).length;
    for (const command of ["status", "tokens", "quote"])
      expect((await run([command])).code).toBe(0);
    expect((await calls()).length).toBe(beforeInfo);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
}, 20000);
