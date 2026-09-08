# Mirawind Publishing Architecture

- Current authority: constitution 4.1.1 and D-138/D-139.
- Body IR v1, manifest v4, version marker v4, database baseline `mirawind-content-ir-v1`.
- Detailed save and content contract: [Structured Content IR](structured-content-ir.md).
- Historical feature specifications describe their original milestones; their Markdown/config-revision
  storage contracts do not apply to this runtime. The management OpenAPI contract is maintained in
  `specs/001-mineru-public-publishing/contracts/openapi.yaml`.

## Runtime Boundary

One Linux host runs one Astro Web process and one worker from the same codebase. SQLite WAL
and a private local filesystem are the only coordination and persistence mechanisms. The worker
executes one bounded heavy task at a time in an interruptible child process. No Redis, separate
API service, object store, second database or multiple application instances are required.

Web owns HTTP, sessions, authorization, response headers, streaming uploads and task submission.
The worker owns document ingestion, content changes, compilation, rendering, indexing and recovery.
Reader requests never parse a book or generate its assets.

Development and production use the same packages and application code. Development login bypass
requires the explicit launcher trust flag, development mode and an entirely loopback origin/Host
configuration. Production always uses the real administrator session. Automated tests use the
authenticated policy, not a third product mode. Process bundles explicitly compile production JSX
so the build shell's `NODE_ENV` cannot select a React helper absent from the runtime environment.

Modules are Publishing, Reader, Catalog and Identity. Reader depends on Publishing's narrow
application APIs; Publishing delegates catalog presentation and deletion policy to Catalog.
Identity is independent. Imports within an ownership package are relative; crossings use `@/`
and the target module's declared application API. The browser shares heading calculation only
through Publishing's pure `application/heading-api.ts` entry point.

## Authority And Storage

`docs/schemas/book.schema.json` is the single body schema. Generated TypeScript types and
Publishing's semantic validator cover ordered and nested blocks, inline formatting, stable IDs,
resource references and cross-field constraints. A heading is a body block, not a separate mutable
TOC record. Numbering, roles, navigation, page plans and search are derived.

```text
<data-root>/
  db/mirawind.sqlite{,-wal,-shm}
  books/<book-id>/
    draft/
      book.json
      import.json
      import-source.json
      import-artifact.json
      views/<updated_at>/{view.json,index.json,blocks.ndjson,analysis.json}
      saves/<job-id>/
      candidates/<candidate-id>/{book.json,resources.json,original.json,analysis.json}
    assets/<resource-id>.<extension>
    originals/<file-id>
    versions/<version-id>/
      book.json
      version.json
      document-manifest.json
      assets/
      originals/
      preview/
      published/
      derived/
    quarantine/
  staging/<job-id>/
  tmp/uploads/
```

The mutable `draft/book.json` owns body, metadata, publishing settings and `updated_at`. SQLite owns
permissions, task attempts, resource integrity records and the only current publication pointer,
`books.current_version_id`. Permissions and private reading state never advance the body timestamp.
Source ZIPs are immutable evidence, not a second editable body.

All managed paths are canonical, private and symlink-safe. Staging and final directories share a
filesystem. File digests belong to storage integrity and immutable publication, not block identity
or revision numbering. The derived NDJSON index uses file byte positions only for bounded reads;
no Markdown offsets, source fingerprints or preprocessing hash chains exist in the body model.

## Import And Compilation

The only book input is a single-book MinerU ZIP containing `content_list_v2.json` or
`<stem>_content_list_v2.json`. D-140 assumes a good-faith administrator: zip.js extracts entries
in a single streaming pass without a custom security inspection or archive rejection budgets.
Sharp reads image format and dimensions without a separate pixel security scan. Managed filesystem
containment, cancellation, cleanup, upload/content budgets and normal parsing remain in force.
Invalid JSON, unsupported content or missing referenced resources fail explicitly.

JSON content kinds directly create IR headings, paragraphs, code, algorithms, formulas, lists,
images, tables and annotations. Table HTML is parsed into cells; formulas become typed nodes before
compilation. Raw HTML and arbitrary source objects are not persisted as body escape hatches.

Printed-contents detection operates on block text, block order and layout evidence. Removed contents
regions reference block IDs. Private analysis v2 associates these IDs with the original JSON page
and record index. There is no synthesized whole-book Markdown or text-offset lookup layer.

The compiler consumes the accepted IR and fixed resources once. It shares one heading presentation
across body, navigation, page metadata and search. Whole-book numbering is `source | generated | none`;
an excluded heading subtree never displays or consumes numbers in any mode. Source numbers remain
stored. All internal content links target stable block IDs, including non-heading blocks.

Preview and publication reuse the same rendered semantic body, sanitization, KaTeX and highlighter.
The preview uses an embedded reading shell and signed resource URLs; published pages use the full
reader shell. Route materialization does not reparse or re-render book content.

## Saves And Publication

`updated_at` is the sole draft revision identifier, a server Unix millisecond integer. A changed
save uses `max(now, previous + 1)`; no-op saves retain the timestamp. Clients submit
`expected_updated_at` for save and publish. A stale request cannot overwrite the accepted document.

A save returns `202` with a durable `save_draft` task. A valid new save cancels unfinished preview
builds for the same book, observes the existing 10-second termination grace, then saves and rebuilds.
It never preempts another book's active task. Editors retain input typed after submission and retain
local edits on failures or conflicts.

Parsing, validation, staging writes and rendering happen outside SQLite transactions. Short
`IMMEDIATE` transactions coordinate submission, fixed build-input capture and publication. Durable
save receipts survive staging cleanup, bind the prepared document and timestamp, and recover the
filesystem replacement/database commit boundary without applying an edit twice or deleting a saved
body. Successful requests discard their edit payload; retryable receipts remain until recovery or
retention permits cleanup.

Candidates are addressed by candidate ID and record `source_updated_at`. Published versions are
immutable. Publication rejects pending saves, stale timestamps, superseded or unready candidates,
blocking diagnostics, changed build identities and incomplete/corrupt files. It promotes the ready
preview artifacts rather than compiling again. Recovery never publishes an unrequested candidate.

## Access And Recovery

Better Auth and the existing Passkey/password flows own formal authentication. All management
mutations enforce administrator authorization and same-origin protection. No book asset lives in a
static public directory. Visibility is checked before ETag/Range processing on every resource request.

| Response                       | Anonymous Access               | Cache               | Indexing    |
| ------------------------------ | ------------------------------ | ------------------- | ----------- |
| Current public HTML            | Allowed                        | Public revalidation | Allowed     |
| Public versioned book asset    | Allowed after authorization    | Private immutable   | Via page    |
| Public original ZIP            | Allowed after authorization    | Private, no-store   | Forbidden   |
| Private book or private asset  | 404                            | No-store            | Forbidden   |
| Management API, draft, preview | Administrator only             | Private, no-store   | Forbidden   |
| Signed candidate asset         | Bound token/session            | Private, no-store   | Forbidden   |
| Site JS/CSS/fonts              | Allowed, contains no book data | Public immutable    | Not content |

The worker owns leases, heartbeat, cancellation, timeout and retry limits. Recovery reconciles durable
save receipts first, contains orphaned version trees and checks current publications. A corrupted
current version can fall back only to a verified previously published predecessor; otherwise only
that book returns an uncached 503. Missing projections are rebuilt off the request path from the
version's IR and manifest. No mutable artifact is repaired by inventing a new current pointer.

Search uses FTS5 trigram and parameterized, escaped queries. One/two-character queries use the bounded
metadata/heading index. Every result is filtered by current publication and visibility; ready, old
and private content is never anonymously searchable.

## Evidence And Transition

This is a clean switch, not an old-library migration. Initialize a fresh root and reimport MinerU v2
ZIPs. Old databases are rejected. The retired local Docker services and their dedicated volume were
removed under D-139; other roots are not automatically deleted or reinterpreted.

Verification covers ordinary extraction and cleanup, schemas, heading policy, edit fidelity, concurrent saves,
clock rollback, cancellation, retries, crash recovery, publication races, authorization and private
resource isolation. Browser workflows assert data and behavior, not fixed UI wording or styling.

Real-book correctness uses independent PDF contents transcription and direct source-JSON-to-IR
content checks. No old Markdown observation or position rebinding enters that gate. Review images
are evidence; renderer-dependent PNG hashes are not semantic content equivalence. Fifteen registered
real books and a 500-page stress book measure build/save latency, RSS and uncached read p95 <= 300 ms.
An incomplete gate must be reported explicitly, never represented as completed by an import success.
