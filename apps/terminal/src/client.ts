import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AtomicPlanService } from "../../../generated/ts/epeius/atomic/v1/atomic_pb";
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

export function atomicPlanClient(baseUrl: string) {
  return createClient(
    AtomicPlanService,
    createConnectTransport({
      baseUrl: validateEngineUrl(baseUrl),
      useBinaryFormat: true,
      defaultTimeoutMs: 5000,
    }),
  );
}
