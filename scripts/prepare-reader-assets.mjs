import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const identity = "mirawind-reader-v5-tailwind-4.3.3";
const mermaidIdentity = "mirawind-mermaid-11.16.0";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) {
  throw new Error("READER_ASSET_OUTPUT_REQUIRED");
}
const outputPath = resolve(
  outputFlag >= 0
    ? process.argv[outputFlag + 1]
    : resolve(projectRoot, "public", "_astro", "scripts", `${identity}.js`),
);
const defaultOutput = outputFlag < 0;
const mermaidOutputDirectory = resolve(dirname(outputPath), mermaidIdentity);

if (defaultOutput) {
  await Promise.all(
    ["scripts", "styles"].map((directory) =>
      rm(resolve(projectRoot, "public", "_astro", directory), {
        force: true,
        recursive: true,
      }),
    ),
  );
} else {
  await rm(outputPath, { force: true });
}
await mkdir(dirname(outputPath), { mode: 0o755, recursive: true });
await copyFile(
  resolve(projectRoot, "src", "web", "features", "reader", "reader-runtime.js"),
  outputPath,
);
await build({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(
        projectRoot,
        "src",
        "web",
        "features",
        "reader",
        "reader-mermaid.ts",
      ),
      fileName: () => "index.js",
      formats: ["es"],
    },
    minify: true,
    outDir: mermaidOutputDirectory,
    rollupOptions: {
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
    target: "es2022",
  },
  configFile: false,
  logLevel: "warn",
  publicDir: false,
});
