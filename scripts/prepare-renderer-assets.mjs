import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transform } from "lightningcss";

const rendererVersion = "semantic-html-v8-katex-0.18.1";
const katexVersion = "0.18.1";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0 && !process.argv[outputFlag + 1]) {
  throw new Error("RENDERER_ASSET_OUTPUT_REQUIRED");
}
const outputDirectory = resolve(
  outputFlag >= 0
    ? process.argv[outputFlag + 1]
    : resolve(projectRoot, "public", "_astro", "renderers", rendererVersion),
);
const defaultOutput = outputFlag < 0;
const require = createRequire(import.meta.url);
const packagePath = require.resolve("katex/package.json");
const packageRoot = dirname(packagePath);
const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
if (packageMetadata.version !== katexVersion) {
  throw new Error("RENDERER_KATEX_VERSION_MISMATCH");
}

function canonicalJson(value) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) =>
            Buffer.from(left).compare(Buffer.from(right)),
          )
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return input;
  };
  return `${JSON.stringify(canonical(value))}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rendererCss(source) {
  const woff2Only = source
    .replace(/src:\s*([^;]+);/gu, (_match, sources) => {
      const woff2 = String(sources)
        .split(",")
        .map((value) => value.trim())
        .find((value) => /\.woff2\)/u.test(value));
      if (!woff2) throw new Error("RENDERER_FONT_WOFF2_MISSING");
      return `src: ${woff2};`;
    })
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const minified = transform({
    code: Buffer.from(woff2Only, "utf8"),
    filename: "katex.css",
    minify: true,
  }).code.toString("utf8");
  return `${minified.trim()}\n`;
}

await rm(defaultOutput ? dirname(outputDirectory) : outputDirectory, {
  force: true,
  recursive: true,
});
await mkdir(resolve(outputDirectory, "fonts"), {
  mode: 0o755,
  recursive: true,
});
const upstreamCss = await readFile(
  resolve(packageRoot, "dist", "katex.css"),
  "utf8",
);
const css = rendererCss(upstreamCss);
if (/https?:|\.woff(?:["')]|$)|\.ttf/iu.test(css)) {
  throw new Error("RENDERER_CSS_EXTERNAL_OR_LEGACY_ASSET");
}
const referencedFonts = [
  ...new Set(
    [...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/gu)].map(
      (match) => match[1],
    ),
  ),
].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
const availableFonts = (await readdir(resolve(packageRoot, "dist", "fonts")))
  .filter((name) => name.endsWith(".woff2"))
  .map((name) => `fonts/${name}`)
  .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
if (
  referencedFonts.length !== 20 ||
  JSON.stringify(referencedFonts) !== JSON.stringify(availableFonts)
) {
  throw new Error("RENDERER_FONT_CLOSURE_MISMATCH");
}

await writeFile(resolve(outputDirectory, "katex.css"), css, { mode: 0o644 });
for (const relativePath of referencedFonts) {
  await copyFile(
    resolve(packageRoot, "dist", relativePath),
    resolve(outputDirectory, relativePath),
  );
}
await copyFile(
  resolve(packageRoot, "LICENSE"),
  resolve(outputDirectory, "LICENSE"),
);
const paths = ["LICENSE", "katex.css", ...referencedFonts].sort((left, right) =>
  Buffer.from(left).compare(Buffer.from(right)),
);
const files = await Promise.all(
  paths.map(async (path) => {
    const bytes = await readFile(resolve(outputDirectory, path));
    return Object.freeze({
      path,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    });
  }),
);
await writeFile(
  resolve(outputDirectory, "integrity.json"),
  canonicalJson({
    files,
    katex_version: katexVersion,
    renderer_version: rendererVersion,
    schema_version: 1,
  }),
  { mode: 0o644 },
);
