import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const local = resolve(root, ".testnet");
const repo = resolve(local, "pancake");
const commit = "986847948755cba528324d41be19480731c36c2a";
const hash =
  "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";
mkdirSync(local, { recursive: true });
if (!existsSync(repo)) {
  execFileSync(
    "git",
    ["clone", "https://github.com/pancakeswap/pancake-v3-contracts.git", repo],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", repo, "checkout", "--detach", commit]);
}
if (
  execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== commit ||
  execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim()
) {
  throw new Error("Pinned Pancake checkout differs or has local changes");
}
const input = {
  language: "Solidity",
  sources: {
    "PancakeBootstrap.sol": {
      content: readFileSync(
        resolve(root, "contracts/pancake/PancakeBootstrap.sol"),
        "utf8",
      ),
    },
  },
  settings: {
    optimizer: { enabled: true, runs: 400 },
    evmVersion: "istanbul",
    metadata: { bytecodeHash: "none" },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] },
    },
  },
};
const output = JSON.parse(
  solc.compile(JSON.stringify(input), {
    import: (path) => {
      const match = /^@pancakeswap\/(v3-core|v3-lm-pool)\/(.*)$/.exec(path);
      if (!match || match[2].includes(".."))
        return { error: `Unsupported import ${path}` };
      return {
        contents: readFileSync(
          resolve(repo, "projects", match[1], match[2]),
          "utf8",
        ),
      };
    },
  }),
);
for (const error of output.errors ?? [])
  if (error.severity === "error") throw new Error(error.formattedMessage);
const pool =
  output.contracts["@pancakeswap/v3-core/contracts/PancakeV3Pool.sol"]
    .PancakeV3Pool;
const actual = execFileSync(
  "cast",
  ["keccak", `0x${pool.evm.bytecode.object}`],
  { encoding: "utf8" },
).trim();
if (actual !== hash) throw new Error(`Compiled pool hash mismatch: ${actual}`);
const npmPool = JSON.parse(
  readFileSync(
    resolve(
      root,
      "scripts/testnet/node_modules/@pancakeswap/v3-core/artifacts/contracts/PancakeV3Pool.sol/PancakeV3Pool.json",
    ),
  ),
);
if (`0x${pool.evm.bytecode.object}` !== npmPool.bytecode)
  throw new Error("Compiled pool differs from pinned released artifact");
const bootstrap = output.contracts["PancakeBootstrap.sol"].PancakeBootstrap;
writeFileSync(
  resolve(local, "PancakeBootstrap.json"),
  JSON.stringify(
    {
      abi: bootstrap.abi,
      bytecode: { object: `0x${bootstrap.evm.bytecode.object}` },
    },
    null,
    2,
  ),
);
execFileSync("forge", ["build", "--root", resolve(root, "contracts")], {
  stdio: "inherit",
});
console.log(
  `Prepared authentic Pancake pool ${hash}; custom contracts built. No network writes.`,
);
