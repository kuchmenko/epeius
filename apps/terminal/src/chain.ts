import {
  createPublicClient,
  hexToBigInt,
  http,
  isHash,
  isHex,
  zeroHash,
} from "viem";
import type { Receipt } from "./execution-policy";

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
  };
}
