import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { maxInt24, minInt24 } from "viem";
import { PrepareExecutionResponseSchema } from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { configureExecution } from "./index";
import { slipstream, slipstreamData, slipstreamPath } from "./slipstream";

const address = (digit: string) => `0x${digit.repeat(40)}`;

function route(spacing: number) {
  return create(PrepareExecutionResponseSchema, {
    amountInAtomic: "11",
    amountOutMinimumAtomic: "19",
    deadlineUnix: "123",
    tokenIn: address("1"),
    tokenOut: address("2"),
    recipient: address("3"),
    route: {
      provider: "aerodrome-slipstream",
      deploymentId: "slip",
      amountOutAtomic: "20",
      legs: [
        {
          tokenIn: address("1"),
          tokenOut: address("2"),
          pool: address("4"),
          selector: { case: "tickSpacing", value: spacing },
        },
      ],
    },
  });
}

test("Slipstream path uses signed three-byte two's-complement tick spacing", () => {
  expect(
    slipstreamPath(
      route(-1).route as NonNullable<ReturnType<typeof route>["route"]>,
    ),
  ).toBe(`${address("1")}ffffff${address("2").slice(2)}` as `0x${string}`);
  expect(
    slipstreamPath(
      route(Number(minInt24)).route as NonNullable<
        ReturnType<typeof route>["route"]
      >,
    ),
  ).toBe(`${address("1")}800000${address("2").slice(2)}` as `0x${string}`);
  expect(
    slipstreamPath(
      route(Number(maxInt24)).route as NonNullable<
        ReturnType<typeof route>["route"]
      >,
    ),
  ).toBe(`${address("1")}7fffff${address("2").slice(2)}` as `0x${string}`);
  expect(() =>
    slipstreamPath(
      route(Number(minInt24) - 1).route as NonNullable<
        ReturnType<typeof route>["route"]
      >,
    ),
  ).toThrow();
  expect(() =>
    slipstreamPath(
      route(Number(maxInt24) + 1).route as NonNullable<
        ReturnType<typeof route>["route"]
      >,
    ),
  ).toThrow();
});

test("Slipstream independently admits config and exact router calldata", () => {
  const prepared = route(100);
  const router = address("9");
  const implementation = slipstream({
    router,
    options: { tick_spacings: [100] },
  });
  const terms = implementation.plan(prepared, [address("1"), address("2")]);
  expect(terms.target).toBe(router);
  expect(terms.spender).toBe(router);
  const castVector =
    "0xc04b8d59000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000000000000b0000000000000000000000000000000000000000000000000000000000000013000000000000000000000000000000000000000000000000000000000000002b11111111111111111111111111111111111111110000642222222222222222222222222222222222222222000000000000000000000000000000000000000000";
  expect(terms.data).toBe(castVector);
  expect(slipstreamData(prepared)).toBe(castVector);
  expect(terms.routeDetails[0][0]).toContain("tick spacing: 100");
  expect(() =>
    slipstream({ router, fees: [100], options: { tick_spacings: [100] } }),
  ).toThrow();
  expect(() =>
    slipstream({
      router: address("0"),
      options: { tick_spacings: [100] },
    }),
  ).toThrow();
  expect(() =>
    slipstream({ router, fees: [], options: { tick_spacings: [100] } }),
  ).toThrow();
  expect(() =>
    slipstream({ router, options: { tick_spacings: [100, 100] } }),
  ).toThrow();
  expect(() => slipstream({ router, options: {} })).toThrow();
  expect(() =>
    slipstream({ router, options: { tick_spacings: [100], unknown: true } }),
  ).toThrow();
  expect(() =>
    configureExecution({
      tokens: [address("1"), address("2")],
      chainId: 1,
      deployments: {
        slip: {
          kind: "aerodrome-slipstream",
          router,
          options: { tick_spacings: [100] },
        },
      },
    }),
  ).not.toThrow();
  expect(() =>
    configureExecution({
      tokens: [address("1"), address("2")],
      deployments: { unknown: { kind: "unknown", router } },
    }),
  ).toThrow("Unsupported provider: unknown.");
  const legacyTopLevelOptions = {
    tokens: [address("1"), address("2")],
    deployments: {
      slip: {
        kind: "aerodrome-slipstream",
        router,
        tick_spacings: [100],
        options: { tick_spacings: [100] },
      },
    },
  } as unknown as Parameters<typeof configureExecution>[0];
  expect(() => configureExecution(legacyTopLevelOptions)).toThrow();

  const wrongProvider = route(100);
  if (wrongProvider.route) wrongProvider.route.provider = "uniswap-v3";
  expect(() =>
    implementation.plan(wrongProvider, [address("1"), address("2")]),
  ).toThrow();

  const wrongSpacing = route(500);
  expect(() =>
    implementation.plan(wrongSpacing, [address("1"), address("2")]),
  ).toThrow();

  const wrongToken = route(100);
  expect(() => implementation.plan(wrongToken, [address("1")])).toThrow();
});

test("provider registry rejects inherited object properties", () => {
  expect(() =>
    configureExecution({
      tokens: [address("1"), address("2")],
      deployments: {
        inherited: { kind: "constructor", router: address("9") },
      },
    }),
  ).toThrow("Unsupported provider: constructor.");
});
