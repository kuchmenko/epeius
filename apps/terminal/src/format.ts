import type { QuoteFinal } from "../../../generated/ts/epeius/quote/v1/quote_pb";

export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function token(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === WETH.toLowerCase())
    return { symbol: "WETH", decimals: 18 };
  if (normalized === USDC.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  return undefined;
}

export function formatAtomic(value: string, decimals: number) {
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function amount(address: string, atomic: string) {
  const known = token(address);
  return known
    ? `${formatAtomic(atomic, known.decimals)} ${known.symbol} (${atomic} atomic)`
    : `${atomic} atomic (${address})`;
}

export function formatQuote(
  quote: QuoteFinal,
  request: { tokenIn: string; tokenOut: string; amountInAtomic: string },
) {
  const lines = [`Quote ${quote.quoteId}`];
  if (quote.block)
    lines.push(`Block: ${quote.block.number} (${quote.block.hash})`);
  if (quote.searchComplete === false)
    lines.push("WARNING: Search was partial; some routes may be missing.");
  lines.push(`Input: ${amount(request.tokenIn, request.amountInAtomic)}`);

  for (const route of quote.routes) {
    lines.push("", `Route ${route.routeId} (${route.provider})`);
    lines.push(`Output: ${amount(request.tokenOut, route.amountOutAtomic)}`);
    if (route.block)
      lines.push(`Route block: ${route.block.number} (${route.block.hash})`);
    for (const [index, leg] of route.legs.entries()) {
      lines.push(
        `Leg ${index + 1}: pool ${leg.pool}; fee ${leg.feePips} pips; ${leg.tokenIn} to ${leg.tokenOut}`,
      );
    }
    lines.push(`Latency: ${route.latencyMs} ms`);
    // Gas cost is absent from direct quotes, so no economic ranking is claimed.
    // Quote output is informational only; execution is not available here.
  }
  for (const error of quote.errors) {
    lines.push(
      `Error (${error.provider}${error.routeId ? `, route ${error.routeId}` : ""}): ${error.message}`,
    );
  }
  if (quote.routes.length === 0) lines.push("No routes returned.");
  return lines.join("\n");
}
