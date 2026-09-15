import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAddress, hexToBigInt, isHex } from "viem";
import { PlanQuoteResponseSchema } from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
import {
  ChainStatusSchema,
  GetStatusResponseSchema,
  QuoteFinalSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { buildEngine, engineBinary } from "../../../scripts/tasks";
import { AtomicIntentJournal } from "./atomic-intent-journal";
import {
  atomicPlanQuoteRequest,
  formatAtomicPlanQuote,
  validateAtomicPlanQuote,
} from "./atomic-plan-quote";
import { runAtomicPlanTrade } from "./atomic-plan-trade";
import { atomicPlanClient, quoteClient } from "./client";
import { MAX_BUDGET, readConfig, validateEngineUrl } from "./config";
import { ExecutionOutcome, type ExecutionResult } from "./execution";
import {
  connectExecution,
  executionCommand,
  verifyAtomicExecutor,
} from "./execution-command";
import { formatQuote, formatStatus, formatTokens } from "./format";
import {
  chainFromStatus,
  decimalToAtomic,
  parseAtomic,
  resolveToken,
  trustChainTokens,
} from "./tokens";
import { runTrade } from "./trade";

export function executionExitCode(result: ExecutionResult) {
  const outcome = result.kind;
  switch (outcome) {
    case ExecutionOutcome.Preview:
    case ExecutionOutcome.ApprovalConfirmed:
    case ExecutionOutcome.SwapVerified:
      return 0;
    case ExecutionOutcome.Canceled:
    case ExecutionOutcome.Failed:
    case ExecutionOutcome.Unknown:
      return 1;
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled execution outcome: ${String(unhandled)}`);
    }
  }
}

const help = `Epeius — EVM quote terminal

Usage:
  bun run terminal -- chains [--config PATH] [--json]
  bun run terminal -- chain check KEY [--config PATH] [--json]
  bun run terminal -- status [--engine-url URL] [--json]
  bun run terminal -- tokens [--chain KEY] [--engine-url URL] [--json]
  bun run terminal -- quote [--chain KEY] --in TOKEN --out TOKEN (--amount DECIMAL | --amount-atomic INTEGER) [--execution-mode atomic-v1] [--search-budget-ms N] [--engine-url URL] [--json]
  bun run terminal -- trade [--chain KEY] --in TOKEN --out TOKEN (--amount DECIMAL | --amount-atomic INTEGER) --keystore PATH --password-file PATH ([--route-id ID] | --execution-mode atomic-v1 --candidate-index N --atomic-journal PATH) [--slippage-bps N] [--search-budget-ms N] [--confirm-approval yes | --confirm-swap yes] [--config PATH]
  bun run terminal -- prepare|execute --chain KEY (--preparation-id ID --slippage-bps N | --quote-id ID (--route-id ID | --allocations JSON) [--execution-mode atomic-v1] [--slippage-bps N]) --keystore PATH --password-file PATH [--confirm-approval yes | --confirm-swap yes] [--config PATH]

Default config: ./epeius.toml. Execution must be explicitly enabled in chain config.
prepare previews without sending. execute displays terms and asks approval or swap confirmation.
trade quotes, selects the engine recommendation or --route-id, and executes. Selection uses raw output, not gas-adjusted output or a global best.
After each approval, trade gets a fresh quote and asks separately for the next permission or swap. At most two permission transactions are allowed.
Approval always requires a fresh quote afterward. Execution output is JSON lines; confirmations go to stderr.`;

type Globals = {
  config?: string;
  engineUrl?: string;
  json: boolean;
  args: string[];
};

function globals(args: string[]): Globals {
  const rest: string[] = [];
  let config: string | undefined;
  let engineUrl: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--config" || arg === "--engine-url") {
      const value = args[++index];
      if (!value) throw new Error(`Provide a value for ${arg}.`);
      if (arg === "--config") config = value;
      else engineUrl = value;
    } else if (arg.startsWith("--config=")) config = arg.slice(9);
    else if (arg.startsWith("--engine-url=")) engineUrl = arg.slice(13);
    else rest.push(arg);
  }
  return { config, engineUrl, json, args: rest };
}

function options(args: string[], names: string[]) {
  try {
    return parseArgs({
      args,
      strict: true,
      options: Object.fromEntries(
        names.map((name) => [name, { type: "string" }]),
      ),
    }).values as Record<string, string | undefined>;
  } catch {
    throw new Error("Invalid arguments. Run bun run terminal --help.");
  }
}

async function goCommand(args: string[], json: boolean, signal: AbortSignal) {
  if (!(await Bun.file(engineBinary).exists())) await buildEngine(signal);
  signal.throwIfAborted();
  const child = Bun.spawn([engineBinary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => child.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  let stdout: string, stderr: string, code: number;
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", stop);
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    // The local Go command sanitizes configuration and RPC errors.
    throw new Error(
      stderr.trim() || "Engine command returned an invalid response.",
    );
  }
  if (json) console.log(JSON.stringify(result));
  else if (args[0] === "chains") {
    const chains = (result as { chains: Array<Record<string, unknown>> })
      .chains;
    for (const chain of chains)
      console.log(
        `${chain.key} (${chain.chainId}): ${chain.rpcConfigured ? "RPC configured" : `set ${chain.rpcUrlEnv}`}`,
      );
  } else {
    const chain = (result as { chain: Record<string, unknown> }).chain;
    console.log(
      `${chain.key} (${chain.chainId}): ${chain.connected ? "connected" : "unavailable"}${chain.block ? `, block ${(chain.block as { number: string }).number}` : ""}`,
    );
    if (chain.error) console.error(chain.error);
  }
  return code;
}

function diagnostic(error: unknown, json: boolean, quoting = false) {
  let message = error instanceof Error ? error.message : "Command failed.";
  let code = "invalid_input";
  if (error instanceof ConnectError) {
    code = Code[error.code].toLowerCase();
    message =
      error.code === Code.Unavailable || error.code === Code.Unknown
        ? quoting
          ? "Quote failed: RPC or engine connection unavailable. Check engine status and the chain's RPC provider."
          : "Cannot reach engine. Start it with bun run engine and check terminal.engine_url."
        : error.code === Code.InvalidArgument
          ? "Engine rejected the request as invalid."
          : error.code === Code.FailedPrecondition
            ? "Chain is unsupported or not ready for quoting."
            : error.code === Code.Canceled
              ? "Request canceled."
              : error.code === Code.DeadlineExceeded
                ? "Request deadline expired before completion."
                : "Engine request failed.";
  }
  console.error(json ? JSON.stringify({ error: { code, message } }) : message);
}

export async function main(rawArgs: string[]) {
  if (!rawArgs.length || rawArgs.includes("--help")) {
    console.log(help);
    return 0;
  }
  let json = rawArgs.includes("--json");
  let quoting = false;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const parsed = globals(rawArgs);
    json = parsed.json;
    const [command, ...args] = parsed.args;
    for (const removed of [
      "sender",
      "recipient",
      "environment",
      ...(command === "quote" ? ["slippage-bps"] : []),
    ])
      if (
        rawArgs.some(
          (arg) => arg === `--${removed}` || arg.startsWith(`--${removed}=`),
        )
      )
        throw new Error(
          `--${removed} was removed; delete it from this command.`,
        );
    const config = await readConfig(parsed.config);
    if (command === "prepare" || command === "execute") {
      const values = options(args, [
        "chain",
        "quote-id",
        "route-id",
        "preparation-id",
        "allocations",
        "execution-mode",
        "keystore",
        "password-file",
        "slippage-bps",
        "confirm-approval",
        "confirm-swap",
      ]);
      if (
        values["execution-mode"] !== undefined &&
        values["execution-mode"] !== "atomic-v1"
      )
        throw new Error("--execution-mode must be atomic-v1 when provided.");
      if (values["preparation-id"] && values["slippage-bps"] === undefined)
        throw new Error("--slippage-bps is required with --preparation-id.");
      if (
        !values.keystore ||
        !values["password-file"] ||
        (!values["quote-id"] && !values["preparation-id"]) ||
        (!!values["quote-id"] && !!values["preparation-id"]) ||
        (values["preparation-id"]
          ? !!values["route-id"] ||
            !!values.allocations ||
            !!values["execution-mode"]
          : !!values["route-id"] === !!values.allocations)
      )
        throw new Error(
          "Provide --keystore, --password-file, and either --preparation-id alone or --quote-id with --route-id or --allocations.",
        );
      const client = quoteClient(
        parsed.engineUrl
          ? validateEngineUrl(parsed.engineUrl)
          : config.engineUrl,
      );
      const status = await client.getStatus({}, { signal: abort.signal });
      let chain = chainFromStatus(
        status.chains,
        values.chain ?? config.defaultChain,
      );
      chain = trustChainTokens(chain, config.chains[chain.key]);
      if (!chain.executionEnabled || !chain.connected)
        throw new Error("Engine must enable execution on the connected chain.");
      return executionExitCode(
        await executionCommand(
          command,
          values,
          config.path,
          chain.key,
          chain.chainId,
          client,
          abort.signal,
          chain.tokens,
        ),
      );
    }
    if (command === "chains" && args.length === 0)
      return await goCommand(
        ["chains", "--config", config.path],
        json,
        abort.signal,
      );
    if (
      command === "chain" &&
      args[0] === "check" &&
      args[1] &&
      args.length === 2
    )
      return await goCommand(
        ["chain", "check", args[1], "--config", config.path],
        json,
        abort.signal,
      );
    if (
      command !== "status" &&
      command !== "tokens" &&
      command !== "quote" &&
      command !== "trade"
    )
      throw new Error("Unknown command. Run bun run terminal --help.");
    const values = options(
      args,
      command === "status"
        ? []
        : command === "tokens"
          ? ["chain"]
          : [
              "chain",
              "in",
              "out",
              "amount",
              "amount-atomic",
              "search-budget-ms",
              ...(command === "quote" ? ["execution-mode"] : []),
              ...(command === "trade"
                ? [
                    "route-id",
                    "candidate-index",
                    "keystore",
                    "password-file",
                    "atomic-journal",
                    "slippage-bps",
                    "execution-mode",
                    "confirm-approval",
                    "confirm-swap",
                  ]
                : []),
            ],
    );
    if (command === "trade") {
      const atomic = values["execution-mode"] === "atomic-v1";
      if (atomic && !values["atomic-journal"])
        throw new Error(
          "Atomic V1 trade requires an explicit --atomic-journal path.",
        );
      if (!atomic && values["atomic-journal"])
        throw new Error(
          "--atomic-journal is only valid with trade --execution-mode atomic-v1.",
        );
    }
    const engineUrl = parsed.engineUrl
      ? validateEngineUrl(parsed.engineUrl)
      : config.engineUrl;
    const client = quoteClient(engineUrl);
    const status = await client.getStatus({}, { signal: abort.signal });
    if (command === "status") {
      console.log(
        json
          ? toJsonString(GetStatusResponseSchema, status)
          : formatStatus(status.chains),
      );
      return status.chains.every((chain) => chain.connected) ? 0 : 1;
    }
    let chain = chainFromStatus(
      status.chains,
      values.chain ?? config.defaultChain,
    );
    chain = trustChainTokens(chain, config.chains[chain.key]);
    if (command === "tokens") {
      console.log(
        json ? toJsonString(ChainStatusSchema, chain) : formatTokens(chain),
      );
      return chain.connected ? 0 : 1;
    }
    if (!chain.connected)
      throw new Error(
        `Chain ${chain.key} is not connected. ${chain.error} Fix its RPC settings and restart the engine.`,
      );
    if (!chain.quotingSupported)
      throw new Error(`Quoting is unsupported on chain ${chain.key}.`);
    if (!values.in || !values.out)
      throw new Error("Provide --in and --out tokens.");
    if (
      (values.amount === undefined) ===
      (values["amount-atomic"] === undefined)
    )
      throw new Error("Provide exactly one of --amount or --amount-atomic.");
    const tokenIn = resolveToken(values.in, chain.tokens);
    const tokenOut = resolveToken(values.out, chain.tokens);
    const amountInAtomic =
      values.amount !== undefined
        ? decimalToAtomic(values.amount, tokenIn.decimals)
        : parseAtomic(values["amount-atomic"] as string);
    const budgetText = values["search-budget-ms"];
    const searchBudgetMs =
      budgetText === undefined
        ? config.searchBudgetMs
        : /^\d+$/.test(budgetText)
          ? Number(budgetText)
          : 0;
    if (
      !Number.isInteger(searchBudgetMs) ||
      searchBudgetMs < 1 ||
      searchBudgetMs > MAX_BUDGET
    )
      throw new Error(`--search-budget-ms must be from 1 to ${MAX_BUDGET}.`);
    if (
      command === "quote" &&
      values["execution-mode"] !== undefined &&
      values["execution-mode"] !== "atomic-v1"
    )
      throw new Error("--execution-mode must be atomic-v1 when provided.");
    quoting = true;
    const getQuote = () =>
      client.getQuote(
        {
          chain: chain.key,
          chainId: chain.chainId,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountInAtomic,
          searchBudgetMs,
        },
        { signal: abort.signal, timeoutMs: searchBudgetMs + 5000 },
      );
    if (command === "trade") {
      if (!values.keystore || !values["password-file"])
        throw new Error("Provide --keystore and --password-file.");
      if (
        values["execution-mode"] !== undefined &&
        values["execution-mode"] !== "atomic-v1"
      )
        throw new Error("--execution-mode must be atomic-v1 when provided.");
      if (
        values["candidate-index"] !== undefined &&
        values["execution-mode"] !== "atomic-v1"
      )
        throw new Error(
          "--candidate-index requires --execution-mode atomic-v1.",
        );
      if (
        values["execution-mode"] === "atomic-v1" &&
        (!values["candidate-index"] || values["route-id"])
      )
        throw new Error(
          "Atomic V1 trade requires --candidate-index and does not accept --route-id.",
        );
      if (!chain.executionEnabled)
        throw new Error("Engine must enable execution on the connected chain.");
      // Establish executable account/network before asking for the first trade quote.
      // Execution still rereads config and discovers the account at its original read point.
      const context = await connectExecution(
        values,
        config.path,
        chain.key,
        chain.chainId,
        abort.signal,
        false,
        values["execution-mode"] === "atomic-v1",
      );
      const rpcChainId = await context.rpc.chainId();
      if (
        !isHex(rpcChainId, { strict: true }) ||
        rpcChainId.length <= 2 ||
        hexToBigInt(rpcChainId).toString() !== context.expectedChainId
      )
        throw new Error(
          `RPC network must match configured chain ID ${context.expectedChainId}.`,
        );
      if (values["execution-mode"] === "atomic-v1") {
        const candidateIndex = Number(values["candidate-index"]);
        const slippage = values["slippage-bps"] ?? "50";
        if (
          !/^[1-9][0-9]*$/.test(values["candidate-index"] ?? "") ||
          !Number.isSafeInteger(candidateIndex)
        )
          throw new Error(
            "--candidate-index must be a positive candidate number.",
          );
        if (!/^\d+$/.test(slippage) || Number(slippage) >= 10000)
          throw new Error("--slippage-bps must be 0 through 9999.");
        for (const name of ["confirm-approval", "confirm-swap"])
          if (values[name] !== undefined && values[name] !== "yes")
            throw new Error(`--${name} requires the literal value yes.`);
        if (values["confirm-approval"] && values["confirm-swap"])
          throw new Error("Confirm only one action: approval or swap.");
        const trustedExecutor = context.trusted.atomicExecutor;
        if (!trustedExecutor)
          throw new Error("Local Atomic V1 executor is unavailable.");
        const request = {
          chainId: BigInt(chain.chainId),
          tokenIn: getAddress(tokenIn.address),
          tokenOut: getAddress(tokenOut.address),
          amountIn: BigInt(amountInAtomic),
        };
        const atomicClient = atomicPlanClient(engineUrl);
        const journal = await AtomicIntentJournal.open(
          values["atomic-journal"] as string,
        );
        try {
          return executionExitCode(
            await runAtomicPlanTrade({
              request,
              candidateIndex: candidateIndex - 1,
              signer: context.signer,
              executor: trustedExecutor,
              slippageBps: Number(slippage),
              journal,
              quote: () =>
                atomicClient.getPlanQuote(
                  atomicPlanQuoteRequest(request, searchBudgetMs),
                  {
                    signal: abort.signal,
                    timeoutMs: searchBudgetMs + 5000,
                  },
                ),
              prepare: (request) =>
                atomicClient.preparePlan(request, {
                  signal: abort.signal,
                  timeoutMs: 25000,
                }),
              recheck: (request) =>
                atomicClient.recheckPlan(request, {
                  signal: abort.signal,
                  timeoutMs: 25000,
                }),
              chainId: context.rpc.chainId,
              send: context.wallet.send,
              receipt: context.rpc.waitCanonicalReceipt,
              traceCanonicalTransaction: context.rpc.traceCanonicalTransaction,
              report: (event) => console.log(JSON.stringify(event)),
              confirm: async (kind, transaction) => {
                if (!(await verifyAtomicExecutor(context.rpc, trustedExecutor)))
                  throw new Error(
                    "Local Atomic V1 executor runtime code or limits changed. Nothing sent.",
                  );
                console.error(
                  JSON.stringify({
                    action: kind,
                    chainId: transaction.chainId,
                    from: transaction.from,
                    to: transaction.to,
                    valueAtomic: transaction.valueAtomic,
                    gasLimit: transaction.gasLimit,
                    data: transaction.data,
                  }),
                );
                if (values[`confirm-${kind}`] === "yes") return true;
                if (values["confirm-approval"] || values["confirm-swap"])
                  return false;
                if (!process.stdin.isTTY) return false;
                const prompt = createInterface({
                  input: process.stdin,
                  output: process.stderr,
                });
                try {
                  return (
                    (await prompt.question(
                      `Type ${kind} to sign and send this transaction: `,
                      { signal: abort.signal },
                    )) === kind
                  );
                } finally {
                  prompt.close();
                }
              },
            }),
          );
        } finally {
          await journal.close();
        }
      }
      return executionExitCode(
        await runTrade(
          {
            quote: getQuote,
            report: (result) => console.log(JSON.stringify(result)),
            execute: async (quote, route, afterApproval, approvalRound) => {
              return executionCommand(
                "trade",
                {
                  ...values,
                  "quote-id": quote.quoteId,
                  "route-id": route.routeId,
                },
                config.path,
                chain.key,
                chain.chainId,
                client,
                abort.signal,
                chain.tokens,
                {
                  signer: context.signer,
                  route,
                  amountInAtomic,
                  tokenIn: tokenIn.address,
                  tokenOut: tokenOut.address,
                  afterApproval,
                  approvalRound,
                },
              );
            },
          },
          values["route-id"],
        ),
      );
    }
    if (values["execution-mode"] === "atomic-v1") {
      const request = {
        chainId: BigInt(chain.chainId),
        tokenIn: getAddress(tokenIn.address),
        tokenOut: getAddress(tokenOut.address),
        amountIn: BigInt(amountInAtomic),
      };
      const quote = validateAtomicPlanQuote(
        await atomicPlanClient(engineUrl).getPlanQuote(
          atomicPlanQuoteRequest(request, searchBudgetMs),
          { signal: abort.signal, timeoutMs: searchBudgetMs + 5000 },
        ),
        request,
      );
      console.log(
        json
          ? toJsonString(PlanQuoteResponseSchema, quote)
          : formatAtomicPlanQuote(
              quote,
              chain,
              tokenIn,
              tokenOut,
              BigInt(amountInAtomic),
            ),
      );
      if (json && !quote.searchComplete)
        console.error(
          "WARNING: Search was partial; some candidates may be missing.",
        );
      return quote.candidates.length ? 0 : 1;
    }
    const quote = await getQuote();
    console.log(
      json
        ? toJsonString(QuoteFinalSchema, quote)
        : formatQuote(quote, chain, tokenIn, tokenOut, amountInAtomic),
    );
    if (json && !quote.searchComplete)
      console.error("WARNING: Search was partial; some routes may be missing.");
    return quote.routes.length ? 0 : 1;
  } catch (error) {
    diagnostic(error, json, quoting);
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
