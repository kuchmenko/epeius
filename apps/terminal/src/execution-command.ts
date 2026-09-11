import { createInterface } from "node:readline/promises";
import { toJsonString } from "@bufbuild/protobuf";
import {
  PreparationStatus,
  PrepareExecutionResponseSchema,
  type RouteQuote,
  RouteQuoteSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { readChain } from "./chain";
import type { quoteClient } from "./client";
import { readExecutionConfig } from "./config";
import { executePrepared } from "./execution";
import { uint256Decimal } from "./execution-policy";
import { castWallet } from "./wallet-cast";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function parseAllocations(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--allocations must be a JSON array.");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2)
    throw new Error("Provide one or two allocations.");
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid allocation.");
    const a = item as Record<string, unknown>;
    if (
      Object.keys(a).some(
        (key) => key !== "routeId" && key !== "amountInAtomic",
      ) ||
      typeof a.routeId !== "string" ||
      !a.routeId ||
      typeof a.amountInAtomic !== "string" ||
      !/^[1-9][0-9]*$/.test(a.amountInAtomic) ||
      uint256Decimal(a.amountInAtomic, "Allocation input") <= 0n
    )
      throw new Error(
        "Allocations need routeId and positive uint256 amountInAtomic.",
      );
    return { routeId: a.routeId, amountInAtomic: a.amountInAtomic };
  });
}

export async function executionCommand(
  command: string,
  values: Record<string, string | undefined>,
  configPath: string,
  chain: string,
  remoteChainId: string,
  client: ReturnType<typeof quoteClient>,
  signal: AbortSignal,
  trade?: {
    route: RouteQuote;
    amountInAtomic: string;
    tokenIn: string;
    tokenOut: string;
    afterApproval: boolean;
  },
) {
  if (
    !values.keystore ||
    !values["password-file"] ||
    !values["quote-id"] ||
    !!values["route-id"] === !!values.allocations
  )
    throw new Error(
      "Provide --keystore, --password-file, --quote-id and either --route-id or --allocations.",
    );
  const allocations = values.allocations
    ? parseAllocations(values.allocations)
    : [];
  const slippage = values["slippage-bps"] ?? "50";
  if (!/^\d+$/.test(slippage) || Number(slippage) >= 10000)
    throw new Error("--slippage-bps must be 0 through 9999.");
  for (const name of ["confirm-approval", "confirm-swap"])
    if (values[name] !== undefined && values[name] !== "yes")
      throw new Error(`--${name} requires the literal value yes.`);
  if (values["confirm-approval"] && values["confirm-swap"])
    throw new Error("Confirm only one action: approval or swap.");
  const { expectedChainId, rpcUrlEnv, trusted } = await readExecutionConfig(
    configPath,
    chain,
    allocations.length > 0,
  );
  if (remoteChainId !== expectedChainId)
    throw new Error(
      `Engine chain ID must match configured chain ID ${expectedChainId}.`,
    );
  const rpcUrl = process.env[rpcUrlEnv];
  if (!rpcUrl)
    throw new Error("Configured RPC environment variable is missing.");
  const rpc = readChain(rpcUrl, signal);
  const wallet = castWallet(
    values.keystore,
    values["password-file"],
    rpcUrl,
    signal,
  );
  const signer = await wallet.account();
  return executePrepared(
    {
      signer,
      reportPreparation: !!trade,
      swapOnly: trade?.afterApproval,
      expectedChainId,
      slippageBps: Number(slippage),
      trusted,
      chainId: rpc.chainId,
      prepare: async (preparationId) => {
        const response = await client.prepareExecution(
          preparationId
            ? { preparationId }
            : {
                quoteId: values["quote-id"],
                routeId: values["route-id"],
                allocations,
                sender: signer,
                slippageBps: Number(slippage),
              },
          { signal, timeoutMs: 25000 },
        );
        // Rejections have no executable terms. Status validation reports the reason.
        if (
          ![
            PreparationStatus.READY,
            PreparationStatus.APPROVAL_REQUIRED,
          ].includes(response.status)
        )
          return response;
        if (response.route && response.route.routeId !== values["route-id"])
          throw new Error("Engine returned a different route. Nothing sent.");
        if (
          response.allocations.length !== allocations.length ||
          response.allocations.some(
            (a, i) =>
              a.route?.routeId !== allocations[i].routeId ||
              a.amountInAtomic !== allocations[i].amountInAtomic,
          )
        )
          throw new Error(
            "Engine returned different allocations. Nothing sent.",
          );
        if (
          trade &&
          (!response.route ||
            toJsonString(RouteQuoteSchema, response.route) !==
              toJsonString(RouteQuoteSchema, trade.route) ||
            response.amountInAtomic !== trade.amountInAtomic ||
            !same(response.tokenIn, trade.tokenIn) ||
            !same(response.tokenOut, trade.tokenOut))
        )
          throw new Error(
            "Preparation does not match the selected quote. Nothing sent.",
          );
        return response;
      },
      confirm: async (kind, p) => {
        console.error(
          `${kind === "approval" ? "APPROVAL ONLY — fresh quote required afterward" : "SWAP"}\n${toJsonString(PrepareExecutionResponseSchema, p, { prettySpaces: 2 })}`,
        );
        if (!trade?.afterApproval && values[`confirm-${kind}`] === "yes")
          return true;
        if (
          (!trade?.afterApproval &&
            (values["confirm-approval"] || values["confirm-swap"])) ||
          !process.stdin.isTTY
        )
          return false;
        const prompt = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          return (
            (await prompt.question(
              `Type ${kind} to sign and send this transaction: `,
              { signal },
            )) === kind
          );
        } finally {
          prompt.close();
        }
      },
      send: wallet.send,
      receipt: rpc.waitCanonicalReceipt,
      report: (result) => console.log(JSON.stringify(result)),
    },
    command === "prepare",
  );
}
