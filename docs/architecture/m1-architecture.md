# Mirawind Publishing Architecture

Authority: constitution 5.1.0 and D-141 through D-143; import trust follows D-140.
See [Block Storage](block-storage.md), [IR](structured-content-ir.md) and the live management
OpenAPI contract under specs/001-mineru-public-publishing/contracts/openapi.yaml.

## Runtime

One Linux host runs one Astro Web process and one same-codebase worker. SQLite WAL stores the
mutable IR, authentication, permissions, durable jobs, completed artifacts and search. Local
private files store shared source assets and immutable generated pages. No additional service
or database is introduced.

Web handles authenticated bounded edits in short SQLite transactions. Worker children own import,
whole-book compilation, rendering and indexing. Reader requests only authorize and read already
generated HTML/resources. Development and production share packages; only controlled loopback
development enables login bypass. Process JSX compilation is independent of the caller's mode.

## Storage

- book_documents: schema version, metadata, alias, publishing settings and sole content timestamp.
- book_blocks: ordered top-level IR blocks. Unchanged rows are not rewritten.
- book_nodes: nested block IDs mapped to root records for bounded editing.
- document_commands: bounded idempotency receipts, not body history.
- jobs: import analysis, preparation, build_book and permanent book deletion.
- book_versions: completed immutable artifacts, also used for previews. No candidate table.
- book_resources/original_files: shared immutable files, not copied per artifact.
- current_version_id: the only published pointer. Access remains an independent property.

## Workbench

Local typing and heading trials update browser state. Autosave batches input and preserves later
typing when a submission completes. The server returns 200 after the transaction commits, without
waiting for rendering. Same-book build requests are coalesced and obsolete running work canceled.
A manual preview request flushes queued build delay without creating duplicate same-input work.

Heading and body editors submit the same `blocks[]` batch to `PATCH /draft`. Publishing prepares
changed roots and checks shared content rules; storage queries supply identities, references and
heading context without a whole-book editing fallback. Metadata/settings can commit in the same
batch. The block-specific route is read-only. See [Unified Block Editing](block-editing.md).

Preview pages are addressed by build ID. Existing preview HTML can remain displayed while a new
build runs, but stale previews cannot be published. Publication rechecks the document time and
selected artifact in a short write transaction, switches the pointer and never recompiles.

## Artifacts And Recovery

Build inputs capture one SQLite read snapshot; transactions are released before serialization and
rendering. Page reuse checks previous file integrity, root contents, heading presentation and
publishing inputs, then regenerates routing and shells. Source resources are read and verified,
not copied. Search rows are temporary job output until atomic registration with the artifact.

A completed build contains its IR snapshot, manifest, integrity marker, preview and reading HTML.
Save recovery belongs to SQLite, not cross-file receipts. Import and build finalization still
respect filesystem/database crash boundaries. Orphans are isolated; recovery never publishes
an artifact without a prior publication action.

Idle maintenance runs periodically, preserving current preview/publication and the latest verified
published predecessor. Replaced unpublished builds and older published artifacts are reclaimed
after their grace periods. Shared assets remain retained while registered/referenced.

## HTTP Boundaries

Management and preview data require administrator authorization and use private, no-store with
noindex. Signed preview assets bind book, artifact, resource and session. Anonymous private content
returns 404. Published HTML supports revalidation; version-addressed resources remain authorized.
No book files are placed in public static directories. Search filters current version and access
for every result, including its short-query path.
