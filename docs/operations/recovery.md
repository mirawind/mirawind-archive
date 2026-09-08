# Recovery and incident runbook

Recovery never mutates the source deployment first. Stop writers, preserve evidence, make a
copy or snapshot, and perform destructive tests only on that copy. A database backup alone
does not contain `book.json`, resources, originals or immutable versions; normal disaster recovery
requires the complete persistent volume.

## 1. Backup policy

Maintain:

- frequent complete snapshots of the `mirawind-data` Docker volume;
- a snapshot immediately before every upgrade or migration;
- copies on storage independent of the application host;
- recorded creation time, byte count and checksum;
- periodic restore drills on a disposable host.

For an application-consistent complete snapshot:

1. stop worker, then Web;
2. confirm both are stopped;
3. snapshot or archive the complete named volume with a host backup tool that preserves
   ownership, permissions and filenames;
4. record and verify the backup checksum;
5. restart the stack.

```bash
docker compose -f docker/compose.yaml stop worker web
docker compose -f docker/compose.yaml ps
# Run the host's volume snapshot/backup command here.
docker compose -f docker/compose.yaml up -d
```

Resolve the exact volume instead of guessing it:

```bash
docker volume ls --filter name=mirawind-data
docker volume inspect <exact-volume-name>
```

Do not copy only `mirawind.sqlite` while writers are running, and do not omit its WAL state.
The supported migration command uses SQLite's online backup API for its pre-migration
database copy, but that copy is not a substitute for the complete volume backup.

## 2. Restore drill

Restore into a new disposable volume or host, never over the only live copy:

1. provision an empty volume;
2. restore the complete data-root contents and metadata;
3. run `data-init` to enforce UID/GID 10001 ownership;
4. run the matching release's `migrate` command with the restored volume while Web/worker
   are stopped;
5. verify SQLite integrity and schema identity;
6. start one Web and one worker;
7. verify public reads, private authorization, search, original download and the
   administrator task/health page;
8. retain the old live volume until acceptance is complete.

The historical M1 drill in `docs/audits/m1-migration-recovery-report.md` concerns the retired
Markdown database. D-138 rejects that baseline: initialize a new IR data root and reimport
the original MinerU v2 ZIPs. Do not run old-format migration or audit scripts on the new root.

## 3. Lost administrator credentials

There is no Web recovery endpoint. From an SSH session on the host:

```bash
docker compose -f docker/compose.yaml stop worker web
docker compose -f docker/compose.yaml run --rm --no-deps web \
  node dist/processes/cli/index.js admin recover \
  --data-dir /var/lib/mirawind
docker compose -f docker/compose.yaml up -d
```

The command requires an interactive TTY and confirmation. It sets a new fallback password,
revokes every session and deletes every Passkey. Register new Passkeys after signing in.
Never pass the recovery password on the command line or through an environment variable.

## 4. Worker interruption or crash

Reader traffic remains on the current published version. Do not start an extra worker.

1. inspect bounded worker logs and the administrator task page;
2. inspect the private health snapshot's queue, last phase durations and process-tree RSS;
3. treat a `null` RSS or unavailable snapshot as missing observation, never as zero use;
4. confirm host memory and disk availability;
5. restart the single worker;
6. allow startup reconciliation and lease recovery to finish;
7. inspect the job's safe error category.

The worker health file is not recovery authority. Do not edit it or infer task success from
it. The worker replaces old or malformed health formats on startup; SQLite task state and
immutable publication pointers remain authoritative.

An expired running lease becomes interrupted. Only a first infrastructure interruption may
retry automatically. Content, validation, security-limit, timeout, cancellation and second
interruption failures require an explicit administrator retry. A recovered `ready` version
is never automatically published.

## 5. Failed build or publication

A failed build must not alter `current_version_id`; readers continue receiving the old
version. Preserve the source ZIP and job record, correct the cause, then use the management
UI to retry.

Do not publish a staging directory by hand. Publication is valid only after version closure,
manifest, resource and search validation succeed and SQLite atomically advances the pointer.

If a crash occurred around final rename or index creation, restart the worker. Reconciliation
will remove incomplete staging, register/contain recoverable state or quarantine an
unreferenced complete directory. Review the result before deleting anything.

## 6. Corrupt or missing current version

On startup, the worker quickly verifies every current version. If the current version is
missing or corrupt, it marks that version corrupt and atomically promotes the newest
verified, published predecessor that also has a matching presentation projection. If no
valid predecessor exists, only that book becomes unavailable with `503`; unrelated books
continue.

A missing presentation is rebuilt off the request path from the immutable `book.json` and
`document-manifest.json`. A digest mismatch is never overwritten automatically and prevents
that version from automatic rollback promotion. Do not repair
`book_version_presentations`, `books.alias` or the projection digest by hand; preserve the
volume, inspect the version authorities, and let reconciliation either rebuild a missing
row or isolate the book.

When automatic rollback occurs:

1. keep both the database and filesystem unchanged after recovery;
2. save bounded logs and the `book.version.recovered` audit event;
3. determine whether the cause is disk failure, manual mutation or incomplete restore;
4. restore the complete volume to a disposable location and compare;
5. rebuild from authoritative `book.json`, resources and original only after the
   storage cause is understood.

Never edit the current pointer, version state, `version.json` or manifest manually.

## 7. Failed permanent deletion cleanup

Permanent deletion is irreversible as soon as its request commits. The book is intentionally
absent from public and administrator book surfaces even when filesystem cleanup later fails.
There is no recycle bin, restore command, undo endpoint or supported way to clear
`deletion_requested_at`.

For a failed cleanup:

1. inspect only the bounded task error code on `/manage/tasks`;
2. correct the host permission, I/O capacity or storage condition without moving remaining
   book bytes into a public directory;
3. use the existing explicit task retry action;
4. verify that the task completes, `PRAGMA foreign_key_check` is empty and the old numeric
   and alias routes still return non-cacheable missing responses.

Cleanup removes the deterministic book directory, associated retained upload directories and
associated inactive staging directories before its final database purge. Missing targets are
normal retry progress. Do not delete `books`, `imports`, `save_draft_requests`,
`book_deletions` or job rows by hand: the database inventory is required until filesystem
absence has been proven.

Restoring a complete pre-deletion host backup is a disaster-recovery rollback of the whole
deployment, not a product restore feature. Never merge a deleted book out of such a backup
into the live database.

## 8. SQLite corruption or failed schema transition

Stop both writers immediately:

```bash
docker compose -f docker/compose.yaml stop worker web
```

Preserve the live volume and the latest logs. Do not run ad-hoc `REPLACE`, delete WAL files,
edit migration checksums or use SQLite `.recover` against the only copy.

Restore the latest known-good complete snapshot into a new volume, then run the restore drill.
If only the database is affected and a matching online database backup is known to correspond
to the unchanged filesystem snapshot, test that pair on a disposable copy first. A successful
test requires:

- `PRAGMA integrity_check` returns `ok`;
- `PRAGMA foreign_key_check` returns no rows;
- the expected schema identity and migration checksum match;
- current version files pass closure and hash verification;
- every current version has a matching presentation digest and current alias;
- public/private/search/download behavior matches the restored pointer.

## 9. Disk full or WAL growth

Stop new imports first. Keep the database, current version, previous verified version and
authoritative originals.

- Free space outside the Mirawind data root or expand the local volume.
- Let the worker retry failed quarantine/reclaimed-version deletion.
- Do not manually remove `mirawind.sqlite-wal`, active staging, current versions or originals.
- If WAL is large, stop Web and worker, take a complete backup, then use a reviewed
  maintenance procedure; normal runtime uses PASSIVE checkpoints only.

After space is restored, start Web and worker, wait for reconciliation, verify current reads
and inspect the health response.

## 10. Failed Archive Import

Cancel the job through the management API/UI if needed. The extractor removes incomplete
staging after parsing or write failures. Re-export a complete MinerU v2 ZIP and import it again
when the source download is incomplete. D-140 trusts good-faith imports and removes custom
hostile-archive inspection and its dedicated tests; an accepted import is not a security scan.
Shared reports continue to use opaque IDs and error codes without private book contents.
