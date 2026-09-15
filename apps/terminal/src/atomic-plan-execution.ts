import { create, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  hexToBytes,
  isHash,
  padHex,
  size,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  AcceptedPlanTermsSchema,
  type PlanCandidate,
  PlanPreparationStatus,
  type PoolOperation,
  type PreparePlanResponse,
  PreparePlanResponseSchema,
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
  maxBranches: number;
  maxOperationsPerBranch: number;
  maxTotalOperations: number;
  factory?: string;
  router?: string;
  pancakeFactory?: string;
  pancakeRouter?: string;
  slipstreamFactory?: string;
  slipstreamRouter?: string;
  balancerVault?: string;
  balancerPools?: string[];
  balancerPoolsHash?: string;
  universalRouter?: string;
  permit2?: string;
  poolManager?: string;
  uniswapV4Pools?: Array<{
    currency0: string;
    currency1: string;
    feePips: number;
    tickSpacing: number;
    hooks: string;
  }>;
};

const operationPool = (operation: PoolOperation) => {
  if (operation.pool.case === "uniswapV3")
    return {
      pool: operation.pool.value,
      kind: 1 as const,
      fee: operation.pool.value.feePips,
      tickSpacing: 0,
    };
  if (operation.pool.case === "pancakeV3")
    return {
      pool: operation.pool.value,
      kind: 2 as const,
      fee: operation.pool.value.feePips,
      tickSpacing: 0,
    };
  if (operation.pool.case === "slipstreamInitial")
    return {
      pool: operation.pool.value,
      kind: 3 as const,
      fee: 0,
      tickSpacing: operation.pool.value.tickSpacing,
    };
  if (operation.pool.case === "balancerV2")
    return {
      pool: operation.pool.value,
      kind: 4 as const,
      fee: 0,
      tickSpacing: 0,
      poolId: exact(operation.pool.value.poolId, 32, "Balancer pool ID"),
    };
  if (operation.pool.case === "uniswapV4")
    return {
      pool: operation.pool.value,
      kind: 5 as const,
      fee: operation.pool.value.key?.feePips,
      tickSpacing: operation.pool.value.key?.tickSpacing,
    };
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
  const isBalancer = branch.operations[0]?.pool.case === "balancerV2";
  const isV4 = branch.operations[0]?.pool.case === "uniswapV4";
  if (
    branch.operations.length < 1 ||
    branch.operations.length > 2 ||
    ((isBalancer || isV4) && branch.operations.length !== 1) ||
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
  const first = operationPool(branch.operations[0]);
  const localFactory =
    first.kind === 4 || first.kind === 5
      ? undefined
      : getAddress(
          first.kind === 1
            ? (executor.factory ?? "")
            : first.kind === 2
              ? (executor.pancakeFactory ?? "")
              : (executor.slipstreamFactory ?? ""),
        );
  const localRouter =
    first.kind === 4 || first.kind === 5
      ? undefined
      : getAddress(
          first.kind === 1
            ? (executor.router ?? "")
            : first.kind === 2
              ? (executor.pancakeRouter ?? "")
              : (executor.slipstreamRouter ?? ""),
        );
  const runtimeCodeHash = executor.runtimeCodeHash as `0x${string}`;
  if (!isHash(runtimeCodeHash))
    throw new Error("Local Atomic V1 runtime hash is invalid.");
  for (const operation of branch.operations) {
    const { pool, kind, fee, tickSpacing, poolId } = operationPool(operation);
    if (
      kind !== first.kind ||
      (kind === 4
        ? getAddress(exact(pool.vault, 20, "Balancer Vault")) !==
            getAddress(executor.balancerVault ?? "") ||
          poolId === zeroHash ||
          !executor.balancerPools?.includes(poolId)
        : kind === 5
          ? !pool.key ||
            fee === undefined ||
            fee > 1_000_000 ||
            tickSpacing === undefined ||
            tickSpacing <= 0 ||
            tickSpacing > 32_767 ||
            getAddress(exact(pool.poolManager, 20, "V4 PoolManager")) !==
              getAddress(executor.poolManager ?? "") ||
            getAddress(exact(pool.key.hooks, 20, "V4 hooks")) !== zeroAddress ||
            BigInt(exact(pool.key.currency0, 20, "V4 currency0")) >=
              BigInt(exact(pool.key.currency1, 20, "V4 currency1")) ||
            ![
              getAddress(exact(operation.tokenIn, 20, "operation input")),
              getAddress(exact(operation.tokenOut, 20, "operation output")),
            ].every((token) =>
              [
                getAddress(exact(pool.key?.currency0, 20, "V4 currency0")),
                getAddress(exact(pool.key?.currency1, 20, "V4 currency1")),
              ].includes(token),
            ) ||
            !executor.uniswapV4Pools?.some(
              (candidate) =>
                getAddress(candidate.currency0) ===
                  getAddress(exact(pool.key?.currency0, 20, "V4 currency0")) &&
                getAddress(candidate.currency1) ===
                  getAddress(exact(pool.key?.currency1, 20, "V4 currency1")) &&
                candidate.feePips === fee &&
                candidate.tickSpacing === tickSpacing &&
                getAddress(candidate.hooks) === zeroAddress,
            )
          : kind === 3
            ? tickSpacing === undefined ||
              tickSpacing <= 0 ||
              tickSpacing > 8_388_607
            : fee === undefined || fee >= 1_000_000) ||
      (kind !== 4 &&
        kind !== 5 &&
        (getAddress(exact(pool.factory, 20, "factory")) !== localFactory ||
          getAddress(exact(pool.router, 20, "router")) !== localRouter))
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
      executor,
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

export function admitAtomicRecoveryPayload(
  input: {
    action: "approval" | "swap";
    payloadType: "approval_response" | "unsigned_preparation";
    payloadBinaryHex: string;
    planId?: string;
    executorPlanHash?: string;
    transactionFingerprint?: string;
    transaction: UnsignedTransaction;
  },
  executor: AtomicExecutorIdentity,
): { action: "approval" } | { action: "swap"; receipt: ReceiptObligations } {
  const binary = hexToBytes(input.payloadBinaryHex as Hex);
  if (input.action === "approval") {
    if (input.payloadType !== "approval_response")
      throw new Error("Atomic recovery approval payload type is invalid.");
    const response = fromBinary(PreparePlanResponseSchema, binary);
    rejectUnknown(response);
    if (
      bytesToHex(toBinary(PreparePlanResponseSchema, response)) !==
        input.payloadBinaryHex ||
      response.status !== PlanPreparationStatus.APPROVAL_REQUIRED ||
      response.preparation ||
      response.simulation ||
      !response.approval ||
      !response.approval.transaction
    )
      throw new Error("Atomic recovery approval payload is invalid.");
    const approval = response.approval;
    const approvalTransaction = approval.transaction;
    if (!approvalTransaction)
      throw new Error("Atomic recovery approval transaction is absent.");
    const transaction = wireTransaction(approvalTransaction);
    const amount = uint(approval.amount, "approval amount");
    const expectedData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [getAddress(executor.address), amount],
    });
    if (
      getAddress(exact(approval.spender, 20, "approval spender")) !==
        getAddress(executor.address) ||
      !same(approval.token, approvalTransaction.to) ||
      bytesToHex(approvalTransaction.data ?? new Uint8Array()) !==
        expectedData ||
      !sameWireTransaction(transaction, input.transaction)
    )
      throw new Error("Atomic recovery approval authority is invalid.");
    return { action: "approval" };
  }
  if (
    input.payloadType !== "unsigned_preparation" ||
    !input.planId ||
    !input.executorPlanHash ||
    !input.transactionFingerprint
  )
    throw new Error("Atomic recovery swap identities are incomplete.");
  const preparation = fromBinary(UnsignedPreparationSchema, binary);
  rejectUnknown(preparation);
  if (
    bytesToHex(toBinary(UnsignedPreparationSchema, preparation)) !==
      input.payloadBinaryHex ||
    !preparation.terms ||
    !preparation.transaction ||
    preparation.terms.branchMinima.length !== 1 ||
    preparation.terms.program?.branches.length !== 1
  )
    throw new Error("Atomic recovery frozen preparation is invalid.");
  const terms = preparation.terms;
  const program = terms.program;
  if (!program) throw new Error("Atomic recovery plan program is absent.");
  const signer = getAddress(exact(terms.signer, 20, "signer"));
  const recipient = getAddress(exact(terms.recipient, 20, "recipient"));
  const executorAddress = getAddress(executor.address);
  const acceptedExecutor = terms.executor;
  const minimum = uint(terms.amountOutMinimum, "aggregate minimum");
  const branchMinimum = uint(terms.branchMinima[0], "branch minimum");
  const expiresAt = uint(terms.expiresAtUnix, "expiry");
  const deadline = uint(terms.deadlineUnix, "deadline");
  if (
    signer !== recipient ||
    minimum <= 0n ||
    branchMinimum !== minimum ||
    expiresAt <= 0n ||
    deadline <= expiresAt ||
    uint(terms.quoteBlock?.number, "quote block number") <= 0n ||
    exact(terms.quoteBlock?.hash, 32, "quote block hash") === zeroHash ||
    !acceptedExecutor ||
    acceptedExecutor.version !== 2 ||
    getAddress(exact(acceptedExecutor.address, 20, "executor")) !==
      executorAddress ||
    exact(acceptedExecutor.runtimeCodeHash, 32, "runtime hash") !==
      executor.runtimeCodeHash
  )
    throw new Error("Atomic recovery accepted executor identity is invalid.");
  const plan = executorPlanFromTerms(terms);
  validateRecoveryProgramDeployment(program, executor);
  const branchHashes = atomicV1AcceptedBranchHashes(program, [branchMinimum]);
  const planId = atomicV1PlanId({
    chainId: uint(program.chainId, "chain ID"),
    executor: executorAddress,
    runtimeCodeHash: executor.runtimeCodeHash as `0x${string}`,
    signer,
    recipient,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amountIn,
    minimum,
    quoteBlockNumber: uint(terms.quoteBlock?.number, "quote block number"),
    quoteBlockHash: exact(terms.quoteBlock?.hash, 32, "quote block hash"),
    expiresAt,
    deadline,
    branchHashes,
  });
  const data = atomicV1ExecutorCalldata(plan);
  const transaction = wireTransaction(preparation.transaction);
  const planHash = atomicV1ExecutorPlanHash({
    chainId: uint(program.chainId, "chain ID"),
    executor: executorAddress,
    sender: signer,
    plan,
  });
  const fingerprint = atomicV1TransactionFingerprint({
    planId,
    chainId: uint(program.chainId, "chain ID"),
    from: signer,
    to: executorAddress,
    value: 0n,
    data,
    gasLimit: BigInt(transaction.gasLimit),
  });
  if (
    exact(preparation.preparationId, 32, "preparation ID") === zeroHash ||
    exact(preparation.planId, 32, "plan ID") !== planId ||
    input.planId !== planId ||
    input.executorPlanHash !== planHash ||
    input.transactionFingerprint !== fingerprint ||
    transaction.data !== data ||
    transaction.valueAtomic !== "0" ||
    transaction.chainId !== uint(program.chainId, "chain ID").toString() ||
    getAddress(transaction.from) !== signer ||
    getAddress(transaction.to) !== executorAddress ||
    BigInt(transaction.gasLimit) <= 0n ||
    !sameWireTransaction(transaction, input.transaction)
  )
    throw new Error("Atomic recovery frozen identities changed.");
  return {
    action: "swap",
    receipt: receiptObligations(
      { terms, planId } as ReturnType<typeof acceptAtomicCandidate>,
      executor,
      planHash,
      fingerprint,
    ),
  };
}

function validateRecoveryProgramDeployment(
  program: NonNullable<
    ReturnType<typeof acceptAtomicCandidate>["terms"]["program"]
  >,
  executor: AtomicExecutorIdentity,
) {
  const branch = program.branches[0];
  const programTokenIn = getAddress(
    exact(program.tokenIn, 20, "program input"),
  );
  const programTokenOut = getAddress(
    exact(program.tokenOut, 20, "program output"),
  );
  if (
    program.formatVersion !== 1 ||
    uint(program.chainId, "chain ID") <= 0n ||
    uint(program.amountIn, "input amount") <= 0n ||
    programTokenIn === programTokenOut ||
    !branch ||
    uint(branch.amountIn, "branch input") !==
      uint(program.amountIn, "input amount") ||
    branch.operations.length < 1 ||
    branch.operations.length > 2
  )
    throw new Error("Atomic recovery plan path is unsupported.");
  const first = operationPool(branch.operations[0]);
  if (
    ((first.kind === 4 || first.kind === 5) &&
      branch.operations.length !== 1) ||
    branch.operations.some(
      (operation) => operationPool(operation).kind !== first.kind,
    )
  )
    throw new Error("Atomic recovery plan path is unsupported.");
  const factory =
    first.kind < 4
      ? getAddress(
          first.kind === 1
            ? (executor.factory ?? "")
            : first.kind === 2
              ? (executor.pancakeFactory ?? "")
              : (executor.slipstreamFactory ?? ""),
        )
      : undefined;
  const router =
    first.kind < 4
      ? getAddress(
          first.kind === 1
            ? (executor.router ?? "")
            : first.kind === 2
              ? (executor.pancakeRouter ?? "")
              : (executor.slipstreamRouter ?? ""),
        )
      : undefined;
  let currentToken = programTokenIn;
  const physicalPools = new Set<string>();
  for (const operation of branch.operations) {
    const { pool, kind, fee, tickSpacing, poolId } = operationPool(operation);
    const tokenIn = getAddress(exact(operation.tokenIn, 20, "operation input"));
    const tokenOut = getAddress(
      exact(operation.tokenOut, 20, "operation output"),
    );
    const pair =
      BigInt(tokenIn) < BigInt(tokenOut)
        ? `${tokenIn}:${tokenOut}`
        : `${tokenOut}:${tokenIn}`;
    const physical =
      kind === 4
        ? `4:${poolId}`
        : kind === 5
          ? `5:${exact(pool.key?.currency0, 20, "V4 currency0")}:${exact(pool.key?.currency1, 20, "V4 currency1")}:${fee}:${tickSpacing}`
          : `${kind}:${pair}:${kind === 3 ? tickSpacing : fee}`;
    if (
      tokenIn !== currentToken ||
      (kind === 4
        ? getAddress(exact(pool.vault, 20, "Balancer Vault")) !==
            getAddress(executor.balancerVault ?? "") ||
          poolId === zeroHash ||
          !executor.balancerPools?.includes(poolId)
        : kind === 5
          ? !pool.key ||
            fee === undefined ||
            fee > 1_000_000 ||
            tickSpacing === undefined ||
            tickSpacing <= 0 ||
            tickSpacing > 32_767 ||
            getAddress(exact(pool.poolManager, 20, "V4 PoolManager")) !==
              getAddress(executor.poolManager ?? "") ||
            getAddress(exact(pool.key.hooks, 20, "V4 hooks")) !== zeroAddress ||
            BigInt(exact(pool.key.currency0, 20, "V4 currency0")) >=
              BigInt(exact(pool.key.currency1, 20, "V4 currency1")) ||
            ![tokenIn, tokenOut].every((token) =>
              [
                getAddress(exact(pool.key?.currency0, 20, "V4 currency0")),
                getAddress(exact(pool.key?.currency1, 20, "V4 currency1")),
              ].includes(token),
            ) ||
            !executor.uniswapV4Pools?.some(
              (candidate) =>
                getAddress(candidate.currency0) ===
                  getAddress(exact(pool.key?.currency0, 20, "V4 currency0")) &&
                getAddress(candidate.currency1) ===
                  getAddress(exact(pool.key?.currency1, 20, "V4 currency1")) &&
                candidate.feePips === fee &&
                candidate.tickSpacing === tickSpacing &&
                getAddress(candidate.hooks) === zeroAddress,
            )
          : (kind === 3
              ? tickSpacing === undefined ||
                tickSpacing <= 0 ||
                tickSpacing > 8_388_607
              : fee === undefined || fee >= 1_000_000) ||
            getAddress(exact(pool.factory, 20, "factory")) !== factory ||
            getAddress(exact(pool.router, 20, "router")) !== router) ||
      tokenIn === tokenOut ||
      physicalPools.has(physical)
    )
      throw new Error("Atomic recovery plan differs from local deployment.");
    physicalPools.add(physical);
    currentToken = tokenOut;
  }
  if (currentToken !== programTokenOut)
    throw new Error("Atomic recovery plan final token is invalid.");
}

function sameWireTransaction(
  left: UnsignedTransaction,
  right: UnsignedTransaction,
) {
  return (
    left.chainId === right.chainId &&
    left.from.toLowerCase() === right.from.toLowerCase() &&
    left.to.toLowerCase() === right.to.toLowerCase() &&
    left.data.toLowerCase() === right.data.toLowerCase() &&
    left.valueAtomic === right.valueAtomic &&
    left.gasLimit === right.gasLimit
  );
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
          const { kind, fee, tickSpacing, poolId } = operationPool(operation);
          if (fee === undefined || tickSpacing === undefined)
            throw new Error("Atomic V1 operation is unsupported.");
          return {
            kind,
            tokenOut: getAddress(
              exact(operation.tokenOut, 20, "operation output"),
            ),
            fee,
            tickSpacing,
            poolId: poolId ?? zeroHash,
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
  executorIdentity: AtomicExecutorIdentity,
  planHash: `0x${string}`,
  fingerprint: `0x${string}`,
): ReceiptObligations {
  const executor = getAddress(executorIdentity.address);
  const program = expected.terms.program;
  if (!program) throw new Error("Atomic V1 accepted program is absent.");
  const operations = program.branches[0].operations;
  const first = operationPool(operations[0]);
  const endpoint = getAddress(
    first.kind === 4
      ? exact(first.pool.vault, 20, "Balancer Vault")
      : first.kind === 5
        ? (executorIdentity.universalRouter ?? "")
        : exact(first.pool.router, 20, "router"),
  );
  const tokenIn = exact(program.tokenIn, 20, "input token");
  const tokenOut = exact(program.tokenOut, 20, "output token");
  const minimum = uint(expected.terms.amountOutMinimum, "aggregate minimum");
  return {
    tokenIn,
    tokenOut,
    recipient: exact(expected.terms.recipient, 20, "recipient"),
    amountInAtomic: uint(program.amountIn, "input amount").toString(),
    amountOutMinimumAtomic: minimum.toString(),
    intermediate: operations.slice(0, -1).map((operation) => ({
      token: exact(operation.tokenOut, 20, "intermediate token"),
      owner: endpoint,
    })),
    touched: [
      tokenIn,
      ...operations.map((operation) =>
        exact(operation.tokenOut, 20, "operation output"),
      ),
    ].flatMap((token) => [
      { token, owner: executor },
      ...(first.kind === 4
        ? []
        : [
            { token, owner: endpoint },
            ...(first.kind === 5 && executorIdentity.permit2
              ? [{ token, owner: getAddress(executorIdentity.permit2) }]
              : []),
          ]),
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
          minimumAtomic: minimum.toString(),
          operations: operations.map((operation) => {
            const { kind } = operationPool(operation);
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
