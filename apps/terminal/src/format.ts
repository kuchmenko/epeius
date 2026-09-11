import { formatUnits } from "viem";
import {
  type ChainStatus,
  PreparationStatus,
  type PrepareExecutionResponse,
  type QuoteFinal,
  type Token,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type { ExecutionPlan } from "./execution-policy";

export function formatAtomic(value: string, decimals: number) {
  if (decimals === 0) return value;
  return formatUnits(BigInt(value), decimals);
}

function amount(token: Token, atomic: string) {
  return `${formatAtomic(atomic, token.decimals)} ${token.symbol} (${atomic} atomic)`;
}

export function formatPreparation(
  p: PrepareExecutionResponse,
  chain: Pick<ChainStatus, "key" | "chainId" | "tokens">,
  plan: Pick<ExecutionPlan, "spender" | "routeDetails">,
) {
  const text = (value: string) =>
    JSON.stringify(value)
      .slice(1, -1)
      .replace(
        /[\p{Cc}\p{Cf}]/gu,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
  const token = (address: string) => {
    const found = chain.tokens.find(
      (item) => item.address.toLowerCase() === address.toLowerCase(),
    );
    if (!found) throw new Error("Preparation token metadata is unavailable.");
    return found;
  };
  const amount = (address: string, atomic: string) => {
    const metadata = token(address);
    return `${text(formatAtomic(atomic, metadata.decimals))} ${text(metadata.symbol)} (${text(atomic)} atomic)`;
  };
  const identity = (address: string) =>
    `${text(token(address).symbol)} ${address}`;
  const timestamp = (unix: string) => {
    const milliseconds = BigInt(unix) * 1000n;
    // Date only represents this range; all displayed Unix values remain exact.
    const utc =
      milliseconds <= 8640000000000000n
        ? new Date(Number(milliseconds)).toISOString()
        : "outside UTC calendar range";
    return `${utc} (Unix ${unix})`;
  };
  const approval = p.status === PreparationStatus.APPROVAL_REQUIRED;
  const tx = approval ? p.approvalTransaction : p.transaction;
  if (!tx) throw new Error("Preparation has no transaction to review.");
  const lines = [
    approval
      ? "APPROVAL ONLY — fresh quote and separate swap consent required afterward"
      : "SWAP",
    `Chain: ${text(chain.key)} (${chain.chainId})`,
    `Account: ${tx.from}`,
    `Recipient: ${p.recipient}`,
    `Transaction target: ${tx.to}`,
    `Spender: ${plan.spender}`,
    `Input token: ${identity(p.tokenIn)}`,
    `Output token: ${identity(p.tokenOut)}`,
    `Total input: ${amount(p.tokenIn, p.amountInAtomic)}`,
    `${approval ? "Proposed swap minimum (not sent by this approval)" : "Minimum output"}: ${amount(p.tokenOut, p.amountOutMinimumAtomic)}`,
  ];
  const routes = p.allocations.length
    ? p.allocations
    : [{ route: p.route, amountInAtomic: p.amountInAtomic }];
  for (const [index, allocation] of routes.entries()) {
    const route = allocation.route;
    if (!route) throw new Error("Preparation route is unavailable.");
    lines.push(
      "",
      `${p.allocations.length ? `Allocation ${index + 1}` : "Route"}: ${text(route.routeId)}`,
      `Deployment: ${text(route.deploymentId)} (${text(route.provider)})`,
      `Input: ${amount(p.tokenIn, allocation.amountInAtomic)}`,
      `Quoted output (estimate): ${amount(p.tokenOut, route.amountOutAtomic)}`,
    );
    for (const [i, leg] of route.legs.entries())
      lines.push(
        `Hop ${i + 1}: ${identity(leg.tokenIn)} to ${identity(leg.tokenOut)}`,
        `  ${text(plan.routeDetails[index][i])}`,
      );
    if (route.block)
      lines.push(
        `Quote block: ${text(route.block.number)} (${text(route.block.hash)})`,
      );
  }
  lines.push(
    "",
    `Swap deadline: ${timestamp(p.deadlineUnix)}`,
    `Preparation expires: ${timestamp(p.expiresAtUnix)}`,
  );
  lines.push(
    p.simulationBlock
      ? `Simulation block: ${text(p.simulationBlock.number)} (${text(p.simulationBlock.hash)})`
      : "Simulation block: not provided",
  );
  if (p.simulatedAmountOutAtomic)
    lines.push(
      `Simulated output (estimate, not a receipt): ${amount(p.tokenOut, p.simulatedAmountOutAtomic)}`,
    );
  if (approval)
    lines.push(
      "This approval authorizes only the total input above. It does not send a swap.",
    );
  lines.push(
    "Actual output is verified from canonical receipt token deltas after submission.",
  );
  return lines.join("\n");
}

export function formatStatus(chains: ChainStatus[]) {
  return chains
    .map((chain) => {
      const state = chain.connected ? "connected" : "unavailable";
      const quote = chain.quotingSupported ? "quoting" : "quotes unsupported";
      const block = chain.block ? `, block ${chain.block.number}` : "";
      return `${chain.key} (${chain.chainId}): ${state}, ${quote}${block}${chain.error ? ` — ${chain.error}` : ""}`;
    })
    .join("\n");
}

export function formatTokens(chain: ChainStatus) {
  const lines = [`${chain.key} (${chain.chainId}) tokens:`];
  if (chain.block) lines[0] += ` block ${chain.block.number}`;
  if (!chain.tokens.length)
    lines.push("No supported quote tokens on this chain.");
  for (const token of chain.tokens)
    lines.push(`${token.symbol} ${token.address} (${token.decimals} decimals)`);
  return lines.join("\n");
}

export function formatQuote(
  quote: QuoteFinal,
  chain: ChainStatus,
  tokenIn: Token,
  tokenOut: Token,
  amountInAtomic: string,
) {
  const lines = [`Quote ${quote.quoteId} — ${chain.key} (${chain.chainId})`];
  if (quote.block)
    lines.push(`Block: ${quote.block.number} (${quote.block.hash})`);
  if (!quote.searchComplete)
    lines.push("WARNING: Search was partial; some routes may be missing.");
  lines.push(`Input: ${amount(tokenIn, amountInAtomic)}`);
  if (quote.bestRouteId)
    lines.push(
      `Engine recommendation: ${quote.bestRouteId} (highest raw output among returned routes; not gas-adjusted or a global best).`,
    );
  for (const route of quote.routes) {
    lines.push("", `Route ${route.routeId} (${route.provider})`);
    lines.push(`Output: ${amount(tokenOut, route.amountOutAtomic)}`);
    if (route.block)
      lines.push(`Route block: ${route.block.number} (${route.block.hash})`);
    for (const [index, leg] of route.legs.entries())
      lines.push(
        `Leg ${index + 1}: pool ${leg.pool}; ${leg.selector.case === "feePips" ? `fee ${leg.selector.value} pips` : leg.selector.case === "tickSpacing" ? `tick spacing ${leg.selector.value}` : "unknown selector"}; ${leg.tokenIn} to ${leg.tokenOut}`,
      );
    lines.push(`Latency: ${route.latencyMs} ms`);
  }
  for (const error of quote.errors)
    lines.push(
      `Error (${error.provider}${error.routeId ? `, route ${error.routeId}` : ""}): ${error.message}`,
    );
  if (!quote.routes.length) lines.push("No routes returned.");
  return lines.join("\n");
}
