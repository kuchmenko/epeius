import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { quoteClient } from "../apps/terminal/src/client";
import { readConfig, readSettings } from "../apps/terminal/src/config";
import { decimalToAtomic, resolveToken } from "../apps/terminal/src/tokens";
import { PreparationStatus } from "../generated/ts/epeius/quote/v1/quote_pb";

export function scenarios(deployments: string[]) {
  return [...deployments].sort().flatMap((deployment) =>
    [1, 2].flatMap((hops) =>
      [false, true].map((reverse) => ({
        deployment,
        hops,
        input: reverse ? "C" : "A",
        output: reverse ? "A" : "C",
      })),
    ),
  );
}

// Persist submitted hashes as they arrive, before waiting for receipt verification.
// Only the final event can establish success; an approval is not a completed swap.
export async function recordExecution(
  stdout: AsyncIterable<Uint8Array>,
  exited: Promise<number>,
  kind: "approval" | "swap",
  record: (result: Record<string, unknown>) => Promise<void>,
) {
  let pending = "";
  let last:
    | { transactionHash?: string; verification?: { outcome?: string } }
    | undefined;
  const decoder = new TextDecoder();
  for await (const chunk of stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const result = JSON.parse(line);
      await record(result);
      last = result;
    }
  }
  pending += decoder.decode();
  if (
    (await exited) !== 0 ||
    pending.trim() ||
    !/^0x[0-9a-fA-F]{64}$/.test(last?.transactionHash ?? "") ||
    last?.verification?.outcome !==
      (kind === "swap" ? "passed" : "receipt_success")
  )
    throw new Error(
      "Terminal execution did not pass. Inspect recorded hashes before any retry.",
    );
}

async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      config: { type: "string" },
      chain: { type: "string" },
      keystore: { type: "string" },
      "password-file": { type: "string" },
      report: { type: "string" },
      selection: { type: "boolean", default: false },
      broadcast: { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun scripts/e2e.ts --config PATH [--chain KEY] [--selection] [--broadcast --keystore PATH --password-file PATH] [--report PATH]\nWithout --broadcast, prints scenarios without network calls. Default: named deployment/hop/direction coverage. --selection: engine-selected trades in both directions, with interactive approval and swap confirmations. Requires seeded harness fixture tokens A and C as scenario inputs, not a general token whitelist. Stops at first failure without resending.",
    );
    return;
  }
  if (!values.config)
    throw new Error("Provide --config for the seeded harness.");
  const config = await readConfig(values.config);
  const settings = await readSettings(config.path);
  const chainKey = values.chain ?? settings.terminal?.default_chain;
  if (!chainKey) throw new Error("Provide --chain or terminal.default_chain.");
  const chain = settings.chains?.[chainKey];
  if (
    !chain ||
    !Number.isSafeInteger(chain.chain_id) ||
    (chain.chain_id ?? 0) <= 0 ||
    chain.execution_enabled !== true
  )
    throw new Error("Selected chain must explicitly enable execution.");
  const deployments = Object.entries(chain.deployments ?? {});
  if (!deployments.length)
    throw new Error(
      "Selected chain requires at least one configured deployment.",
    );
  const planned = scenarios(deployments.map(([id]) => id));
  const selectedScenarios = [
    { input: "A", output: "C" },
    { input: "C", output: "A" },
  ];
  const plan = values.selection ? selectedScenarios : planned;
  const track = values.selection ? "selection" : "coverage";
  if (!values.broadcast) {
    console.log(
      JSON.stringify({ broadcast: false, track, scenarios: plan }, null, 2),
    );
    return;
  }
  if (!values.keystore || !values["password-file"])
    throw new Error("Broadcast requires --keystore and --password-file.");
  if (values.selection && !process.stdin.isTTY)
    throw new Error("Selected-route trades require interactive confirmation.");
  const wallet = [
    "--keystore",
    values.keystore,
    "--password-file",
    values["password-file"],
  ];
  const derive = Bun.spawn(["cast", "wallet", "address", ...wallet], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const sender = (await new Response(derive.stdout).text()).trim();
  if ((await derive.exited) !== 0 || !/^0x[0-9a-fA-F]{40}$/.test(sender))
    throw new Error("Could not open local keystore.");
  const reportPath = resolve(
    values.report ?? `.testnet/e2e-${Date.now()}.jsonl`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, "", { flag: "wx", mode: 0o600 });
  const record = async (event: unknown) => {
    const line = JSON.stringify(event);
    console.log(line);
    await appendFile(reportPath, `${line}\n`);
  };
  const client = quoteClient(config.engineUrl);
  const status = await client.getStatus({}, { timeoutMs: 15000 });
  const remote = status.chains.find((item) => item.key === chainKey);
  if (
    !remote?.connected ||
    !remote.executionEnabled ||
    remote.chainId !== String(chain.chain_id)
  )
    throw new Error(
      "Engine must be connected and execution-enabled on selected chain.",
    );
  await record({ event: "start", track, sender, reportPath, scenarios: plan });
  if (values.selection) {
    for (const scenario of selectedScenarios) {
      const child = Bun.spawn(
        [
          "bun",
          "apps/terminal/src/main.ts",
          "trade",
          "--chain",
          remote.key,
          "--config",
          config.path,
          "--in",
          scenario.input,
          "--out",
          scenario.output,
          "--amount",
          "1",
          "--slippage-bps",
          "50",
          "--search-budget-ms",
          "15000",
          ...wallet,
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          stdin: "inherit",
          stdout: "pipe",
          stderr: "inherit",
        },
      );
      await recordExecution(
        child.stdout,
        child.exited,
        "swap",
        async (result) => {
          await record({ event: "trade", scenario, result });
        },
      );
      await record({ event: "scenario_passed", scenario });
    }
    await record({ event: "passed", track, count: selectedScenarios.length });
    return;
  }
  for (const scenario of planned) {
    const tokenIn = resolveToken(scenario.input, remote.tokens);
    const tokenOut = resolveToken(scenario.output, remote.tokens);
    const freshQuote = async () => {
      const quote = await client.getQuote(
        {
          chain: remote.key,
          chainId: remote.chainId,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountInAtomic: decimalToAtomic("1", tokenIn.decimals),
          searchBudgetMs: 15000,
        },
        { timeoutMs: 20000 },
      );
      const route = quote.routes.find(
        (item) =>
          item.deploymentId === scenario.deployment &&
          item.legs.length === scenario.hops,
      );
      if (!route)
        throw new Error(
          "Required scenario route unavailable; no substitute selected.",
        );
      await record({
        event: "quote",
        scenario,
        quoteId: quote.quoteId,
        block: quote.block,
        bestRouteId: quote.bestRouteId,
        searchComplete: quote.searchComplete,
        errors: quote.errors,
        route,
      });
      return { quote, route };
    };
    const execute = async (
      quoteId: string,
      routeId: string,
      kind: "approval" | "swap",
    ) => {
      const child = Bun.spawn(
        [
          "bun",
          "apps/terminal/src/main.ts",
          "execute",
          "--chain",
          remote.key,
          "--config",
          config.path,
          "--quote-id",
          quoteId,
          "--route-id",
          routeId,
          "--slippage-bps",
          "50",
          `--confirm-${kind}`,
          "yes",
          ...wallet,
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        },
      );
      await recordExecution(
        child.stdout,
        child.exited,
        kind,
        async (result) => {
          await record({ event: kind, scenario, result });
        },
      );
    };
    let selected = await freshQuote();
    const prepared = await client.prepareExecution(
      {
        quoteId: selected.quote.quoteId,
        routeId: selected.route.routeId,
        sender,
        slippageBps: 50,
      },
      { timeoutMs: 45000 },
    );
    await record({ event: "preparation_preview", scenario, prepared });
    if (prepared.status === PreparationStatus.APPROVAL_REQUIRED) {
      await execute(selected.quote.quoteId, selected.route.routeId, "approval");
      selected = await freshQuote();
    } else if (prepared.status !== PreparationStatus.READY) {
      throw new Error(
        "Preparation did not pass; nothing sent for this scenario.",
      );
    }
    await execute(selected.quote.quoteId, selected.route.routeId, "swap");
    await record({ event: "scenario_passed", scenario });
  }
  await record({ event: "passed", track, count: planned.length });
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch {
    console.error(
      "E2E stopped. Check recorded outcomes and wallet transactions before rerunning; no automatic resubmission. Provider diagnostics suppressed.",
    );
    process.exitCode = 1;
  }
}
