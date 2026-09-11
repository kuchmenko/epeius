import { createInterface } from "node:readline/promises";
import { toJsonString } from "@bufbuild/protobuf";
import {
  PrepareExecutionResponseSchema,
  type RouteQuote,
  RouteQuoteSchema,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import { readChain } from "./chain";
import type { quoteClient } from "./client";
import { executePrepared } from "./execution";
import { type TrustedExecution, uint256Decimal } from "./execution-policy";
import { castWallet } from "./wallet-cast";

const localAddress = /^(?:0x|0X)?[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const normalizeLocalAddress = (value: string) => {
  if (!localAddress.test(value)) throw new Error("Invalid local address.");
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
};

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
    onApprovalVerified: () => void;
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
  const config = Bun.TOML.parse(await Bun.file(configPath).text()) as {
    chains?: Record<
      string,
      {
        chain_id?: number;
        rpc_url_env?: string;
        execution_enabled?: boolean;
        executor?: {
          address?: string;
          uniswap_deployment?: string;
          pancake_deployment?: string;
        };
        tokens?: Array<{ address?: string }>;
        deployments?: Record<
          string,
          { kind?: string; router?: string; fees?: number[] }
        >;
      }
    >;
  };
  const localChain = config.chains?.[chain];
  if (
    !localChain ||
    !Number.isSafeInteger(localChain.chain_id) ||
    (localChain.chain_id ?? 0) <= 0 ||
    localChain.execution_enabled !== true ||
    typeof localChain.rpc_url_env !== "string" ||
    !localChain.rpc_url_env.trim()
  )
    throw new Error(
      "Local chain must set a safe positive chain_id, explicitly enable execution, and set rpc_url_env.",
    );
  const expectedChainId = String(localChain.chain_id);
  const trusted: TrustedExecution = { tokens: [], deployments: {} };
  for (const token of localChain.tokens ?? []) {
    if (!token.address)
      throw new Error("Local execution tokens must have valid addresses.");
    try {
      trusted.tokens.push(normalizeLocalAddress(token.address));
    } catch {
      throw new Error("Local execution tokens must have valid addresses.");
    }
  }
  for (const [id, deployment] of Object.entries(localChain.deployments ?? {})) {
    if (
      (deployment.kind !== "uniswap-v3" && deployment.kind !== "pancake-v3") ||
      !deployment.router ||
      !localAddress.test(deployment.router) ||
      !Array.isArray(deployment.fees) ||
      !deployment.fees.every(
        (fee) => Number.isInteger(fee) && fee >= 0 && fee < 1_000_000,
      )
    )
      throw new Error("Local execution deployment is invalid.");
    trusted.deployments[id] = {
      kind: deployment.kind,
      router: normalizeLocalAddress(deployment.router),
      fees: deployment.fees,
    };
  }
  if (allocations.length) {
    const e = localChain.executor;
    const uni =
      e?.uniswap_deployment && trusted.deployments[e.uniswap_deployment];
    const pan =
      e?.pancake_deployment && trusted.deployments[e.pancake_deployment];
    if (
      !e?.address ||
      !e.uniswap_deployment ||
      !e.pancake_deployment ||
      !localAddress.test(e.address) ||
      BigInt(normalizeLocalAddress(e.address)) === 0n ||
      !uni ||
      !pan ||
      uni.kind !== "uniswap-v3" ||
      pan.kind !== "pancake-v3" ||
      same(uni.router, pan.router)
    )
      throw new Error(
        "Local executor needs an address and distinct Uniswap/Pancake deployments.",
      );
    trusted.executor = {
      address: normalizeLocalAddress(e.address),
      uniswapDeployment: e.uniswap_deployment,
      pancakeDeployment: e.pancake_deployment,
    };
  }
  if (remoteChainId !== expectedChainId)
    throw new Error(
      `Engine chain ID must match configured chain ID ${expectedChainId}.`,
    );
  const rpcUrl = process.env[localChain.rpc_url_env];
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
      onApprovalVerified: trade?.onApprovalVerified,
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
