import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from "viem";
import { executorV2Abi } from "../../../generated/abi";
import {
  BranchSchema,
  OperationSchema,
  PlanSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import {
  PreparationStatus,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { validatePreparation } from "./execution-policy";
import { configureExecution } from "./protocols";
import { atomicV1ExecutorPlanHash } from "./protocols/atomic-v1";
import { type Receipt, verifyReceipt } from "./receipt";

type Fixture = {
  chainId: string;
  executor: string;
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountInAtomic: string;
  amountOutMinimumAtomic: string;
  deadlineUnix: string;
  branches: Array<{
    amountInAtomic: string;
    amountOutMinimumAtomic: string;
    operations: Array<{
      kind: number;
      tokenOut: string;
      feePips: number;
      tickSpacing: number;
      poolId: string;
    }>;
  }>;
  calldata: string;
  calldataKeccak: string;
  executorPlanHash: string;
};

const fixture = (await Bun.file(
  new URL("../../../contracts/fixtures/atomic-v1-plan.json", import.meta.url),
).json()) as Fixture;
const router = "0x5555555555555555555555555555555555555555";
const factory = "0x4444444444444444444444444444444444444444";
const pool = "0x3333333333333333333333333333333333333333";
const trusted = configureExecution({
  tokens: [fixture.tokenIn, fixture.tokenOut],
  atomicExecutor: {
    address: fixture.executor,
    runtimeCodeHash: `0x${"a".repeat(64)}`,
    uniswapDeployment: "uni",
  },
  deployments: {
    uni: {
      kind: "uniswap-v3",
      factory,
      router,
      fees: [500],
    },
  },
});

function preparation() {
  const operation = fixture.branches[0].operations[0];
  return create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "atomic-preparation",
    expiresAtUnix: "4102444800",
    deadlineUnix: fixture.deadlineUnix,
    tokenIn: fixture.tokenIn,
    tokenOut: fixture.tokenOut,
    amountInAtomic: fixture.amountInAtomic,
    amountOutMinimumAtomic: fixture.amountOutMinimumAtomic,
    recipient: fixture.sender,
    transaction: {
      chainId: fixture.chainId,
      from: fixture.sender,
      to: fixture.executor,
      data: fixture.calldata,
      valueAtomic: "0",
      gasLimit: "1000000",
    },
    route: {
      routeId: "uni:500",
      provider: "uniswap-v3",
      deploymentId: "uni",
      amountOutAtomic: "12",
      block: { number: "12345678", hash: `0x${"a".repeat(64)}` },
      legs: [
        {
          pool,
          tokenIn: fixture.tokenIn,
          tokenOut: operation.tokenOut,
          selector: { case: "feePips", value: operation.feePips },
        },
      ],
    },
    atomicPlan: create(PlanSchema, {
      executorPlanHash: fixture.executorPlanHash,
      chainId: fixture.chainId,
      executor: fixture.executor,
      sender: fixture.sender,
      tokenIn: fixture.tokenIn,
      tokenOut: fixture.tokenOut,
      amountInAtomic: fixture.amountInAtomic,
      amountOutMinimumAtomic: fixture.amountOutMinimumAtomic,
      deadlineUnix: fixture.deadlineUnix,
      branches: fixture.branches.map((branch) =>
        create(BranchSchema, {
          amountInAtomic: branch.amountInAtomic,
          amountOutMinimumAtomic: branch.amountOutMinimumAtomic,
          operations: branch.operations.map((op) =>
            create(OperationSchema, {
              kind: op.kind,
              tokenOut: op.tokenOut,
              feePips: op.feePips,
              tickSpacing: op.tickSpacing,
              poolId: op.poolId,
            }),
          ),
        }),
      ),
    }),
  });
}

test("Atomic V1 matches independent commitment and calldata vectors", () => {
  const branch = fixture.branches[0];
  const operation = branch.operations[0];
  expect(
    String(
      atomicV1ExecutorPlanHash({
        chainId: BigInt(fixture.chainId),
        executor: fixture.executor as `0x${string}`,
        sender: fixture.sender as `0x${string}`,
        plan: {
          tokenIn: fixture.tokenIn as `0x${string}`,
          tokenOut: fixture.tokenOut as `0x${string}`,
          amountIn: BigInt(fixture.amountInAtomic),
          minAmountOut: BigInt(fixture.amountOutMinimumAtomic),
          deadline: BigInt(fixture.deadlineUnix),
          branches: [
            {
              amountIn: BigInt(branch.amountInAtomic),
              minAmountOut: BigInt(branch.amountOutMinimumAtomic),
              operations: [
                {
                  kind: operation.kind,
                  tokenOut: operation.tokenOut as `0x${string}`,
                  fee: operation.feePips,
                  tickSpacing: operation.tickSpacing,
                  poolId: operation.poolId as `0x${string}`,
                },
              ],
            },
          ],
        },
      }),
    ),
  ).toBe(fixture.executorPlanHash);
  expect(trusted.atomicExecutor?.plan(preparation(), trusted.tokens).data).toBe(
    fixture.calldata,
  );
});

test("terminal admits exact Atomic V1 plan and rejects changed terms", () => {
  const p = preparation();
  expect(
    validatePreparation(p, fixture.sender, fixture.chainId, 50, trusted, 1),
  ).toMatchObject({ action: "swap", spender: fixture.executor });

  const changedOperation = preparation();
  const operation = changedOperation.atomicPlan?.branches[0].operations[0];
  if (!operation) throw new Error("missing operation");
  operation.feePips = 3000;
  expect(() =>
    validatePreparation(
      changedOperation,
      fixture.sender,
      fixture.chainId,
      50,
      trusted,
      1,
    ),
  ).toThrow("differs from prepared route");

  const changedId = preparation();
  if (!changedId.atomicPlan) throw new Error("missing plan");
  changedId.atomicPlan.executorPlanHash = `0x${"f".repeat(64)}`;
  expect(() =>
    validatePreparation(
      changedId,
      fixture.sender,
      fixture.chainId,
      50,
      trusted,
      1,
    ),
  ).toThrow("plan hash");
});

test("Atomic V1 receipt requires ordered exact executor events and token deltas", () => {
  const amountOut = 12n;
  const hash = `0x${"9".repeat(64)}`;
  const transferLog = (
    token: string,
    from: string,
    to: string,
    value: bigint,
  ) => ({
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }) as string[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    transactionHash: hash,
  });
  const logs = [
    transferLog(
      fixture.tokenIn,
      fixture.sender,
      fixture.executor,
      BigInt(fixture.amountInAtomic),
    ),
    transferLog(
      fixture.tokenIn,
      fixture.executor,
      pool,
      BigInt(fixture.amountInAtomic),
    ),
    transferLog(fixture.tokenOut, pool, fixture.executor, amountOut),
    {
      address: fixture.executor,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "OperationExecuted",
        args: {
          planHash: fixture.executorPlanHash as `0x${string}`,
          branchIndex: 0n,
          operationIndex: 0n,
        },
      }) as string[],
      data: encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [
          1,
          fixture.tokenIn as `0x${string}`,
          fixture.tokenOut as `0x${string}`,
          BigInt(fixture.amountInAtomic),
          amountOut,
        ],
      ),
      transactionHash: hash,
    },
    {
      address: fixture.executor,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "BranchExecuted",
        args: {
          planHash: fixture.executorPlanHash as `0x${string}`,
          branchIndex: 0n,
        },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [BigInt(fixture.amountInAtomic), amountOut],
      ),
      transactionHash: hash,
    },
    transferLog(fixture.tokenOut, fixture.executor, fixture.sender, amountOut),
    {
      address: fixture.executor,
      topics: encodeEventTopics({
        abi: executorV2Abi,
        eventName: "PlanExecuted",
        args: {
          planHash: fixture.executorPlanHash as `0x${string}`,
          caller: fixture.sender as `0x${string}`,
          tokenOut: fixture.tokenOut as `0x${string}`,
        },
      }) as string[],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [
          fixture.tokenIn as `0x${string}`,
          BigInt(fixture.amountInAtomic),
          amountOut,
        ],
      ),
      transactionHash: hash,
    },
  ];
  const receipt: Receipt = {
    transactionHash: hash,
    status: "0x1",
    logs,
  };
  const obligations = validatePreparation(
    preparation(),
    fixture.sender,
    fixture.chainId,
    50,
    trusted,
    1,
  );
  if (obligations.action !== "swap") throw new Error("missing receipt terms");
  expect(verifyReceipt(receipt, hash, obligations.receipt).outcome).toBe(
    "passed",
  );
  expect(
    verifyReceipt(
      { ...receipt, logs: logs.slice(0, -1) },
      hash,
      obligations.receipt,
    ).outcome,
  ).toBe("failed");
  const reordered = [...logs];
  [reordered[3], reordered[4]] = [reordered[4], reordered[3]];
  expect(
    verifyReceipt({ ...receipt, logs: reordered }, hash, obligations.receipt)
      .outcome,
  ).toBe("failed");
});
