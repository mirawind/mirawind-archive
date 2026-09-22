# Block Storage Implementation

Authority: constitution 5.1.0 and D-141 through D-144. This supersedes the mutable-file and independent
candidate parts of `structured-content-ir.md`. Import trust follows D-140.

SQLite owns the document header and ordered top-level IR blocks. Nested identities belong to
their root record. IR v1 remains the semantic schema. No editable JSON file, NDJSON view,
independent candidate table or save worker is retained.

D-144 uses database baseline `mirawind-block-storage-v3` with resource lifetimes and reference indexes.
D-142 removed the retired import-review
failure category. Job error classes are defined once in Publishing: infrastructure, content,
validation, timeout and canceled. Normal content budget failures are content errors. Worker IPC v8
and health schema v3 use the same definitions; old health snapshots are discarded and regenerated.

Saving prepares a patch outside a write transaction, checks the expected document timestamp,
then commits changed rows and the next timestamp together. No-op writes preserve the timestamp.
Browser saves are serialized and preserve typing that follows a submission. The response is
200 only after commit. Publication and access settings remain separate.

Build requests are coalesced per book and capture a consistent read snapshot. A completed
artifact uses one identity for preview/publication; `current_version_id` is the sole published
pointer. Stale artifacts cannot be published. Readers only read pre-generated files. Images and
ZIPs live once under their book, not under each artifact. Manifest/marker v5 explicitly record
shared resources and authorization checks artifact membership before serving any bytes.

## Implementation Order

1. Complete: clean database baseline and transactional block storage.
2. Complete: block queries/edits and consistent build-input capture.
3. Complete: one artifact identity, bounded workers/retry and shared resources.
4. Complete: serialized autosave, explicit preview refresh and local conflict preservation.
5. Complete: recurring idle reclamation.
6. Complete: schema, concurrency, recovery, authorization, browser, all 15 real books and stress
   gates pass; measurements are recorded in the acceptance report.
7. Complete: the owner-approved old root was removed after clients disconnected. A new database
   and administrator were initialized; 16 books were reimported, previewed and privately published.
   There is no old-root conversion or automatic reset.

Changed-block updates must leave unrelated rows and assets untouched. Same-millisecond saves,
clock rollback, network retries and saves during rendering must not lose content. Published reads
stay on their old artifact until explicit promotion. Shared resources remain authorized and
retained while referenced. No presentation-copy or old-code-absence tests are added.

## Data Ownership

| Location                           | Responsibility                                                            | Lifetime                                  |
| ---------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| `book_documents`                   | One document header, metadata, settings and content timestamp per book    | Mutable working draft                     |
| `book_blocks`                      | One ordered JSON record per root block                                    | Only changed roots are written            |
| `book_nodes`                       | Nested ID to owning root index                                            | Rebuilt only for an edited root           |
| `document_commands`                | Request identity, request digest and accepted timestamp                   | Last 64 receipts per book, no body copies |
| `jobs`                             | Import, preparation, build and deletion execution                         | Durable task history                      |
| `book_versions`                    | Completed artifact metadata and state                                     | One identity for preview and publication  |
| `books.current_version_id`         | Current published artifact                                                | Only publication/recovery changes it      |
| `books/<id>/assets/`, `originals/` | Immutable source resources                                                | Shared by all builds of the book          |
| `books/<id>/import/`               | Original analysis and import receipt                                      | Private source evidence                   |
| `books/<id>/builds/<id>/`          | Frozen `book.json`, manifest, integrity marker, HTML and preview metadata | Retained immutable artifacts              |
| `staging/<job>/`                   | Captured build inputs, search spool and incomplete output                 | Removed after completion/failure          |

There are no persistent `draft/`, `views/`, `saves/`, `candidates/` or separate `versions/`
directories. A completed build is reused for publication, without another directory copy.
An unchanged page can reuse verified article HTML; its current navigation, URLs and shells are
still generated from the current compiled document. Filesystem hashes prove storage integrity,
not block identity or content revision.

## Save And Build States

The draft has a timestamp, not a parallel status machine. Browser-local text has not been accepted
until PATCH returns 200. The browser waits 600 ms of inactivity, serializes saves and keeps input
typed after a submission for the next save. Validation errors and 412 conflicts retain local text;
the user can retry or explicitly discard. Closing a dirty tab triggers the browser leave warning.

All block types use the same batch edit path, including headings and nested nodes. Publishing
reads owning roots, parses editor syntax and checks local shape, references and boundaries.
Only changes to heading structure request the ordered heading-bearing roots; unrelated body
roots are not loaded. Metadata and numbering-mode edits do not load body roots. There is no
whole-book save fallback. See [Unified Block Editing](block-editing.md). The short IMMEDIATE
transaction checks the expected time,
writes changed rows, records the receipt and coalesces a build job. Failure rolls everything back.
A no-op returns the same time; a changed save takes `max(now, previous + 1)`. Network retries with
the same request identity return the prior result; reusing an identity for another request fails.

Build jobs follow `queued -> running -> succeeded | failed | canceled | interrupted`. Further saves
replace queued inputs and reset the 1-second debounce. A same-input running request reuses its job;
newer content requests cancellation of the older same-book build, using the existing termination
protocol. Other books are not interrupted. Manual POST `/build` checks the timestamp and removes
the queue delay; it does not resave the document.

The worker captures raw root JSON in an SQLite read snapshot, releases its transaction and writes
frozen inputs without materializing the entire document tree in its supervisor. Import acceptance
streams the child's validated, hash-bound IR into rows before opening its write transaction.
Rendering, file synchronization and rename happen outside database transactions. Registration
rechecks source time, active job/lease and predecessor, then commits artifact, search and display
projection together. A crash before registration leaves an unreferenced artifact for quarantine;
it never becomes public. A failed build never rolls back accepted draft edits.

Artifacts follow `ready -> published -> superseded`, or `ready -> discarded` when a newer preview
replaces them. Corruption is isolated as `corrupt`. Publication verifies the exact preview and
current draft time, then atomically advances the single pointer. Old readers stay on the previous
immutable publication while edits and builds proceed. Discarded previews expire after 1 hour;
older publications after 24 hours, retaining the current and latest verified published predecessor.
Retention starts at retirement, not creation/publication. Reclamation marks a tombstone before
deleting files and records physical completion so old tombstones do not trigger more deletion.
It never removes shared resources along with an artifact. Between-job batches reclaim unused
uploaded resources separately, protecting source images, retained artifacts and running tasks.
See [Resource Lifecycle](resource-lifecycle.md) for catalogue, dependency and cleanup boundaries.

## Inspection

Connect DBeaver to `data/library/db/mirawind.sqlite`. Expand tables or use:

```sql
SELECT book_id, updated_at, metadata_json, publishing_json
FROM book_documents WHERE book_id = 1;

SELECT ordinal, id, type, content_json
FROM book_blocks WHERE book_id = 1 ORDER BY ordinal;

SELECT id, root_id, kind FROM book_nodes WHERE book_id = 1;
```

The JSON cell editor displays nested paragraphs, list items, inline formatting and formulas.
Do not edit rows directly: direct SQL bypasses semantic validation, timestamp checks and build
scheduling. A build's `book.json` can be inspected as a whole-book snapshot, but is not a working
draft. Stop Web/worker and disconnect DBeaver before replacing the database directory.
