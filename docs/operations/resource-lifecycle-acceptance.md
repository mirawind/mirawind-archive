# Resource Lifecycle Acceptance

Date: 2026-09-22. Authority: D-144 and [Resource Lifecycle](../architecture/resource-lifecycle.md).

## Behavior

- Imported images and original ZIPs have book ownership; uploaded covers have reference retention.
- Saved root blocks update only their resource-ID index. Captured IR and build proofs contain
  actual body/cover dependencies, not every registered resource. Original ZIP bytes are no longer
  read or included in body-build integrity. Authorized downloads remain independently registered.
- The administrator image picker and image reads work without a ready build. Anonymous access
  remains hidden, with no-store/noindex policies and book ownership checks.
- Drafts, retained artifacts and running same-book jobs protect resources. Pending deletion rejects
  new references; failed file deletion retries, successful deletion removes the resource row.
- Artifact expiry starts at retirement/corruption. Current preview, publication and latest verified
  publication predecessor remain protected. Completed deletion does not revisit historical paths.
- The single worker gives bounded reclamation a turn between jobs. Full orphan reconciliation
  remains idle work. There is no extra service, body copy, manual reference counter or compatibility
  layer. The former whole-catalogue build dependency and manifest-based image picker are removed.

## Evidence

Tests exercise nested inline/table/note/caption references, replaced covers and publication
predecessors, running-input protection, rejection after deletion marking, failed deletion retries,
fair batches, retirement-based grace periods, corrupt-current protection and SQLite transactions.
Independent reference-v3 comparisons passed for all 15 real MinerU ZIPs. All 17 browser workflows
passed, including the real 97-page book, mobile and no-JavaScript reading.

Raw logs and sanitized reports are under ignored `.cache/resource-lifecycle/` and
`.cache/resource-*.log`. Full verification passes 626 tests across 112 files, all 17 browser
workflows, typecheck, lint, formatting and the production build. No frozen paired speedup
percentage is claimed.

All 15 real books and the 500-page stress book pass import/build, edit, publication, search and
reading gates. Worst uncached reading p95, including concurrent builds, is 41.118 ms. Paragraph
saves take 3.001-6.548 ms and write exactly one root. Initial import/build wall time ranges from
2.857 to 49.426 seconds; peak process-tree RSS ranges from 293.1 to 1087.6 MiB.

Five initial wall/RSS observations exceeded the historical tolerance and received two repeats.
Two remained outside the tolerance. Inspection found repeated statement preparation in the new
root-reference writer; statements are now lazily prepared once per repository and reused across
the import/save batch. Three post-change repetitions of the two affected books meet the unchanged
wall `max(5%, 1 s)` and RSS `max(5%, 64 MiB)` tolerance. Together with the other fixture results,
all sixteen checks pass. This is a same-fixture historical regression check, not a frozen paired
speedup claim. Raw initial, repeat and targeted measurements remain in the report directory.

## Clean Switch

The owner explicitly authorized deleting existing runtime data. The old `data/library`, temporary
old database copies and one-time transition script were deleted. The application accepts only the
new v3 baseline, without an old-library migration. Real source ZIP fixtures and independent
reference evidence are retained. `.env` and its secret are unchanged.

The development launcher initialized the new baseline and local administrator. All 15 real ZIPs
plus the stress book were reimported through the HTTP API, previewed and privately published.
The fresh library contains 16 documents, 116,234 root blocks, 3,395 shared images, 16 original ZIPs
and 16 completed artifacts, with no pending tasks. SQLite integrity and foreign keys pass. All
16 artifacts pass full verification; each resource index matches its manifest, and every new
shared-file declaration is an actual image dependency, not an original ZIP.

The runtime uses approximately 2.9 GiB at `data/library`. Disposable benchmark/E2E libraries and
the temporary import script were removed; only sanitized measurements and logs remain. The
development service is running at `http://127.0.0.1:4322/manage`. Old edits, identities and
publication history were deliberately not inherited.
