import { randomBytes } from "node:crypto";

import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import type { SafeDiagnostic } from "@/domain/errors";
import type {
  NormalizedDocument,
  TransientDocumentNode,
} from "../preparation/document-model";
import type { ResourceResolution } from "./resource-model";
import type { HeadingPresentation } from "./heading-presentation";
import { resolveBlockLinkTarget, type BlockLinkIndex } from "./compiled-book";
import { renderCode } from "./render-code";
import { renderMath } from "./render-math";
import {
  importedHtmlSanitizationSchema,
  rehypeRestrictResources,
} from "./sanitize-html";

interface TreeNode {
  alt?: string;
  blockId?: string;
  children?: TreeNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  depth?: number;
  identifier?: string;
  lang?: string | null;
  properties?: Record<string, unknown>;
  tagName?: string;
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
  [key: string]: unknown;
}

interface MathSource {
  readonly blockId?: string;
  readonly displayMode: boolean;
  readonly source: string;
}

type RenderHeadingPresentation = Pick<
  HeadingPresentation,
  "display_level" | "number" | "titleChildren"
>;

export interface SemanticRenderResult {
  readonly css: string;
  readonly diagnostics: readonly SafeDiagnostic[];
  readonly html: string;
}

export interface RenderSemanticDocumentOptions {
  readonly document: NormalizedDocument;
  readonly blockHref?: (blockId: string) => string;
  readonly blockLinkIndex: BlockLinkIndex;
  readonly headingPresentations?: ReadonlyMap<
    string,
    RenderHeadingPresentation
  >;
  readonly publishedResourceUrl: (resourceId: string) => string;
  readonly resourceResolution: ResourceResolution;
}

const blockIdPattern = /^blk_[A-Za-z0-9_-]{16,80}$/u;
const forbiddenTags = new Set(["embed", "iframe", "object", "script"]);

function assertSafePublishedUrl(url: string): void {
  if (
    !url.startsWith("/") ||
    url.startsWith("//") ||
    [...url].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new TypeError(
      "Published resource URL must be a safe same-origin path",
    );
  }
}

function rendererTree(options: RenderSemanticDocumentOptions): TreeNode {
  const resourceIdByOriginalUrl = new Map(
    options.resourceResolution.references.map((reference) => [
      reference.originalUrl,
      reference.resourceId,
    ]),
  );
  const resourceUrls = new Map<string, string>();
  const mathSourceByMarker = new Map<string, MathSource>();
  const mathMarkerPrefix = randomBytes(16).toString("base64url");
  let mathSourceIndex = 0;
  for (const resource of options.resourceResolution.resources) {
    const url = options.publishedResourceUrl(resource.id);
    assertSafePublishedUrl(url);
    resourceUrls.set(resource.id, url);
  }
  const clone = (node: TransientDocumentNode): TreeNode => {
    const { children, ...properties } = node;
    const output: TreeNode = {
      ...properties,
      ...(children ? { children: children.map(clone) } : {}),
    };
    if (node.blockId) {
      output.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, dataBlockId: node.blockId },
      };
    }

    if (node.type === "heading" && node.blockId) {
      const presentation = options.headingPresentations?.get(node.blockId);
      const depth = presentation?.display_level ?? node.depth;
      if (depth !== undefined) output.depth = depth;
      output.data = {
        hProperties: {
          dataBlockId: node.blockId,
          id: node.blockId,
        },
      };
      if (presentation) {
        output.children = [
          ...(presentation.number
            ? [
                {
                  children: [
                    { type: "text", value: `${presentation.number} ` },
                  ],
                  data: {
                    hName: "span",
                    hProperties: { className: ["heading-number"] },
                  },
                  type: "mirawindHeadingNumber",
                },
              ]
            : []),
          ...presentation.titleChildren.map(clone),
        ];
      }
    } else if (node.type === "inlineMath" && node.value !== undefined) {
      const marker = `${mathMarkerPrefix}_${mathSourceIndex++}`;
      mathSourceByMarker.set(
        marker,
        Object.freeze({
          ...(node.blockId ? { blockId: node.blockId } : {}),
          displayMode: false,
          source: node.value,
        }),
      );
      output.data = {
        hName: "code",
        hProperties: {
          className: ["language-math", "math-inline"],
          dataMirawindMath: marker,
        },
      };
      output.children = [{ type: "text", value: node.value }];
      delete output.value;
    } else if (node.type === "math" && node.value !== undefined) {
      const marker = `${mathMarkerPrefix}_${mathSourceIndex++}`;
      mathSourceByMarker.set(
        marker,
        Object.freeze({
          ...(node.blockId ? { blockId: node.blockId } : {}),
          displayMode: true,
          source: node.value,
        }),
      );
      output.data = {
        hName: "div",
        hProperties: {
          className: ["math-block"],
          ...(node.blockId ? { dataBlockId: node.blockId } : {}),
        },
      };
      output.children = [
        {
          children: [
            {
              children: [{ type: "text", value: node.value }],
              data: {
                hName: "code",
                hProperties: {
                  className: ["language-math", "math-display"],
                  dataMirawindMath: marker,
                },
              },
              type: "mirawindMathCode",
            },
          ],
          data: { hName: "pre" },
          type: "mirawindMathPre",
        },
      ];
      delete output.value;
    } else if (node.type === "semanticContainer" && node.containerKind) {
      output.data = {
        hName: "aside",
        hProperties: {
          ariaLabel: node.containerKind,
          className: ["semantic-container", `semantic-${node.containerKind}`],
          dataContainerKind: node.containerKind,
          ...(node.blockId ? { dataBlockId: node.blockId } : {}),
        },
      };
    }

    if (
      node.type === "image" ||
      (node.type === "link" &&
        node.url &&
        resourceIdByOriginalUrl.has(node.url))
    ) {
      const resourceId = node.url
        ? resourceIdByOriginalUrl.get(node.url)
        : undefined;
      const publishedUrl = resourceId
        ? resourceUrls.get(resourceId)
        : undefined;
      output.url = publishedUrl ?? "";
      if (resourceId && publishedUrl)
        output.data = {
          ...(output.data ?? {}),
          hProperties: {
            ...(output.data?.hProperties ?? {}),
            dataMirawindResource: resourceId,
          },
        };
    }
    return output;
  };

  const root = clone(options.document.root);
  Object.defineProperty(root, "_resourceUrls", {
    enumerable: false,
    value: resourceUrls,
  });
  Object.defineProperty(root, "_mathSourceByMarker", {
    enumerable: false,
    value: mathSourceByMarker,
  });
  return root;
}

function textContent(node: TreeNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function classNames(node: TreeNode): readonly unknown[] {
  return Array.isArray(node.properties?.className)
    ? node.properties.className
    : [];
}

function renderMathNodes(
  tree: TreeNode,
  sourceByMarker: ReadonlyMap<string, MathSource>,
  diagnostics: SafeDiagnostic[],
): void {
  const consumedMarkers = new Set<string>();
  const trackedSource = (node: TreeNode): MathSource | undefined => {
    const marker = node.properties?.dataMirawindMath;
    if (typeof marker !== "string") return;
    delete node.properties?.dataMirawindMath;
    const source = sourceByMarker.get(marker);
    if (!source) return;
    if (consumedMarkers.has(marker)) {
      throw new Error("MATH_SOURCE_ALIGNMENT_INVALID");
    }
    consumedMarkers.add(marker);
    return source;
  };
  const render = (
    parent: TreeNode,
    index: number,
    scope: TreeNode,
    code: TreeNode,
    displayMode: boolean,
    sourceMetadata: MathSource | undefined,
  ): void => {
    if (sourceMetadata && sourceMetadata.displayMode !== displayMode) {
      throw new Error("MATH_SOURCE_ALIGNMENT_INVALID");
    }
    const source = sourceMetadata?.source ?? textContent(scope);
    const rendered = renderMath({
      ...(sourceMetadata?.blockId ? { blockId: sourceMetadata.blockId } : {}),
      displayMode,
      source,
    });
    if (!rendered.diagnostic && rendered.markup) {
      // Imported HTML is already sanitized; raw nodes are reserved for KaTeX
      // output generated above with trust disabled.
      parent.children?.splice(index, 1, {
        type: "raw",
        value: rendered.markup,
      });
      return;
    }
    if (rendered.diagnostic) diagnostics.push(rendered.diagnostic);
    code.properties = { className: ["math-fallback"] };
    code.children = [{ type: "text", value: rendered.source }];
    if (displayMode) {
      const parentClasses = classNames(parent);
      if (parentClasses.includes("math-block")) {
        parent.properties = {
          ...(parent.properties ?? {}),
          className: ["math-fallback"],
        };
      }
    }
  };
  const visit = (parent: TreeNode): void => {
    for (let index = 0; index < (parent.children?.length ?? 0); index += 1) {
      const child = parent.children?.[index];
      if (!child || child.type !== "element") continue;
      if (child.tagName === "pre") {
        const code = child.children?.[0];
        const classes = code ? classNames(code) : [];
        if (
          code?.type === "element" &&
          code.tagName === "code" &&
          classes.includes("language-math")
        ) {
          const source = trackedSource(code);
          render(parent, index, child, code, true, source);
          continue;
        }
      }
      const classes = classNames(child);
      if (
        classes.includes("language-math") ||
        classes.includes("math-display") ||
        classes.includes("math-inline")
      ) {
        const displayMode = classes.includes("math-display");
        const source = trackedSource(child);
        render(parent, index, child, child, displayMode, source);
        continue;
      }
      visit(child);
    }
  };
  visit(tree);
  const stripMarkers = (node: TreeNode): void => {
    delete node.properties?.dataMirawindMath;
    for (const child of node.children ?? []) stripMarkers(child);
  };
  stripMarkers(tree);
}

async function highlightCodeBlocks(
  tree: TreeNode,
  diagnostics: SafeDiagnostic[],
  codeBlockIds: readonly string[],
): Promise<string> {
  const css: string[] = [];
  let codeBlockIndex = 0;
  const visit = async (node: TreeNode): Promise<void> => {
    if (node.children) {
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (
          child?.type === "element" &&
          child.tagName === "pre" &&
          child.children?.length === 1
        ) {
          const code = child.children[0];
          const classes = Array.isArray(code?.properties?.className)
            ? code.properties.className
            : [];
          const languageClass = classes.find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("language-"),
          );
          if (
            code?.type === "element" &&
            code.tagName === "code" &&
            languageClass !== "language-math"
          ) {
            const blockId = codeBlockIds[codeBlockIndex++];
            const source = textContent(code);
            const rendered = await renderCode({
              ...(blockId ? { blockId } : {}),
              ...(languageClass
                ? { language: languageClass.slice("language-".length) }
                : {}),
              source,
            });
            node.children[index] = rendered.tree as TreeNode;
            if (rendered.css) css.push(rendered.css);
            if (rendered.diagnostic) diagnostics.push(rendered.diagnostic);
            continue;
          }
        }
        if (child) await visit(child);
      }
    }
  };
  await visit(tree);
  return [...new Set(css)].sort().join("");
}

function restoreStableHeadingIds(tree: TreeNode): void {
  const visit = (node: TreeNode) => {
    if (
      node.type === "element" &&
      /^h[1-4]$/u.test(node.tagName ?? "") &&
      typeof node.properties?.dataBlockId === "string" &&
      blockIdPattern.test(node.properties.dataBlockId)
    ) {
      node.properties.id = node.properties.dataBlockId;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function repairFootnoteLinks(
  tree: TreeNode,
  footnoteBlockIds: readonly string[],
): void {
  const normalizeId = (value: string) =>
    value.replace(/^(?:user-content-){2,}/u, "user-content-");
  let footnoteIndex = 0;
  const visit = (node: TreeNode, insideFootnotes = false) => {
    const isFootnotes =
      insideFootnotes ||
      (node.type === "element" &&
        Object.hasOwn(node.properties ?? {}, "dataFootnotes"));
    if (node.type === "element") {
      const properties = node.properties ?? {};
      const id = properties.id;
      if (typeof id === "string") properties.id = normalizeId(id);
      const href = properties.href;
      if (typeof href === "string" && href.startsWith("#")) {
        properties.href = `#${normalizeId(href.slice(1))}`;
      }
      if (Object.hasOwn(properties, "dataFootnoteRef")) {
        properties.role = "doc-noteref";
      } else if (isFootnotes && node.tagName === "li") {
        properties.role = "doc-endnote";
        const blockId = footnoteBlockIds[footnoteIndex++];
        if (blockId) properties.dataBlockId = blockId;
      }
      node.properties = properties;
    }
    for (const child of node.children ?? []) visit(child, isFootnotes);
  };
  visit(tree);
}

function repairInternalHeadingLinks(
  tree: TreeNode,
  blockLinkIndex: BlockLinkIndex,
  blockHref: ((blockId: string) => string) | undefined,
): void {
  const visit = (node: TreeNode) => {
    if (
      node.type === "element" &&
      node.tagName === "a" &&
      typeof node.properties?.href === "string" &&
      node.properties.href.startsWith("#") &&
      !Object.hasOwn(node.properties, "dataFootnoteRef") &&
      !Object.hasOwn(node.properties, "dataFootnoteBackref")
    ) {
      const rawTarget = node.properties.href.slice(1);
      let decoded = rawTarget;
      try {
        decoded = decodeURIComponent(rawTarget);
      } catch {
        // Keep the literal fragment; an unresolved link fails below.
      }
      const target = resolveBlockLinkTarget(blockLinkIndex, decoded);
      if (!target) throw new Error("INTERNAL_HEADING_LINK_UNRESOLVED");
      const href = blockHref?.(target) ?? `#${target}`;
      if (
        !href.startsWith("/") &&
        !href.startsWith("#") &&
        !/^[1-9][0-9]*#[A-Za-z0-9_-]+$/u.test(href)
      ) {
        throw new TypeError("Heading URL must be a safe publication path");
      }
      node.properties.href = href;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function assertPostRenderInvariants(tree: TreeNode): void {
  const ids = new Set<string>();
  const visit = (node: TreeNode) => {
    if (node.type === "element") {
      if (forbiddenTags.has(node.tagName ?? "")) {
        throw new Error("Forbidden element survived semantic rendering");
      }
      const id = node.properties?.id;
      if (typeof id === "string") {
        if (ids.has(id)) throw new Error("Duplicate rendered element ID");
        ids.add(id);
      }
      const source = node.properties?.src;
      if (typeof source === "string" && /^(?:[a-z]+:)?\/\//iu.test(source)) {
        throw new Error("External resource URL survived semantic rendering");
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

export async function renderSemanticDocument(
  options: RenderSemanticDocumentOptions,
): Promise<SemanticRenderResult> {
  const diagnostics: SafeDiagnostic[] = [
    ...options.resourceResolution.diagnostics,
  ];
  const tree = rendererTree(options);
  const rendererState = tree as TreeNode & {
    _mathSourceByMarker: ReadonlyMap<string, MathSource>;
    _resourceUrls: ReadonlyMap<string, string>;
  };
  const processor = unified()
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeRestrictResources, {
      allowedResourceUrls: rendererState._resourceUrls,
    })
    .use(rehypeSanitize, importedHtmlSanitizationSchema);
  const transformed = (await processor.run(tree as never)) as TreeNode;
  renderMathNodes(transformed, rendererState._mathSourceByMarker, diagnostics);
  restoreStableHeadingIds(transformed);
  repairFootnoteLinks(
    transformed,
    options.document.blocks.flatMap((block) =>
      block.type === "footnoteDefinition" && block.blockId
        ? [block.blockId]
        : [],
    ),
  );
  repairInternalHeadingLinks(
    transformed,
    options.blockLinkIndex,
    options.blockHref,
  );
  const css = await highlightCodeBlocks(
    transformed,
    diagnostics,
    options.document.blocks.flatMap((block) =>
      block.type === "code" && block.blockId ? [block.blockId] : [],
    ),
  );
  assertPostRenderInvariants(transformed);
  const html = unified()
    .use(rehypeStringify, { allowDangerousHtml: true })
    .stringify(transformed as never);
  return Object.freeze({
    css,
    diagnostics: Object.freeze(diagnostics),
    html,
  });
}
