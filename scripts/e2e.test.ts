import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenarios } from "./e2e";

test("E2E covers both directions and hop counts independently for each deployment", () => {
  expect(scenarios(["uni", "pancake"])).toEqual([
    { deployment: "pancake", hops: 1, input: "A", output: "C" },
    { deployment: "pancake", hops: 1, input: "C", output: "A" },
    { deployment: "pancake", hops: 2, input: "A", output: "C" },
    { deployment: "pancake", hops: 2, input: "C", output: "A" },
    { deployment: "uni", hops: 1, input: "A", output: "C" },
    { deployment: "uni", hops: 1, input: "C", output: "A" },
    { deployment: "uni", hops: 2, input: "A", output: "C" },
    { deployment: "uni", hops: 2, input: "C", output: "A" },
  ]);
});

test("default E2E only lists scenarios without a signer or reachable engine", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "epeius-e2e-"));
  try {
    const path = join(temporary, "runtime.toml");
    await writeFile(
      path,
      `
[terminal]
default_chain = "base-sepolia"
engine_url = "http://127.0.0.1:1"
search_budget_ms = 2000
[chains.base-sepolia]
chain_id = 84532
execution_enabled = true
[chains.base-sepolia.deployments.uni]
kind = "uniswap-v3"
[chains.base-sepolia.deployments.pancake]
kind = "pancake-v3"
`,
    );
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "e2e.ts"), "--config", path],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const result = JSON.parse(output);
      expect(result.broadcast).toBe(false);
      expect(result.scenarios).toHaveLength(8);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
