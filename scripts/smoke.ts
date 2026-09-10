import assert from "node:assert/strict";
import { fromJsonString } from "@bufbuild/protobuf";
import { USDC, WETH } from "../apps/terminal/src/format";
import { QuoteFinalSchema } from "../generated/ts/epeius/quote/v1/quote_pb";
import { startEngine } from "./engine";
import { buildEngine, root } from "./tasks";

// Read-only inputs; sender and recipient do not need balances or approvals.
export const smokeQuoteArgs = [
  "quote",
  "--sender",
  "0x1111111111111111111111111111111111111111",
  "--recipient",
  "0x2222222222222222222222222222222222222222",
  "--in",
  WETH,
  "--out",
  USDC,
  "--amount-atomic",
  "9007199254740993",
  "--slippage-bps",
  "37",
  "--search-budget-ms",
  "1200",
];

if (import.meta.main) {
  try {
    await buildEngine();
    const engine = await startEngine({
      ...process.env,
      EPEIUS_LISTEN_ADDR: "127.0.0.1:0",
    });
    try {
      const mainnet = engine.ready.environment === "base-mainnet";
      for (const reverse of mainnet ? [false, true] : [false]) {
        const args = [...smokeQuoteArgs, "--json"];
        const set = (flag: string, value: string) => {
          args[args.indexOf(flag) + 1] = value;
        };
        set("--in", reverse ? USDC : WETH);
        set("--out", reverse ? WETH : USDC);
        set("--amount-atomic", reverse ? "100000000" : "10000000000000000");
        set("--search-budget-ms", "10000");
        const cli = Bun.spawn(["bun", "apps/terminal/src/main.ts", ...args], {
          cwd: root,
          env: { ...process.env, EPEIUS_ENGINE_URL: engine.ready.url },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(cli.stdout).text(),
          new Response(cli.stderr).text(),
          cli.exited,
        ]);
        if (mainnet) {
          assert.equal(code, 0, stderr || stdout);
          const quote = fromJsonString(QuoteFinalSchema, stdout);
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
              (reverse ? USDC : WETH).toLowerCase(),
            );
            assert.equal(
              route.legs[0].tokenOut.toLowerCase(),
              (reverse ? WETH : USDC).toLowerCase(),
            );
          }
          console.log(stdout.trim());
        } else {
          assert.equal(code, 1);
          assert.equal(stdout, "");
          assert.match(stderr, /Quoting is unsupported on Base Sepolia/);
        }
      }
      console.log(
        JSON.stringify({
          ...engine.ready,
          event: "smoke-passed",
          quote: mainnet
            ? "both-directions-verified"
            : "unsupported-on-sepolia",
          readOnly: true,
        }),
      );
    } finally {
      await engine.stop();
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Smoke check failed.",
    );
    process.exitCode = 1;
  }
}
