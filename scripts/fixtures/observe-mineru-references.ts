import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDraft } from "../../src/modules/publishing/adapters/worker/prepare-draft.js";
import { extractZipFile } from "../../src/modules/publishing/adapters/filesystem/extract-archive.js";
import { validateBookDocument } from "../../src/modules/publishing/core/content/book-document.js";
import {
  inferPrintedHeadingEvidence,
  type PrintedContentsCandidate,
} from "../../src/modules/publishing/core/preparation/printed-contents.js";
import type { ImportedBlockOrigin } from "../../src/modules/publishing/core/preparation/mineru-content.js";
import type { MineruReferencePack } from "./create-mineru-reference-pack.js";
import type { ObservedMineruOutcome } from "./compare-mineru-references.js";
import {
  type ReferenceAnchor,
  type ReferenceContentsEntry,
  type ReferenceContentsRegion,
  type ReferenceSemanticKind,
} from "./mineru-reference.js";
import { verifySourceContent } from "./source-content-fidelity.js";
import { verifyRealMineruFixtures } from "./verify-real-mineru.js";

const frontmatter =
  /^(?:序|序言|前言|中文版序(?:[0-9零〇一二三四五六七八九十]+)?|第\s*[0-9零〇一二三四五六七八九十百千]+\s*版\s*前言|译者序|致学生|致教师|出版者的话|关于作者|专家指导委员会|作者简介|译者简介|教学建议|preface(?:\s+to\s+(?:the\s+)?[\p{L}\p{N} -]+\s+edition)?|foreword|prologue)$/iu;
const backmatter =
  /^(?:参考文献|参考资料|(?:表|图|主题|作者)?索引|(?:译)?后记|致谢|术语表|图片来源|符号索引|bibliography|references|(?:author|subject)\s+index|index|afterword|acknowledg(?:e)?ments?|credits)$/iu;

function normalize(value: string): string {
  return value
    .normalize("NFC")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, "")
    .replace(/[*_`]/gu, "")
    .replace(/\\([\\`*_{}[\]()#+.!-])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

export function stripPageLabel(value: string): {
  readonly pageLabel: string | null;
  readonly title: string;
} {
  const text = normalize(value);
  if (
    /^(?:chapter|part)\s+(?:[0-9ivxlcdm]+|[A-Z])\s+.*\b(?:windows|macos|android)\s+\d+\s*$/iu.test(
      text,
    )
  ) {
    return Object.freeze({ pageLabel: null, title: text });
  }
  if (/^(?:chapter|part)\s+(?:\d+|[ivxlcdm]+)$/iu.test(text)) {
    return Object.freeze({ pageLabel: null, title: text });
  }
  const match =
    /^(?<title>.+?)(?:\.(?:\s*\.)+|…+|·(?:\s*·)+|\s{2,}|\s)\s*(?<page>[ivxlcdm]+|\d{1,5})\s*$/iu.exec(
      text,
    ) ?? /^(?<title>.+[)\]}>])(?<page>\d{1,5})\s*$/u.exec(text);
  if (!match?.groups?.title || !match.groups.page) {
    return Object.freeze({ pageLabel: null, title: text });
  }
  const title = match.groups.title.trim();
  if (
    (title.length < 2 && !/^\p{Script=Han}$/u.test(title)) ||
    /^(?:chapter|part|第\s*\d+\s*(?:章|部分))$/iu.test(title)
  ) {
    return Object.freeze({ pageLabel: null, title: text });
  }
  return Object.freeze({ pageLabel: match.groups.page, title });
}

function kindFor(
  title: string,
  level: number,
  beforeFirstBodyUnit: boolean,
): ReferenceSemanticKind {
  const evidence = inferPrintedHeadingEvidence(title);
  if (evidence?.kind === "part") return "part";
  if (evidence?.kind === "chapter") return "chapter";
  if (evidence?.kind === "appendix") return "appendix";
  if (evidence?.kind === "decimal") return "section";
  if (frontmatter.test(title)) return "frontmatter";
  if (
    beforeFirstBodyUnit &&
    /^(?:致谢|acknowledg(?:e)?ments?)$/iu.test(title)
  ) {
    return "frontmatter";
  }
  if (backmatter.test(title)) return level > 1 ? "other" : "backmatter";
  return "other";
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function observeRealMineruFixture(input: {
  readonly archivePath: string;
  readonly pack: MineruReferencePack;
  readonly stagingDirectory: string;
  readonly preparedBookRoot?: string;
}): Promise<ObservedMineruOutcome> {
  const { pack } = input;
  if (
    pack.schema_version !== 2 ||
    !pack.content_json ||
    (await fileHash(input.archivePath)) !== pack.archive_sha256
  )
    throw new Error("OBSERVED_REFERENCE_PACK_BINDING_MISMATCH");
  const originalPdf = pack.pdf_documents.find((pdf) =>
    /(?:^|[/_])origin\.pdf$/iu.test(pdf.relative_path),
  );
  if (!originalPdf) throw new Error("OBSERVED_REFERENCE_PRIMARY_INPUT_INVALID");
  const prepared = input.preparedBookRoot
    ? {
        preparedRoot: input.preparedBookRoot,
        extractedRoot: join(input.stagingDirectory, "extracted"),
      }
    : await prepareDraft({
        archivePath: input.archivePath,
        bookId: 1,
        sourcePath: pack.content_json.relative_path,
        stagingDirectory: input.stagingDirectory,
      });
  if (input.preparedBookRoot)
    await extractZipFile({
      archivePath: input.archivePath,
      destination: prepared.extractedRoot,
    });
  const book = validateBookDocument(
    JSON.parse(
      await readFile(join(prepared.preparedRoot, "import/book.json"), "utf8"),
    ),
  );
  if (
    (await fileHash(
      join(prepared.extractedRoot, pack.content_json.relative_path),
    )) !== pack.content_json.input_sha256 ||
    (await fileHash(
      join(prepared.extractedRoot, originalPdf.relative_path),
    )) !== originalPdf.sha256
  )
    throw new Error("OBSERVED_REFERENCE_INPUT_HASH_MISMATCH");
  const analysis = JSON.parse(
    await readFile(
      join(prepared.preparedRoot, "import", "analysis.json"),
      "utf8",
    ),
  ) as {
    origins: ImportedBlockOrigin[];
    printed_contents: PrintedContentsCandidate[];
  };
  const byId = new Map(
    analysis.origins.map((origin) => [origin.block_id, origin]),
  );
  const candidates = analysis.printed_contents.filter(
    (candidate) => candidate.proposedRegion,
  );
  const regionByBlock = new Map<string, string>();
  const anchorFor = (blockId: string): ReferenceAnchor | null => {
    const origin = byId.get(blockId);
    return origin
      ? { page_index: origin.page_index, source_index: origin.source_index }
      : null;
  };
  const regions: ReferenceContentsRegion[] = candidates.map(
    (candidate, candidateIndex) => {
      const key =
        candidates.length === 2 && candidateIndex === 0
          ? "brief-contents"
          : "full-contents";
      const ids = candidate.proposedRegion?.block_ids ?? [];
      for (const id of ids) regionByBlock.set(id, key);
      const first = ids[0],
        last = ids.at(-1);
      const start = first ? anchorFor(first) : null,
        end = last ? anchorFor(last) : null;
      if (!start || !end)
        throw new Error("OBSERVED_REFERENCE_REGION_ANCHOR_MISSING");
      const firstBody = candidate.logicalEntries.findIndex((entry) => {
        const kind = inferPrintedHeadingEvidence(
          stripPageLabel(entry.sourceTitle).title,
        )?.kind;
        return kind === "chapter" || kind === "part";
      });
      const entries: ReferenceContentsEntry[] = candidate.logicalEntries.map(
        (entry, index) => {
          const printed = stripPageLabel(entry.sourceTitle);
          return {
            entry_key: key + "-entry-" + String(index + 1).padStart(5, "0"),
            kind: kindFor(
              printed.title,
              entry.referenceLevel,
              firstBody >= 0 && index < firstBody,
            ),
            level: entry.referenceLevel,
            page_label: printed.pageLabel,
            title: printed.title,
          };
        },
      );
      const pages = new Set(
        candidate.logicalEntries.flatMap((entry) =>
          entry.pageIndex === undefined ? [] : [entry.pageIndex],
        ),
      );
      if (!pages.size)
        for (const id of ids) {
          const origin = byId.get(id);
          if (origin) pages.add(origin.page_index);
        }
      return {
        canonical: candidate.canonical,
        entries,
        source_range: { start, end },
        pdf_page_indices: [...pages].sort((a, b) => a - b),
        region_key: key,
      };
    },
  );
  const raw = JSON.parse(
    await readFile(
      join(prepared.extractedRoot, pack.content_json.relative_path),
      "utf8",
    ),
  );
  const sourceFidelity = verifySourceContent({
    source: raw,
    book,
    origins: analysis.origins,
    excludedBlockIds: new Set(regionByBlock.keys()),
  });
  return {
    schema_version: 3,
    fixture_id: pack.fixture_id,
    archive_sha256: pack.archive_sha256,
    content_json: {
      relative_path: pack.content_json.relative_path,
      input_sha256: pack.content_json.input_sha256,
    },
    original_pdf: {
      relative_path: originalPdf.relative_path,
      sha256: originalPdf.sha256,
      page_count: originalPdf.page_count,
    },
    printed_contents: { state: regions.length ? "present" : "absent", regions },
    source_fidelity: sourceFidelity,
  };
}

export async function observeRealMineruSet(input: {
  readonly fixtureIds?: readonly string[];
  readonly outputDirectory: string;
  readonly realDirectory: string;
}): Promise<
  readonly { readonly fixture_id: string; readonly regions: number }[]
> {
  const root = resolve(input.realDirectory);
  const fixtures = await verifyRealMineruFixtures(
    root,
    undefined,
    input.fixtureIds,
  );
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  const summaries = [];
  for (const fixture of fixtures) {
    const pack = JSON.parse(
      await readFile(
        join(root, "reference-packs-v2", fixture.id, "observations.json"),
        "utf8",
      ),
    ) as MineruReferencePack;
    if (
      pack.fixture_id !== fixture.id ||
      pack.archive_sha256 !== fixture.sha256
    ) {
      throw new Error("OBSERVED_REFERENCE_PACK_BINDING_MISMATCH");
    }
    const stagingDirectory = await mkdtemp(
      join(tmpdir(), "mirawind-observed-reference-"),
    );
    try {
      const observed = await observeRealMineruFixture({
        archivePath: join(root, fixture.fileName),
        pack,
        stagingDirectory,
      });
      await writeFile(
        join(outputDirectory, `${fixture.id}.json`),
        `${JSON.stringify(observed, null, 2)}\n`,
        { mode: 0o600 },
      );
      summaries.push(
        Object.freeze({
          fixture_id: fixture.id,
          regions: observed.printed_contents.regions.length,
        }),
      );
      process.stderr.write(
        `${JSON.stringify({ fixture_id: fixture.id, regions: observed.printed_contents.regions.length })}\n`,
      );
    } finally {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  }
  return Object.freeze(summaries);
}

function parseArguments(arguments_: readonly string[]): {
  readonly fixtureIds: readonly string[];
  readonly outputDirectory: string;
  readonly realDirectory: string;
} {
  const normalized = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const values = new Map<string, string>();
  const fixtureIds: string[] = [];
  for (let index = 0; index < normalized.length; index += 2) {
    const name = normalized[index];
    const value = normalized[index + 1];
    if (
      !name ||
      !value ||
      !["--fixture", "--output", "--real-dir"].includes(name) ||
      (name !== "--fixture" && values.has(name))
    ) {
      throw new Error("Arguments must be --name value pairs");
    }
    if (name === "--fixture") fixtureIds.push(value);
    else values.set(name, value);
  }
  const outputDirectory = values.get("--output");
  const realDirectory = values.get("--real-dir");
  if (!outputDirectory || !realDirectory) {
    throw new Error("Required: --real-dir --output");
  }
  return Object.freeze({
    fixtureIds: Object.freeze(fixtureIds),
    outputDirectory,
    realDirectory,
  });
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const fixtures = await observeRealMineruSet({
    ...(arguments_.fixtureIds.length > 0
      ? { fixtureIds: arguments_.fixtureIds }
      : {}),
    outputDirectory: arguments_.outputDirectory,
    realDirectory: arguments_.realDirectory,
  });
  process.stdout.write(`${JSON.stringify({ fixtures, ok: true })}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
