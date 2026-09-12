import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  keccak256,
} from "viem";
import { uniswapUniversalRouterAbi } from "../../../../generated/abi";
import type {
  PrepareExecutionResponse,
  RouteQuote,
} from "../../../../generated/ts/epeius/quote/v1/quote_pb";
import { type SwapTerms, uint256Decimal } from "../execution-policy";

type Pool = {
  currency0: string;
  currency1: string;
  feePips: number;
  tickSpacing: number;
  hooks: string;
};

type Deployment = {
  kind: "uniswap-v4";
  router: string;
  permit2: string;
  pools: Pool[];
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// Bind reviewed Universal Router runtime generations to their Permit2 immutable.
// https://docs.uniswap.org/contracts/v4/deployments
const reviewedRouterPermit2 = new Map([
  [
    "0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0",
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
  ],
  [
    "0x952c879f642706a4d399eb917827b5a2a5519328446dba72aef3579909bf15ef",
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
  ],
]);
const address = (value?: string, allowZero = false) => {
  const normalized = `0x${value?.replace(/^0x/i, "") ?? ""}`;
  if (
    !isAddress(normalized, { strict: false }) ||
    (!allowZero && /^0x0{40}$/.test(normalized))
  )
    throw new Error("Local execution deployment is invalid.");
  return normalized.toLowerCase();
};

const poolTuple = {
  name: "poolKey",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

function key(pool: Pool) {
  return {
    currency0: pool.currency0 as Address,
    currency1: pool.currency1 as Address,
    fee: pool.feePips,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks as Address,
  };
}

function admit(
  route: RouteQuote,
  p: PrepareExecutionResponse,
  deployment: Deployment,
) {
  const leg = route.legs[0];
  const routeKey = leg?.uniswapV4PoolKey;
  const pool = deployment.pools.find(
    (candidate) =>
      routeKey &&
      same(routeKey.currency0, candidate.currency0) &&
      same(routeKey.currency1, candidate.currency1) &&
      routeKey.feePips === candidate.feePips &&
      routeKey.tickSpacing === candidate.tickSpacing &&
      same(routeKey.hooks, candidate.hooks),
  );
  if (
    route.provider !== "uniswap-v4" ||
    route.legs.length !== 1 ||
    !leg ||
    leg.selector.case !== undefined ||
    !pool ||
    !same(leg.tokenIn, p.tokenIn) ||
    !same(leg.tokenOut, p.tokenOut) ||
    !(
      (same(leg.tokenIn, pool.currency0) &&
        same(leg.tokenOut, pool.currency1)) ||
      (same(leg.tokenIn, pool.currency1) && same(leg.tokenOut, pool.currency0))
    ) ||
    !same(leg.pool, keccak256(encodeAbiParameters([poolTuple], [key(pool)])))
  )
    throw new Error(
      "Route is not allowed by local token and deployment config.",
    );
  return pool;
}

export function uniswapV4Data(p: PrepareExecutionResponse, pool: Pool) {
  const amount = uint256Decimal(p.amountInAtomic, "Input amount");
  const minimum = uint256Decimal(
    p.amountOutMinimumAtomic,
    "Minimum output amount",
  );
  if (amount >= 1n << 128n || minimum >= 1n << 128n)
    throw new Error("Uniswap V4 amounts must fit uint128.");
  const poolKey = key(pool);
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          poolTuple,
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey,
        zeroForOne: same(p.tokenIn, pool.currency0),
        amountIn: amount,
        amountOutMinimum: minimum,
        hookData: "0x",
      },
    ],
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
    [p.tokenIn as Address, amount, true],
  );
  const output = same(p.tokenIn, pool.currency0)
    ? pool.currency1
    : pool.currency0;
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [output as Address, minimum],
  );
  const input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    ["0x060b0f", [swap, settle, take]],
  );
  return encodeFunctionData({
    abi: uniswapUniversalRouterAbi,
    functionName: "execute",
    args: ["0x10", [input], uint256Decimal(p.deadlineUnix, "Deadline")],
  });
}

export function uniswapV4(raw: {
  factory?: string;
  quoter?: string;
  router?: string;
  fees?: number[];
  options?: unknown;
}) {
  const options = raw.options as
    | {
        pool_manager?: string;
        state_view?: string;
        permit2?: string;
        router_code_hash?: string;
        pools?: Array<{
          currency0?: string;
          currency1?: string;
          fee_pips?: number;
          tick_spacing?: number;
          hooks?: string;
          [key: string]: unknown;
        }>;
      }
    | undefined;
  if (
    raw.factory !== undefined ||
    raw.fees !== undefined ||
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).length !== 5 ||
    ![
      "pool_manager",
      "state_view",
      "permit2",
      "router_code_hash",
      "pools",
    ].every((field) => Object.hasOwn(options, field)) ||
    !/^(?:0x)?[0-9a-f]{64}$/i.test(options.router_code_hash ?? "")
  )
    throw new Error("Local execution deployment is invalid.");
  const permit2 = address(options.permit2);
  const routerCodeHash = `0x${options.router_code_hash?.replace(/^0x/i, "").toLowerCase()}`;
  if (reviewedRouterPermit2.get(routerCodeHash) !== permit2)
    throw new Error("Local execution deployment is invalid.");
  address(raw.quoter);
  address(options.pool_manager);
  address(options.state_view);
  const deployment: Deployment = {
    kind: "uniswap-v4",
    router: address(raw.router),
    permit2,
    pools: (options.pools ?? []).map((pool) => {
      if (
        Object.keys(pool).length !== 5 ||
        !["currency0", "currency1", "fee_pips", "tick_spacing", "hooks"].every(
          (field) => Object.hasOwn(pool, field),
        )
      )
        throw new Error("Local execution deployment is invalid.");
      return {
        currency0: address(pool.currency0),
        currency1: address(pool.currency1),
        feePips: pool.fee_pips ?? -1,
        tickSpacing: pool.tick_spacing ?? 0,
        hooks: address(pool.hooks, true),
      };
    }),
  };
  if (
    deployment.pools.length === 0 ||
    new Set(deployment.pools.map((pool) => JSON.stringify(pool))).size !==
      deployment.pools.length ||
    deployment.pools.some(
      (pool) =>
        pool.currency0 >= pool.currency1 ||
        !Number.isInteger(pool.feePips) ||
        pool.feePips < 0 ||
        pool.feePips > 1_000_000 ||
        pool.feePips === 0x800000 ||
        !Number.isInteger(pool.tickSpacing) ||
        pool.tickSpacing <= 0 ||
        pool.tickSpacing > 32767 ||
        pool.hooks !== "0x0000000000000000000000000000000000000000",
    )
  )
    throw new Error("Local execution deployment is invalid.");
  return {
    ...deployment,
    plan(p: PrepareExecutionResponse): SwapTerms {
      if (!p.route) throw new Error("Invalid route terms.");
      const pool = admit(p.route, p, deployment);
      if (uint256Decimal(p.route.amountOutAtomic, "Route quoted output") <= 0n)
        throw new Error("Route quoted output must be positive.");
      return {
        target: deployment.router,
        spender: deployment.permit2,
        permission: { target: deployment.permit2, spender: deployment.router },
        data: uniswapV4Data(p, pool),
        quotedOutput: p.route.amountOutAtomic,
        routeDetails: [
          [
            `Pool: ${p.route.legs[0].pool}; key: ${pool.currency0}/${pool.currency1}; fee: ${pool.feePips} pips; tick spacing: ${pool.tickSpacing}; hooks: ${pool.hooks}`,
          ],
        ],
        receipt: {
          intermediate: [],
          touched: [
            { token: p.tokenIn, owner: deployment.router },
            { token: p.tokenOut, owner: deployment.router },
          ],
        },
      };
    },
  };
}
