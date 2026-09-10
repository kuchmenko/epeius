import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { quoteClient } from "../apps/terminal/src/client";
import { readConfig } from "../apps/terminal/src/config";
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

async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      config: { type: "string" },
      keystore: { type: "string" },
      "password-file": { type: "string" },
      report: { type: "string" },
      broadcast: { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun scripts/e2e.ts --config PATH [--broadcast --keystore PATH --password-file PATH] [--report PATH]\nWithout --broadcast, prints scenarios without network calls. Requires the seeded A/B/C harness and a running engine for broadcast. Sends separate approvals and eight swaps for two deployments; stops at the first failure without resending.",
    );
    return;
  }
  if (!values.config)
    throw new Error("Provide --config for the seeded harness.");
  const config = await readConfig(values.config);
  const settings = Bun.TOML.parse(await Bun.file(config.path).text()) as {
    chains?: Record<
      string,
      {
        chain_id?: number;
        execution_enabled?: boolean;
        deployments?: Record<string, { kind?: string }>;
      }
    >;
  };
  const chain = settings.chains?.["base-sepolia"];
  if (chain?.chain_id !== 84532 || chain.execution_enabled !== true)
    throw new Error("Harness must explicitly enable Base Sepolia execution.");
  const deployments = Object.entries(chain.deployments ?? {});
  if (
    deployments.length !== 2 ||
    !["uniswap-v3", "pancake-v3"].every((kind) =>
      deployments.some(([, deployment]) => deployment.kind === kind),
    )
  )
    throw new Error("Harness requires one Uniswap and one Pancake deployment.");
  const planned = scenarios(deployments.map(([id]) => id));
  if (!values.broadcast) {
    console.log(
      JSON.stringify({ broadcast: false, scenarios: planned }, null, 2),
    );
    return;
  }
  if (!values.keystore || !values["password-file"])
    throw new Error("Broadcast requires --keystore and --password-file.");
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
  const remote = status.chains.find((item) => item.key === "base-sepolia");
  if (
    !remote?.connected ||
    !remote.executionEnabled ||
    remote.chainId !== "84532"
  )
    throw new Error(
      "Engine must be connected and execution-enabled on Base Sepolia.",
    );
  await record({ event: "start", sender, reportPath, scenarios: planned });
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
      // Persist each submitted hash before waiting for the receipt. Do not retry sends.
      let pending = "";
      let verified = false;
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const result = JSON.parse(line);
          await record({ event: kind, scenario, result });
          if (
            /^0x[0-9a-fA-F]{64}$/.test(result.transactionHash ?? "") &&
            result.verification?.outcome ===
              (kind === "swap" ? "passed" : "receipt_success")
          )
            verified = true;
        }
      }
      if ((await child.exited) !== 0 || !verified || pending.trim())
        throw new Error(
          "Terminal execution did not pass. Inspect recorded hashes before any retry.",
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
  await record({ event: "passed", count: planned.length });
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
