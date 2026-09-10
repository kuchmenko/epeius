import { showStartup } from "../apps/terminal/src/main";
import { startEngine } from "./engine";
import { buildEngine } from "./tasks";

const abort = new AbortController();
const cancel = () => abort.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  await buildEngine(abort.signal);
  const engine = await startEngine(process.env, abort.signal);
  const stop = () => {
    void engine.stop();
  };
  abort.signal.addEventListener("abort", stop, { once: true });
  try {
    showStartup(engine.ready.environment, engine.ready.url);
    console.log(
      `Chain ${engine.ready.chainId} · block ${engine.ready.blockNumber}\n${engine.ready.blockHash}`,
    );
    await engine.child.exited;
    if (!abort.signal.aborted)
      throw new Error("Engine stopped unexpectedly. Restart with bun run dev.");
  } finally {
    abort.signal.removeEventListener("abort", stop);
    await engine.stop();
  }
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(error instanceof Error ? error.message : "Startup failed.");
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
