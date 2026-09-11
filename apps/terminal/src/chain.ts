import type { Receipt } from "./execution-policy";

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function readChain(rpcUrl: string, signal: AbortSignal) {
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
  };
}
