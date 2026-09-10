import assert from "node:assert/strict";
import { fromJsonString } from "@bufbuild/protobuf";
import { quoteClient } from "../apps/terminal/src/client";
import { readConfig } from "../apps/terminal/src/config";
import { QuoteFinalSchema } from "../generated/ts/epeius/quote/v1/quote_pb";
import { root } from "./tasks";

// Read-only smoke check against an already running engine. Never owns its process.
try {
  const config = await readConfig();
  const client = quoteClient(config.engineUrl);
  const status = await client.getStatus({});
  assert.ok(status.chains.length > 0, "Engine returned no chains");
  for (const chain of status.chains) {
    assert.ok(chain.connected, `${chain.key}: ${chain.error}`);
    console.log(`${chain.key}: connected, chain ID ${chain.chainId}`);
    if (!chain.quotingSupported) {
      console.log(`${chain.key}: quoting not implemented`);
      continue;
    }
    for (const reverse of [false, true]) {
      const tokenIn = chain.tokens.find(
        (t) => t.symbol === (reverse ? "USDC" : "WETH"),
      );
      const tokenOut = chain.tokens.find(
        (t) => t.symbol === (reverse ? "WETH" : "USDC"),
      );
      assert.ok(tokenIn && tokenOut, "Expected supported WETH/USDC pair");
      const child = Bun.spawn(
        [
          "bun",
          "apps/terminal/src/main.ts",
          "quote",
          "--config",
          config.path,
          "--chain",
          chain.key,
          "--in",
          tokenIn.symbol,
          "--out",
          tokenOut.symbol,
          "--amount",
          reverse ? "25" : "0.01",
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
      assert.ok(quote.block && /^0x[0-9a-f]{64}$/.test(quote.block.hash));
      assert.ok(quote.routes.length > 0);
      assert.equal(quote.bestRouteId, undefined);
      for (const route of quote.routes) {
        assert.ok(BigInt(route.amountOutAtomic) > 0n);
        assert.deepEqual(route.block, quote.block);
        assert.equal(route.networkCostOutAtomic, undefined);
        assert.equal(route.effectiveOutAtomic, undefined);
        assert.equal(route.legs.length, 1);
        assert.equal(
          route.legs[0].tokenIn.toLowerCase(),
          tokenIn.address.toLowerCase(),
        );
        assert.equal(
          route.legs[0].tokenOut.toLowerCase(),
          tokenOut.address.toLowerCase(),
        );
      }
      console.log(
        `${chain.key}: ${tokenIn.symbol}/${tokenOut.symbol}, ${quote.routes.length} routes, block ${quote.block.number}`,
      );
    }
  }
  console.log("Read-only smoke check passed. No transactions sent.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Smoke check failed.");
  process.exitCode = 1;
}
