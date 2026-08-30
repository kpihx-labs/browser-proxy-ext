/**
 * Purpose: bundle each Manifest V3 TypeScript entry point into the extension's `dist` directory.
 * Args: none.
 * Returns: a promise that resolves after Bun has written all bundles, or rejects on a build error.
 * Examples: `bun run scripts/build.ts`; `make build`.
 */
async function buildExtension(): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/background.ts", "src/content.ts", "src/options.ts", "src/offscreen.ts"],
    outdir: "dist",
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    minify: false,
  });

  if (!result.success) {
    throw new Error(`Extension build failed: ${result.logs.map((log) => log.message).join("; ")}`);
  }
}

void buildExtension();
