import { expect, test } from "bun:test";
import { smokeQuoteArgs } from "../../../scripts/smoke";
import { root } from "../../../scripts/tasks";
import { quoteClient } from "./client";
import { quoteInput } from "./main";

const args = smokeQuoteArgs.slice(1);
function changed(flag: string, value: string) {
  const copy = [...args];
  copy.splice(copy.indexOf(flag), 2, `${flag}=${value}`);
  return copy;
}

test("quote input preserves amounts above JS integer precision and distinct addresses", () => {
  const input = quoteInput(args, "base-mainnet");
  expect(input.amountInAtomic).toBe("9007199254740993");
  expect(input.sender).toBe(`0x${"1".repeat(40)}`);
  expect(input.recipient).toBe(`0x${"2".repeat(40)}`);
  expect(input.tokenIn).toBe("0x4200000000000000000000000000000000000006");
  expect(input.tokenOut).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  expect(input.slippageBps).toBe(37);
  expect(input.searchBudgetMs).toBe(1200);
  expect(
    quoteInput(
      changed("--amount-atomic", ((1n << 256n) - 1n).toString()),
      "base-sepolia",
    ).amountInAtomic,
  ).toHaveLength(78);
});

test("invalid units, bounds, addresses, and environments are rejected", () => {
  for (const amount of [
    "0",
    "-1",
    "1.2",
    "1e6",
    "01",
    (1n << 256n).toString(),
  ]) {
    expect(() =>
      quoteInput(changed("--amount-atomic", amount), "base-mainnet"),
    ).toThrow("uint256");
  }
  expect(
    quoteInput(changed("--slippage-bps", "0"), "base-mainnet").slippageBps,
  ).toBe(0);
  expect(
    quoteInput(changed("--slippage-bps", "10000"), "base-mainnet").slippageBps,
  ).toBe(10000);
  expect(
    quoteInput(changed("--search-budget-ms", "2147478647"), "base-mainnet")
      .searchBudgetMs,
  ).toBe(2147478647);
  for (const [flag, value] of [
    ["--slippage-bps", "10001"],
    ["--search-budget-ms", "0"],
    ["--search-budget-ms", "2147478648"],
    ["--search-budget-ms", "4294967296"],
    ["--sender", "0x123"],
  ]) {
    expect(() => quoteInput(changed(flag, value), "base-mainnet")).toThrow();
  }
  expect(() => quoteInput(args, "base-fork")).toThrow("environment");
  expect(() =>
    quoteInput([...args, "--unknown", "secret"], "base-mainnet"),
  ).toThrow("Invalid quote arguments");
});

test("engine URL validation never echoes credentials", () => {
  for (const url of [
    "https://user:secret@example.com",
    "http://example.com/?key=secret",
    "secret",
    "file:///secret",
  ]) {
    try {
      quoteClient(url);
      throw new Error("accepted invalid URL");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).toContain("EPEIUS_ENGINE_URL");
    }
  }
});

test("help is available without configuration and execute cannot send", async () => {
  for (const [arguments_, expected] of [
    [["--help"], 0],
    [["execute", "q", "--route", "r"], 1],
  ] as const) {
    const cli = Bun.spawn(["bun", "apps/terminal/src/main.ts", ...arguments_], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect(code).toBe(expected);
    expect(out + err).toContain("not implemented");
  }
});
