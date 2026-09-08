import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SqliteBookAccessRepository } from "@/modules/catalog/adapters/sqlite/book-access";
import { setBookAccess } from "@/modules/catalog/application/commands/set-book-access";
import { createSetupAuth } from "@/modules/identity/adapters/better-auth/setup-auth";
import { bootstrapAdministrator } from "@/composition/cli";
import { openDatabase } from "@/platform/sqlite/connection";
import { applyMigrations } from "@/platform/sqlite/migrate";
import { loadMigrationManifest } from "@/platform/sqlite/migration-manifest";
import { ImportRepository } from "@/modules/publishing/adapters/sqlite/imports";
import { JobRepository } from "@/modules/publishing/adapters/sqlite/jobs";
import { BuildRepository } from "@/modules/publishing/adapters/sqlite/builds";
import { BuildRegistrationRepository } from "@/modules/publishing/adapters/sqlite/build-registration";
import { BuildPublicationRepository } from "@/modules/publishing/adapters/sqlite/build-publication";
import { BookPresentationRepository } from "@/modules/catalog/adapters/sqlite/book-presentations";
import { buildBookVersion } from "@/modules/publishing/adapters/filesystem/build-book-version";
import {
  finalizeBuild,
  m1PublishPolicy,
  publishBuild,
} from "@/modules/publishing/application/publishing-api";
import { createStorageLayout } from "@/platform/filesystem/storage-layout";
import { DocumentRepository } from "@/modules/publishing/adapters/sqlite/documents";
import { captureFrozenJobInput } from "@/composition/worker/capture-frozen-input";
import { createOpaqueId } from "@/domain/ids";
import { buildZip } from "../../scripts/fixtures/zip-builder";
import { installIrDraft, headingBlock, paragraphBlock } from "./ir-book";
import {
  mineruZip,
  mineruTitle,
  mineruParagraph,
  mineruText,
} from "./mineru-v2";
import { startWorkerProcess } from "./processes";

export const e2eAdministrator = {
  email: "admin@example.test",
  password: "e2e-only-password-0123456789",
};
export const e2eDataRoot = resolve(".cache/e2e-playwright-ir-data");
export const e2eFixtureRoot = resolve(".cache/e2e-ir-fixtures");
export const e2eOrigin = `http://127.0.0.1:${process.env.MIRAWIND_E2E_PORT ?? "4321"}`;
export const e2eHighContent = [
  [
    mineruTitle("E2E Cloud Book"),
    mineruParagraph("A durable source paragraph."),
    mineruTitle("First chapter", 2),
    mineruParagraph("The preview is compiled in the worker."),
  ],
];
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function seedPublishedLibraryBook(input: {
  database: ReturnType<typeof openDatabase>;
  layout: Awaited<ReturnType<typeof createStorageLayout>>;
}) {
  const fixture = await installIrDraft(input.database, input.layout);
  const book = fixture.book;
  const opening = {
    ...headingBlock("Opening"),
    id: "blk_e2e_library_opening_0001",
  };
  const overview = {
    ...headingBlock("Overview", 2),
    id: "blk_e2e_library_overview_0001",
  };
  const continuation = {
    ...headingBlock("Continue", 2),
    id: "blk_e2e_library_continue_0001",
    starts_page: true,
  };
  book.alias = "e2e-library-book";
  book.metadata = {
    title: "E2E Library Book",
    authors: ["Mirawind Test"],
    description: "A stable browser fixture for the public reading loop.",
    language: "en",
  };
  book.publishing.numbering = "generated";
  book.publishing.boundaries = { body_start_block_id: opening.id };
  book.blocks = [
    opening,
    paragraphBlock(
      "A seeded public book for the complete library and reading journey.",
    ),
    {
      id: createOpaqueId("block"),
      type: "list",
      ordered: false,
      items: ["A visible list item", "Another list item"].map((text) => ({
        id: createOpaqueId("block"),
        content: [paragraphBlock(text)],
      })),
    },
    {
      id: createOpaqueId("block"),
      type: "code",
      language: "text",
      code: "const readerFixture = true;",
    },
    {
      id: createOpaqueId("block"),
      type: "code",
      language: "mermaid",
      code: "flowchart LR\n  Source --> Reader",
    },
    ...Array.from({ length: 12 }, (_, i) =>
      paragraphBlock(
        `Opening context paragraph ${i + 1} keeps the first page long enough to exercise local navigation.`,
      ),
    ),
    overview,
    paragraphBlock(
      "The local outline follows this section while the full contents remains hierarchical.",
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      paragraphBlock(
        `Overview detail paragraph ${i + 1} keeps the section readable during scroll tracking.`,
      ),
    ),
    continuation,
    paragraphBlock("Searchable reader content."),
  ];
  input.database
    .transaction(() => {
      input.database
        .prepare("DELETE FROM book_documents WHERE book_id=?")
        .run(book.book_id);
      new DocumentRepository(input.database).insert(book);
    })
    .immediate();
  input.database
    .prepare("UPDATE books SET title_cache=? WHERE id=?")
    .run(book.metadata.title, book.book_id);
  const builds = new BuildRepository(input.database);
  const jobs = new JobRepository(input.database);
  const job = jobs.claimNext({ leaseOwner: "e2e-seed", nowMs: Date.now() });
  if (!job) throw new Error("SEED_JOB_MISSING");
  const command = await captureFrozenJobInput({
    ...input,
    job,
    builds,
    imports: new ImportRepository(input.database),
  });
  if (command.kind !== "build_book") throw new Error("SEED_JOB_INVALID");
  const artifact = await buildBookVersion({
    command,
    createdAtMs: Date.now(),
    layout: input.layout,
    preparationDiagnostics: [],
  });
  await finalizeBuild({
    artifact,
    command,
    leaseOwner: "e2e-seed",
    nowMs: Date.now(),
    registration: new BuildRegistrationRepository(
      input.database,
      input.layout,
      new BookPresentationRepository(input.database),
    ),
  });
  await publishBuild({
    actorUserId: null,
    bookId: book.book_id,
    buildId: fixture.build.id,
    expectedUpdatedAt: book.updated_at,
    nowMs: Date.now(),
    policy: m1PublishPolicy,
    publication: new BuildPublicationRepository(input.database),
  });
  setBookAccess({
    access: "public",
    actorUserId: null,
    bookId: book.book_id,
    books: new SqliteBookAccessRepository(input.database),
    nowMs: Date.now(),
  });
}

async function prepareE2eData() {
  const layout = await createStorageLayout(e2eDataRoot);
  await mkdir(e2eFixtureRoot, { recursive: true, mode: 0o700 });
  const database = openDatabase(
    resolve(layout.databaseDirectory, "mirawind.sqlite"),
    { role: "worker" },
  );
  try {
    applyMigrations(database, await loadMigrationManifest());
    await bootstrapAdministrator({
      auth: createSetupAuth({
        database,
        environment: {
          allowedHosts: ["127.0.0.1", "localhost"],
          authSecret: "test-only-secret-0123456789-abcdef",
          dataDirectory: e2eDataRoot,
          passkeyRpId: "127.0.0.1",
          publicOrigin: e2eOrigin,
        },
      }),
      database,
      displayName: "Administrator",
      email: e2eAdministrator.email,
      password: e2eAdministrator.password,
      nowMs: Date.now(),
    });
  } finally {
    database.close();
  }
  await promisify(execFile)(
    resolve("node_modules/.bin/tsx"),
    [resolve("tests/helpers/global-setup.ts")],
    { env: { ...process.env, MIRAWIND_E2E_SEED_ONLY: "1" } },
  );
  const publishContent = [
    [
      mineruTitle("Front"),
      mineruParagraph("Opening."),
      mineruTitle("Main"),
      mineruParagraph("Published body."),
      mineruTitle("Details", 2),
      mineruParagraph("Detail body."),
      {
        type: "image",
        content: {
          image_source: { path: "pixel.png" },
          image_caption: [mineruText("Pixel")],
          image_footnote: [],
        },
      },
      mineruTitle("Semantics", 3),
      {
        type: "list",
        content: {
          list_type: "text_list",
          list_items: ["First item", "Second item"].map((text) => ({
            item_type: "text",
            item_content: [mineruText(text)],
          })),
        },
      },
      {
        type: "table",
        content: {
          html: "<table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>",
          table_caption: [],
          table_footnote: [],
        },
      },
      {
        type: "paragraph",
        content: {
          paragraph_content: [
            mineruText("Formula "),
            { type: "equation_inline", content: "x+y" },
          ],
        },
      },
      {
        type: "code",
        content: {
          code_language: "ts",
          code_content: [mineruText("const answer: number = 42")],
          code_caption: [],
        },
      },
      {
        type: "page_footnote",
        content: { page_footnote_content: [mineruText("Semantic note body.")] },
      },
      mineruTitle("Appendix"),
      mineruParagraph("Appendix body."),
      mineruTitle("Back"),
      mineruParagraph("Closing."),
    ],
  ];
  const titles = [
    "第 1 章 绪论",
    "1.1 中文与 English 排版",
    "1.2 模型评估",
    "第 2 章 方法",
    "2.1 训练",
    "2.2 测试",
  ];
  const printedContents = [
    [
      mineruTitle("目录"),
      ...titles.map((title, i) =>
        mineruParagraph(title + " ...... " + [1, 3, 8, 15, 17, 23][i]),
      ),
    ],
    titles.flatMap((title, i) => [
      mineruTitle(title, i === 0 || i === 3 ? 1 : 2),
      mineruParagraph("正文。"),
    ]),
  ];
  const fixtures = {
    "high-confidence.zip": mineruZip(e2eHighContent),
    "generic.zip": buildZip({
      entries: [{ name: "notes.md", data: "An unsupported document" }],
    }),
    "ambiguous.zip": buildZip({
      entries: [
        {
          name: "a/content_list_v2.json",
          data: JSON.stringify(e2eHighContent),
        },
        {
          name: "b/content_list_v2.json",
          data: JSON.stringify(e2eHighContent),
        },
      ],
    }),
    "publish.zip": mineruZip(publishContent, [
      { name: "result/pixel.png", data: pixel },
    ]),
    "publishing-quality.zip": mineruZip([
      [
        mineruTitle("排版质量"),
        mineruParagraph("中文English123测试,继续:结束?"),
        mineruParagraph("URL https://example.com/a?x=1&y=2 和 v1.2.3 不改。"),
        {
          type: "paragraph",
          content: {
            paragraph_content: [
              mineruText("公式 "),
              { type: "equation_inline", content: "x+y" },
              mineruText(" 保持。"),
            ],
          },
        },
        {
          type: "equation_interline",
          content: { math_type: "latex", math_content: "\\notacommand{" },
        },
      ],
    ]),
    "printed-toc.zip": mineruZip(printedContents),
  };
  for (const [name, bytes] of Object.entries(fixtures))
    await writeFile(resolve(e2eFixtureRoot, name), bytes, { mode: 0o600 });
}

export default async function globalSetup() {
  const worker = await startWorkerProcess({
    dataRoot: e2eDataRoot,
    environment: { MIRAWIND_AUTH_SECRET: "test-only-secret-0123456789-abcdef" },
    publicOrigin: e2eOrigin,
  });
  return async () => worker.stop();
}
if (process.env.MIRAWIND_E2E_SEED_ONLY === "1") {
  const layout = await createStorageLayout(e2eDataRoot);
  const database = openDatabase(
    resolve(layout.databaseDirectory, "mirawind.sqlite"),
    { role: "worker" },
  );
  try {
    await seedPublishedLibraryBook({ database, layout });
  } finally {
    database.close();
  }
} else if (process.env.MIRAWIND_E2E_PREPARE_ONLY === "1")
  await prepareE2eData();
