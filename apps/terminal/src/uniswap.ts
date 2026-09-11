import { type Address, encodeFunctionData } from "viem";
import { uniswapRouter02Abi } from "../../../generated/abi";
import type { PrepareExecutionResponse } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { uint256Decimal } from "./execution-policy";
import { admitV3Route, directV3Terms, v3Deployment, v3Path } from "./v3";

export function uniswapData(p: PrepareExecutionResponse) {
  if (!p.route) throw new Error("Invalid route terms.");
  const inner = encodeFunctionData({
    abi: uniswapRouter02Abi,
    functionName: "exactInput",
    args: [
      {
        path: v3Path(p.route),
        recipient: p.recipient as Address,
        amountIn: uint256Decimal(p.amountInAtomic, "Input amount"),
        amountOutMinimum: uint256Decimal(
          p.amountOutMinimumAtomic,
          "Minimum output amount",
        ),
      },
    ],
  });
  return encodeFunctionData({
    abi: uniswapRouter02Abi,
    functionName: "multicall",
    args: [uint256Decimal(p.deadlineUnix, "Deadline"), [inner]],
  });
}

export function uniswap(raw: { router?: string; fees?: number[] }) {
  const deployment = v3Deployment(raw, "uniswap-v3");
  return {
    ...deployment,
    plan(p: PrepareExecutionResponse, tokens: string[]) {
      if (!p.route) throw new Error("Invalid route terms.");
      admitV3Route(p.route, p, deployment, tokens);
      return directV3Terms(p, deployment, uniswapData(p));
    },
  };
}
