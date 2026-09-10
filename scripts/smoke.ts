import assert from "node:assert/strict";
import { startEngine } from "./engine";
import { buildEngine, root } from "./tasks";

// Addresses are transport inputs only. This smoke test makes no token/pool claim.
export const smokeQuoteArgs = [
  "quote",
  "--sender",
  "0x1111111111111111111111111111111111111111",
  "--recipient",
  "0x2222222222222222222222222222222222222222",
  "--in",
  "0x3333333333333333333333333333333333333333",
  "--out",
  "0x4444444444444444444444444444444444444444",
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
      const cli = Bun.spawn(
        ["bun", "apps/terminal/src/main.ts", ...smokeQuoteArgs],
        {
          cwd: root,
          env: { ...process.env, EPEIUS_ENGINE_URL: engine.ready.url },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
        cli.exited,
      ]);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Quotes are not implemented \(unimplemented\)/);
      console.log(
        JSON.stringify({
          ...engine.ready,
          event: "smoke-passed",
          quote: "unimplemented",
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
