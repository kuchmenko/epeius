import { fromJsonString } from "@bufbuild/protobuf";
import { formatStatus } from "../apps/terminal/src/format";
import {
  type ChainStatus,
  GetStatusResponseSchema,
} from "../generated/ts/epeius/quote/v1/quote_pb";
import { buildEngine, engineBinary } from "./tasks";

export type Ready = {
  event: "ready";
  url: string;
  chains: ChainStatus[];
};

// Shared only by local launchers and tests; never manages an existing service.
export async function startEngine(
  env = process.env,
  signal?: AbortSignal,
  args: string[] = [],
) {
  signal?.throwIfAborted();
  const child = Bun.spawn([engineBinary, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  let stopping: Promise<void> | undefined;
  function stop() {
    stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 4000);
      try {
        await child.exited;
      } finally {
        clearTimeout(force);
      }
    })();
    return stopping;
  }
  const cancel = () => {
    void stop();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    const reader = child.stdout
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let text = "";
    try {
      while (!text.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(
            (await errors).trim() ||
              "Engine stopped before readiness. Check its configuration.",
          );
        text += chunk.value;
      }
    } finally {
      reader.releaseLock();
    }
    const ready: Ready = JSON.parse(text.slice(0, text.indexOf("\n")));
    if (ready.event !== "ready" || !ready.url)
      throw new Error("Engine did not report readiness.");
    ready.chains = fromJsonString(
      GetStatusResponseSchema,
      JSON.stringify({ chains: ready.chains }),
    ).chains;
    signal?.throwIfAborted();
    return { child, ready, errors, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

if (import.meta.main) {
  const args = Bun.argv
    .slice(2)
    .filter((arg, index) => !(index === 0 && arg === "--"));
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run engine [--config PATH] [--anvil-simulation]\nStarts all configured chains. --anvil-simulation enables read-only trace simulation for a single loopback Anvil chain. Press Ctrl+C to stop.",
    );
  } else {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      await buildEngine(abort.signal);
      const engine = await startEngine(process.env, abort.signal, args);
      const stop = () => {
        void engine.stop();
      };
      abort.signal.addEventListener("abort", stop, { once: true });
      try {
        console.log(
          `Epeius — non-signing engine\nEngine: ${engine.ready.url}\n${formatStatus(engine.ready.chains)}\nConnectivity was checked at startup. Only the terminal signs and sends transactions.\nPress Ctrl+C to stop.`,
        );
        await engine.child.exited;
        if (!abort.signal.aborted)
          throw new Error(
            "Engine stopped unexpectedly. Restart with bun run engine.",
          );
      } finally {
        abort.signal.removeEventListener("abort", stop);
        await engine.stop();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error(
          error instanceof Error ? error.message : "Startup failed.",
        );
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
}
