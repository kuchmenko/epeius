import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { fromJsonString } from "@bufbuild/protobuf";
import { isHash } from "viem";
import { quoteClient } from "../apps/terminal/src/client";
import { readConfig } from "../apps/terminal/src/config";
import {
  type QuoteFinal,
  QuoteFinalSchema,
} from "../generated/ts/epeius/quote/v1/quote_pb";
import { root } from "./tasks";

export function parseScenario(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      chain: { type: "string" },
      in: { type: "string" },
      out: { type: "string" },
      amount: { type: "string" },
      config: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  assert.ok(
    values.chain && values.in && values.out && values.amount,
    "Smoke requires --chain, --in, --out and --amount for one configured pair",
  );
  assert.notEqual(values.in, values.out, "Smoke tokens must differ");
  assert.ok(
    /^\d+(\.\d+)?$/.test(values.amount) &&
      BigInt(values.amount.replace(".", "")) > 0n,
    "Smoke amount must be a positive decimal",
  );
  return {
    chain: values.chain,
    tokenIn: values.in,
    tokenOut: values.out,
    amount: values.amount,
    config: values.config,
  };
}

export function assertQuote(
  quote: QuoteFinal,
  tokenIn: string,
  tokenOut: string,
) {
  assert.ok(quote.block && isHash(quote.block.hash));
  assert.ok(quote.routes.length > 0, "Scenario returned no routes");
  let best = quote.routes[0];
  for (const route of quote.routes) {
    assert.ok(BigInt(route.amountOutAtomic) > 0n);
    assert.deepEqual(route.block, quote.block);
    assert.equal(route.networkCostOutAtomic, undefined);
    assert.equal(route.effectiveOutAtomic, undefined);
    assert.ok(route.legs.length === 1 || route.legs.length === 2);
    assert.equal(route.legs[0].tokenIn.toLowerCase(), tokenIn.toLowerCase());
    assert.equal(
      route.legs[route.legs.length - 1].tokenOut.toLowerCase(),
      tokenOut.toLowerCase(),
    );
    if (route.legs.length === 2)
      assert.equal(
        route.legs[0].tokenOut.toLowerCase(),
        route.legs[1].tokenIn.toLowerCase(),
      );
    // Matches the engine's stable candidate order: the first maximum wins ties.
    if (BigInt(route.amountOutAtomic) > BigInt(best.amountOutAtomic))
      best = route;
  }
  assert.equal(quote.bestRouteId, best.routeId);
}

// Read-only smoke check against an already running engine. Never owns its process.
if (import.meta.main) {
  try {
    const scenario = parseScenario(Bun.argv.slice(2));
    const config = await readConfig(scenario.config);
    const tokens = config.chains[scenario.chain]?.tokens;
    const tokenIn = tokens?.find((token) => token.symbol === scenario.tokenIn);
    const tokenOut = tokens?.find(
      (token) => token.symbol === scenario.tokenOut,
    );
    assert.ok(
      tokenIn && tokenOut,
      "Scenario requires a locally configured pair",
    );
    const client = quoteClient(config.engineUrl);
    const status = await client.getStatus({});
    assert.ok(status.chains.length > 0, "Engine returned no chains");
    for (const chain of status.chains) {
      assert.ok(chain.connected, `${chain.key}: ${chain.error}`);
      console.log(`${chain.key}: connected, chain ID ${chain.chainId}`);
    }
    const chain = status.chains.find((chain) => chain.key === scenario.chain);
    assert.ok(
      chain?.quotingSupported,
      "Scenario chain does not support quotes",
    );
    for (const token of [tokenIn, tokenOut])
      assert.ok(
        chain.tokens.some(
          (remote) =>
            remote.symbol === token.symbol &&
            remote.address.toLowerCase() === token.address.toLowerCase() &&
            remote.decimals === token.decimals,
        ),
        "Scenario token differs from engine configuration",
      );
    const child = Bun.spawn(
      [
        "bun",
        "apps/terminal/src/main.ts",
        "quote",
        "--config",
        config.path,
        "--chain",
        scenario.chain,
        "--in",
        tokenIn.symbol,
        "--out",
        tokenOut.symbol,
        "--amount",
        scenario.amount,
        "--search-budget-ms",
        "10000",
        "--json",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, err);
    const quote = fromJsonString(QuoteFinalSchema, out);
    assertQuote(quote, tokenIn.address, tokenOut.address);
    console.log(
      `${chain.key}: ${tokenIn.symbol}/${tokenOut.symbol}, ${quote.routes.length} routes, block ${quote.block?.number}`,
    );
    console.log("Read-only smoke check passed. No transactions sent.");
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Smoke check failed.",
    );
    process.exitCode = 1;
  }
}
