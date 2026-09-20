# Block Storage Acceptance

Current follow-up: D-142 removes the obsolete import-review failure category. The local database
now uses `mirawind-block-storage-v2`; IR and publication artifacts retain their existing formats.
The original D-141 measurement and import evidence below remains applicable to the body pipeline.

## Import Review Cleanup

Removed the retired task failure classification from SQLite, worker IPC, health snapshots, retry
policy and HTTP contracts, including its dedicated retry fixtures. Job error classes now have one
Publishing definition; ordinary content budgets are reported as content errors. No independent
ZIP/media security-review stage, table or failure category remains. Authentication, renderer
sanitization, authorized resource serving and publication recovery remain operational.

The offline local schema update was exercised on a disposable SQLite copy with an injected failure
after rebuilding the task table. Schema and every business-table row remained unchanged on rollback.
The successful update preserves every business-table row and task rowid, including 16 books and
48 tasks. SQLite integrity, foreign keys and the new baseline ledger pass. The temporary database
and one-time update script were deleted after execution; no migration adapter was added.

Verification: 595 tests across 109 files pass, including a real child process reporting a content
node-budget failure and cleaning its unfinished build without changing the accepted draft.
All 17 browser workflows pass, including real MinerU import/publication, desktop/mobile reading
and worker interruption/retry. Typecheck, lint, formatting and the production build pass.
On 2026-09-20, the resumed local runtime serves workbench, preview and published HTML successfully;
health schema v3 reports an empty queue. SQLite integrity and foreign keys were rechecked.
Evidence is recorded in ignored `.cache/security-cleanup-*.log` and
`.cache/security-cleanup-database.json`.

Date: 2026-09-09. Authority: constitution 5.1.0 and D-141. This supersedes the active-runtime
claims in `content-refactor-acceptance.md`; earlier measurement reports remain historical evidence.

## Implemented

- SQLite owns editable root blocks and the sole document timestamp. No mutable book file,
  file-derived editor view, save worker, source reprocessing or independent candidate record remains.
- Changed-root transactions include request receipts and coalesced build scheduling. Conflict,
  no-op, same-millisecond save, clock rollback and retry preserve the accepted content.
- Preview/publication share one immutable build; book images and original ZIPs are shared once.
- Verified unchanged pages reuse article HTML; headings, links and current shells remain consistent.
- Autosave preserves continued input; explicit preview refresh and publication stay independent.
- Replaced previews and old publications are reclaimed during recurring idle maintenance.

## Verified

- Full Vitest: 594 passing tests across 109 files.
- Final publication, recovery and build-protocol check: 74 passing tests across 18 files.
- Typecheck: zero errors, warnings or hints. Lint and formatting pass; production bundle builds.
- Browser workflows: all 17 desktop/mobile/no-JavaScript and real 97-page MinerU workflows pass,
  including preview next/previous navigation. Desktop/mobile screenshots were inspected.
  No assertion-only presentation tests were added.
- Fresh observations from all 15 registered MinerU v2 archives pass the independent reference-v3
  comparison, without Markdown offsets or production-output-derived reference edits.
- Ordinary edit tests prove only one root is updated, nested identity is preserved and dangling
  cross-root references are rejected. Shared-resource tampering fails version verification.
- Preview reclamation preserves current/previous publications and shared assets.

Evidence lives in ignored `.cache/block-storage/` and `.cache/block-storage-*.log`. The benchmark
records real block-save transaction latency, roots written, subsequent build time/RSS and uncached
reading/search latency. Current performance results and final local-data cutover are recorded below
after measurement. No frozen clean-commit old-versus-new percentage improvement is claimed.

## Cleanup And Cutover

Retired development roots, extracted copies and retained old benchmark databases were deleted from
`.cache`, reducing it from approximately 25 GiB to 608 MiB before the new measurements. Independent
reference truth, original real ZIP fixtures, PDF review evidence and historical reports remain.

After DBeaver disconnected, the old 7 GiB `data/library` was deleted and a fresh
`mirawind-block-storage-v1` database and local administrator were initialized at the same path.
`integrity_check` returns `ok` and `foreign_key_check` is empty. `data/development` and `data/ir-v1`
were already absent. No old-format migration, compatibility reader or data conversion was introduced.

## Performance Findings

The first complete run passed reading/search gates: worst uncached read p95 was 57.367 ms.
Every measured paragraph edit wrote exactly one root, taking 20.371-30.146 ms including its first
editor-parser initialization. This run exposed excessive supervisor memory and a slow reuse path
for the 501-page stress output, so it is not the final regression-gate result.

The supervisor now captures raw block JSON and streams prepared IR into SQL rows; it no longer
constructs another whole-book object tree. In the targeted repeat, the representative large book
peaked at 697.3 MiB and the stress book at 463.8 MiB, within their historical tolerances. Books with
more than 100 pages use fresh rendering instead of reparsing large navigation shells for reuse.
The final full measurement follows these fixes.

The final 16-book run passes all reading/search gates. Paragraph save transactions take
18.012-30.224 ms and write exactly one root in every book. Worst uncached reading p95 is
64.601 ms, below 300 ms, including reads during rebuilding. Initial build peak process-tree RSS
ranges from 292.2 to 1,137.4 MiB.

Every original fixture hash matches the retained historical report. All RSS observations are
within `max(5%, 64 MiB)`. One wall-time observation marginally exceeded `max(5%, 1 second)`;
its two prescribed repeats took 13.627 and 15.061 seconds, giving a three-run median of
15.061 seconds against a historical 16.731 seconds. All 16 wall/RSS regression checks pass.
Raw evidence: `performance-final.json`, `performance-repeat.json`, and `regression.json`.
This is a same-fixture historical regression check, not a frozen clean-commit speedup claim.

The 1,000-book library projection benchmark also passes when run without the concurrent test
suite: library p95 227.575 ms, details p95 11.798 ms. The earlier contended exploratory run is not
used as the release measurement.

## Final Local Runtime

`http://127.0.0.1:4322/manage` runs the local development launcher with the new `data/library`.
All 15 registered real books plus the 500-page stress book were reimported via the management
HTTP API. Every generated preview and reading page returned usable HTML; all books were privately
published. The runtime contains 16 documents, 116,234 roots, 201,267 indexed nodes, 16 builds and
16 original ZIPs. No synthetic benchmark edit remains in those documents.

The complete active root uses approximately 2.9 GiB. SQLite integrity and foreign keys pass,
all 16 current artifacts pass full file/shared-resource verification, and staging/uploads and
the pending task queue are empty. The two temporary benchmark libraries and E2E runtime roots
were removed after verification; source fixtures, independent truth and measurement reports remain.
