import {
  type Address,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  isHash,
  zeroAddress,
} from "viem";
import { executorAbi } from "../../../../generated/abi";
import type { PrepareExecutionResponse } from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { type SwapTerms, uint256Decimal } from "../execution-policy";
import { admitV3Route, type V3Deployment, v3Review } from "./v3";

type ExecutorDeployment = {
  kind: string;
  router?: string;
  fees?: number[];
};

function executorVenue(
  id: string | undefined,
  expectedKind: string,
  deployments: Record<string, ExecutorDeployment>,
) {
  if (!id)
    throw new Error(`Local executor ${expectedKind} deployment ID is missing.`);
  const deployment = deployments[id];
  if (!deployment)
    throw new Error(`Local executor deployment "${id}" is not configured.`);
  if (deployment.kind !== expectedKind)
    throw new Error(
      `Local executor deployment "${id}" must use ${expectedKind}.`,
    );
  if (
    typeof deployment.router !== "string" ||
    !isAddress(deployment.router, { strict: false })
  )
    throw new Error(`Local executor deployment "${id}" has an invalid router.`);
  if (!Array.isArray(deployment.fees))
    throw new Error(`Local executor deployment "${id}" has no fee list.`);
  return {
    id,
    kind: deployment.kind,
    router: getAddress(deployment.router).toLowerCase(),
    fees: deployment.fees,
  };
}

export function expectedExecutorData(p: PrepareExecutionResponse): string {
  const allocations = p.allocations.map((allocation) => {
    if (!allocation.route) throw new Error("Missing allocation route.");
    const route = allocation.route;
    if (route.provider !== "uniswap-v3" && route.provider !== "pancake-v3")
      throw new Error("Unsupported executor venue.");
    return {
      venue: route.provider === "uniswap-v3" ? 0 : 1,
      amountIn: uint256Decimal(allocation.amountInAtomic, "Allocation input"),
      hops: route.legs.map((leg) => {
        if (leg.selector.case !== "feePips")
          throw new Error("Unsupported executor selector.");
        return { tokenOut: leg.tokenOut as Address, fee: leg.selector.value };
      }),
    };
  });
  return encodeFunctionData({
    abi: executorAbi,
    functionName: "execute",
    args: [
      p.tokenIn as Address,
      p.tokenOut as Address,
      uint256Decimal(p.amountInAtomic, "Input amount"),
      uint256Decimal(p.amountOutMinimumAtomic, "Minimum output amount"),
      uint256Decimal(p.deadlineUnix, "Deadline"),
      allocations,
    ],
  });
}

export function fixedExecutor(
  raw: {
    address?: string;
    uniswapDeployment?: string;
    pancakeDeployment?: string;
  },
  deployments: Record<string, ExecutorDeployment>,
) {
  const configuredAddress = `0x${raw.address?.replace(/^0x/i, "") ?? ""}`;
  if (!isAddress(configuredAddress, { strict: false }))
    throw new Error("Local executor address is invalid.");
  const address = getAddress(configuredAddress).toLowerCase();
  if (address === zeroAddress)
    throw new Error("Local executor address must not be zero.");

  const uni = executorVenue(raw.uniswapDeployment, "uniswap-v3", deployments);
  const pan = executorVenue(raw.pancakeDeployment, "pancake-v3", deployments);
  if (isAddressEqual(uni.router as Address, pan.router as Address))
    throw new Error("Local executor venues must use distinct routers.");

  const venues = new Map<string, V3Deployment>([
    [uni.id, uni],
    [pan.id, pan],
  ]);
  return {
    plan(p: PrepareExecutionResponse, tokens: string[]): SwapTerms {
      if (!p.allocations.length || p.allocations.length > 2 || p.route)
        throw new Error(
          "Provide either a direct route or executor allocations.",
        );
      const used = new Set<string>();
      const touched: Array<{ token: string; owner: string }> = [];
      const intermediates = new Set<string>();
      let total = 0n;
      let quoted = 0n;
      const routeDetails: string[][] = [];
      for (const allocation of p.allocations) {
        const route = allocation.route;
        if (!route) throw new Error("Missing route terms.");
        const deployment = venues.get(route.deploymentId);
        if (!deployment || used.has(route.deploymentId))
          throw new Error(
            "Executor routes must use configured distinct venues without cycles.",
          );
        admitV3Route(route, p, deployment, tokens);
        used.add(route.deploymentId);
        const pathTokens = [
          route.legs[0].tokenIn,
          ...route.legs.map((leg) => leg.tokenOut),
        ];
        if (
          new Set(pathTokens.map((token) => token.toLowerCase())).size !==
          pathTokens.length
        )
          throw new Error(
            "Executor routes must use configured distinct venues without cycles.",
          );
        const block = p.allocations[0].route?.block;
        if (
          !route.block ||
          !block ||
          block.hash.length !== 66 ||
          !isHash(block.hash) ||
          !/^[0-9]+$/.test(block.number) ||
          route.block.number !== block.number ||
          route.block.hash.toLowerCase() !== block.hash.toLowerCase()
        )
          throw new Error("Allocation quotes must share one block.");
        const amount = uint256Decimal(
          allocation.amountInAtomic,
          "Allocation input",
        );
        if (amount <= 0n)
          throw new Error("Allocation inputs must be positive.");
        total += amount;
        const output = uint256Decimal(
          route.amountOutAtomic,
          "Route quoted output",
        );
        if (output <= 0n)
          throw new Error("Route quoted output must be positive.");
        quoted += output;
        routeDetails.push(v3Review(route));
        for (const leg of route.legs.slice(0, -1))
          intermediates.add(leg.tokenOut);
        for (const token of pathTokens)
          for (const owner of [address, deployment.router, p.recipient]) {
            if (
              owner.toLowerCase() === p.recipient.toLowerCase() &&
              [p.tokenIn.toLowerCase(), p.tokenOut.toLowerCase()].includes(
                token.toLowerCase(),
              )
            )
              continue;
            touched.push({ token, owner });
          }
      }
      if (total !== uint256Decimal(p.amountInAtomic, "Input amount"))
        throw new Error("Allocation inputs must sum to the total input.");
      return {
        target: address,
        spender: address,
        data: expectedExecutorData(p),
        quotedOutput: quoted.toString(),
        routeDetails,
        receipt: {
          intermediate: [...intermediates].map((token) => ({
            token,
            owner: address,
          })),
          touched,
        },
      };
    },
  };
}
