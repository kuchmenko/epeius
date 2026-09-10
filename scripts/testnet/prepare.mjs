import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
execFileSync("forge", ["build", "--root", resolve(root, "contracts/pancake")], {
  stdio: "inherit",
});
const pool = JSON.parse(
  readFileSync(
    resolve(local, "pancake-out/PancakeV3Pool.sol/PancakeV3Pool.json"),
  ),
);
const actual = execFileSync("cast", ["keccak", pool.bytecode.object], {
  encoding: "utf8",
}).trim();
if (actual !== hash) throw new Error(`Compiled pool hash mismatch: ${actual}`);
const npmPool = JSON.parse(
  readFileSync(
    resolve(
      root,
      "scripts/testnet/node_modules/@pancakeswap/v3-core/artifacts/contracts/PancakeV3Pool.sol/PancakeV3Pool.json",
    ),
  ),
);
if (pool.bytecode.object !== npmPool.bytecode)
  throw new Error("Compiled pool differs from pinned released artifact");
const bootstrap = JSON.parse(
  readFileSync(
    resolve(local, "pancake-out/PancakeBootstrap.sol/PancakeBootstrap.json"),
  ),
);
writeFileSync(
  resolve(local, "PancakeBootstrap.json"),
  JSON.stringify(
    {
      abi: bootstrap.abi,
      bytecode: { object: bootstrap.bytecode.object },
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
