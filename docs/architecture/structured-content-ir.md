# Structured Content IR

Authority: constitution 5.1.0, D-138, D-140 and D-141. Runtime storage and transaction boundaries
are specified in [Block Storage](block-storage.md). Earlier mutable-file drafts and independent
candidate records are retired, not compatibility requirements.

## Logical Document

IR v1 represents a book with schema version, book ID, the sole content timestamp, metadata,
optional alias, publishing settings, ordered blocks and resource references. The JSON Schema
generates TypeScript types; Publishing owns semantic validation and edits.

The working document lives in SQLite: book_documents owns its header, book_blocks owns ordered
top-level block JSON, and book_nodes indexes nested identities to their owning root. No mutable
book.json, Markdown body, NDJSON editor view or file-based save receipt is maintained. A frozen
book.json is generated only for a build and retained with the resulting immutable artifact.

## Blocks And References

Blocks cover headings, paragraphs, lists/items, quotes, code, math, images, structured tables,
footnotes, dividers and textbook containers. Inline nodes cover formatting, links, math, code,
images, breaks and footnote references. Nested structure and captions remain typed; no arbitrary
JSON or HTML body field is supported.

Opaque block IDs remain stable under ordinary edits. New nodes get new IDs. Order is independent
of identity. Table cells and nested lists stay within their root block rather than becoming an
unbounded forest of tiny database records.

A heading stores level, inline content, optional source_number, include_in_toc, starts_page and
exclude_from_numbering. Numbering, role, navigation and page plans are derived. Numbering modes
are source/generated/none; excluding a heading excludes its entire deeper subtree from numbering
and counters until the next same-or-higher heading. Source numbers are preserved.

## Import

Only one MinerU content-list v2 JSON document is accepted per ZIP. Import assumes a good-faith
administrator under D-140. zip.js parses the archive; ordinary errors and cancellation clean
incomplete work. Upload/JSON budgets, schema validation and filesystem containment remain.

MinerU JSON directly creates IR, without a whole-book Markdown intermediate. parse5 converts
table/inline markup into structured nodes. Printed-contents recovery, duplicate cleanup and
Chinese typography run at import. Original ZIP and private source analysis are stored once.
Fresh uploads create fresh books; there is no old-library conversion or source-format fallback.

## Editing And Rendering

The existing editors use local Markdown fragments as input syntax only. D-143 unifies all block
edits, including headings, under one batch command and one scoped core operation. Edits load owning
roots and indexed references; heading-structure changes additionally query heading-bearing roots,
not the entire body. Metadata and numbering mode need no body roots. SQLite atomically commits changed
rows and max(now, previous + 1); no-op saves keep the time. Permission changes do not change it.

The supervisor captures stored root JSON in a consistent database read snapshot without expanding
another whole-book tree. Import acceptance likewise streams the child's validated, hash-bound
document into SQL rows before its write transaction. The compiler child validates and reads the
frozen snapshot off the reader path. It renders semantic HTML with
sanitization, KaTeX and Shiki, then materializes preview/reader shells and authorized URLs.
Unchanged pages may reuse hash-verified HTML from a same-compiler artifact; snapshots larger than
32 MiB, books with more than 100 pages, and pages with footnotes or rendering warnings are rendered
normally. Large navigation shells can cost more to parse than fresh rendering. Heading numbering,
page content and shared publishing inputs must match before reuse. No extra body cache is stored.

Manifest v5 maps pages, blocks, navigation and shared resources. Marker v5 closes generated files
and separately records shared files. Assets are never copied into each build. Published versions
remain immutable and current_version_id remains the sole reader pointer.
