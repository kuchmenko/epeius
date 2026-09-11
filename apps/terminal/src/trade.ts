import { toJson } from "@bufbuild/protobuf";
import {
  type QuoteFinal,
  QuoteFinalSchema,
  type RouteQuote,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";

export type TradeIO = {
  quote: () => Promise<QuoteFinal>;
  execute: (
    quote: QuoteFinal,
    route: RouteQuote,
    afterApproval: boolean,
  ) => Promise<{ code: number; approvalVerified: boolean }>;
  report: (result: unknown) => void;
};

export async function runTrade(io: TradeIO, routeId?: string) {
  const source = routeId === undefined ? "engine" : "manual";
  let previousQuoteId: string | undefined;
  for (const afterApproval of [false, true]) {
    const quote = await io.quote();
    io.report({ quote: toJson(QuoteFinalSchema, quote) });
    if (!quote.quoteId || quote.quoteId === previousQuoteId)
      throw new Error("A fresh quote ID is required. Nothing sent.");
    const selectedId = routeId ?? quote.bestRouteId;
    const route = quote.routes.find(
      (candidate) => candidate.routeId === selectedId,
    );
    if (!route)
      throw new Error(
        "Selected route is unavailable. No route substituted; nothing sent.",
      );
    io.report({
      selection: {
        quoteId: quote.quoteId,
        routeId: route.routeId,
        source,
        searchComplete: quote.searchComplete,
        basis: "raw_output",
        afterApproval,
      },
    });
    const result = await io.execute(quote, route, afterApproval);
    if (result.code !== 0 || !result.approvalVerified) return result.code;
    if (afterApproval)
      throw new Error(
        "Approval is still required. Start a new trade; nothing retried.",
      );
    previousQuoteId = quote.quoteId;
  }
  return 1;
}
