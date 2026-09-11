import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dir, "..");
export const engineDir = join(root, "services/quote-engine");
export const engineBinary = join(root, "dist/epeius-engine");

export async function run(
  cmd: string[],
  cwd = root,
  env = process.env,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const code = await child.exited;
    if (code !== 0)
      throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed (${code}).`);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

export async function buildEngine(signal?: AbortSignal) {
  await mkdir(join(root, "dist"), { recursive: true });
  await run(
    ["go", "build", "-o", engineBinary, "./cmd/epeius-engine"],
    engineDir,
    process.env,
    signal,
  );
}

async function generatedFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(path: string) {
    for (const entry of await readdir(join(directory, path), {
      withFileTypes: true,
    })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (name.endsWith(".go") || name.endsWith(".ts"))
        files.set(name, await Bun.file(join(directory, name)).text());
    }
  }
  await visit("");
  return files;
}

async function task(name: string) {
  switch (name) {
    case "setup": {
      const env = { ...process.env, GOBIN: join(root, ".tools/bin") };
      await run(
        [
          "go",
          "install",
          "google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12",
        ],
        root,
        env,
      );
      await run(
        [
          "go",
          "install",
          "connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.0",
        ],
        root,
        env,
      );
      await run(
        ["go", "install", "honnef.co/go/tools/cmd/staticcheck@2026.1"],
        root,
        env,
      );
      await run(["go", "mod", "download"], join(root, "generated/go"));
      await run(["go", "mod", "download"], engineDir);
      break;
    }
    case "generate":
      await run(["bunx", "--no-install", "buf", "generate"]);
      break;
    case "check:generated": {
      const temporary = await mkdtemp(join(tmpdir(), "epeius-generation-"));
      try {
        await run([
          "bunx",
          "--no-install",
          "buf",
          "generate",
          "--output",
          temporary,
        ]);
        const expected = await generatedFiles(join(temporary, "generated"));
        const actual = await generatedFiles(join(root, "generated"));
        if (
          actual.size !== expected.size ||
          [...expected].some(([name, text]) => actual.get(name) !== text)
        ) {
          throw new Error(
            "Generated bindings differ. Run bun run generate and remove stale generated files.",
          );
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      break;
    }
    case "check": {
      await run(["bunx", "--no-install", "biome", "check", "."]);
      await run(["bunx", "--no-install", "buf", "lint"]);
      await run([
        "bunx",
        "--no-install",
        "buf",
        "format",
        "--diff",
        "--exit-code",
      ]);
      await run([
        "bunx",
        "--no-install",
        "tsc",
        "-p",
        "apps/terminal/tsconfig.json",
      ]);
      const formatting = Bun.spawn(
        ["gofmt", "-l", "services", "generated/go"],
        { cwd: root, stdout: "pipe" },
      );
      const unformatted = await new Response(formatting.stdout).text();
      if ((await formatting.exited) !== 0 || unformatted.trim())
        throw new Error(`Run gofmt on: ${unformatted}`);
      for (const directory of [join(root, "generated/go"), engineDir]) {
        await run(["go", "vet", "./..."], directory);
        if (directory === engineDir)
          await run([join(root, ".tools/bin/staticcheck"), "./..."], engineDir);
        // Go's test cache does not track the TypeScript subprocess inputs.
        await run(["go", "test", "-race", "-count=1", "./..."], directory);
      }
      await buildEngine();
      await run(["bun", "test", "apps/terminal", "scripts"]);
      await run([
        "bun",
        "build",
        "apps/terminal/src/main.ts",
        "--target=bun",
        "--outdir=dist/terminal",
      ]);
      break;
    }
    default:
      throw new Error("Unknown repository task.");
  }
}

if (import.meta.main) {
  try {
    await task(Bun.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Task failed.");
    process.exitCode = 1;
  }
}
