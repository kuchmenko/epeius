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

export function readChain(rpcUrl: string, signal: AbortSignal) {
  const rpc = async (method: string, params: unknown[] = []) => {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 15000);
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
  return {
    chainId: async () => String(await rpc("eth_chainId")).toLowerCase(),
    pendingNonce: async (address: string) => {
      const value = String(
        await rpc("eth_getTransactionCount", [address, "pending"]),
      );
      if (!isHex(value, { strict: true }) || value.length <= 2)
        throw new Error("Pending account nonce is unavailable.");
      const nonce = hexToBigInt(value as Hex);
      if (
        toHex(nonce) !== value.toLowerCase() ||
        nonce > 0xffff_ffff_ffff_ffffn
      )
        throw new Error("Pending account nonce is invalid.");
      return nonce;
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
        const receipt = (await rpc("eth_getTransactionReceipt", [
          hash,
        ])) as Receipt | null;
        // Preconfirmations may report success with a zero or missing block hash.
        if (
          receipt?.blockHash &&
          validHash(receipt.blockHash) &&
          !same(receipt.blockHash, zeroHash) &&
          receipt.blockNumber &&
          isHex(receipt.blockNumber, { strict: true }) &&
          receipt.blockNumber.length > 2
        ) {
          const block = (await rpc("eth_getBlockByNumber", [
            receipt.blockNumber,
            false,
          ])) as { hash?: string } | null;
          if (
            block?.hash &&
            validHash(block.hash) &&
            hexToBigInt(block.hash as `0x${string}`) !== 0n
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
