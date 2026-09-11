import { type Address, encodeFunctionData, type Hex, isAddress } from "viem";
import { balancerVaultAbi } from "../../../../generated/abi";
import type { PrepareExecutionResponse } from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { uint256Decimal } from "../execution-policy";

export type BalancerV2Deployment = {
  kind: "balancer-v2";
  vault: string;
  pools: string[];
};

export const isBalancerPoolId = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);

export function balancerData(p: PrepareExecutionResponse) {
  if (p.route?.legs.length !== 1) throw new Error("Invalid route terms.");
  const leg = p.route.legs[0];
  return encodeFunctionData({
    abi: balancerVaultAbi,
    functionName: "swap",
    args: [
      {
        poolId: leg.pool as Hex,
        kind: 0,
        assetIn: leg.tokenIn as Address,
        assetOut: leg.tokenOut as Address,
        amount: uint256Decimal(p.amountInAtomic, "Input amount"),
        userData: "0x",
      },
      {
        sender: p.recipient as Address,
        fromInternalBalance: false,
        recipient: p.recipient as Address,
        toInternalBalance: false,
      },
      uint256Decimal(p.amountOutMinimumAtomic, "Minimum output amount"),
      uint256Decimal(p.deadlineUnix, "Deadline"),
    ],
  });
}

export function balancer(raw: {
  factory?: string;
  quoter?: string;
  router?: string;
  fees?: number[];
  options?: unknown;
}) {
  const options = raw.options as Record<string, unknown> | undefined;
  const configuredVault = options?.vault;
  const pools = options?.pools;
  const vault = `0x${typeof configuredVault === "string" ? configuredVault.replace(/^0x/i, "") : ""}`;
  if (
    !isAddress(vault, { strict: false }) ||
    /^0x0{40}$/i.test(vault) ||
    raw.factory !== undefined ||
    raw.quoter !== undefined ||
    raw.router !== undefined ||
    raw.fees !== undefined ||
    !options ||
    Object.keys(options).length !== 2 ||
    !Array.isArray(pools) ||
    pools.length === 0 ||
    !pools.every(isBalancerPoolId) ||
    new Set(pools).size !== pools.length
  )
    throw new Error("Local execution deployment is invalid.");
  const deployment: BalancerV2Deployment = {
    kind: "balancer-v2",
    vault: vault.toLowerCase(),
    pools: [...pools],
  };
  return {
    ...deployment,
    plan(p: PrepareExecutionResponse, tokens: string[]) {
      const route = p.route;
      if (route?.legs.length !== 1) throw new Error("Invalid route terms.");
      const leg = route.legs[0];
      const configured = new Set(tokens.map((token) => token.toLowerCase()));
      if (
        route.provider !== deployment.kind ||
        !deployment.pools.includes(leg.pool) ||
        leg.selector.case !== undefined ||
        leg.tokenIn.toLowerCase() !== p.tokenIn.toLowerCase() ||
        leg.tokenOut.toLowerCase() !== p.tokenOut.toLowerCase() ||
        !configured.has(leg.tokenIn.toLowerCase()) ||
        !configured.has(leg.tokenOut.toLowerCase())
      )
        throw new Error(
          "Route is not allowed by local token and deployment config.",
        );
      const poolAddress = `0x${leg.pool.slice(2, 42)}`;
      if (
        leg.tokenIn.toLowerCase() === poolAddress ||
        leg.tokenOut.toLowerCase() === poolAddress
      )
        throw new Error("Balancer BPT swaps are not supported.");
      if (uint256Decimal(route.amountOutAtomic, "Route quoted output") <= 0n)
        throw new Error("Route quoted output must be positive.");
      return {
        target: deployment.vault,
        spender: deployment.vault,
        data: balancerData(p),
        quotedOutput: route.amountOutAtomic,
        routeDetails: [[`Pool ID: ${leg.pool}; pool address: ${poolAddress}`]],
        receipt: { intermediate: [], touched: [] },
      };
    },
  };
}
