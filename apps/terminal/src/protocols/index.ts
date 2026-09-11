import type { readExecutionConfig } from "../config";
import type { TrustedExecution } from "../execution-policy";
import { fixedExecutor } from "./fixed-executor";
import { pancake } from "./pancake-v3";
import { uniswap } from "./uniswap-v3";

export const configureChain: Parameters<typeof readExecutionConfig>[3] = (
  tokens,
  settings,
  allocations,
) =>
  configureExecution({
    tokens,
    deployments: settings.deployments ?? {},
    ...(allocations
      ? {
          executor: {
            address: settings.executor?.address,
            uniswapDeployment: settings.executor?.uniswap_deployment,
            pancakeDeployment: settings.executor?.pancake_deployment,
          },
        }
      : {}),
  });

export function configureExecution(config: {
  tokens: string[];
  deployments: Record<
    string,
    { kind?: string; router?: string; fees?: number[] }
  >;
  executor?: {
    address?: string;
    uniswapDeployment?: string;
    pancakeDeployment?: string;
  };
}): TrustedExecution {
  const factories = { "uniswap-v3": uniswap, "pancake-v3": pancake };
  const deployments = Object.fromEntries(
    Object.entries(config.deployments).map(([id, raw]) => {
      if (raw.kind !== "uniswap-v3" && raw.kind !== "pancake-v3")
        throw new Error("Local execution deployment is invalid.");
      return [id, factories[raw.kind](raw)];
    }),
  );
  return {
    tokens: config.tokens,
    deployments,
    ...(config.executor
      ? { executor: fixedExecutor(config.executor, deployments) }
      : {}),
  };
}
