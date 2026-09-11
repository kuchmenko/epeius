import { type Address, encodePacked, isAddress } from "viem";
import type {
  PrepareExecutionResponse,
  RouteQuote,
} from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { type SwapTerms, uint256Decimal } from "../execution-policy";

export type V3Deployment = { kind: string; router: string; fees: number[] };

export function v3Deployment(
  raw: { router?: string; fees?: number[] },
  kind: string,
): V3Deployment {
  const router = `0x${raw.router?.replace(/^0x/i, "") ?? ""}`;
  if (
    !isAddress(router, { strict: false }) ||
    !Array.isArray(raw.fees) ||
    !raw.fees.every(
      (fee) => Number.isInteger(fee) && fee >= 0 && fee < 1_000_000,
    )
  )
    throw new Error("Local execution deployment is invalid.");
  return { kind, router: router.toLowerCase(), fees: [...raw.fees] };
}

export function admitV3Route(
  route: RouteQuote,
  p: PrepareExecutionResponse,
  deployment: V3Deployment,
  tokens: string[],
) {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !route.legs.length ||
    route.legs.length > 2 ||
    !same(route.legs[0].tokenIn, p.tokenIn) ||
    !same(route.legs[route.legs.length - 1].tokenOut, p.tokenOut) ||
    (route.legs.length === 2 &&
      !same(route.legs[0].tokenOut, route.legs[1].tokenIn))
  )
    throw new Error("Invalid route terms.");
  const configured = new Set(tokens.map((token) => token.toLowerCase()));
  if (
    route.provider !== deployment.kind ||
    !route.legs.every(
      (leg) =>
        leg.selector.case === "feePips" &&
        Number.isInteger(leg.selector.value) &&
        leg.selector.value >= 0 &&
        leg.selector.value < 1_000_000 &&
        deployment.fees.includes(leg.selector.value) &&
        configured.has(leg.tokenIn.toLowerCase()) &&
        configured.has(leg.tokenOut.toLowerCase()),
    )
  )
    throw new Error(
      "Route is not allowed by local token and deployment config.",
    );
}

export function v3Path(route: RouteQuote) {
  if (
    !route.legs.length ||
    route.legs.some((leg) => leg.selector.case !== "feePips")
  )
    throw new Error("Invalid route terms.");
  return encodePacked(
    [...route.legs.flatMap(() => ["address", "uint24"]), "address"],
    [
      ...route.legs.flatMap((leg) => [leg.tokenIn, leg.selector.value]),
      route.legs[route.legs.length - 1].tokenOut as Address,
    ],
  );
}

export function v3Review(route: RouteQuote) {
  return route.legs.map(
    (leg) => `Pool: ${leg.pool}; fee: ${leg.selector.value} pips`,
  );
}

export function directV3Terms(
  p: PrepareExecutionResponse,
  deployment: V3Deployment,
  data: string,
): SwapTerms {
  if (!p.route) throw new Error("Invalid route terms.");
  if (uint256Decimal(p.route.amountOutAtomic, "Route quoted output") <= 0n)
    throw new Error("Route quoted output must be positive.");
  return {
    target: deployment.router,
    spender: deployment.router,
    data,
    quotedOutput: p.route.amountOutAtomic,
    routeDetails: [v3Review(p.route)],
    receipt: {
      intermediate: p.route.legs
        .slice(0, -1)
        .map((leg) => ({ token: leg.tokenOut, owner: deployment.router })),
    },
  };
}
