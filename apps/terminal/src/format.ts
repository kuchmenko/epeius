import type {
  ChainStatus,
  QuoteFinal,
  Token,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";

export function formatAtomic(value: string, decimals: number) {
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function amount(token: Token, atomic: string) {
  return `${formatAtomic(atomic, token.decimals)} ${token.symbol} (${atomic} atomic)`;
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
  for (const route of quote.routes) {
    lines.push("", `Route ${route.routeId} (${route.provider})`);
    lines.push(`Output: ${amount(tokenOut, route.amountOutAtomic)}`);
    if (route.block)
      lines.push(`Route block: ${route.block.number} (${route.block.hash})`);
    for (const [index, leg] of route.legs.entries())
      lines.push(
        `Leg ${index + 1}: pool ${leg.pool}; fee ${leg.feePips} pips; ${leg.tokenIn} to ${leg.tokenOut}`,
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
