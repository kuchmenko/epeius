import { create, equals, toBinary } from "@bufbuild/protobuf";
import {
  type Address,
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBytes,
  isHash,
  padHex,
  size,
  toHex,
  zeroHash,
} from "viem";
import {
  AcceptedPlanTermsSchema,
  type PlanCandidate,
  PlanPreparationStatus,
  type PoolOperation,
  type PreparePlanResponse,
  SimulationStatus,
  UnsignedPreparationSchema,
} from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import {
  type UnsignedTransaction,
  UnsignedTransactionSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import {
  type AtomicExecutorPlan,
  atomicV1AcceptedBranchHashes,
  atomicV1ExecutorCalldata,
  atomicV1ExecutorPlanHash,
  atomicV1PlanId,
  atomicV1TransactionFingerprint,
} from "./protocols/atomic-v1";
import type { ReceiptObligations } from "./receipt";

const exact = (value: Uint8Array | undefined, width: number, label: string) => {
  if (!value || value.length !== width)
    throw new Error(`Atomic V1 ${label} has the wrong width.`);
  return bytesToHex(value);
};
const uint = (value: Uint8Array | undefined, label: string) =>
  BigInt(exact(value, 32, label));
const word = (value: bigint) => hexToBytes(padHex(toHex(value), { size: 32 }));
const addressBytes = (value: string) => hexToBytes(getAddress(value));
const same = (left: Uint8Array | undefined, right: Uint8Array | undefined) =>
  !!left && !!right && bytesToHex(left) === bytesToHex(right);

function rejectUnknown(value: unknown) {
  if (!value || typeof value !== "object" || value instanceof Uint8Array)
    return;
  const message = value as { $unknown?: unknown[] };
  if (message.$unknown?.length)
    throw new Error("Atomic V1 preparation contains unsupported fields.");
  for (const child of Object.values(value)) rejectUnknown(child);
}

export type AtomicExecutorIdentity = {
  address: string;
  runtimeCodeHash: string;
  factory: string;
  router: string;
  pancakeFactory?: string;
  pancakeRouter?: string;
};

const operationV3 = (operation: PoolOperation) => {
  if (operation.pool.case === "uniswapV3")
    return { pool: operation.pool.value, kind: 1 };
  if (operation.pool.case === "pancakeV3")
    return { pool: operation.pool.value, kind: 2 };
  throw new Error("Atomic V1 operation is unsupported.");
};

export function acceptAtomicCandidate(
  candidate: PlanCandidate,
  signer: string,
  executor: AtomicExecutorIdentity,
  slippageBps: number,
  nowUnix = BigInt(Math.floor(Date.now() / 1000)),
) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9999)
    throw new Error("--slippage-bps must be 0 through 9999.");
  const program = candidate.program;
  const quoteBlock = candidate.quoteBlock;
  const quote = candidate.branchQuotes[0];
  if (!program || !quoteBlock || program.branches.length !== 1 || !quote)
    throw new Error("Atomic V1 candidate is incomplete.");
  const branch = program.branches[0];
  if (
    branch.operations.length < 1 ||
    branch.operations.length > 2 ||
    quote.operationOutputs.length !== branch.operations.length
  )
    throw new Error("Atomic V1 candidate path is unsupported.");
  const finalOutput = uint(
    quote.operationOutputs.at(-1),
    "candidate final output",
  );
  const minimum = (finalOutput * BigInt(10000 - slippageBps)) / 10000n;
  if (minimum <= 0n)
    throw new Error("Atomic V1 minimum output must be positive.");
  const localExecutor = getAddress(executor.address);
  const first = operationV3(branch.operations[0]);
  const localFactory = getAddress(
    first.kind === 1 ? executor.factory : (executor.pancakeFactory ?? ""),
  );
  const localRouter = getAddress(
    first.kind === 1 ? executor.router : (executor.pancakeRouter ?? ""),
  );
  const runtimeCodeHash = executor.runtimeCodeHash as `0x${string}`;
  if (!isHash(runtimeCodeHash))
    throw new Error("Local Atomic V1 runtime hash is invalid.");
  for (const operation of branch.operations) {
    const { pool, kind } = operationV3(operation);
    if (
      kind !== first.kind ||
      pool.feePips === undefined ||
      getAddress(exact(pool.factory, 20, "factory")) !== localFactory ||
      getAddress(exact(pool.router, 20, "router")) !== localRouter
    )
      throw new Error("Atomic V1 candidate differs from local deployment.");
  }
  const expiresAt = nowUnix + 25n;
  const deadline = nowUnix + 120n;
  const terms = create(AcceptedPlanTermsSchema, {
    program,
    executor: {
      address: addressBytes(localExecutor),
      version: 2,
      runtimeCodeHash: hexToBytes(runtimeCodeHash),
    },
    signer: addressBytes(signer),
    recipient: addressBytes(signer),
    branchMinima: [word(minimum)],
    amountOutMinimum: word(minimum),
    quoteBlock,
    expiresAtUnix: word(expiresAt),
    deadlineUnix: word(deadline),
  });
  const branchHashes = atomicV1AcceptedBranchHashes(program, [minimum]);
  const planId = atomicV1PlanId({
    chainId: uint(program.chainId, "chain ID"),
    executor: localExecutor,
    runtimeCodeHash,
    signer: getAddress(signer),
    recipient: getAddress(signer),
    tokenIn: getAddress(exact(program.tokenIn, 20, "input token")),
    tokenOut: getAddress(exact(program.tokenOut, 20, "output token")),
    amountIn: uint(program.amountIn, "input amount"),
    minimum,
    quoteBlockNumber: uint(quoteBlock.number, "quote block number"),
    quoteBlockHash: exact(quoteBlock.hash, 32, "quote block hash"),
    expiresAt,
    deadline,
    branchHashes,
  });
  return { terms, planId, minimum, finalOutput, expiresAt, deadline };
}

export function validateAtomicPlanPreparation(
  response: PreparePlanResponse,
  expected: ReturnType<typeof acceptAtomicCandidate>,
  executor: AtomicExecutorIdentity,
) {
  rejectUnknown(response);
  if (
    response.status === undefined ||
    !Object.values(PlanPreparationStatus).includes(response.status)
  )
    throw new Error("Atomic V1 preparation status is absent or unknown.");
  const program = expected.terms.program;
  if (!program) throw new Error("Atomic V1 accepted program is absent.");
  const signer = getAddress(exact(expected.terms.signer, 20, "signer"));
  const executorAddress = getAddress(executor.address);
  const amountIn = uint(program.amountIn, "input amount");
  if (response.status === PlanPreparationStatus.APPROVAL_REQUIRED) {
    if (response.preparation || response.simulation || !response.approval)
      throw new Error("Atomic V1 approval response contains swap preparation.");
    const approval = response.approval;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [executorAddress, amountIn],
    });
    const transaction = approval.transaction;
    if (
      !same(approval.token, program.tokenIn) ||
      getAddress(exact(approval.spender, 20, "approval spender")) !==
        executorAddress ||
      uint(approval.amount, "approval amount") !== amountIn ||
      !transaction ||
      uint(transaction.chainId, "approval chain ID") !==
        uint(program.chainId, "chain ID") ||
      getAddress(exact(transaction.from, 20, "approval sender")) !== signer ||
      !same(transaction.to, program.tokenIn) ||
      bytesToHex(transaction.data ?? new Uint8Array()) !== data ||
      uint(transaction.value, "approval value") !== 0n ||
      uint(transaction.gasLimit, "approval gas limit") <= 0n
    )
      throw new Error("Atomic V1 approval transaction is invalid.");
    return {
      kind: "approval" as const,
      transaction: wireTransaction(transaction),
    };
  }
  if (
    response.status !== PlanPreparationStatus.READY ||
    !response.preparation ||
    !response.simulation ||
    response.approval
  )
    throw new Error(response.message || "Atomic V1 plan is not ready.");
  const preparation = response.preparation;
  const simulation = response.simulation;
  if (
    exact(preparation.preparationId, 32, "preparation ID") === zeroHash ||
    exact(preparation.planId, 32, "plan ID") !== expected.planId ||
    !preparation.terms ||
    !equals(AcceptedPlanTermsSchema, preparation.terms, expected.terms) ||
    !preparation.transaction
  )
    throw new Error(
      "Atomic V1 unsigned preparation differs from accepted terms.",
    );
  const executorPlan = executorPlanFromTerms(expected.terms);
  const expectedData = atomicV1ExecutorCalldata(executorPlan);
  const transaction = preparation.transaction;
  const chainId = uint(program.chainId, "chain ID");
  if (
    uint(transaction.chainId, "transaction chain ID") !== chainId ||
    getAddress(exact(transaction.from, 20, "transaction sender")) !== signer ||
    getAddress(exact(transaction.to, 20, "transaction target")) !==
      executorAddress ||
    !transaction.data ||
    size(bytesToHex(transaction.data)) === 0 ||
    bytesToHex(transaction.data) !== expectedData ||
    uint(transaction.value, "transaction value") !== 0n ||
    uint(transaction.gasLimit, "transaction gas limit") <= 0n
  )
    throw new Error("Atomic V1 unsigned transaction is invalid.");
  const executorPlanHash = atomicV1ExecutorPlanHash({
    chainId,
    executor: executorAddress,
    sender: signer,
    plan: executorPlan,
  });
  const fingerprint = atomicV1TransactionFingerprint({
    planId: expected.planId,
    chainId,
    from: signer,
    to: executorAddress,
    value: 0n,
    data: expectedData,
    gasLimit: uint(transaction.gasLimit, "transaction gas limit"),
  });
  if (
    !same(simulation.planId, preparation.planId) ||
    !same(simulation.preparationId, preparation.preparationId) ||
    exact(simulation.transactionFingerprint, 32, "transaction fingerprint") !==
      fingerprint ||
    simulation.status !== SimulationStatus.PASSED ||
    !simulation.block ||
    uint(simulation.block.number, "simulation block number") <= 0n ||
    !isHash(exact(simulation.block.hash, 32, "simulation block hash")) ||
    uint(simulation.observedAtUnix, "simulation observed time") <= 0n ||
    simulation.branchResults.length !== 1 ||
    simulation.branchResults[0].operationOutputs.length !==
      program.branches[0].operations.length
  )
    throw new Error("Atomic V1 simulation evidence is incomplete.");
  const outputs = simulation.branchResults[0].operationOutputs.map((value) =>
    uint(value, "measured operation output"),
  );
  const finalOutput = outputs.at(-1);
  if (
    !finalOutput ||
    outputs.some((value) => value <= 0n) ||
    finalOutput < expected.minimum
  )
    throw new Error("Atomic V1 measured output does not meet accepted minima.");
  return {
    kind: "swap" as const,
    preparation,
    frozen: toBinary(UnsignedPreparationSchema, preparation),
    transaction: wireTransaction(transaction),
    planId: expected.planId,
    executorPlanHash,
    transactionFingerprint: fingerprint,
    outputs,
    receipt: receiptObligations(
      expected,
      executorAddress,
      executorPlanHash,
      fingerprint,
    ),
  };
}

export function assertAtomicPlanRecheck(
  response: PreparePlanResponse,
  initial: Extract<
    ReturnType<typeof validateAtomicPlanPreparation>,
    { kind: "swap" }
  >,
  expected: ReturnType<typeof acceptAtomicCandidate>,
  executor: AtomicExecutorIdentity,
) {
  const checked = validateAtomicPlanPreparation(response, expected, executor);
  if (
    checked.kind !== "swap" ||
    !equals(
      UnsignedPreparationSchema,
      checked.preparation,
      initial.preparation,
    ) ||
    bytesToHex(checked.frozen) !== bytesToHex(initial.frozen)
  )
    throw new Error("Atomic V1 recheck changed frozen preparation.");
  return checked;
}

function executorPlanFromTerms(
  terms: ReturnType<typeof acceptAtomicCandidate>["terms"],
): AtomicExecutorPlan {
  const program = terms.program;
  if (!program) throw new Error("Atomic V1 accepted program is absent.");
  const branch = program.branches[0];
  return {
    tokenIn: getAddress(exact(program.tokenIn, 20, "input token")),
    tokenOut: getAddress(exact(program.tokenOut, 20, "output token")),
    amountIn: uint(program.amountIn, "input amount"),
    minAmountOut: uint(terms.amountOutMinimum, "aggregate minimum"),
    deadline: uint(terms.deadlineUnix, "deadline"),
    branches: [
      {
        amountIn: uint(branch.amountIn, "branch input"),
        minAmountOut: uint(terms.branchMinima[0], "branch minimum"),
        operations: branch.operations.map((operation) => {
          const { pool, kind } = operationV3(operation);
          if (pool.feePips === undefined)
            throw new Error("Atomic V1 operation is unsupported.");
          return {
            kind,
            tokenOut: getAddress(
              exact(operation.tokenOut, 20, "operation output"),
            ),
            fee: pool.feePips,
            tickSpacing: 0,
            poolId: zeroHash,
          };
        }),
      },
    ],
  };
}

function wireTransaction(
  transaction: NonNullable<PreparePlanResponse["preparation"]>["transaction"],
): UnsignedTransaction {
  if (!transaction) throw new Error("Atomic V1 transaction is absent.");
  return create(UnsignedTransactionSchema, {
    chainId: uint(transaction.chainId, "transaction chain ID").toString(),
    from: exact(transaction.from, 20, "transaction sender"),
    to: exact(transaction.to, 20, "transaction target"),
    data: bytesToHex(transaction.data ?? new Uint8Array()),
    valueAtomic: uint(transaction.value, "transaction value").toString(),
    gasLimit: uint(transaction.gasLimit, "transaction gas limit").toString(),
  });
}

function receiptObligations(
  expected: ReturnType<typeof acceptAtomicCandidate>,
  executor: Address,
  planHash: `0x${string}`,
  fingerprint: `0x${string}`,
): ReceiptObligations {
  const program = expected.terms.program;
  if (!program) throw new Error("Atomic V1 accepted program is absent.");
  const operations = program.branches[0].operations;
  const first = operationV3(operations[0]);
  const router = getAddress(exact(first.pool.router, 20, "router"));
  const tokenIn = exact(program.tokenIn, 20, "input token");
  const tokenOut = exact(program.tokenOut, 20, "output token");
  return {
    tokenIn,
    tokenOut,
    recipient: exact(expected.terms.recipient, 20, "recipient"),
    amountInAtomic: uint(program.amountIn, "input amount").toString(),
    amountOutMinimumAtomic: expected.minimum.toString(),
    intermediate: operations.slice(0, -1).map((operation) => ({
      token: exact(operation.tokenOut, 20, "intermediate token"),
      owner: router,
    })),
    touched: [
      tokenIn,
      ...operations.map((operation) =>
        exact(operation.tokenOut, 20, "operation output"),
      ),
    ].flatMap((token) => [
      { token, owner: executor },
      { token, owner: router },
    ]),
    atomicPlan: {
      executor,
      planHash,
      planId: expected.planId,
      transactionFingerprint: fingerprint,
      branches: [
        {
          amountInAtomic: uint(
            program.branches[0].amountIn,
            "branch input",
          ).toString(),
          minimumAtomic: expected.minimum.toString(),
          operations: operations.map((operation) => {
            const { kind } = operationV3(operation);
            return {
              kind,
              tokenIn: exact(operation.tokenIn, 20, "operation input"),
              tokenOut: exact(operation.tokenOut, 20, "operation output"),
            };
          }),
        },
      ],
    },
  };
}
