import { resolve } from "node:path";

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
    parsed = Bun.TOML.parse(await Bun.file(absolutePath).text());
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
