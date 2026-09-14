import {
  type AbiParameter,
  type Address,
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHash,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { executorV2Abi } from "../../../../generated/abi";
import type { PrepareExecutionResponse } from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { type SwapTerms, uint256Decimal } from "../execution-policy";
import { admitV3Route, type V3Deployment, v3Review } from "./v3";

type AtomicOperation = {
  kind: number;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
  poolId: `0x${string}`;
};

type AtomicBranch = {
  amountIn: bigint;
  minAmountOut: bigint;
  operations: readonly AtomicOperation[];
};

export type AtomicExecutorPlan = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: bigint;
  branches: readonly AtomicBranch[];
};

const operationComponents = [
  { name: "kind", type: "uint8" },
  { name: "tokenOut", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "poolId", type: "bytes32" },
] as const;
const branchComponents = [
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "operations", type: "tuple[]", components: operationComponents },
] as const;
const planParameter = {
  name: "plan",
  type: "tuple",
  components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "branches", type: "tuple[]", components: branchComponents },
  ],
} as const satisfies AbiParameter;

const domain = (value: string) => keccak256(stringToHex(value));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const requiredBytes = (
  value: Uint8Array | undefined,
  size: number,
  label: string,
) => {
  if (!value || value.length !== size)
    throw new Error(`Atomic V1 ${label} has the wrong width.`);
  return bytesToHex(value);
};
const requiredUint = (value: Uint8Array | undefined, label: string) =>
  BigInt(requiredBytes(value, 32, label));

function rejectUnknownFields(value: unknown) {
  if (!value || typeof value !== "object" || value instanceof Uint8Array)
    return;
  const message = value as { $unknown?: unknown[] };
  if (message.$unknown?.length)
    throw new Error("Atomic V1 plan contains unsupported fields.");
  for (const child of Object.values(value)) rejectUnknownFields(child);
}

export function atomicV1PlanId(terms: {
  chainId: bigint;
  executor: Address;
  runtimeCodeHash: `0x${string}`;
  signer: Address;
  recipient: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minimum: bigint;
  quoteBlockNumber: bigint;
  quoteBlockHash: `0x${string}`;
  expiresAt: bigint;
  deadline: bigint;
  branchHashes: readonly `0x${string}`[];
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32[]" },
      ],
      [
        domain("Epeius.AtomicPlan.v1"),
        1,
        terms.chainId,
        terms.executor,
        2,
        terms.runtimeCodeHash,
        terms.signer,
        terms.recipient,
        terms.tokenIn,
        terms.tokenOut,
        terms.amountIn,
        terms.minimum,
        terms.quoteBlockNumber,
        terms.quoteBlockHash,
        terms.expiresAt,
        terms.deadline,
        [...terms.branchHashes],
      ],
    ),
  );
}

export function atomicV1TransactionFingerprint(terms: {
  planId: `0x${string}`;
  chainId: bigint;
  from: Address;
  to: Address;
  value: bigint;
  data: `0x${string}`;
  gasLimit: bigint;
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        domain("Epeius.AtomicTransaction.v1"),
        terms.planId,
        terms.chainId,
        terms.from,
        terms.to,
        terms.value,
        keccak256(terms.data),
        terms.gasLimit,
      ],
    ),
  );
}

export function atomicV1ExecutorPlanHash(terms: {
  chainId: bigint;
  executor: Address;
  sender: Address;
  plan: AtomicExecutorPlan;
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        planParameter,
      ],
      [2n, terms.chainId, terms.executor, terms.sender, terms.plan],
    ),
  );
}

export function atomicExecutorV1(
  raw: {
    address?: string;
    runtimeCodeHash?: string;
    uniswapDeployment?: string;
  },
  deployments: Record<string, { kind: string }>,
) {
  const configuredAddress = `0x${raw.address?.replace(/^0x/i, "") ?? ""}`;
  if (
    !isAddress(configuredAddress, { strict: false }) ||
    getAddress(configuredAddress) === zeroAddress ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(raw.runtimeCodeHash ?? "")
  )
    throw new Error("Local Atomic V1 executor identity is invalid.");
  const address = getAddress(configuredAddress).toLowerCase() as Address;
  const runtimeCodeHash = `0x${raw.runtimeCodeHash?.replace(/^0x/i, "").toLowerCase()}`;
  const deployment = raw.uniswapDeployment
    ? (deployments[raw.uniswapDeployment] as V3Deployment | undefined)
    : undefined;
  if (deployment?.kind !== "uniswap-v3" || !deployment.factory)
    throw new Error(
      "Local Atomic V1 executor needs a configured Uniswap V3 deployment.",
    );
  const factory = deployment.factory;

  return {
    address,
    runtimeCodeHash,
    plan(p: PrepareExecutionResponse, tokens: string[]): SwapTerms {
      const wirePlan = p.atomicPlan;
      const route = p.route;
      if (
        !wirePlan ||
        !route ||
        p.allocations.length ||
        route.legs.length !== 1
      )
        throw new Error("Invalid Atomic V1 plan.");
      admitV3Route(route, p, deployment, tokens);
      const branch = wirePlan.branches[0];
      const operation = branch?.operations[0];
      if (
        wirePlan.branches.length !== 1 ||
        !branch ||
        branch.operations.length !== 1 ||
        !operation
      )
        throw new Error("Atomic V1 requires one branch and one operation.");
      const leg = route.legs[0];
      const accepted = wirePlan.acceptedTerms;
      const program = accepted?.program;
      const acceptedBranch = program?.branches[0];
      const acceptedOperation = acceptedBranch?.operations[0];
      const acceptedPool =
        acceptedOperation?.pool.case === "uniswapV3"
          ? acceptedOperation.pool.value
          : undefined;
      const quoteBlock = accepted?.quoteBlock;
      const acceptedExecutor = accepted?.executor;
      rejectUnknownFields(wirePlan);
      if (
        !accepted ||
        !program ||
        !acceptedBranch ||
        !acceptedOperation ||
        !acceptedPool ||
        !quoteBlock ||
        !acceptedExecutor ||
        program.formatVersion !== 1 ||
        program.branches.length !== 1 ||
        acceptedBranch.operations.length !== 1 ||
        accepted.branchMinima.length !== 1 ||
        acceptedExecutor.version !== 2 ||
        acceptedPool.feePips === undefined ||
        !wirePlan.planId ||
        wirePlan.planId.length !== 32 ||
        !wirePlan.transactionFingerprint ||
        wirePlan.transactionFingerprint.length !== 32
      )
        throw new Error("Invalid Atomic V1 accepted terms.");
      const swapChainId =
        p.transaction?.chainId ??
        p.approvalTransaction?.chainId ??
        p.onChainPermission?.transaction?.chainId;
      if (
        !isHash(wirePlan.executorPlanHash) ||
        wirePlan.chainId !== swapChainId ||
        !same(wirePlan.executor, address) ||
        !same(wirePlan.sender, p.recipient) ||
        !same(wirePlan.tokenIn, p.tokenIn) ||
        !same(wirePlan.tokenOut, p.tokenOut) ||
        wirePlan.amountInAtomic !== p.amountInAtomic ||
        wirePlan.amountOutMinimumAtomic !== p.amountOutMinimumAtomic ||
        wirePlan.deadlineUnix !== p.deadlineUnix ||
        branch.amountInAtomic !== p.amountInAtomic ||
        branch.amountOutMinimumAtomic !== p.amountOutMinimumAtomic ||
        operation.kind !== 1 ||
        !same(operation.tokenOut, leg.tokenOut) ||
        operation.feePips !== leg.selector.value ||
        operation.tickSpacing !== 0 ||
        !same(operation.poolId, zeroHash)
      )
        throw new Error("Atomic V1 plan differs from prepared route terms.");
      const plan = {
        tokenIn: getAddress(wirePlan.tokenIn),
        tokenOut: getAddress(wirePlan.tokenOut),
        amountIn: uint256Decimal(wirePlan.amountInAtomic, "Input amount"),
        minAmountOut: uint256Decimal(
          wirePlan.amountOutMinimumAtomic,
          "Minimum output amount",
        ),
        deadline: uint256Decimal(wirePlan.deadlineUnix, "Deadline"),
        branches: [
          {
            amountIn: uint256Decimal(branch.amountInAtomic, "Branch input"),
            minAmountOut: uint256Decimal(
              branch.amountOutMinimumAtomic,
              "Branch minimum output",
            ),
            operations: [
              {
                kind: operation.kind,
                tokenOut: getAddress(operation.tokenOut),
                fee: operation.feePips,
                tickSpacing: operation.tickSpacing,
                poolId: operation.poolId as `0x${string}`,
              },
            ],
          },
        ],
      } as const;
      if (plan.minAmountOut === 0n || plan.branches[0].minAmountOut === 0n)
        throw new Error("Atomic V1 minimum output must be positive.");

      const acceptedChainId = requiredUint(program.chainId, "chain ID");
      const acceptedTokenIn = requiredBytes(program.tokenIn, 20, "input token");
      const acceptedTokenOut = requiredBytes(
        program.tokenOut,
        20,
        "output token",
      );
      const acceptedAmountIn = requiredUint(program.amountIn, "input amount");
      const acceptedBranchAmount = requiredUint(
        acceptedBranch.amountIn,
        "branch input",
      );
      const acceptedOperationIn = requiredBytes(
        acceptedOperation.tokenIn,
        20,
        "operation input token",
      );
      const acceptedOperationOut = requiredBytes(
        acceptedOperation.tokenOut,
        20,
        "operation output token",
      );
      const acceptedFactory = requiredBytes(
        acceptedPool.factory,
        20,
        "factory",
      );
      const acceptedRouter = requiredBytes(acceptedPool.router, 20, "router");
      const acceptedPoolAddress = requiredBytes(acceptedPool.pool, 20, "pool");
      const acceptedExecutorAddress = requiredBytes(
        acceptedExecutor.address,
        20,
        "executor",
      );
      const acceptedRuntimeHash = requiredBytes(
        acceptedExecutor.runtimeCodeHash,
        32,
        "runtime hash",
      );
      const acceptedSigner = requiredBytes(accepted.signer, 20, "signer");
      const acceptedRecipient = requiredBytes(
        accepted.recipient,
        20,
        "recipient",
      );
      const branchMinimum = requiredUint(
        accepted.branchMinima[0],
        "branch minimum",
      );
      const aggregateMinimum = requiredUint(
        accepted.amountOutMinimum,
        "aggregate minimum",
      );
      const quoteBlockNumber = requiredUint(
        quoteBlock.number,
        "quote block number",
      );
      const quoteBlockHash = requiredBytes(
        quoteBlock.hash,
        32,
        "quote block hash",
      );
      const expiresAt = requiredUint(accepted.expiresAtUnix, "expiry");
      const acceptedDeadline = requiredUint(accepted.deadlineUnix, "deadline");
      if (
        acceptedChainId !== BigInt(wirePlan.chainId) ||
        !same(acceptedTokenIn, p.tokenIn) ||
        !same(acceptedTokenOut, p.tokenOut) ||
        acceptedAmountIn !== plan.amountIn ||
        acceptedBranchAmount !== plan.amountIn ||
        !same(acceptedOperationIn, p.tokenIn) ||
        !same(acceptedOperationOut, p.tokenOut) ||
        !same(acceptedFactory, factory) ||
        !same(acceptedRouter, deployment.router) ||
        !same(acceptedPoolAddress, leg.pool) ||
        acceptedPool.feePips !== leg.selector.value ||
        !same(acceptedExecutorAddress, address) ||
        !same(acceptedRuntimeHash, runtimeCodeHash) ||
        !same(acceptedSigner, p.recipient) ||
        !same(acceptedRecipient, p.recipient) ||
        branchMinimum !== plan.branches[0].minAmountOut ||
        aggregateMinimum !== plan.minAmountOut ||
        !route.block ||
        quoteBlockNumber !== BigInt(route.block.number) ||
        !same(quoteBlockHash, route.block.hash) ||
        expiresAt !== BigInt(p.expiresAtUnix) ||
        acceptedDeadline !== plan.deadline
      )
        throw new Error("Atomic V1 accepted terms differ from preparation.");

      const providerHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint8" },
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "uint24" },
          ],
          [
            domain("Epeius.AtomicProvider.v1"),
            1,
            getAddress(acceptedFactory),
            getAddress(acceptedRouter),
            getAddress(acceptedPoolAddress),
            acceptedPool.feePips,
          ],
        ),
      );
      const operationHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint8" },
            { type: "address" },
            { type: "address" },
            { type: "bytes32" },
          ],
          [
            domain("Epeius.AtomicOperation.v1"),
            1,
            getAddress(acceptedOperationIn),
            getAddress(acceptedOperationOut),
            providerHash,
          ],
        ),
      );
      const branchHash = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bytes32[]" },
          ],
          [
            domain("Epeius.AtomicAcceptedBranch.v1"),
            acceptedBranchAmount,
            branchMinimum,
            [operationHash],
          ],
        ),
      );
      const planId = atomicV1PlanId({
        chainId: acceptedChainId,
        executor: getAddress(acceptedExecutorAddress),
        runtimeCodeHash: acceptedRuntimeHash,
        signer: getAddress(acceptedSigner),
        recipient: getAddress(acceptedRecipient),
        tokenIn: getAddress(acceptedTokenIn),
        tokenOut: getAddress(acceptedTokenOut),
        amountIn: acceptedAmountIn,
        minimum: aggregateMinimum,
        quoteBlockNumber,
        quoteBlockHash,
        expiresAt,
        deadline: acceptedDeadline,
        branchHashes: [branchHash],
      });
      if (!same(planId, bytesToHex(wirePlan.planId)))
        throw new Error("Atomic V1 plan ID does not match accepted terms.");
      if (
        !same(
          atomicV1ExecutorPlanHash({
            chainId: BigInt(wirePlan.chainId),
            executor: address,
            sender: getAddress(wirePlan.sender),
            plan,
          }),
          wirePlan.executorPlanHash,
        )
      )
        throw new Error(
          "Atomic V1 executor plan hash does not match its terms.",
        );
      const data = encodeFunctionData({
        abi: executorV2Abi,
        functionName: "execute",
        args: [plan],
      });
      const tx = p.transaction;
      if (
        !tx ||
        !same(
          atomicV1TransactionFingerprint({
            planId,
            chainId: BigInt(tx.chainId),
            from: getAddress(tx.from),
            to: getAddress(tx.to),
            value: BigInt(tx.valueAtomic),
            data: tx.data as `0x${string}`,
            gasLimit: BigInt(tx.gasLimit),
          }),
          bytesToHex(wirePlan.transactionFingerprint),
        )
      )
        throw new Error("Atomic V1 transaction fingerprint does not match.");
      return {
        target: address,
        spender: address,
        data,
        quotedOutput: route.amountOutAtomic,
        routeDetails: [v3Review(route)],
        receipt: {
          intermediate: [],
          atomicPlan: {
            executor: address,
            planHash: wirePlan.executorPlanHash,
            planId,
            transactionFingerprint: bytesToHex(wirePlan.transactionFingerprint),
            operation: {
              kind: 1,
              tokenIn: p.tokenIn,
              tokenOut: p.tokenOut,
              amountInAtomic: p.amountInAtomic,
              branchMinimumAtomic: branch.amountOutMinimumAtomic,
            },
          },
          touched: [
            { token: p.tokenIn, owner: address },
            { token: p.tokenOut, owner: address },
            { token: p.tokenIn, owner: deployment.router },
            { token: p.tokenOut, owner: deployment.router },
          ],
        },
      };
    },
  };
}
