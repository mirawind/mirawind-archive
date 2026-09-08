export const readerAssetIdentity = "mirawind-reader-v5-tailwind-4.3.3" as const;
export const readerMermaidAssetIdentity = "mirawind-mermaid-11.16.0" as const;
export const readerStylesheetUrl =
  `/reader-assets/styles/${readerAssetIdentity}.css` as const;
export const readerScriptUrl =
  `/reader-assets/scripts/${readerAssetIdentity}.js` as const;
export const readerMermaidScriptUrl =
  `/reader-assets/scripts/${readerMermaidAssetIdentity}/index.js` as const;

export function acceptedReaderAssetPath(
  assetPath: string | undefined,
  rendererIdentity: string,
): string | null {
  if (!assetPath) return null;
  const rendererPrefix = `renderers/${rendererIdentity}/`;
  if (assetPath.startsWith(rendererPrefix)) {
    const relative = assetPath.slice(rendererPrefix.length);
    return ["LICENSE", "integrity.json", "katex.css"].includes(relative) ||
      /^fonts\/KaTeX_[A-Za-z0-9-]+\.woff2$/u.test(relative)
      ? assetPath
      : null;
  }
  const mermaidPrefix = `scripts/${readerMermaidAssetIdentity}/`;
  if (assetPath.startsWith(mermaidPrefix)) {
    const relative = assetPath.slice(mermaidPrefix.length);
    return relative === "index.js" ||
      /^chunks\/[A-Za-z0-9_.-]+\.js$/u.test(relative)
      ? assetPath
      : null;
  }
  return assetPath === `scripts/${readerAssetIdentity}.js` ||
    assetPath === `styles/${readerAssetIdentity}.css`
    ? assetPath
    : null;
}
