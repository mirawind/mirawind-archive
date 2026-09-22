# Resource Lifecycle

Authority: D-144. The resource catalogue is not a build dependency list.

Imported images have book retention; uploaded covers have reference retention. Original ZIPs
remain independently registered attachments. None are copied per build. The image picker reads
the catalogue, including images absent from the current body, without requiring a ready build.

`book_block_resources` indexes each root's recursively collected image and resource-link IDs.
Block writes replace only that root's index in the same transaction. Cover references stay in
document metadata. Build capture selects their union in a consistent database snapshot; the child
verifies only those image bytes. `book_version_resources` records the completed manifest's IDs.
Original download metadata is captured without reading ZIP bytes or adding ZIP integrity to the
body artifact.

An uploaded resource is eligible only without draft/retained-artifact references and without a
running same-book task. Maintenance records `unreferenced_at`, then after one hour rechecks and
marks `deletion_requested_at` in an IMMEDIATE transaction. Saves and registration check availability
in their commit transaction. Files are removed outside transactions; the row is removed only after
successful deletion. A crash leaves a retryable pending row, never a usable broken reference.

Artifacts record `retired_at` at replacement/corruption and `files_removed_at` after successful
physical deletion. Current publication, latest verified publication predecessor and running-book
inputs are protected. Reclaimed artifacts retain minimal lineage, not search data or resource
references. A bounded batch is attempted between worker jobs every minute; full filesystem orphan
reconciliation runs while idle. Failed entries cannot indefinitely starve the rest of the batch.

Implementation: schema and reference collection; scoped save/build capture; catalogue endpoints;
transactional reclamation and scheduling; behavior/recovery tests; owner-approved destructive
clean switch and fresh imports; representative/stress and live verification. No old-library
backfill or compatibility path remains. Source fixtures and independent references are preserved.
