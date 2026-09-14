import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  hexToBytes,
} from "viem";
import { executorV2Abi } from "../../../generated/abi";
import {
  AcceptedPlanTermsSchema,
  BranchSchema,
  ExecutorIdentitySchema,
  OperationSchema,
  PinnedBlockSchema,
  PlanBranchSchema,
  PlanProgramSchema,
  PlanSchema,
  PoolOperationSchema,
  V3PoolSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import {
  PreparationStatus,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { validatePreparation } from "./execution-policy";
import { configureExecution } from "./protocols";
import {
  atomicV1ExecutorPlanHash,
  atomicV1PlanId,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";
import { type Receipt, verifyReceipt } from "./receipt";

type Fixture = {
  chainId: string;
  executor: string;
  sender: string;
  runtimeCodeHash: string;
  factory: string;
  router: string;
  pool?: string;
  pools?: string[];
  tokenIn: string;
  intermediateToken?: string;
  tokenOut: string;
  amountInAtomic: string;
  amountOutMinimumAtomic: string;
  deadlineUnix: string;
  expiresAtUnix: string;
  quoteBlockNumber: string;
  quoteBlockHash: string;
  gasLimit: string;
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
  branchHash: string;
  planId: string;
  transactionFingerprint: string;
};

const fixture = (await Bun.file(
  new URL("../../../contracts/fixtures/atomic-v1-plan.json", import.meta.url),
).json()) as Fixture;
const twoHopFixture = (await Bun.file(
  new URL(
    "../../../contracts/fixtures/atomic-v1-two-hop-plan.json",
    import.meta.url,
  ),
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

const twoHopTrusted = configureExecution({
  tokens: [
    twoHopFixture.tokenIn,
    twoHopFixture.intermediateToken ?? "",
    twoHopFixture.tokenOut,
  ],
  atomicExecutor: {
    address: twoHopFixture.executor,
    runtimeCodeHash: twoHopFixture.runtimeCodeHash,
    uniswapDeployment: "uni",
  },
  deployments: {
    uni: {
      kind: "uniswap-v3",
      factory: twoHopFixture.factory,
      router: twoHopFixture.router,
      fees: twoHopFixture.branches[0].operations.map(
        (operation) => operation.feePips,
      ),
    },
  },
});

function preparation(source = fixture) {
  const pools = source.pools ?? [source.pool ?? ""];
  let currentToken = source.tokenIn;
  return create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "atomic-preparation",
    expiresAtUnix: source.expiresAtUnix,
    deadlineUnix: source.deadlineUnix,
    tokenIn: source.tokenIn,
    tokenOut: source.tokenOut,
    amountInAtomic: source.amountInAtomic,
    amountOutMinimumAtomic: source.amountOutMinimumAtomic,
    recipient: source.sender,
    transaction: {
      chainId: source.chainId,
      from: source.sender,
      to: source.executor,
      data: source.calldata,
      valueAtomic: "0",
      gasLimit: source.gasLimit,
    },
    route: {
      routeId: "uni:500",
      provider: "uniswap-v3",
      deploymentId: "uni",
      amountOutAtomic: "12",
      block: { number: source.quoteBlockNumber, hash: source.quoteBlockHash },
      legs: source.branches[0].operations.map((operation, i) => {
        const leg = {
          pool: pools[i],
          tokenIn: currentToken,
          tokenOut: operation.tokenOut,
          selector: { case: "feePips" as const, value: operation.feePips },
        };
        currentToken = operation.tokenOut;
        return leg;
      }),
    },
    atomicPlan: create(PlanSchema, {
      executorPlanHash: source.executorPlanHash,
      chainId: source.chainId,
      executor: source.executor,
      sender: source.sender,
      tokenIn: source.tokenIn,
      tokenOut: source.tokenOut,
      amountInAtomic: source.amountInAtomic,
      amountOutMinimumAtomic: source.amountOutMinimumAtomic,
      deadlineUnix: source.deadlineUnix,
      planId: hexToBytes(source.planId as `0x${string}`),
      transactionFingerprint: hexToBytes(
        source.transactionFingerprint as `0x${string}`,
      ),
      acceptedTerms: create(AcceptedPlanTermsSchema, {
        program: create(PlanProgramSchema, {
          formatVersion: 1,
          chainId: uintBytes(source.chainId),
          tokenIn: hexToBytes(source.tokenIn as `0x${string}`),
          tokenOut: hexToBytes(source.tokenOut as `0x${string}`),
          amountIn: uintBytes(source.amountInAtomic),
          branches: [
            create(PlanBranchSchema, {
              amountIn: uintBytes(source.amountInAtomic),
              operations: source.branches[0].operations.map((operation, i) =>
                create(PoolOperationSchema, {
                  tokenIn: hexToBytes(
                    (i === 0
                      ? source.tokenIn
                      : source.branches[0].operations[i - 1]
                          .tokenOut) as `0x${string}`,
                  ),
                  tokenOut: hexToBytes(operation.tokenOut as `0x${string}`),
                  pool: {
                    case: "uniswapV3",
                    value: create(V3PoolSchema, {
                      factory: hexToBytes(source.factory as `0x${string}`),
                      router: hexToBytes(source.router as `0x${string}`),
                      pool: hexToBytes(pools[i] as `0x${string}`),
                      feePips: operation.feePips,
                    }),
                  },
                }),
              ),
            }),
          ],
        }),
        executor: create(ExecutorIdentitySchema, {
          address: hexToBytes(source.executor as `0x${string}`),
          version: 2,
          runtimeCodeHash: hexToBytes(source.runtimeCodeHash as `0x${string}`),
        }),
        signer: hexToBytes(source.sender as `0x${string}`),
        recipient: hexToBytes(source.sender as `0x${string}`),
        branchMinima: [uintBytes(source.amountOutMinimumAtomic)],
        amountOutMinimum: uintBytes(source.amountOutMinimumAtomic),
        quoteBlock: create(PinnedBlockSchema, {
          number: uintBytes(source.quoteBlockNumber),
          hash: hexToBytes(source.quoteBlockHash as `0x${string}`),
        }),
        expiresAtUnix: uintBytes(source.expiresAtUnix),
        deadlineUnix: uintBytes(source.deadlineUnix),
      }),
      branches: source.branches.map((branch) =>
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

function uintBytes(value: string) {
  return hexToBytes(`0x${BigInt(value).toString(16).padStart(64, "0")}`);
}

function accepted(p: ReturnType<typeof preparation>) {
  const terms = p.atomicPlan?.acceptedTerms;
  if (!terms?.program || !terms.executor || !terms.quoteBlock)
    throw new Error("missing accepted terms");
  return {
    terms,
    program: terms.program,
    executor: terms.executor,
    quoteBlock: terms.quoteBlock,
  };
}

function acceptedPool(p: ReturnType<typeof preparation>) {
  const operation = accepted(p).program.branches[0]?.operations[0];
  if (
    operation?.pool.case !== "uniswapV3" ||
    !operation.pool.value.factory ||
    !operation.pool.value.pool
  )
    throw new Error("missing accepted pool");
  return operation.pool.value;
}

function transaction(p: ReturnType<typeof preparation>) {
  if (!p.transaction) throw new Error("missing transaction");
  return p.transaction;
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
  expect(
    atomicV1PlanId({
      chainId: BigInt(fixture.chainId),
      executor: fixture.executor as `0x${string}`,
      runtimeCodeHash: fixture.runtimeCodeHash as `0x${string}`,
      signer: fixture.sender as `0x${string}`,
      recipient: fixture.sender as `0x${string}`,
      tokenIn: fixture.tokenIn as `0x${string}`,
      tokenOut: fixture.tokenOut as `0x${string}`,
      amountIn: BigInt(fixture.amountInAtomic),
      minimum: BigInt(fixture.amountOutMinimumAtomic),
      quoteBlockNumber: BigInt(fixture.quoteBlockNumber),
      quoteBlockHash: fixture.quoteBlockHash as `0x${string}`,
      expiresAt: BigInt(fixture.expiresAtUnix),
      deadline: BigInt(fixture.deadlineUnix),
      branchHashes: [fixture.branchHash as `0x${string}`],
    }),
  ).toBe(fixture.planId as `0x${string}`);
  expect(
    atomicV1TransactionFingerprint({
      planId: fixture.planId as `0x${string}`,
      chainId: BigInt(fixture.chainId),
      from: fixture.sender as `0x${string}`,
      to: fixture.executor as `0x${string}`,
      value: 0n,
      data: fixture.calldata as `0x${string}`,
      gasLimit: BigInt(fixture.gasLimit),
    }),
  ).toBe(fixture.transactionFingerprint as `0x${string}`);
  expect(trusted.atomicExecutor?.plan(preparation(), trusted.tokens).data).toBe(
    fixture.calldata,
  );
});

test("Atomic V1 consent and transaction identities reject each changed field", () => {
  const mutations: Array<
    [string, (p: ReturnType<typeof preparation>) => void]
  > = [
    [
      "quote block",
      (p) => {
        accepted(p).quoteBlock.number = uintBytes("12345679");
      },
    ],
    [
      "runtime hash",
      (p) => {
        const executor = accepted(p).executor;
        if (!executor.runtimeCodeHash) throw new Error("missing runtime hash");
        executor.runtimeCodeHash[0] ^= 1;
      },
    ],
    [
      "provider factory",
      (p) => {
        const pool = acceptedPool(p);
        if (!pool.factory) throw new Error("missing factory");
        pool.factory[0] ^= 1;
      },
    ],
    [
      "pool identity",
      (p) => {
        const pool = acceptedPool(p);
        if (!pool.pool) throw new Error("missing pool");
        pool.pool[0] ^= 1;
      },
    ],
    [
      "branch minimum",
      (p) => {
        accepted(p).terms.branchMinima[0] = uintBytes("10");
      },
    ],
    [
      "aggregate minimum",
      (p) => {
        accepted(p).terms.amountOutMinimum = uintBytes("10");
      },
    ],
    [
      "expiry",
      (p) => {
        accepted(p).terms.expiresAtUnix = uintBytes("1999999899");
      },
    ],
    [
      "deadline",
      (p) => {
        accepted(p).terms.deadlineUnix = uintBytes("1999999999");
      },
    ],
    [
      "calldata",
      (p) => {
        const tx = transaction(p);
        tx.data = `${tx.data.slice(0, -2)}01`;
      },
    ],
    [
      "target",
      (p) => {
        transaction(p).to = "0x0000000000000000000000000000000000000066";
      },
    ],
    [
      "gas limit",
      (p) => {
        transaction(p).gasLimit = "999999";
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const p = preparation();
    mutate(p);
    expect(
      () =>
        validatePreparation(p, fixture.sender, fixture.chainId, 50, trusted, 1),
      name,
    ).toThrow();
  }

  const unknown = preparation();
  const operation = accepted(unknown).program.branches[0]?.operations[0];
  if (!operation) throw new Error("missing operation");
  operation.$unknown = [{ no: 99, wireType: 0, data: new Uint8Array() }];
  expect(() =>
    validatePreparation(
      unknown,
      fixture.sender,
      fixture.chainId,
      50,
      trusted,
      1,
    ),
  ).toThrow("unsupported fields");
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

test("Atomic V1 admits independent two-hop vectors and binds operation order", () => {
  const p = preparation(twoHopFixture);
  const result = validatePreparation(
    p,
    twoHopFixture.sender,
    twoHopFixture.chainId,
    50,
    twoHopTrusted,
    1,
  );
  expect(result).toMatchObject({
    action: "swap",
    transaction: { data: twoHopFixture.calldata },
    receipt: {
      atomicPlan: {
        planHash: twoHopFixture.executorPlanHash,
        planId: twoHopFixture.planId,
        transactionFingerprint: twoHopFixture.transactionFingerprint,
        operations: [
          { tokenIn: twoHopFixture.tokenIn },
          { tokenIn: twoHopFixture.intermediateToken },
        ],
      },
    },
  });

  const reordered = preparation(twoHopFixture);
  const operations = accepted(reordered).program.branches[0]?.operations;
  if (operations?.length !== 2) throw new Error("missing operations");
  [operations[0], operations[1]] = [operations[1], operations[0]];
  expect(() =>
    validatePreparation(
      reordered,
      twoHopFixture.sender,
      twoHopFixture.chainId,
      50,
      twoHopTrusted,
      1,
    ),
  ).toThrow();

  const repeatedPool = preparation(twoHopFixture);
  if (!repeatedPool.route) throw new Error("missing route");
  repeatedPool.route.legs[1].pool = repeatedPool.route.legs[0].pool;
  expect(() =>
    validatePreparation(
      repeatedPool,
      twoHopFixture.sender,
      twoHopFixture.chainId,
      50,
      twoHopTrusted,
      1,
    ),
  ).toThrow("distinct pools");
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

test("Atomic V1 receipt proves measured two-hop chaining and exact event cardinality", () => {
  const hash = `0x${"8".repeat(64)}`;
  const intermediateAmount = 83n;
  const outputAmount = 12n;
  const pools = twoHopFixture.pools ?? [];
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
  const executorEvent = (
    name: "OperationExecuted" | "BranchExecuted" | "PlanExecuted",
    topics: Record<string, unknown>,
    parameters: readonly { type: string }[],
    values: readonly unknown[],
  ) => ({
    address: twoHopFixture.executor,
    topics: encodeEventTopics({
      abi: executorV2Abi,
      eventName: name,
      args: topics,
    }) as string[],
    data: encodeAbiParameters(parameters, values),
    transactionHash: hash,
  });
  const operation = (
    index: bigint,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOut: bigint,
  ) =>
    executorEvent(
      "OperationExecuted",
      {
        planHash: twoHopFixture.executorPlanHash,
        branchIndex: 0n,
        operationIndex: index,
      },
      [
        { type: "uint8" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [1, tokenIn, tokenOut, amountIn, amountOut],
    );
  const logs = [
    transferLog(
      twoHopFixture.tokenIn,
      twoHopFixture.sender,
      twoHopFixture.executor,
      37n,
    ),
    transferLog(twoHopFixture.tokenIn, twoHopFixture.executor, pools[0], 37n),
    transferLog(
      twoHopFixture.intermediateToken ?? "",
      pools[0],
      twoHopFixture.executor,
      intermediateAmount,
    ),
    operation(
      0n,
      twoHopFixture.tokenIn,
      twoHopFixture.intermediateToken ?? "",
      37n,
      intermediateAmount,
    ),
    transferLog(
      twoHopFixture.intermediateToken ?? "",
      twoHopFixture.executor,
      pools[1],
      intermediateAmount,
    ),
    transferLog(
      twoHopFixture.tokenOut,
      pools[1],
      twoHopFixture.executor,
      outputAmount,
    ),
    operation(
      1n,
      twoHopFixture.intermediateToken ?? "",
      twoHopFixture.tokenOut,
      intermediateAmount,
      outputAmount,
    ),
    executorEvent(
      "BranchExecuted",
      { planHash: twoHopFixture.executorPlanHash, branchIndex: 0n },
      [{ type: "uint256" }, { type: "uint256" }],
      [37n, outputAmount],
    ),
    transferLog(
      twoHopFixture.tokenOut,
      twoHopFixture.executor,
      twoHopFixture.sender,
      outputAmount,
    ),
    executorEvent(
      "PlanExecuted",
      {
        planHash: twoHopFixture.executorPlanHash,
        caller: twoHopFixture.sender,
        tokenOut: twoHopFixture.tokenOut,
      },
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [twoHopFixture.tokenIn, 37n, outputAmount],
    ),
  ];
  const obligations = validatePreparation(
    preparation(twoHopFixture),
    twoHopFixture.sender,
    twoHopFixture.chainId,
    50,
    twoHopTrusted,
    1,
  );
  if (obligations.action !== "swap") throw new Error("missing receipt terms");
  const receipt: Receipt = { transactionHash: hash, status: "0x1", logs };
  expect(verifyReceipt(receipt, hash, obligations.receipt).outcome).toBe(
    "passed",
  );

  const wrongInput = [...logs];
  wrongInput[6] = operation(
    1n,
    twoHopFixture.intermediateToken ?? "",
    twoHopFixture.tokenOut,
    12n,
    outputAmount,
  );
  expect(
    verifyReceipt({ ...receipt, logs: wrongInput }, hash, obligations.receipt)
      .outcome,
  ).toBe("failed");
  for (const changed of [
    logs.filter((_, i) => i !== 6),
    [...logs.slice(0, 7), logs[6], ...logs.slice(7)],
    [
      ...logs.slice(0, 3),
      logs[6],
      ...logs.slice(4, 6),
      logs[3],
      ...logs.slice(7),
    ],
  ]) {
    expect(
      verifyReceipt({ ...receipt, logs: changed }, hash, obligations.receipt)
        .outcome,
    ).toBe("failed");
  }
});
