import type { UnsignedTransaction } from "../../../generated/ts/epeius/quote/v1/quote_pb";

export function castWallet(
  keystore: string,
  passwordFile: string,
  rpcUrl: string,
  signal: AbortSignal,
) {
  const wallet = ["--keystore", keystore, "--password-file", passwordFile];
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
  return {
    account: () => cast(["wallet", "address", ...wallet]),
    send: (tx: UnsignedTransaction) =>
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
  };
}
