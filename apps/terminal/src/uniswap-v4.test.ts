import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { encodeFunctionData } from "viem";
import { permit2Abi } from "../../../generated/abi";
import {
  OnChainPermissionSchema,
  PreparationStatus,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { validatePreparation } from "./execution-policy";
import { configureExecution } from "./protocols";
import { uniswapV4Data } from "./protocols/uniswap-v4";

const weth = "0x4200000000000000000000000000000000000006";
const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const router = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const sender = "0x1111111111111111111111111111111111111111";
const pool = {
  currency0: weth,
  currency1: usdc,
  feePips: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000",
};
const rawDeployment = {
  kind: "uniswap-v4" as const,
  quoter: "0x2222222222222222222222222222222222222222",
  router,
  options: {
    pool_manager: "0x3333333333333333333333333333333333333333",
    state_view: "0x4444444444444444444444444444444444444444",
    permit2,
    pools: [
      {
        currency0: weth,
        currency1: usdc,
        fee_pips: 500,
        tick_spacing: 10,
        hooks: pool.hooks,
      },
    ],
  },
};

function prepared() {
  return create(PrepareExecutionResponseSchema, {
    status: PreparationStatus.READY,
    preparationId: "p-v4",
    expiresAtUnix: "1777777700",
    deadlineUnix: "1777777777",
    amountInAtomic: "1000000000000000000",
    amountOutMinimumAtomic: "2000000000",
    tokenIn: weth,
    tokenOut: usdc,
    recipient: sender,
    route: {
      routeId: "v4:pool",
      provider: "uniswap-v4",
      deploymentId: "v4",
      amountOutAtomic: "2035623410",
      legs: [
        {
          pool: "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0",
          tokenIn: weth,
          tokenOut: usdc,
          uniswapV4PoolKey: {
            currency0: weth,
            currency1: usdc,
            feePips: 500,
            tickSpacing: 10,
            hooks: pool.hooks,
          },
        },
      ],
    },
  });
}

test("terminal reconstructs reviewed V4 action bytes and Permit2 permission", () => {
  const p = prepared();
  const data = uniswapV4Data(p, pool);
  expect(data).not.toBe(
    "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000069f6bc7100000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000380000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000077359400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000042000000000000000000000000000000000000060000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000040000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000077359400",
  );
  expect(Buffer.from(data.slice(2), "hex")).toHaveLength(1124);
  expect(
    createHash("sha256")
      .update(Buffer.from(data.slice(2), "hex"))
      .digest("hex"),
  ).toBe("db25857dd02bc68ee7c058200a182fee1c552394b4208135792021fde1661de1");
  const expiration = 1777779577;
  p.status = PreparationStatus.APPROVAL_REQUIRED;
  const permission = create(OnChainPermissionSchema, {
    target: permit2,
    token: weth,
    spender: router,
    amountAtomic: p.amountInAtomic,
    expirationUnix: String(expiration),
    transaction: {
      chainId: "8453",
      from: sender,
      to: permit2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [weth, router, 1_000_000_000_000_000_000n, expiration],
      }),
      valueAtomic: "0",
      gasLimit: "100000",
    },
  });
  if (!permission.transaction)
    throw new Error("missing test permission transaction");
  p.onChainPermission = permission;
  const plan = validatePreparation(
    p,
    sender,
    "8453",
    175,
    configureExecution({
      tokens: [weth, usdc],
      deployments: { v4: rawDeployment },
    }),
    1777777000,
  );
  expect(plan.action).toBe("approval");
  expect(plan.transaction).toBe(permission.transaction);

  permission.expirationUnix = "1777779578";
  permission.transaction.data = encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [weth, router, 1_000_000_000_000_000_000n, 1777779578],
  });
  expect(() =>
    validatePreparation(
      p,
      sender,
      "8453",
      175,
      configureExecution({
        tokens: [weth, usdc],
        deployments: { v4: rawDeployment },
      }),
      1777777000,
    ),
  ).toThrow("Permit2 permission");

  permission.expirationUnix = String(expiration);
  permission.transaction.data = encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [weth, router, 1_000_000_000_000_000_000n, expiration],
  });
  permission.spender = permit2;
  expect(() =>
    validatePreparation(
      p,
      sender,
      "8453",
      175,
      configureExecution({
        tokens: [weth, usdc],
        deployments: { v4: rawDeployment },
      }),
      1777777000,
    ),
  ).toThrow("Permit2 permission");
});

test("V4 config rejects missing, unknown, misplaced, and inapplicable provider options", () => {
  const config = (deployment: Record<string, unknown>) => () =>
    configureExecution({
      tokens: [weth, usdc],
      deployments: {
        v4: deployment as Parameters<
          typeof configureExecution
        >[0]["deployments"][string],
      },
    });
  expect(config(rawDeployment)).not.toThrow();
  expect(config({ kind: "uniswap-v4", router })).toThrow();
  expect(
    config({
      ...rawDeployment,
      options: { ...rawDeployment.options, unknown: true },
    }),
  ).toThrow();
  expect(
    config({
      kind: "uniswap-v4",
      router,
      permit2,
      options: rawDeployment.options,
    }),
  ).toThrow();
  expect(
    config({
      kind: "uniswap-v3",
      router,
      fees: [500],
      options: rawDeployment.options,
    }),
  ).toThrow();
});
