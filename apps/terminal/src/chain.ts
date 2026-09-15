import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  hexToBigInt,
  http,
  isHash,
  isHex,
  keccak256,
  toHex,
  zeroHash,
} from "viem";
import type { Receipt, TransactionCallTrace } from "./receipt";

const validHash = (value: string) => value.length === 66 && isHash(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function readChain(
  rpcUrl: string,
  signal: AbortSignal,
  requestTimeoutMs = 15000,
) {
  const rpc = async (method: string, params: unknown[] = []) => {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), requestTimeoutMs);
    try {
      // viem 2.38.5 takes the signal on its transport, not client.request.
      // A fresh signal covers headers AND body; no SDK timeout or retries compete.
      const client = createPublicClient({
        transport: http(rpcUrl, {
          timeout: 0,
          retryCount: 0,
          batch: false,
          fetchOptions: {
            signal: AbortSignal.any([signal, deadline.signal]),
          },
        }),
      });
      // Low-level request preserves receipt hex fields/null without action formatting.
      return await client.request({ method, params } as Parameters<
        typeof client.request
      >[0]);
    } catch {
      throw new Error(
        "RPC request failed or timed out. Check the configured RPC provider.",
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const nonce = async (address: string, tag: "latest" | "pending") => {
    const value = String(await rpc("eth_getTransactionCount", [address, tag]));
    if (!isHex(value, { strict: true }) || value.length <= 2)
      throw new Error(
        `${tag === "pending" ? "Pending" : "Latest"} account nonce is unavailable.`,
      );
    const result = hexToBigInt(value as Hex);
    if (
      toHex(result) !== value.toLowerCase() ||
      result > 0xffff_ffff_ffff_ffffn
    )
      throw new Error(
        `${tag === "pending" ? "Pending" : "Latest"} account nonce is invalid.`,
      );
    return result;
  };
  const readCanonicalReceipt = async (
    hash: string,
    unsealedIsError: boolean,
  ): Promise<Receipt | null> => {
    if (!validHash(hash)) throw new Error("Transaction hash is invalid.");
    const receipt = (await rpc("eth_getTransactionReceipt", [
      hash,
    ])) as Receipt | null;
    if (receipt === null) return null;
    if (!same(receipt.transactionHash, hash))
      throw new Error("Receipt transaction identity is invalid.");
    if (
      !receipt.blockHash ||
      !validHash(receipt.blockHash) ||
      same(receipt.blockHash, zeroHash) ||
      !receipt.blockNumber ||
      !isHex(receipt.blockNumber, { strict: true }) ||
      receipt.blockNumber.length <= 2
    ) {
      if (!unsealedIsError) return null;
      throw new Error("Receipt identity is not canonical.");
    }
    const block = (await rpc("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ])) as {
      hash?: string;
    } | null;
    if (
      !block?.hash ||
      !validHash(block.hash) ||
      !same(receipt.blockHash, block.hash)
    )
      throw new Error("Receipt block is not canonical.");
    return receipt;
  };
  return {
    chainId: async () => String(await rpc("eth_chainId")).toLowerCase(),
    nonce,
    pendingNonce: (address: string) => nonce(address, "pending"),
    canonicalReceipt: (hash: string) => readCanonicalReceipt(hash, true),
    transactionByHash: async (hash: string): Promise<unknown | null> => {
      if (!validHash(hash)) throw new Error("Transaction hash is invalid.");
      return (await rpc("eth_getTransactionByHash", [hash])) as unknown | null;
    },
    receiptByHash: async (hash: string): Promise<unknown | null> => {
      if (!validHash(hash)) throw new Error("Transaction hash is invalid.");
      return (await rpc("eth_getTransactionReceipt", [hash])) as unknown | null;
    },
    blockByNumber: async (number: string): Promise<unknown | null> =>
      (await rpc("eth_getBlockByNumber", [number, false])) as unknown | null,
    blockByHash: async (hash: string): Promise<unknown | null> => {
      if (!validHash(hash)) throw new Error("Block hash is invalid.");
      return (await rpc("eth_getBlockByHash", [hash, false])) as unknown | null;
    },
    submitRawTransaction: async (raw: string) => {
      if (!/^0x02[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0)
        throw new Error("Signed transaction bytes are invalid.");
      const hash = String(await rpc("eth_sendRawTransaction", [raw]));
      if (!validHash(hash))
        throw new Error("RPC returned an invalid transaction hash.");
      return hash;
    },
    codeHash: async (address: string) => {
      const code = String(await rpc("eth_getCode", [address, "latest"]));
      if (!isHex(code, { strict: true }) || code === "0x")
        throw new Error("Configured contract code is unavailable.");
      return keccak256(code as Hex);
    },
    uint32Getter: async (
      address: string,
      name: "maxBranches" | "maxOperationsPerBranch" | "maxTotalOperations",
    ) => {
      const abi = [
        {
          type: "function",
          name,
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint32" }],
        },
      ] as const;
      const data = String(
        await rpc("eth_call", [
          {
            to: address,
            data: encodeFunctionData({ abi, functionName: name }),
          },
          "latest",
        ]),
      );
      if (!isHex(data, { strict: true }))
        throw new Error("Configured contract getter is unavailable.");
      return Number(
        decodeFunctionResult({ abi, functionName: name, data: data as Hex }),
      );
    },
    waitCanonicalReceipt: async (hash: string): Promise<Receipt> => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const receipt = await readCanonicalReceipt(hash, false);
        if (receipt) return receipt;
        await Bun.sleep(1000);
      }
      throw new Error("Receipt timeout.");
    },
    traceCanonicalTransaction: async (
      hash: string,
      receipt: Receipt,
    ): Promise<TransactionCallTrace> => {
      if (
        !validHash(hash) ||
        !same(receipt.transactionHash, hash) ||
        !receipt.blockHash ||
        !validHash(receipt.blockHash) ||
        !receipt.blockNumber ||
        !isHex(receipt.blockNumber, { strict: true }) ||
        receipt.blockNumber.length <= 2
      )
        throw new Error(
          "Receipt identity is unavailable for transaction trace.",
        );
      const trace = (await rpc("debug_traceTransaction", [
        hash,
        { tracer: "callTracer" },
      ])) as TransactionCallTrace;
      const confirmed = (await rpc("eth_getTransactionReceipt", [
        hash,
      ])) as Receipt | null;
      if (
        !confirmed ||
        !same(confirmed.transactionHash, hash) ||
        !confirmed.blockHash ||
        !same(confirmed.blockHash, receipt.blockHash) ||
        !confirmed.blockNumber ||
        !same(confirmed.blockNumber, receipt.blockNumber)
      )
        throw new Error("Receipt changed after transaction trace.");
      const block = (await rpc("eth_getBlockByNumber", [
        receipt.blockNumber,
        false,
      ])) as { hash?: string } | null;
      if (
        !block?.hash ||
        !validHash(block.hash) ||
        !same(block.hash, receipt.blockHash)
      )
        throw new Error("Receipt block changed after transaction trace.");
      return trace;
    },
  };
}

export type ReturnTypeOfReadChain = ReturnType<typeof readChain>;
