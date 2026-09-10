import { resolve } from "node:path";

export type TerminalConfig = {
  path: string;
  defaultChain: string;
  engineUrl: string;
  searchBudgetMs: number;
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
  return {
    path: absolutePath,
    defaultChain: values.default_chain,
    engineUrl: validateEngineUrl(values.engine_url),
    searchBudgetMs: values.search_budget_ms,
  };
}

export { MAX_BUDGET };
