import { expect, test } from "bun:test";
import { keccak256 } from "viem";
import {
  type AtomicExecutorPlan,
  atomicV1ExecutorCalldata,
  atomicV1ExecutorPlanHash,
} from "./protocols/atomic-v1";

const fixture = await Bun.file(
  "contracts/fixtures/executor-v2-composition.json",
).json();
const address = (value: number) =>
  `0x${BigInt(value).toString(16).padStart(40, "0")}` as `0x${string}`;

function plan(counts: number[]): AtomicExecutorPlan {
  let index = 0;
  const amounts = counts.map((_, branch) => BigInt(branch + 1));
  amounts[amounts.length - 1] +=
    100n - amounts.reduce((sum, value) => sum + value, 0n);
  return {
    tokenIn: address(0x11),
    tokenOut: address(0xff),
    amountIn: 100n,
    minAmountOut: 1n,
    deadline: 2_000_000_000n,
    branches: counts.map((count, branch) => ({
      amountIn: amounts[branch],
      minAmountOut: 1n,
      operations: Array.from({ length: count }, (_, local) => {
        const current = index++;
        return {
          kind: ((current % 5) + 1) as 1 | 2 | 3 | 4 | 5,
          tokenOut: address(local === count - 1 ? 0xff : 0x20 + current),
          fee: current % 5 < 2 ? 101 + current : 0,
          tickSpacing:
            current % 5 === 2 || current % 5 === 4 ? 10 + current : 0,
          poolId: `0x${BigInt(current % 5 === 3 ? current + 1 : 0)
            .toString(16)
            .padStart(64, "0")}`,
        };
      }),
    })),
  };
}

test("generic ExecutorV2 profiles match independent Cast calldata and hashes", () => {
  for (const profile of fixture.profiles) {
    const value = plan(profile.branches);
    const calldata = atomicV1ExecutorCalldata(value);
    expect(calldata).toBe(profile.calldata);
    expect(keccak256(calldata)).toBe(profile.calldataKeccak);
    expect(
      atomicV1ExecutorPlanHash({
        chainId: 8453n,
        executor: address(0x44),
        sender: address(0x55),
        plan: value,
      }),
    ).toBe(profile.executorPlanHash);
  }
});
