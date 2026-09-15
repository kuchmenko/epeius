import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Cast is independent of the production Go/TypeScript ABI encoders.
const planType =
  "(address,address,uint256,uint256,uint256,(uint256,uint256,(uint8,address,uint24,int24,bytes32)[])[])";
const executeSignature = `execute(${planType})`;
const hashSignature = `f(uint256,uint256,address,address,${planType})`;
const zero = `0x${"00".repeat(32)}`;
const address = (value) => `0x${BigInt(value).toString(16).padStart(40, "0")}`;
const operation = (index, final) =>
  `(${(index % 5) + 1},${address(final ? 0xff : 0x20 + index)},${index % 5 < 2 ? 101 + index : 0},${index % 5 === 2 || index % 5 === 4 ? 10 + index : 0},${
    index % 5 === 3
      ? `0x${BigInt(index + 1)
          .toString(16)
          .padStart(64, "0")}`
      : zero
  })`;

const profiles = [
  { name: "long-8-low-entropy", branches: [8] },
  { name: "unequal-branches-9-high-entropy", branches: [4, 5] },
  { name: "four-branches-10", branches: [1, 2, 3, 4] },
  { name: "boundary-12-all-kinds", branches: [3, 3, 3, 3] },
].map((profile) => {
  let operationIndex = 0;
  const amounts = profile.branches.map((_, index) => index + 1);
  amounts[amounts.length - 1] +=
    100 - amounts.reduce((sum, value) => sum + value, 0);
  const branches = profile.branches.map((count, branchIndex) => {
    const operations = Array.from({ length: count }, (_, localIndex) => {
      const value = operation(operationIndex, localIndex === count - 1);
      operationIndex++;
      return value;
    });
    return `(${amounts[branchIndex]},1,[${operations.join(",")}])`;
  });
  const plan = `(${address(0x11)},${address(0xff)},100,1,2000000000,[${branches.join(",")}])`;
  const calldata = execFileSync("cast", ["calldata", executeSignature, plan], {
    encoding: "utf8",
  }).trim();
  const encodedHashInput = execFileSync(
    "cast",
    [
      "abi-encode",
      hashSignature,
      "2",
      "8453",
      address(0x44),
      address(0x55),
      plan,
    ],
    { encoding: "utf8" },
  ).trim();
  return {
    ...profile,
    calldata,
    calldataBytes: (calldata.length - 2) / 2,
    calldataKeccak: execFileSync("cast", ["keccak", calldata], {
      encoding: "utf8",
    }).trim(),
    executorPlanHash: execFileSync("cast", ["keccak", encodedHashInput], {
      encoding: "utf8",
    }).trim(),
  };
});

writeFileSync(
  new URL("executor-v2-composition.json", import.meta.url),
  `${JSON.stringify({ executeSignature, selector: execFileSync("cast", ["sig", executeSignature], { encoding: "utf8" }).trim(), profiles }, null, 2)}\n`,
);
