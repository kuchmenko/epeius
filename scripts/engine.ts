import { engineBinary, root } from "./tasks";

export type Ready = {
  event: "ready";
  url: string;
  environment: string;
  chainId: string;
  blockNumber: string;
  blockHash: string;
};

// Shared only by local launchers and tests; never manages an existing service.
export async function startEngine(env = process.env, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const child = Bun.spawn([engineBinary], {
    cwd: root,
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
