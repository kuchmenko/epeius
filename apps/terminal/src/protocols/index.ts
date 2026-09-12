import type { readExecutionConfig } from "../config";
import type { TrustedExecution } from "../execution-policy";
import { balancer } from "./balancer-v2";
import { fixedExecutor } from "./fixed-executor";
import { pancake } from "./pancake-v3";
import { slipstream } from "./slipstream";
import { uniswap } from "./uniswap-v3";

type RawDeployment = {
  kind?: string;
  factory?: string;
  quoter?: string;
  router?: string;
  fees?: number[];
  options?: unknown;
};

type ParsedDeployment = TrustedExecution["deployments"][string] & {
  kind: string;
  router?: string;
  fees?: number[];
};

const providerParsers = new Map<
  string,
  (raw: RawDeployment) => ParsedDeployment
>([
  ["uniswap-v3", uniswap],
  ["pancake-v3", pancake],
  ["aerodrome-slipstream", slipstream],
  ["balancer-v2", balancer],
]);

const deploymentFields = new Set([
  "kind",
  "factory",
  "quoter",
  "router",
  "fees",
  "options",
]);

export const configureChain: Parameters<typeof readExecutionConfig>[3] = (
  tokens,
  settings,
  allocations,
) =>
  configureExecution({
    tokens,
    chainId: settings.chain_id,
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
  chainId?: number;
  deployments: Record<string, RawDeployment>;
  executor?: {
    address?: string;
    uniswapDeployment?: string;
    pancakeDeployment?: string;
  };
}): TrustedExecution {
  const deployments = Object.fromEntries(
    Object.entries(config.deployments).map(([id, raw]) => {
      if (Object.keys(raw).some((field) => !deploymentFields.has(field)))
        throw new Error("Local execution deployment is invalid.");
      const provider =
        typeof raw.kind === "string"
          ? providerParsers.get(raw.kind)
          : undefined;
      if (!provider)
        throw new Error(`Unsupported provider: ${raw.kind ?? "missing"}.`);
      return [id, provider(raw)];
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
