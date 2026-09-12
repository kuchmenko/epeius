import {
  type Address,
  encodeFunctionData,
  encodePacked,
  isAddress,
  maxInt24,
  minInt24,
} from "viem";
import { aerodromeSlipstreamRouterAbi } from "../../../../generated/abi";
import type {
  PrepareExecutionResponse,
  RouteQuote,
} from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { uint256Decimal } from "../execution-policy";
import { directV3Terms } from "./v3";

type Deployment = {
  kind: string;
  router: string;
  tickSpacings: number[];
};

const MIN_TICK_SPACING = Number(minInt24);
const MAX_TICK_SPACING = Number(maxInt24);

export function slipstreamPath(route: RouteQuote) {
  if (
    !route.legs.length ||
    route.legs.length > 2 ||
    route.legs.some(
      (leg) =>
        leg.selector.case !== "tickSpacing" ||
        !Number.isInteger(leg.selector.value) ||
        leg.selector.value < MIN_TICK_SPACING ||
        leg.selector.value > MAX_TICK_SPACING,
    )
  )
    throw new Error("Invalid route terms.");
  return encodePacked(
    [...route.legs.flatMap(() => ["address", "int24"] as const), "address"],
    [
      ...route.legs.flatMap((leg) => [
        leg.tokenIn as Address,
        leg.selector.case === "tickSpacing" ? leg.selector.value : 0,
      ]),
      route.legs.at(-1)?.tokenOut as Address,
    ],
  );
}

export function slipstreamData(p: PrepareExecutionResponse) {
  if (!p.route) throw new Error("Invalid route terms.");
  return encodeFunctionData({
    abi: aerodromeSlipstreamRouterAbi,
    functionName: "exactInput",
    args: [
      {
        path: slipstreamPath(p.route),
        recipient: p.recipient as Address,
        deadline: uint256Decimal(p.deadlineUnix, "Deadline"),
        amountIn: uint256Decimal(p.amountInAtomic, "Input amount"),
        amountOutMinimum: uint256Decimal(
          p.amountOutMinimumAtomic,
          "Minimum output amount",
        ),
      },
    ],
  });
}

export function slipstream(raw: {
  router?: string;
  fees?: number[];
  options?: unknown;
}) {
  const router = `0x${raw.router?.replace(/^0x/i, "") ?? ""}`.toLowerCase();
  const options = raw.options as Record<string, unknown> | undefined;
  const tickSpacings = options?.tick_spacings;
  if (
    !isAddress(router, { strict: false }) ||
    raw.fees !== undefined ||
    !options ||
    Object.keys(options).length !== 1 ||
    !Array.isArray(tickSpacings) ||
    !tickSpacings.length ||
    new Set(tickSpacings).size !== tickSpacings.length ||
    !tickSpacings.every(
      (v) =>
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= MIN_TICK_SPACING &&
        v <= MAX_TICK_SPACING,
    )
  )
    throw new Error("Local execution deployment is invalid.");
  const deployment: Deployment = {
    kind: "aerodrome-slipstream",
    router,
    tickSpacings: [...tickSpacings],
  };
  return {
    ...deployment,
    plan(p: PrepareExecutionResponse, tokens: string[]) {
      const route = p.route;
      if (
        !route?.legs.length ||
        route.legs.length > 2 ||
        route.provider !== deployment.kind
      )
        throw new Error("Invalid route terms.");
      const same = (a: string, b: string) =>
        a.toLowerCase() === b.toLowerCase();
      const configured = new Set(tokens.map((v) => v.toLowerCase()));
      if (
        !same(route.legs[0].tokenIn, p.tokenIn) ||
        !same(route.legs.at(-1)?.tokenOut ?? "", p.tokenOut) ||
        (route.legs.length === 2 &&
          !same(route.legs[0].tokenOut, route.legs[1].tokenIn)) ||
        !route.legs.every(
          (l) =>
            l.selector.case === "tickSpacing" &&
            deployment.tickSpacings.includes(l.selector.value) &&
            configured.has(l.tokenIn.toLowerCase()) &&
            configured.has(l.tokenOut.toLowerCase()),
        )
      )
        throw new Error(
          "Route is not allowed by local token and deployment config.",
        );
      const terms = directV3Terms(p, deployment, slipstreamData(p));
      terms.routeDetails = [
        route.legs.map(
          (l) => `Pool: ${l.pool}; tick spacing: ${l.selector.value}`,
        ),
      ];
      return terms;
    },
  };
}
