import { createInterface } from "node:readline/promises";
import { toJsonString } from "@bufbuild/protobuf";
import {
  PreparationStatus,
  type PrepareExecutionResponse,
  PrepareExecutionResponseSchema,
  type UnsignedTransaction,
} from "../../../generated/ts/epeius/quote/v1/quote_pb";
import type { quoteClient } from "./client";

const address = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const transfer =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type Receipt = {
  transactionHash: string;
  status: string;
  blockHash?: string | null;
  blockNumber?: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    removed?: boolean;
  }>;
};

export function verifyReceipt(
  receipt: Receipt,
  hash: string,
  prepared: PrepareExecutionResponse,
) {
  if (!same(receipt.transactionHash, hash))
    return {
      outcome: "unavailable",
      reason: "Receipt transaction hash mismatch.",
    };
  if (receipt.status !== "0x1")
    return {
      outcome: "failed",
      reason: "Transaction reverted or receipt status is not successful.",
    };
  try {
    const deltas = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (!same(log.transactionHash, hash) || log.removed)
        throw new Error("Invalid receipt log identity.");
      if (!same(log.topics[0] ?? "", transfer)) continue;
      if (
        !address.test(log.address) ||
        log.topics.length !== 3 ||
        !/^0x[0-9a-fA-F]{64}$/.test(log.data) ||
        !log.topics
          .slice(1)
          .every((topic) => /^0x0{24}[0-9a-fA-F]{40}$/.test(topic))
      )
        throw new Error("Nonstandard Transfer log.");
      const value = BigInt(log.data);
      for (const [topic, sign] of [
        [log.topics[1], -1n],
        [log.topics[2], 1n],
      ] as const) {
        const key = `${log.address.toLowerCase()}:0x${topic.slice(-40).toLowerCase()}`;
        deltas.set(key, (deltas.get(key) ?? 0n) + sign * value);
      }
    }
    const delta = (token: string, owner: string) =>
      deltas.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? 0n;
    const input = -delta(prepared.tokenIn, prepared.recipient);
    const output = delta(prepared.tokenOut, prepared.recipient);
    const router = prepared.transaction?.to;
    if (!router || !prepared.route?.legs.length)
      throw new Error("Route evidence missing.");
    const intermediates = prepared.route.legs
      .slice(0, -1)
      .map((leg) => leg.tokenOut);
    const residue = intermediates.some((token) => delta(token, router) !== 0n);
    return {
      outcome:
        input === BigInt(prepared.amountInAtomic) &&
        output >= BigInt(prepared.amountOutMinimumAtomic) &&
        !residue
          ? "passed"
          : "failed",
      inputSpentAtomic: input.toString(),
      outputReceivedAtomic: output.toString(),
      routerIntermediateDeltas: Object.fromEntries(
        intermediates.map((token) => [token, delta(token, router).toString()]),
      ),
      reason:
        "Exact-transaction standard ERC20 Transfer net deltas; no pre-existing balances counted.",
    };
  } catch {
    return {
      outcome: "unavailable",
      reason: "Receipt cannot establish standard ERC20 transfer invariants.",
    };
  }
}

export function validatePreparation(
  p: PrepareExecutionResponse,
  signer: string,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    ![PreparationStatus.READY, PreparationStatus.APPROVAL_REQUIRED].includes(
      p.status,
    )
  )
    throw new Error(
      "Preparation rejected, expired, or requires a fresh quote. Rerun quote.",
    );
  const approval = p.status === PreparationStatus.APPROVAL_REQUIRED;
  const tx = approval ? p.approvalTransaction : p.transaction;
  if (
    !tx ||
    !p.preparationId ||
    !address.test(signer) ||
    !same(p.recipient, signer) ||
    !same(tx.from, signer)
  )
    throw new Error("Signer, transaction sender, and recipient must match.");
  if (tx.chainId !== "84532")
    throw new Error("Execution only supports chain ID 84532.");
  if (
    !address.test(tx.to) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.data) ||
    tx.valueAtomic !== "0" ||
    !/^[1-9][0-9]*$/.test(tx.gasLimit)
  )
    throw new Error("Invalid ERC20 transaction terms.");
  if (
    !/^[0-9]+$/.test(p.expiresAtUnix) ||
    BigInt(p.expiresAtUnix) <= BigInt(now) ||
    !/^[0-9]+$/.test(p.deadlineUnix) ||
    BigInt(p.deadlineUnix) <= BigInt(now)
  )
    throw new Error("Preparation expired. Rerun quote.");
  if (
    !address.test(p.tokenIn) ||
    !address.test(p.tokenOut) ||
    same(p.tokenIn, p.tokenOut) ||
    !/^[1-9][0-9]*$/.test(p.amountInAtomic) ||
    !/^[1-9][0-9]*$/.test(p.amountOutMinimumAtomic)
  )
    throw new Error("Invalid swap amount or token terms.");
  if (
    !p.route?.legs.length ||
    p.route.legs.length > 2 ||
    !same(p.route.legs[0].tokenIn, p.tokenIn) ||
    !same(p.route.legs[p.route.legs.length - 1].tokenOut, p.tokenOut) ||
    (p.route.legs.length === 2 &&
      !same(p.route.legs[0].tokenOut, p.route.legs[1].tokenIn))
  )
    throw new Error("Invalid route terms.");
  if (approval) {
    const expected = `0x095ea7b3${p.approvalSpender.slice(2).toLowerCase().padStart(64, "0")}${BigInt(p.amountInAtomic).toString(16).padStart(64, "0")}`;
    if (
      !address.test(p.approvalSpender) ||
      !same(tx.to, p.tokenIn) ||
      !same(tx.data, expected) ||
      p.transaction
    )
      throw new Error(
        "Approval must authorize only the displayed input amount and spender.",
      );
  }
  return tx;
}

export type ExecutionIO = {
  signer: string;
  chainId: () => Promise<string>;
  prepare: (preparationId?: string) => Promise<PrepareExecutionResponse>;
  confirm: (
    kind: "approval" | "swap",
    p: PrepareExecutionResponse,
  ) => Promise<boolean>;
  send: (tx: UnsignedTransaction) => Promise<string>;
  receipt: (hash: string) => Promise<Receipt>;
  report: (result: unknown) => void;
};

export async function executePrepared(io: ExecutionIO, preview = false) {
  if ((await io.chainId()) !== "0x14a34")
    throw new Error("RPC network must be chain ID 84532.");
  const prepared = await io.prepare();
  const tx = validatePreparation(prepared, io.signer);
  const snapshot = toJsonString(PrepareExecutionResponseSchema, prepared);
  const kind =
    prepared.status === PreparationStatus.APPROVAL_REQUIRED
      ? "approval"
      : "swap";
  if (preview) {
    io.report({ preparation: JSON.parse(snapshot), sent: false });
    return 0;
  }
  if (!(await io.confirm(kind, prepared))) {
    io.report({ sent: false, outcome: "canceled" });
    return 1;
  }
  const checked = await io.prepare(prepared.preparationId);
  validatePreparation(checked, io.signer);
  // Compare all executable terms, including route, minimum, deadline and approval.
  // A newer simulation block and output estimate do not change signed terms.
  const immutable = (p: PrepareExecutionResponse) =>
    toJsonString(PrepareExecutionResponseSchema, {
      ...p,
      simulationBlock: undefined,
      simulatedAmountOutAtomic: "",
      message: "",
    });
  if (
    immutable(checked) !== immutable(prepared) ||
    snapshot !== toJsonString(PrepareExecutionResponseSchema, prepared)
  )
    throw new Error(
      "Preparation changed after confirmation. Nothing sent; rerun quote.",
    );
  if ((await io.chainId()) !== "0x14a34")
    throw new Error("RPC network changed. Nothing sent.");
  validatePreparation(prepared, io.signer);
  let hash: string;
  try {
    hash = (await io.send(tx)).trim();
    if (!hashPattern.test(hash)) throw new Error("Invalid transaction hash.");
  } catch {
    io.report({
      transactionHash: null,
      submission: "unknown",
      verification: { outcome: "unavailable" },
      message:
        "Send attempt may have reached the network. Inspect wallet transactions; do not automatically resend.",
    });
    return 1;
  }
  io.report({
    transactionHash: hash,
    submission: "submitted",
    kind,
    verification: { outcome: "pending" },
  });
  try {
    const receipt = await io.receipt(hash);
    const verification =
      kind === "swap"
        ? verifyReceipt(receipt, hash, prepared)
        : {
            outcome:
              same(receipt.transactionHash, hash) && receipt.status === "0x1"
                ? "receipt_success"
                : "failed",
          };
    io.report({
      transactionHash: hash,
      verification,
      ...(kind === "approval"
        ? {
            nextAction:
              "Rerun quote, then execute with the new quote and selected route. Approval never executes the old quote.",
          }
        : {}),
    });
    return verification.outcome === "passed" ||
      verification.outcome === "receipt_success"
      ? 0
      : 1;
  } catch {
    io.report({
      transactionHash: hash,
      submission: "pending_or_unknown",
      verification: { outcome: "unavailable" },
      message: "Receipt unavailable. Do not resend automatically.",
    });
    return 1;
  }
}

export async function executionCommand(
  command: string,
  values: Record<string, string | undefined>,
  configPath: string,
  chain: string,
  client: ReturnType<typeof quoteClient>,
  signal: AbortSignal,
) {
  if (
    !values.keystore ||
    !values["password-file"] ||
    !values["quote-id"] ||
    !values["route-id"]
  )
    throw new Error(
      "Provide --keystore, --password-file, --quote-id and --route-id.",
    );
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
      { chain_id?: number; rpc_url_env?: string; execution_enabled?: boolean }
    >;
  };
  const localChain = config.chains?.[chain];
  if (
    localChain?.chain_id !== 84532 ||
    localChain.execution_enabled !== true ||
    !localChain.rpc_url_env
  )
    throw new Error(
      "Local chain must explicitly enable execution on chain ID 84532 and set rpc_url_env.",
    );
  const rpcUrl = process.env[localChain.rpc_url_env];
  if (!rpcUrl)
    throw new Error("Configured RPC environment variable is missing.");
  const rpc = async (method: string, params: unknown[] = []) => {
    signal.throwIfAborted();
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      const body = (await response.json()) as {
        result?: unknown;
        error?: unknown;
      };
      if (!response.ok || body.error) throw new Error("RPC request failed.");
      return body.result;
    } catch {
      throw new Error(
        "RPC request failed or timed out. Check the configured RPC provider.",
      );
    }
  };
  const wallet = [
    "--keystore",
    values.keystore,
    "--password-file",
    values["password-file"],
  ];
  const cast = async (args: string[]) => {
    signal.throwIfAborted();
    // Avoid inherited Foundry wallet/RPC overrides. Never read key material in JS.
    const child = Bun.spawn(["cast", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(args[0] === "send" ? { ETH_RPC_URL: rpcUrl } : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 60000);
    try {
      const output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0)
        throw new Error("Cast failed; no private diagnostics displayed.");
      return output.trim();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  };
  const signer = await cast(["wallet", "address", ...wallet]);
  return executePrepared(
    {
      signer,
      chainId: async () => String(await rpc("eth_chainId")).toLowerCase(),
      prepare: async (preparationId) => {
        const response = await client.prepareExecution(
          preparationId
            ? { preparationId }
            : {
                quoteId: values["quote-id"],
                routeId: values["route-id"],
                sender: signer,
                slippageBps: Number(slippage),
              },
          { signal, timeoutMs: 25000 },
        );
        if (response.route && response.route.routeId !== values["route-id"])
          throw new Error("Engine returned a different route. Nothing sent.");
        return response;
      },
      confirm: async (kind, p) => {
        console.error(
          `${kind === "approval" ? "APPROVAL ONLY — fresh quote required afterward" : "SWAP"}\n${toJsonString(PrepareExecutionResponseSchema, p, { prettySpaces: 2 })}`,
        );
        if (values[`confirm-${kind}`] === "yes") return true;
        if (
          values["confirm-approval"] ||
          values["confirm-swap"] ||
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
      send: (tx) =>
        cast([
          "send",
          tx.to,
          tx.data,
          "--value",
          tx.valueAtomic,
          "--gas-limit",
          tx.gasLimit,
          "--chain",
          tx.chainId,
          "--from",
          tx.from,
          "--async",
          ...wallet,
        ]),
      receipt: async (hash) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          const receipt = (await rpc("eth_getTransactionReceipt", [
            hash,
          ])) as Receipt | null;
          // Base preconfirmations may report success with a zero or missing block hash.
          if (
            receipt?.blockHash &&
            hashPattern.test(receipt.blockHash) &&
            BigInt(receipt.blockHash) !== 0n &&
            receipt.blockNumber &&
            /^0x[0-9a-fA-F]+$/.test(receipt.blockNumber)
          ) {
            const block = (await rpc("eth_getBlockByNumber", [
              receipt.blockNumber,
              false,
            ])) as { hash?: string } | null;
            if (
              block?.hash &&
              hashPattern.test(block.hash) &&
              BigInt(block.hash) !== 0n
            ) {
              if (!same(receipt.blockHash, block.hash))
                throw new Error("Receipt block is not canonical.");
              return receipt;
            }
          }
          await Bun.sleep(1000);
        }
        throw new Error("Receipt timeout.");
      },
      report: (result) => console.log(JSON.stringify(result)),
    },
    command === "prepare",
  );
}
