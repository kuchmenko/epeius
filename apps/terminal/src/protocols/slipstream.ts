import {
  type Address,
  encodeFunctionData,
  encodePacked,
  isAddress,
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

export function slipstreamPath(route: RouteQuote) {
  if (
    !route.legs.length ||
    route.legs.length > 2 ||
    route.legs.some(
      (leg) =>
        leg.selector.case !== "tickSpacing" ||
        !Number.isInteger(leg.selector.value) ||
        leg.selector.value < -8388608 ||
        leg.selector.value > 8388607,
    )
  )
    throw new Error("Invalid route terms.");
  return encodePacked(
    [...route.legs.flatMap(() => ["address", "bytes3"] as const), "address"],
    [
      ...route.legs.flatMap((leg) => [
        leg.tokenIn as Address,
        `0x${((leg.selector.case === "tickSpacing" ? leg.selector.value : 0) & 0xffffff).toString(16).padStart(6, "0")}` as `0x${string}`,
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
  tick_spacings?: number[];
}) {
  const router = `0x${raw.router?.replace(/^0x/i, "") ?? ""}`.toLowerCase();
  if (
    !isAddress(router, { strict: false }) ||
    router !== "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5" ||
    raw.fees !== undefined ||
    !Array.isArray(raw.tick_spacings) ||
    !raw.tick_spacings.length ||
    new Set(raw.tick_spacings).size !== raw.tick_spacings.length ||
    !raw.tick_spacings.every(
      (v) => Number.isInteger(v) && v >= -8388608 && v <= 8388607,
    )
  )
    throw new Error("Local execution deployment is invalid.");
  const deployment: Deployment = {
    kind: "aerodrome-slipstream",
    router,
    tickSpacings: [...raw.tick_spacings],
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
