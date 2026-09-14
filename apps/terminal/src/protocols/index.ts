import type { readExecutionConfig } from "../config";
import type { TrustedExecution } from "../execution-policy";
import { atomicExecutorV1 } from "./atomic-v1";
import { balancer } from "./balancer-v2";
import { fixedExecutor } from "./fixed-executor";
import { pancake } from "./pancake-v3";
import { slipstream } from "./slipstream";
import { uniswap } from "./uniswap-v3";
import { uniswapV4 } from "./uniswap-v4";

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
  (raw: RawDeployment, tokens: string[]) => ParsedDeployment
>([
  ["uniswap-v3", uniswap],
  ["pancake-v3", pancake],
  ["aerodrome-slipstream", slipstream],
  ["balancer-v2", balancer],
  ["uniswap-v4", uniswapV4],
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
  atomic,
) => {
  const atomicExecutor = settings.atomic_executor;
  if (
    atomic &&
    (!atomicExecutor ||
      Object.keys(atomicExecutor).length !== 3 ||
      !["address", "runtime_code_hash", "uniswap_deployment"].every((field) =>
        Object.hasOwn(atomicExecutor, field),
      ))
  )
    throw new Error("Local Atomic V1 executor configuration is invalid.");
  return configureExecution({
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
    ...(atomic
      ? {
          atomicExecutor: {
            address: atomicExecutor?.address,
            runtimeCodeHash: atomicExecutor?.runtime_code_hash,
            uniswapDeployment: atomicExecutor?.uniswap_deployment,
          },
        }
      : {}),
  });
};

export function configureExecution(config: {
  tokens: string[];
  chainId?: number;
  deployments: Record<string, RawDeployment>;
  executor?: {
    address?: string;
    uniswapDeployment?: string;
    pancakeDeployment?: string;
  };
  atomicExecutor?: {
    address?: string;
    runtimeCodeHash?: string;
    uniswapDeployment?: string;
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
      return [id, provider(raw, config.tokens)];
    }),
  );
  return {
    tokens: config.tokens,
    deployments,
    ...(config.executor
      ? {
          executor: fixedExecutor(config.executor, deployments),
        }
      : {}),
    ...(config.atomicExecutor
      ? {
          atomicExecutor: atomicExecutorV1(config.atomicExecutor, deployments),
        }
      : {}),
  };
}
