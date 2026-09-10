import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { QuoteService } from "../../../generated/ts/epeius/quote/v1/quote_pb";

export function quoteClient(baseUrl: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Set EPEIUS_ENGINE_URL to the engine's HTTP address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EPEIUS_ENGINE_URL must be an HTTP address without credentials, query, or fragment.",
    );
  }
  return createClient(
    QuoteService,
    createConnectTransport({
      baseUrl: url.toString(),
      httpVersion: "1.1",
      defaultTimeoutMs: 5000,
    }),
  );
}
