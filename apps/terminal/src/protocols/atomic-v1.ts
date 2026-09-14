import {
  type AbiParameter,
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHash,
  keccak256,
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
      const swapChainId =
        p.transaction?.chainId ??
        p.approvalTransaction?.chainId ??
        p.onChainPermission?.transaction?.chainId;
      const same = (a: string, b: string) =>
        a.toLowerCase() === b.toLowerCase();
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
