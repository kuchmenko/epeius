import { toJson } from "@bufbuild/protobuf";
import {
  type QuoteFinal,
  QuoteFinalSchema,
  type RouteQuote,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { ExecutionOutcome, type ExecutionResult } from "./execution";

export type TradeIO = {
  quote: () => Promise<QuoteFinal>;
  execute: (
    quote: QuoteFinal,
    route: RouteQuote,
    afterApproval: boolean,
  ) => Promise<ExecutionResult>;
  report: (result: unknown) => void;
};

export async function runTrade(
  io: TradeIO,
  routeId?: string,
): Promise<ExecutionResult> {
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
    if (result.kind !== ExecutionOutcome.ApprovalConfirmed) return result;
    if (afterApproval)
      throw new Error(
        "Approval is still required. Start a new trade; nothing retried.",
      );
    previousQuoteId = quote.quoteId;
  }
  throw new Error("Trade did not produce a swap result.");
}
