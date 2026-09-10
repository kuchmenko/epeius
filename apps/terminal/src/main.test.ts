import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetStatusResponseSchema,
  QuoteFinalSchema,
  type QuoteRequest,
  QuoteRequestSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { readConfig, validateEngineUrl } from "./config";
import { decimalToAtomic, parseAtomic, resolveToken } from "./tokens";

const token = (symbol: string, address: string, decimals: number) => ({
  $typeName: "epeius.quote.v1.Token" as const,
  symbol,
  address,
  decimals,
});

test("decimal amounts convert exactly at 0, 6, and 18 decimals", () => {
  expect(decimalToAtomic("7", 0)).toBe("7");
  expect(decimalToAtomic("1.000001", 6)).toBe("1000001");
  expect(decimalToAtomic("0.000000000000000001", 18)).toBe("1");
  expect(decimalToAtomic("9007199254740993.123456", 6)).toBe(
    "9007199254740993123456",
  );
  expect(() => decimalToAtomic("1.0", 0)).toThrow("0 decimal");
  expect(() => decimalToAtomic("0.0000001", 6)).toThrow("6 decimal");
  expect(() => decimalToAtomic("0", 18)).toThrow("positive");
  expect(decimalToAtomic(((1n << 256n) - 1n).toString(), 0)).toHaveLength(78);
  expect(() => decimalToAtomic((1n << 256n).toString(), 0)).toThrow("uint256");
  for (const value of ["-1", "1e3", "01", "1."])
    expect(() => decimalToAtomic(value, 6)).toThrow();
});

test("atomic amounts enforce positive uint256", () => {
  expect(parseAtomic(((1n << 256n) - 1n).toString())).toHaveLength(78);
  for (const value of ["0", "01", "-1", "1.2", (1n << 256n).toString()])
    expect(() => parseAtomic(value)).toThrow("uint256");
});

test("token lookup is case-insensitive and rejects unknown or ambiguous values", () => {
  const tokens = [
    token("USDC", `0x${"1".repeat(40)}`, 6),
    token("same", `0x${"2".repeat(40)}`, 18),
    token("SAME", `0x${"3".repeat(40)}`, 18),
  ];
  expect(resolveToken("usdc", tokens).decimals).toBe(6);
  expect(resolveToken(`0x${"1".repeat(40)}`, tokens).symbol).toBe("USDC");
  expect(() => resolveToken("same", tokens)).toThrow("ambiguous");
  expect(() => resolveToken("ETH", tokens)).toThrow("not supported");
  expect(() => resolveToken(`0x${"4".repeat(40)}`, tokens)).toThrow(
    "not supported",
  );
});

test("config reads chain token metadata and sanitizes parse errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-terminal-"));
  try {
    const path = join(directory, "custom.toml");
    await Bun.write(
      path,
      `[terminal]\ndefault_chain='base'\nengine_url='http://127.0.0.1:8080'\nsearch_budget_ms=2000\n[chains.base]\nchain_id=1\n[[chains.base.tokens]]\naddress='${"1".repeat(40)}'\nsymbol='AAA'\ndecimals=18\n`,
    );
    expect(await readConfig(path)).toMatchObject({
      defaultChain: "base",
      searchBudgetMs: 2000,
      chains: { base: { tokens: [{ symbol: "AAA", decimals: 18 }] } },
    });
    await Bun.write(path, "secret = '");
    await expect(readConfig(path)).rejects.not.toThrow("secret");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("engine URL errors do not echo secrets", () => {
  for (const value of [
    "secret",
    "https://user:secret@example.com",
    "http://x/?secret",
  ])
    try {
      validateEngineUrl(value);
      throw new Error("accepted URL");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
});

test("help needs no config and removed flags give migration errors", async () => {
  for (const [args, code, text] of [
    [["--help"], 0, "prepare previews without sending"],
    [["quote", "--sender", "x"], 1, "--sender was removed"],
    [["quote", "--slippage-bps", "50"], 1, "--slippage-bps was removed"],
    [["execute"], 1, "Provide --keystore"],
  ] as const) {
    const child = Bun.spawn(["bun", "apps/terminal/src/main.ts", ...args], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(code);
    expect(output + error).toContain(text);
  }
});

test("missing global option values return guarded text and JSON errors", async () => {
  for (const [args, json] of [
    [["status", "--config"], false],
    [["status", "--json", "--engine-url"], true],
  ] as const) {
    const child = Bun.spawn(["bun", "apps/terminal/src/main.ts", ...args], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(error).not.toContain("apps/terminal/src/main.ts:");
    if (json)
      expect(JSON.parse(error).error.message).toBe(
        "Provide a value for --engine-url.",
      );
    else expect(error.trim()).toBe("Provide a value for --config.");
  }
});

test("command detection ignores option values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-command-"));
  const config = join(directory, "epeius.toml");
  await Bun.write(
    config,
    `[terminal]\ndefault_chain='testnet'\nengine_url='http://127.0.0.1:1'\nsearch_budget_ms=2000\n[chains.testnet]\n[[chains.testnet.tokens]]\naddress='${"1".repeat(40)}'\nsymbol='AAA'\ndecimals=18\n`,
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      ["bun", "apps/terminal/src/main.ts", "--config", config, ...args],
      {
        cwd: join(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output: out + err, code };
  };
  try {
    const ordinary = await run([
      "execute",
      "--quote-id",
      "q1",
      "--slippage-bps",
      "50",
    ]);
    const commandNamedValue = await run([
      "execute",
      "--quote-id",
      "quote",
      "--slippage-bps",
      "50",
    ]);
    expect(ordinary.output).toContain("Provide --keystore");
    expect(commandNamedValue.output).toBe(ordinary.output);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("CLI resolves symbols and addresses, sends exact amounts, and handles complete, partial and empty JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "epeius-cli-"));
  const config = join(directory, "epeius.toml");
  const tokens = [
    token("AAA", `0x${"a".repeat(40)}`, 6),
    token("BBB", `0x${"b".repeat(40)}`, 18),
  ];
  const requests: QuoteRequest[] = [];
  let mode = "complete";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/GetStatus"))
        return new Response(
          toBinary(
            GetStatusResponseSchema,
            create(GetStatusResponseSchema, {
              chains: [
                {
                  key: "custom",
                  chainId: "123",
                  connected: true,
                  quotingSupported: true,
                  executionEnabled: true,
                  tokens:
                    mode === "input-decimals-mismatch"
                      ? [{ ...tokens[0], decimals: 30 }, tokens[1]]
                      : mode === "output-decimals-mismatch"
                        ? [tokens[0], { ...tokens[1], decimals: 30 }]
                        : mode === "address-mismatch"
                          ? [
                              { ...tokens[0], address: `0x${"c".repeat(40)}` },
                              tokens[1],
                            ]
                          : tokens,
                },
              ],
            }),
          ),
          { headers: { "content-type": "application/proto" } },
        );
      requests.push(
        fromBinary(
          QuoteRequestSchema,
          new Uint8Array(await request.arrayBuffer()),
        ),
      );
      return new Response(
        toBinary(
          QuoteFinalSchema,
          create(QuoteFinalSchema, {
            quoteId: "fixture",
            searchComplete: mode !== "partial",
            routes: mode === "empty" ? [] : [{ amountOutAtomic: "987654321" }],
          }),
        ),
        { headers: { "content-type": "application/proto" } },
      );
    },
  });
  await Bun.write(
    config,
    `[terminal]\ndefault_chain='custom'\nengine_url='${server.url}'\nsearch_budget_ms=1234\n[chains.custom]\nchain_id=123\n[[chains.custom.tokens]]\naddress='${"a".repeat(40)}'\nsymbol='AAA'\ndecimals=6\n[[chains.custom.tokens]]\naddress='${tokens[1].address}'\nsymbol='BBB'\ndecimals=18\n`,
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      ["bun", "apps/terminal/src/main.ts", "--config", config, ...args],
      {
        cwd: join(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  try {
    for (const next of ["complete", "partial", "empty"]) {
      mode = next;
      const result = await run([
        "quote",
        "--in",
        "aaa",
        "--out",
        tokens[1].address,
        "--amount",
        "9007199254740993.123456",
        "--json",
      ]);
      expect(result.code).toBe(next === "empty" ? 1 : 0);
      expect(JSON.parse(result.out).quoteId).toBe("fixture");
      expect(result.err.includes("Search was partial")).toBe(
        next === "partial",
      );
      expect(requests.at(-1)).toMatchObject({
        chain: "custom",
        chainId: "123",
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        amountInAtomic: "9007199254740993123456",
        searchBudgetMs: 1234,
      });
    }
    const atomic = await run([
      "quote",
      "--in",
      tokens[1].address,
      "--out",
      "AAA",
      "--amount-atomic",
      "19",
      "--search-budget-ms",
      "2147478647",
      "--json",
    ]);
    expect(atomic.err).not.toContain("TimeoutOverflow");
    expect(requests.at(-1)).toMatchObject({
      tokenIn: tokens[1].address,
      amountInAtomic: "19",
      searchBudgetMs: 2147478647,
    });
    for (const [nextMode, amountArgs] of [
      ["input-decimals-mismatch", ["--amount", "1"]],
      ["output-decimals-mismatch", ["--amount-atomic", "1"]],
      ["address-mismatch", ["--amount", "1"]],
    ] as const) {
      mode = nextMode;
      const before = requests.length;
      const mismatch = await run([
        "quote",
        "--in",
        "AAA",
        "--out",
        "BBB",
        ...amountArgs,
      ]);
      expect(mismatch.code).toBe(1);
      expect(mismatch.err).toContain("does not match local config");
      expect(requests.length).toBe(before);
    }
    mode = "input-decimals-mismatch";
    const executionMismatch = await run([
      "prepare",
      "--quote-id",
      "q1",
      "--route-id",
      "r1",
      "--keystore",
      "missing.json",
      "--password-file",
      "missing.txt",
    ]);
    expect(executionMismatch.code).toBe(1);
    expect(executionMismatch.err).toContain("does not match local config");
    mode = "complete";
    for (const amountArgs of [
      ["--amount", "1", "--amount-atomic", "1"],
      ["--amount", ""],
      ["--amount", "1", "--search-budget-ms", "2147478648"],
    ]) {
      const before = requests.length;
      expect(
        (await run(["quote", "--in", "AAA", "--out", "BBB", ...amountArgs]))
          .code,
      ).toBe(1);
      expect(requests.length).toBe(before);
    }
    const unavailableUrl = server.url.toString();
    await server.stop(true);
    const failure = await run([
      "status",
      "--engine-url",
      unavailableUrl,
      "--json",
    ]);
    expect(failure.code).toBe(1);
    expect(JSON.parse(failure.err).error.message).toContain("bun run engine");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true });
  }
});
