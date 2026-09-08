# Structured Content Refactor Acceptance

Historical evidence for D-138, superseded by D-140/D-141. The mutable-file drafts, asynchronous
save tasks, independent candidates and runtime data described here have been retired. This is
not acceptance evidence for the current block-storage runtime; see `block-storage-acceptance.md`.

Date: 2026-09-08. Governing decisions: D-138/D-139. This records the local implementation
and verification, not an old-library migration or an independently released deployment.

## Delivered Runtime

- `book.json` IR v1 is the editable authority; manifest/version marker v4 and a clean SQLite baseline.
- Only MinerU v2 JSON ZIP input. No Markdown import, format adapter registry, fallback or old-data converter.
- Removed Markdown offsets, source-region application, source fingerprints, old source/config stores,
  obsolete source IDs, whole-Markdown normalization and deferred table-formula reparsing.
- Shared heading numbering, subtree exclusion, stable block references and immutable preview/publication.
- Durable asynchronous saves, timestamp conflicts, same-book preemption, receipt-based crash recovery
  and clock-rollback-safe candidate completion.
- Development and production share code and packages. Development's explicit local trust controls
  authentication bypass; process JSX compilation does not depend on the caller's test environment.

## Local Data

The active root is `data/library`, with a newly initialized local administrator. Fifteen registered
real books and one 500-page synthetic stress book were imported, every generated preview page was
requested, and each ready candidate was privately published. There are 16 private published books
and no queued/running tasks after acceptance. Existing unrelated roots were not migrated or removed.
The old dedicated Docker services and volume were already retired under D-139.

`PRAGMA integrity_check` returns `ok`; `PRAGMA foreign_key_check` returns no rows. Saving benchmark
metadata was restored before republishing; no test edit remains in the book body or metadata.

## Correctness Evidence

The independent comparison uses PDF contents transcription and original MinerU JSON, not old
Markdown observations. It checked 104,732 retained source blocks, 2,937 explicit code blocks and
91,891 explicit formulas. All 15 book comparisons pass with no content or contents-order issues.
Inline formatting in JSON is represented as IR nodes while code stays literal. A mixed superscript
and less-than expression was verified without interpreting its mathematical comparison as a tag.

The PDF review corrected one transcription error: the line “Architectures 379” continues section
9.6, rather than forming a separate entry. This was checked against the original PDF image, not
inferred from compiler output. Newly rendered review images are retained; image byte hashes alone
are not treated as semantic equivalence between different PDF renderings.

Evidence is under the ignored `.cache/ir-acceptance/` directory:

- `content-comparison.json`: 15 successful independent comparisons.
- `populated-library.json`: import, preview and private-publication receipts.
- `save-performance.json`: restored metadata and measured save/build completion.
- `performance-production.json`: all 15 books plus the stress workload, including HTTP and RSS.
- `performance-repeat.json`: three repeated runs of each available same-archive historical anchor.
- `reference-errata.json` and `review-evidence/`: original-PDF review provenance.

## Verification

The full Vitest suite, TypeScript checks, lint, formatting and production build pass. Coverage
includes hostile archives, strict schemas, authorization, private resources, leases, cancellation,
retry bounds, search isolation, publication recovery and immutable versions. Production rendering
is also executed from a bundle built under `NODE_ENV=test`; it no longer relies on `jsxDEV`.

All 17 Playwright workflows pass, covering editing while saving, stale editors, previews,
publication, access changes, resource downloads, mobile reading and no-JavaScript reading.
Desktop/mobile workbench screenshots were inspected. No presentation-only wording, CSS-value,
DOM-wrapper or source-spelling tests were introduced.

## Precommit Review

The folder-by-folder review removed the retired MinerU candidate fixtures and their registry-only
test, unused time helpers, a keyboard helper exercised only by its own tests, and empty retired
directories. Actual reader keyboard navigation remains covered in the browser workflow. Obsolete
Markdown profiling stages and counters were removed; current private profile artifacts use v2.
The unused direct Markdown integration dependency was removed, and YAML is now test tooling only.
Runtime documentation and Docker's generated local configuration consistently select `data/library`.
Historical audits and research remain labelled as historical or advisory, not current contracts.

Two functional regressions were reproduced and fixed: original-ZIP reprocessing now rebinds all
analysis block references so diagnostics can navigate to preview content, and the paired benchmark
now creates the same reference-pack directory that its JSON observer consumes. Both have behavioral
regressions that failed before the fix. Generated content types now use repository formatting, and
`typecheck` verifies them against the authoritative schema before checking TypeScript.

The final full Vitest run has 645 passing tests. Type checking reports zero errors, warnings or hints.
The existing fifteen-book reference/observation comparison was rerun with all books passing; this
does not represent a new performance measurement or replace the performance scope below.

## Performance Scope

The 16-book production run passed the uncached public reading p95 <= 300 ms gate both idle and
during a rebuild. The worst observed p95 was 52.517 ms. Peak process-tree RSS ranged from about
277 MiB to 1.22 GiB. Normal and short-query search gates also passed.

The local asynchronous save measurements were 1,068 and 1,785 ms; subsequent preview rebuilds were
1,217 and 1,746 ms. They include task polling and scheduling, not only a filesystem write.

Repeated median build times for the three available same-archive historical anchors were 8.591,
3.043 and 14.103 seconds. Their wall/RSS results stay within the existing `max(5%, 1 second)` and
`max(5%, 64 MiB)` regression ceilings relative to the stored historical measurements.

This does not claim a frozen, clean-commit 15-book old-versus-new speed-up percentage: the old
reference format and several historical fixture bindings are no longer the current acceptance
contract. The raw reports retain the current environment and source-state fingerprints so that
future release comparisons can use the same JSON-based inputs and evidence.
