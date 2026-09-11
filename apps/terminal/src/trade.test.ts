import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { QuoteFinalSchema } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type { ExecutionResult } from "./execution";
import { runTrade, type TradeIO } from "./trade";

function fixture() {
  const quotes = [
    create(QuoteFinalSchema, {
      quoteId: "q1",
      bestRouteId: "uni",
      searchComplete: false,
      routes: [
        { routeId: "uni", amountOutAtomic: "120" },
        { routeId: "cake", amountOutAtomic: "100" },
      ],
    }),
    create(QuoteFinalSchema, {
      quoteId: "q2",
      bestRouteId: "cake",
      searchComplete: true,
      routes: [
        { routeId: "uni", amountOutAtomic: "110" },
        { routeId: "cake", amountOutAtomic: "145" },
      ],
    }),
  ];
  const reports: unknown[] = [];
  const calls: unknown[] = [];
  let quoteCount = 0;
  const io: TradeIO = {
    quote: async () => quotes[quoteCount++],
    execute: async (quote, route, afterApproval) => {
      calls.push([
        quote.quoteId,
        route.routeId,
        route.amountOutAtomic,
        afterApproval,
      ]);
      return {
        kind: afterApproval ? "swap-verified" : "approval-confirmed",
        transactionHash: "hash",
      };
    },
    report: (result) => reports.push(result),
  };
  return { quotes, reports, calls, io, quoteCount: () => quoteCount };
}

test("auto refresh reselects engine result; manual nonwinner remains selected", async () => {
  for (const manual of [undefined, "cake"]) {
    const f = fixture();
    expect(await runTrade(f.io, manual)).toEqual({
      kind: "swap-verified",
      transactionHash: "hash",
    });
    expect(f.quoteCount()).toBe(2);
    expect(f.calls).toEqual([
      ["q1", manual ?? "uni", manual ? "100" : "120", false],
      ["q2", "cake", "145", true],
    ]);
    expect(f.reports[1]).toEqual({
      selection: {
        quoteId: "q1",
        routeId: manual ?? "uni",
        source: manual ? "manual" : "engine",
        searchComplete: false,
        basis: "raw_output",
        afterApproval: false,
      },
    });
  }
});

test("missing recommendation or selected manual route never substitutes another candidate", async () => {
  for (const manual of [undefined, "missing"]) {
    const f = fixture();
    f.quotes[0].bestRouteId = undefined;
    await expect(runTrade(f.io, manual)).rejects.toThrow(
      "No route substituted",
    );
    expect(f.calls).toEqual([]);
  }
  const f = fixture();
  f.quotes[1].routes = f.quotes[1].routes.filter((r) => r.routeId !== "uni");
  await expect(runTrade(f.io, "uni")).rejects.toThrow("No route substituted");
  expect(f.calls).toHaveLength(1);
});

test("fresh quote must have new ID; quote failure never retries", async () => {
  const f = fixture();
  f.quotes[1].quoteId = "q1";
  await expect(runTrade(f.io)).rejects.toThrow("fresh quote ID");
  expect(f.calls).toHaveLength(1);
  f.io.quote = async () => {
    throw new Error("offline");
  };
  await expect(runTrade(f.io)).rejects.toThrow("offline");
  expect(f.calls).toHaveLength(1);
});

test("only successful verified approval refreshes; cancellation and unknown submission stop", async () => {
  for (const result of [
    { kind: "preview" },
    { kind: "swap-verified", transactionHash: "hash" },
    { kind: "canceled" },
    { kind: "failed", transactionHash: "hash" },
    { kind: "unknown", transactionHash: "hash" },
    { kind: "unknown", transactionHash: null },
  ] satisfies ExecutionResult[]) {
    const f = fixture();
    f.io.execute = async () => result;
    expect(await runTrade(f.io)).toBe(result);
    expect(f.quoteCount()).toBe(1);
  }
});
