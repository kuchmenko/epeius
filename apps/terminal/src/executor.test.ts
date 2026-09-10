import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  PreparationStatus,
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  executePrepared,
  expectedExecutorData,
  parseAllocations,
  type Receipt,
  type TrustedExecution,
  validatePreparation,
  verifyReceipt,
} from "./execution";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const input = addr("1"),
  middle = addr("2"),
  output = addr("3"),
  wallet = addr("7"),
  uni = addr("8"),
  pan = addr("6"),
  executor = addr("9");
const blockHash = `0x${"b".repeat(64)}`,
  hash = `0x${"a".repeat(64)}`;
const trusted: TrustedExecution = {
  tokens: [input, middle, output],
  executor: {
    address: executor,
    uniswapDeployment: "uni",
    pancakeDeployment: "pan",
  },
  deployments: {
    uni: { kind: "uniswap-v3", router: uni, fees: [500, 3000] },
    pan: { kind: "pancake-v3", router: pan, fees: [0, 2500, 10000] },
  },
};
type Vector = {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: string;
  calldata: string;
  allocations: Array<{
    venue: number;
    amountIn: string;
    hops: Array<{ tokenOut: string; fee: number }>;
  }>;
};
const fixture = (await Bun.file(
  new URL(
    "../../../contracts/fixtures/executor-calldata.json",
    import.meta.url,
  ),
).json()) as { vectors: Vector[] };
function preparation(v = fixture.vectors[2]) {
  return create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "p",
    expiresAtUnix: "4102444800",
    deadlineUnix: v.deadline,
    tokenIn: v.tokenIn,
    tokenOut: v.tokenOut,
    amountInAtomic: v.amountIn,
    amountOutMinimumAtomic: v.minAmountOut,
    recipient: wallet,
    transaction: {
      chainId: "11155111",
      from: wallet,
      to: executor,
      data: v.calldata,
      valueAtomic: "0",
      gasLimit: "3000000",
    },
    allocations: v.allocations.map((a, index) => {
      let tokenIn = v.tokenIn;
      return {
        amountInAtomic: a.amountIn,
        route: {
          routeId: `r${index}`,
          provider: a.venue === 0 ? "uniswap-v3" : "pancake-v3",
          deploymentId: a.venue === 0 ? "uni" : "pan",
          amountOutAtomic: index === 0 ? v.minAmountOut : "0",
          block: { number: "112230", hash: blockHash },
          legs: a.hops.map((h) => {
            const leg = {
              tokenIn,
              tokenOut: h.tokenOut,
              pool: addr("4"),
              selector: { case: "feePips" as const, value: h.fee },
            };
            tokenIn = h.tokenOut;
            return leg;
          }),
        },
      };
    }),
  });
}
function splitPreparation() {
  const p = preparation();
  if (!p.allocations[0].route || !p.allocations[1].route || !p.transaction)
    throw new Error("bad fixture");
  p.allocations[0].route.amountOutAtomic = "79";
  p.allocations[1].route.amountOutAtomic = "173";
  p.amountOutMinimumAtomic = "250";
  p.transaction.data = expectedExecutorData(p);
  return p;
}

test("executor encoder matches independent single/two-hop/split golden vectors", () => {
  expect(fixture.vectors).toHaveLength(3);
  for (const vector of fixture.vectors)
    expect(expectedExecutorData(preparation(vector))).toBe(vector.calldata);
});

test("executor local validation sums outputs before rounding and rejects altered plans", () => {
  const p = splitPreparation();
  if (!p.transaction) throw new Error("bad fixture");
  expect(validatePreparation(p, wallet, "11155111", 75, trusted)).toBe(
    p.transaction,
  );
  const changes: Array<(p: PrepareExecutionResponse) => void> = [
    (p) => {
      p.amountOutMinimumAtomic = "249";
    },
    (p) => {
      p.allocations[0].amountInAtomic = "38";
    },
    (p) => {
      p.allocations[0].amountInAtomic = "0";
    },
    (p) => {
      p.allocations[0].amountInAtomic = (1n << 256n).toString();
    },
    (p) => {
      p.allocations.push(p.allocations[0]);
    },
    (p) => {
      p.route = p.allocations[0].route;
    },
    (p) => {
      if (p.allocations[1].route) p.allocations[1].route.deploymentId = "uni";
    },
    (p) => {
      if (p.allocations[1].route?.block)
        p.allocations[1].route.block.number = "112231";
    },
    (p) => {
      if (p.allocations[0].route)
        p.allocations[0].route.legs[0].tokenOut = middle;
    },
    (p) => {
      if (p.transaction) p.transaction.to = uni;
    },
    (p) => {
      if (p.transaction) p.transaction.data = "0x19b5e3d5";
    },
  ];
  for (const change of changes) {
    const changed = splitPreparation();
    change(changed);
    expect(() =>
      validatePreparation(changed, wallet, "11155111", 75, trusted),
    ).toThrow();
  }
});

test("executor approvals authorize only configured executor and exact total", () => {
  const p = splitPreparation();
  p.status = PreparationStatus.APPROVAL_REQUIRED;
  p.approvalSpender = executor;
  p.approvalTransaction = create(PrepareExecutionResponseSchema, {
    transaction: p.transaction,
  }).transaction;
  if (!p.approvalTransaction) throw new Error("bad fixture");
  p.approvalTransaction.to = input;
  p.approvalTransaction.data = `0x095ea7b3${executor.slice(2).padStart(64, "0")}${101n.toString(16).padStart(64, "0")}`;
  p.transaction = undefined;
  expect(validatePreparation(p, wallet, "11155111", 75, trusted)).toBe(
    p.approvalTransaction,
  );
  p.approvalSpender = uni;
  expect(() =>
    validatePreparation(p, wallet, "11155111", 75, trusted),
  ).toThrow();
});

const transfer = (
  token: string,
  from: string,
  to: string,
  amount: bigint,
): Receipt["logs"][number] => ({
  address: token,
  transactionHash: hash,
  topics: [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    `0x${from.slice(2).padStart(64, "0")}`,
    `0x${to.slice(2).padStart(64, "0")}`,
  ],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
});
function receipt(): Receipt {
  return {
    transactionHash: hash,
    status: "0x1",
    logs: [
      transfer(input, wallet, executor, 101n),
      transfer(input, executor, addr("4"), 101n),
      transfer(output, addr("4"), executor, 252n),
      transfer(output, executor, wallet, 252n),
    ],
  };
}

test("executor receipts reject dust changes at wallet, executor and each venue", () => {
  const p = splitPreparation();
  expect(verifyReceipt(receipt(), hash, p, trusted).outcome).toBe("passed");
  expect(verifyReceipt(receipt(), hash, p).outcome).toBe("unavailable");
  for (const [token, owner] of [
    [input, executor],
    [output, executor],
    [middle, executor],
    [middle, wallet],
    [input, uni],
    [output, uni],
    [input, pan],
    [middle, pan],
    [output, pan],
  ]) {
    for (const reversed of [false, true]) {
      const r = receipt();
      r.logs.push(
        transfer(
          token,
          reversed ? addr("4") : owner,
          reversed ? owner : addr("4"),
          1n,
        ),
      );
      expect(verifyReceipt(r, hash, p, trusted).outcome).toBe("failed");
    }
  }
});

test("executor recheck cannot change allocation terms and unknown send never retries", async () => {
  for (const change of [false, true]) {
    let sent = 0;
    const p = splitPreparation();
    const run = executePrepared({
      signer: wallet,
      expectedChainId: "11155111",
      slippageBps: 75,
      trusted,
      chainId: async () => "0xaa36a7",
      prepare: async (id) => {
        if (!id) return p;
        const q = splitPreparation();
        if (change) q.allocations[0].amountInAtomic = "36";
        return q;
      },
      confirm: async () => true,
      send: async () => {
        sent++;
        throw new Error("unknown");
      },
      receipt: async () => receipt(),
      report: () => {},
    });
    if (change) {
      await expect(run).rejects.toThrow();
      expect(sent).toBe(0);
    } else {
      expect(await run).toBe(1);
      expect(sent).toBe(1);
    }
  }
});

test("allocation CLI input is explicit positive uint256 JSON, not percentages", () => {
  expect(
    parseAllocations(
      '[{"routeId":"uni:500","amountInAtomic":"37"},{"routeId":"pan:0","amountInAtomic":"64"}]',
    ),
  ).toHaveLength(2);
  for (const value of [
    "[]",
    "null",
    "[null]",
    '[{"routeId":"x","amountInAtomic":37}]',
    '[{"routeId":"x","amountInAtomic":"0"}]',
    '[{"routeId":"x","amountInAtomic":"37","percent":37}]',
  ])
    expect(() => parseAllocations(value)).toThrow();
});
