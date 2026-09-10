import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { QuoteService } from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { validateEngineUrl } from "./config";

export function quoteClient(baseUrl: string) {
  return createClient(
    QuoteService,
    createConnectTransport({
      baseUrl: validateEngineUrl(baseUrl),
      // Use Bun's native fetch, avoiding its Node HTTP compatibility path.
      useBinaryFormat: true,
      defaultTimeoutMs: 5000,
    }),
  );
}
