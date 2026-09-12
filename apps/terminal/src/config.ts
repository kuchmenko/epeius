import { resolve } from "node:path";
import { isAddress } from "viem";
import type { TrustedExecution } from "./execution-policy";

const normalizeLocalAddress = (value: string) => {
  const address = `0x${value.replace(/^0x/i, "")}`;
  if (!isAddress(address, { strict: false }))
    throw new Error("Invalid local address.");
  return address.toLowerCase();
};

export type TerminalConfig = {
  path: string;
  defaultChain: string;
  engineUrl: string;
  searchBudgetMs: number;
  chains: Record<string, LocalChainConfig>;
};

export type LocalChainConfig = {
  tokens: LocalTokenConfig[];
};

export type LocalTokenConfig = {
  address: string;
  symbol: string;
  decimals: number;
};

const MAX_BUDGET = 2_147_478_647;

export function validateEngineUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("terminal.engine_url must be an HTTP address.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("terminal.engine_url must be an HTTP address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "terminal.engine_url must not contain credentials, query, or fragment.",
    );
  return url.toString();
}

export async function readConfig(
  path = resolve(process.cwd(), "epeius.toml"),
): Promise<TerminalConfig> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = await readSettings(absolutePath);
  } catch {
    throw new Error(`Unable to read or parse config file ${absolutePath}.`);
  }
  const terminal = (parsed as { terminal?: unknown })?.terminal;
  if (!terminal || typeof terminal !== "object")
    throw new Error("Config must contain [terminal].");
  const values = terminal as Record<string, unknown>;
  if (typeof values.default_chain !== "string" || !values.default_chain.trim())
    throw new Error("terminal.default_chain must be a non-empty string.");
  if (
    typeof values.search_budget_ms !== "number" ||
    !Number.isInteger(values.search_budget_ms) ||
    values.search_budget_ms < 1 ||
    values.search_budget_ms > MAX_BUDGET
  )
    throw new Error(
      `terminal.search_budget_ms must be an integer from 1 to ${MAX_BUDGET}.`,
    );
  const rawChains = (parsed as { chains?: unknown }).chains;
  if (rawChains !== undefined && typeof rawChains !== "object")
    throw new Error("Config chains must be a table.");
  const chains: Record<string, LocalChainConfig> = {};
  for (const [key, rawChain] of Object.entries(rawChains ?? {})) {
    const rawTokens = (rawChain as { tokens?: unknown })?.tokens;
    if (rawTokens !== undefined && !Array.isArray(rawTokens))
      throw new Error(`chains.${key}.tokens must be an array.`);
    chains[key] = {
      tokens: (rawTokens ?? []).map((rawToken) => {
        const token = rawToken as Record<string, unknown>;
        if (
          typeof token.address !== "string" ||
          typeof token.symbol !== "string" ||
          typeof token.decimals !== "number" ||
          !Number.isInteger(token.decimals)
        )
          throw new Error(`chains.${key}.tokens contains an invalid token.`);
        return {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
        };
      }),
    };
  }
  return {
    path: absolutePath,
    defaultChain: values.default_chain,
    engineUrl: validateEngineUrl(values.engine_url),
    searchBudgetMs: values.search_budget_ms,
    chains,
  };
}

export { MAX_BUDGET };

// Readers choose their own validation needs and read moments; no cached snapshot.
export async function readSettings(path: string) {
  return Bun.TOML.parse(await Bun.file(path).text()) as {
    terminal?: { default_chain?: string };
    chains?: Record<
      string,
      {
        chain_id?: number;
        rpc_url_env?: string;
        execution_enabled?: boolean;
        executor?: {
          address?: string;
          uniswap_deployment?: string;
          pancake_deployment?: string;
        };
        tokens?: Array<{
          address?: string;
          symbol?: string;
          decimals?: number;
        }>;
        deployments?: Record<
          string,
          {
            kind?: string;
            router?: string;
            fees?: number[];
            options?: unknown;
            pool_manager?: string;
            state_view?: string;
            permit2?: string;
            pools?: Array<{
              currency0?: string;
              currency1?: string;
              fee_pips?: number;
              tick_spacing?: number;
              hooks?: string;
            }>;
          }
        >;
      }
    >;
  };
}

export async function readExecutionConfig(
  configPath: string,
  chain: string,
  allocations: boolean,
  configure: (
    tokens: string[],
    settings: NonNullable<
      Awaited<ReturnType<typeof readSettings>>["chains"]
    >[string],
    allocations: boolean,
  ) => TrustedExecution,
) {
  const config = await readSettings(configPath);
  const localChain = config.chains?.[chain];
  if (
    !localChain ||
    !Number.isSafeInteger(localChain.chain_id) ||
    (localChain.chain_id ?? 0) <= 0 ||
    localChain.execution_enabled !== true ||
    typeof localChain.rpc_url_env !== "string" ||
    !localChain.rpc_url_env.trim()
  )
    throw new Error(
      "Local chain must set a safe positive chain_id, explicitly enable execution, and set rpc_url_env.",
    );
  const expectedChainId = String(localChain.chain_id);
  const tokens: string[] = [];
  for (const token of localChain.tokens ?? []) {
    if (!token.address)
      throw new Error("Local execution tokens must have valid addresses.");
    try {
      tokens.push(normalizeLocalAddress(token.address));
    } catch {
      throw new Error("Local execution tokens must have valid addresses.");
    }
  }
  const trusted = configure(tokens, localChain, allocations);
  return { expectedChainId, rpcUrlEnv: localChain.rpc_url_env, trusted };
}
