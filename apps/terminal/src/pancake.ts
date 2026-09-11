import { type Address, encodeFunctionData } from "viem";
import { pancakeV3RouterAbi } from "../../../generated/abi";
import type { PrepareExecutionResponse } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { uint256Decimal } from "./execution-policy";
import { admitV3Route, directV3Terms, v3Deployment, v3Path } from "./v3";

export function pancakeData(p: PrepareExecutionResponse) {
  if (!p.route) throw new Error("Invalid route terms.");
  return encodeFunctionData({
    abi: pancakeV3RouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: v3Path(p.route),
        recipient: p.recipient as Address,
        deadline: uint256Decimal(p.deadlineUnix, "Deadline"),
        amountIn: uint256Decimal(p.amountInAtomic, "Input amount"),
        amountOutMinimum: uint256Decimal(
          p.amountOutMinimumAtomic,
          "Minimum output amount",
        ),
      },
    ],
  });
}

export function pancake(raw: { router?: string; fees?: number[] }) {
  const deployment = v3Deployment(raw, "pancake-v3");
  return {
    ...deployment,
    plan(p: PrepareExecutionResponse, tokens: string[]) {
      if (!p.route) throw new Error("Invalid route terms.");
      admitV3Route(p.route, p, deployment, tokens);
      return directV3Terms(p, deployment, pancakeData(p));
    },
  };
}
