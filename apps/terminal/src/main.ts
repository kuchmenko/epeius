import { parseArgs } from "node:util";
import { Code, ConnectError } from "@connectrpc/connect";
import { Environment } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { quoteClient } from "./client";

const help = `Epeius — EVM trading terminal and quote engine (currently Base)

Usage:
  bun run dev
  bun run terminal -- quote [options]
  bun run terminal -- execute <quote-id> --route <route-id>

Foundation only: quotes and execution are not implemented. No transactions are sent.

Quote options (all trade fields are explicit):
  --environment     base-mainnet or base-sepolia (or EPEIUS_ENVIRONMENT)
  --sender          EVM address
  --recipient       EVM address
  --in              Input token address
  --out             Output token address
  --amount-atomic   Positive integer in the input token's smallest unit
  --slippage-bps    Integer from 0 to 10000
  --search-budget-ms Positive integer, at most 4294967295

Use token addresses and atomic units; token-symbol lookup is not implemented.`;

export function showStartup(environment: string, url: string) {
  console.log(
    `Epeius — ${environment} (read-only)\nEngine: ${url}\nQuotes and execution are not implemented.\nRun bun run terminal -- quote --help in another terminal.\nPress Ctrl+C to stop.`,
  );
}

export function quoteInput(args: string[], fallbackEnvironment?: string) {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      options: Object.fromEntries(
        [
          "environment",
          "sender",
          "recipient",
          "in",
          "out",
          "amount-atomic",
          "slippage-bps",
          "search-budget-ms",
        ].map((name) => [name, { type: "string" as const }]),
      ),
    }).values as Record<string, string | undefined>;
  } catch {
    throw new Error(
      "Invalid quote arguments. Run bun run terminal -- quote --help.",
    );
  }
  const name = values.environment ?? fallbackEnvironment;
  const environment =
    name === "base-mainnet"
      ? Environment.BASE_MAINNET
      : name === "base-sepolia"
        ? Environment.BASE_SEPOLIA
        : undefined;
  if (environment === undefined)
    throw new Error("Choose --environment base-mainnet or base-sepolia.");
  function address(key: string) {
    const value = values[key];
    if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value))
      throw new Error(`Provide a 20-byte EVM address for --${key}.`);
    return value;
  }
  const amountInAtomic = values["amount-atomic"];
  if (
    !amountInAtomic ||
    !/^[1-9][0-9]*$/.test(amountInAtomic) ||
    amountInAtomic.length > 78 ||
    BigInt(amountInAtomic) >= 1n << 256n
  ) {
    throw new Error("Use a positive uint256 integer for --amount-atomic.");
  }
  function integer(key: string, min: number, max: number) {
    const value = values[key];
    if (
      !value ||
      !/^\d+$/.test(value) ||
      Number(value) < min ||
      Number(value) > max
    )
      throw new Error(`Provide an integer from ${min} to ${max} for --${key}.`);
    return Number(value);
  }
  return {
    environment,
    sender: address("sender"),
    recipient: address("recipient"),
    tokenIn: address("in"),
    tokenOut: address("out"),
    amountInAtomic,
    slippageBps: integer("slippage-bps", 0, 10000),
    searchBudgetMs: integer("search-budget-ms", 1, 4294967295),
  };
}

export async function main(args: string[]) {
  if (args.length === 0 || args.includes("--help")) {
    console.log(help);
    return 0;
  }
  if (args[0] === "execute") {
    console.error(
      "Execution is not implemented. No transaction was signed or sent.",
    );
    return 1;
  }
  if (args[0] !== "quote") {
    console.error("Unknown command. Run bun run terminal --help.");
    return 1;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const input = quoteInput(args.slice(1), process.env.EPEIUS_ENVIRONMENT);
    const client = quoteClient(
      process.env.EPEIUS_ENGINE_URL ?? "http://127.0.0.1:8080",
    );
    await client.getQuote(input, { signal: abort.signal });
    // Foundation must not present an unexpected server response as a real quote.
    console.error("This terminal does not support quote results yet.");
    return 1;
  } catch (error) {
    if (error instanceof ConnectError) {
      console.error(
        error.code === Code.Unimplemented
          ? "Quotes are not implemented (unimplemented). The engine received the request."
          : `Quote request failed (${Code[error.code]}). Check the engine address and availability.`,
      );
    } else {
      console.error(
        error instanceof Error ? error.message : "Unable to request a quote.",
      );
    }
    return 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main)
  process.exitCode = await main(
    Bun.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--")),
  );
