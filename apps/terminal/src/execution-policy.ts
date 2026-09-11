import { toJsonString } from "@bufbuild/protobuf";
import { type Address, encodeFunctionData, parseAbi } from "viem";
import {
  PreparationStatus,
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";

const address = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const transfer =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const uint256Limit = 1n << 256n;
const uint256MaxDecimal = (uint256Limit - 1n).toString();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type TrustedExecution = {
  tokens: string[];
  executor?: {
    address: string;
    uniswapDeployment: string;
    pancakeDeployment: string;
  };
  deployments: Record<
    string,
    { kind: "uniswap-v3" | "pancake-v3"; router: string; fees: number[] }
  >;
};

// Reviewed router layouts differ in deadline placement. Never use an engine-supplied ABI.
const uniswapABI = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
]);
const pancakeABI = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)",
]);
const executorABI = parseAbi([
  "function execute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 deadline, (uint8 venue, uint256 amountIn, (address tokenOut, uint24 fee)[] hops)[] allocations) returns (uint256)",
]);
const approvalABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const uint256Decimal = (value: string, label: string) => {
  const normalized = value.replace(/^0+(?=\d)/, "");
  if (
    !/^[0-9]+$/.test(value) ||
    normalized.length > uint256MaxDecimal.length ||
    (normalized.length === uint256MaxDecimal.length &&
      normalized > uint256MaxDecimal)
  )
    throw new Error(`${label} must fit uint256.`);
  return BigInt(normalized);
};

export function expectedSwapData(
  p: PrepareExecutionResponse,
  kind: "uniswap-v3" | "pancake-v3",
): string {
  if (!p.route) throw new Error("Invalid route terms.");
  if (p.route.legs.some((leg) => leg.selector.case !== "feePips"))
    throw new Error("Invalid route terms.");
  const path = `0x${p.route.legs
    .map(
      (leg) =>
        `${leg.tokenIn.slice(2).toLowerCase()}${leg.selector.value?.toString(16).padStart(6, "0")}`,
    )
    .join("")}${p.route.legs.at(-1)?.tokenOut.slice(2).toLowerCase()}` as const;
  const params = {
    path,
    recipient: p.recipient.toLowerCase() as Address,
    amountIn: uint256Decimal(p.amountInAtomic, "Input amount"),
    amountOutMinimum: uint256Decimal(
      p.amountOutMinimumAtomic,
      "Minimum output amount",
    ),
  };
  const deadline = uint256Decimal(p.deadlineUnix, "Deadline");
  if (kind === "pancake-v3")
    return encodeFunctionData({
      abi: pancakeABI,
      functionName: "exactInput",
      args: [{ ...params, deadline }],
    });
  const inner = encodeFunctionData({
    abi: uniswapABI,
    functionName: "exactInput",
    args: [params],
  });
  return encodeFunctionData({
    abi: uniswapABI,
    functionName: "multicall",
    args: [deadline, [inner]],
  });
}

export function expectedExecutorData(p: PrepareExecutionResponse): string {
  const allocations = p.allocations.map((allocation) => {
    if (!allocation.route) throw new Error("Missing allocation route.");
    const route = allocation.route;
    return {
      venue: route.provider === "uniswap-v3" ? 0 : 1,
      amountIn: uint256Decimal(allocation.amountInAtomic, "Allocation input"),
      hops: route.legs.map((leg) => ({
        tokenOut: leg.tokenOut.toLowerCase() as Address,
        fee: leg.selector.value ?? 0,
      })),
    };
  });
  return encodeFunctionData({
    abi: executorABI,
    functionName: "execute",
    args: [
      p.tokenIn.toLowerCase() as Address,
      p.tokenOut.toLowerCase() as Address,
      uint256Decimal(p.amountInAtomic, "Input amount"),
      uint256Decimal(p.amountOutMinimumAtomic, "Minimum output amount"),
      uint256Decimal(p.deadlineUnix, "Deadline"),
      allocations,
    ],
  });
}

export type Receipt = {
  transactionHash: string;
  status: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    removed?: boolean;
  }>;
};

export function verifyReceipt(
  receipt: Receipt,
  hash: string,
  prepared: PrepareExecutionResponse,
  trusted?: TrustedExecution,
) {
  if (!same(receipt.transactionHash, hash))
    return {
      outcome: "unavailable",
      reason: "Receipt transaction hash mismatch.",
    };
  if (receipt.status !== "0x1")
    return {
      outcome: "failed",
      reason: "Transaction reverted or receipt status is not successful.",
    };
  try {
    const deltas = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (!same(log.transactionHash, hash) || log.removed)
        throw new Error("Invalid receipt log identity.");
      if (!same(log.topics[0] ?? "", transfer)) continue;
      if (
        !address.test(log.address) ||
        log.topics.length !== 3 ||
        !/^0x[0-9a-fA-F]{64}$/.test(log.data) ||
        !log.topics
          .slice(1)
          .every((topic) => /^0x0{24}[0-9a-fA-F]{40}$/.test(topic))
      )
        throw new Error("Nonstandard Transfer log.");
      const value = BigInt(log.data);
      for (const [topic, sign] of [
        [log.topics[1], -1n],
        [log.topics[2], 1n],
      ] as const) {
        const key = `${log.address.toLowerCase()}:0x${topic.slice(-40).toLowerCase()}`;
        deltas.set(key, (deltas.get(key) ?? 0n) + sign * value);
      }
    }
    const delta = (token: string, owner: string) =>
      deltas.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? 0n;
    const input = -delta(prepared.tokenIn, prepared.recipient);
    const output = delta(prepared.tokenOut, prepared.recipient);
    const router = prepared.transaction?.to;
    const routes = prepared.allocations.length
      ? prepared.allocations.map((a) => a.route)
      : [prepared.route];
    if (!router || routes.some((route) => !route?.legs.length))
      throw new Error("Route evidence missing.");
    const intermediates = [
      ...new Set(
        routes.flatMap(
          (route) => route?.legs.slice(0, -1).map((leg) => leg.tokenOut) ?? [],
        ),
      ),
    ];
    const balances: Record<string, string> = {};
    if (prepared.allocations.length) {
      for (const route of routes) {
        const venueRouter =
          route && trusted?.deployments[route.deploymentId]?.router;
        if (!route || !venueRouter)
          throw new Error("Configured router evidence missing.");
        for (const token of [
          route.legs[0].tokenIn,
          ...route.legs.map((leg) => leg.tokenOut),
        ]) {
          for (const owner of [router, venueRouter, prepared.recipient]) {
            if (
              same(owner, prepared.recipient) &&
              (same(token, prepared.tokenIn) || same(token, prepared.tokenOut))
            )
              continue;
            balances[`${token}:${owner}`] = delta(token, owner).toString();
          }
        }
      }
    }
    const residue =
      intermediates.some((token) => delta(token, router) !== 0n) ||
      Object.values(balances).some((value) => value !== "0");
    return {
      outcome:
        input === BigInt(prepared.amountInAtomic) &&
        output >= BigInt(prepared.amountOutMinimumAtomic) &&
        !residue
          ? "passed"
          : "failed",
      inputSpentAtomic: input.toString(),
      outputReceivedAtomic: output.toString(),
      routerIntermediateDeltas: Object.fromEntries(
        intermediates.map((token) => [token, delta(token, router).toString()]),
      ),
      ...(prepared.allocations.length
        ? { touchedTokenOwnerDeltas: balances }
        : {}),
      reason:
        "Exact-transaction standard ERC20 Transfer net deltas; no pre-existing balances counted.",
    };
  } catch {
    return {
      outcome: "unavailable",
      reason: "Receipt cannot establish standard ERC20 transfer invariants.",
    };
  }
}

export function assertPreparationUnchanged(
  prepared: PrepareExecutionResponse,
  checked: PrepareExecutionResponse,
  snapshot: string,
) {
  // A newer simulation block, estimate and message do not change executable terms.
  const immutable = (p: PrepareExecutionResponse) =>
    toJsonString(PrepareExecutionResponseSchema, {
      ...p,
      simulationBlock: undefined,
      simulatedAmountOutAtomic: "",
      message: "",
    });
  if (
    immutable(checked) !== immutable(prepared) ||
    snapshot !== toJsonString(PrepareExecutionResponseSchema, prepared)
  )
    throw new Error(
      "Preparation changed after confirmation. Nothing sent; rerun quote.",
    );
}

export function validatePreparation(
  p: PrepareExecutionResponse,
  signer: string,
  expectedChainId: string,
  slippageBps: number,
  trusted: TrustedExecution,
  now = Math.floor(Date.now() / 1000),
) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 9999)
    throw new Error("Requested slippage must be 0 through 9999 bps.");
  if (
    ![PreparationStatus.READY, PreparationStatus.APPROVAL_REQUIRED].includes(
      p.status,
    )
  )
    throw new Error(
      `Preparation rejected, expired, or requires a fresh quote. Rerun quote.${p.message ? ` Engine reason: ${JSON.stringify(p.message).replace(/[\p{Cc}\p{Cf}]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}` : ""}`,
    );
  const approval = p.status === PreparationStatus.APPROVAL_REQUIRED;
  const tx = approval ? p.approvalTransaction : p.transaction;
  if (
    !tx ||
    !p.preparationId ||
    !address.test(signer) ||
    !same(p.recipient, signer) ||
    !same(tx.from, signer)
  )
    throw new Error("Signer, transaction sender, and recipient must match.");
  if (tx.chainId !== expectedChainId)
    throw new Error(
      `Prepared transaction chain ID must match configured chain ID ${expectedChainId}.`,
    );
  if (
    !address.test(tx.to) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.data) ||
    tx.valueAtomic !== "0" ||
    !/^[1-9][0-9]*$/.test(tx.gasLimit)
  )
    throw new Error("Invalid ERC20 transaction terms.");
  const deadline = uint256Decimal(p.deadlineUnix, "Deadline");
  if (
    !/^[0-9]+$/.test(p.expiresAtUnix) ||
    BigInt(p.expiresAtUnix) <= BigInt(now) ||
    deadline <= BigInt(now)
  )
    throw new Error("Preparation expired. Rerun quote.");
  const amountIn = uint256Decimal(p.amountInAtomic, "Input amount");
  const minimum = uint256Decimal(
    p.amountOutMinimumAtomic,
    "Minimum output amount",
  );
  if (
    !address.test(p.tokenIn) ||
    !address.test(p.tokenOut) ||
    same(p.tokenIn, p.tokenOut) ||
    !/^[1-9][0-9]*$/.test(p.amountInAtomic) ||
    !/^[1-9][0-9]*$/.test(p.amountOutMinimumAtomic)
  )
    throw new Error("Invalid swap amount or token terms.");
  const executor = p.allocations.length > 0;
  if (executor === !!p.route || p.allocations.length > 2)
    throw new Error("Provide either a direct route or executor allocations.");
  const routes = executor ? p.allocations.map((a) => a.route) : [p.route];
  if (routes.some((route) => !route)) throw new Error("Missing route terms.");
  let quotedOutput = 0n;
  const configuredTokens = new Set(
    trusted.tokens.map((token) => token.toLowerCase()),
  );
  const venues = new Set<string>();
  for (const route of routes) {
    if (!route) throw new Error("Missing route terms.");
    const output = uint256Decimal(route.amountOutAtomic, "Route quoted output");
    if (output <= 0n) throw new Error("Route quoted output must be positive.");
    quotedOutput += output;
    if (
      !route.legs.length ||
      route.legs.length > 2 ||
      !same(route.legs[0].tokenIn, p.tokenIn) ||
      !same(route.legs[route.legs.length - 1].tokenOut, p.tokenOut) ||
      (route.legs.length === 2 &&
        !same(route.legs[0].tokenOut, route.legs[1].tokenIn))
    )
      throw new Error("Invalid route terms.");
    const deployment = trusted.deployments[route.deploymentId];
    if (
      !deployment ||
      route.provider !== deployment.kind ||
      !address.test(deployment.router) ||
      !route.legs.every(
        (leg) =>
          leg.selector.case === "feePips" &&
          Number.isInteger(leg.selector.value) &&
          leg.selector.value >= 0 &&
          leg.selector.value < 1_000_000 &&
          deployment.fees.includes(leg.selector.value) &&
          configuredTokens.has(leg.tokenIn.toLowerCase()) &&
          configuredTokens.has(leg.tokenOut.toLowerCase()),
      )
    )
      throw new Error(
        "Route is not allowed by local token and deployment config.",
      );
    if (executor) {
      const expectedId =
        route.provider === "uniswap-v3"
          ? trusted.executor?.uniswapDeployment
          : trusted.executor?.pancakeDeployment;
      const tokens = [
        route.legs[0].tokenIn,
        ...route.legs.map((leg) => leg.tokenOut),
      ].map((token) => token.toLowerCase());
      if (
        !trusted.executor ||
        !address.test(trusted.executor.address) ||
        route.deploymentId !== expectedId ||
        venues.has(route.provider) ||
        new Set(tokens).size !== tokens.length
      )
        throw new Error(
          "Executor routes must use configured distinct venues without cycles.",
        );
      venues.add(route.provider);
      const block = p.allocations[0].route?.block;
      if (
        !route.block ||
        !block ||
        !hashPattern.test(block.hash) ||
        !/^[0-9]+$/.test(block.number) ||
        route.block.number !== block.number ||
        !same(route.block.hash, block.hash)
      )
        throw new Error("Allocation quotes must share one block.");
    }
  }
  if (
    executor &&
    p.allocations.reduce((total, a) => {
      const amount = uint256Decimal(a.amountInAtomic, "Allocation input");
      if (amount <= 0n) throw new Error("Allocation inputs must be positive.");
      return total + amount;
    }, 0n) !== amountIn
  )
    throw new Error("Allocation inputs must sum to the total input.");
  if (quotedOutput >= uint256Limit)
    throw new Error("Aggregate output must fit uint256.");
  const requestedMinimum =
    (quotedOutput * BigInt(10000 - slippageBps)) / 10000n;
  if (minimum !== requestedMinimum)
    throw new Error(
      "Prepared slippage minimum does not match saved route quote.",
    );
  const deployment = p.route
    ? trusted.deployments[p.route.deploymentId]
    : undefined;
  const spender = executor ? trusted.executor?.address : deployment?.router;
  if (!spender) throw new Error("Missing configured spender.");
  if (approval) {
    const expected = encodeFunctionData({
      abi: approvalABI,
      functionName: "approve",
      args: [spender.toLowerCase() as Address, amountIn],
    });
    if (
      !address.test(p.approvalSpender) ||
      !same(p.approvalSpender, spender) ||
      !same(tx.to, p.tokenIn) ||
      !same(tx.data, expected) ||
      p.transaction
    )
      throw new Error(
        "Approval must authorize only the displayed input amount and spender.",
      );
  } else {
    const expected = deployment
      ? expectedSwapData(p, deployment.kind)
      : expectedExecutorData(p);
    if (!same(tx.to, spender) || !same(tx.data, expected))
      throw new Error("Swap transaction does not match locally encoded route.");
  }
  return tx;
}
