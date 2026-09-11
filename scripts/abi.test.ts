import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { erc20Abi, toEventSelector, toFunctionSelector } from "viem";
import {
  aerodromeSlipstreamFactoryAbi,
  aerodromeSlipstreamQuoterV2Abi,
  aerodromeSlipstreamRouterAbi,
  erc20Abi as canonicalERC20,
  pancakeV3RouterAbi,
  uniswapRouter02Abi,
} from "../generated/abi";
import { abiFiles, syncAbis } from "./abi";

test("canonical ABI projections regenerate into an empty build directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "epeius-abi-output-"));
  try {
    const expected = await abiFiles();
    await syncAbis(false, temporary);
    for (const [path, text] of expected)
      expect(await readFile(join(temporary, path), "utf8")).toBe(text);
    await syncAbis(true, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await syncAbis(true);
});

test("canonical source changes require provenance review", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "epeius-abi-"));
  try {
    await cp(
      resolve(import.meta.dir, "../contracts/abi"),
      join(temporary, "contracts/abi"),
      { recursive: true },
    );
    const source = join(temporary, "contracts/abi/Executor.json");
    await writeFile(source, `${await readFile(source, "utf8")} `);
    await expect(abiFiles(temporary)).rejects.toThrow(
      "Canonical ABI hash differs: Executor",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("official ERC20 ABI agrees with viem on shared functions and events", () => {
  for (const item of canonicalERC20) {
    if (item.type === "function") {
      const other = erc20Abi.find(
        (entry) => entry.type === "function" && entry.name === item.name,
      );
      expect(other?.type).toBe("function");
      if (other?.type !== "function") throw new Error("Missing ERC20 function");
      expect(toFunctionSelector(item)).toBe(toFunctionSelector(other));
      expect(item.outputs.map((output) => output.type).join(",")).toBe(
        other.outputs.map((output) => output.type).join(","),
      );
    } else if (item.type === "event") {
      const other = erc20Abi.find(
        (entry) => entry.type === "event" && entry.name === item.name,
      );
      if (other?.type !== "event") throw new Error("Missing ERC20 event");
      expect(toEventSelector(item)).toBe(toEventSelector(other));
      expect(item.inputs.map((input) => input.indexed)).toEqual(
        other.inputs.map((input) => input.indexed),
      );
    }
  }
});

test("router versions retain their distinct reviewed exactInput selectors", () => {
  const uni = uniswapRouter02Abi.find(
    (item) => item.type === "function" && item.name === "exactInput",
  );
  const pancake = pancakeV3RouterAbi.find(
    (item) => item.type === "function" && item.name === "exactInput",
  );
  if (uni?.type !== "function" || pancake?.type !== "function")
    throw new Error("Missing router function");
  // Existing Cast/Go vectors use these different tuple layouts.
  expect(toFunctionSelector(uni)).toBe("0xb858183f");
  expect(toFunctionSelector(pancake)).toBe("0xc04b8d59");
});

test("Slipstream ABIs retain signed spacing and Initial tuple order", () => {
  const pool = aerodromeSlipstreamFactoryAbi.find(
    (item) => item.type === "function" && item.name === "getPool",
  );
  const quote = aerodromeSlipstreamQuoterV2Abi.find(
    (item) => item.type === "function" && item.name === "quoteExactInputSingle",
  );
  const swap = aerodromeSlipstreamRouterAbi.find(
    (item) => item.type === "function" && item.name === "exactInput",
  );
  if (
    pool?.type !== "function" ||
    quote?.type !== "function" ||
    swap?.type !== "function"
  )
    throw new Error("Missing Slipstream function");
  expect(pool.inputs.map((input) => input.type)).toEqual([
    "address",
    "address",
    "int24",
  ]);
  expect(quote.inputs[0].components?.map((input) => input.type)).toEqual([
    "address",
    "address",
    "uint256",
    "int24",
    "uint160",
  ]);
  expect(swap.inputs[0].components?.map((input) => input.type)).toEqual([
    "bytes",
    "address",
    "uint256",
    "uint256",
    "uint256",
  ]);
  expect(toFunctionSelector(swap)).toBe("0xc04b8d59");
});
