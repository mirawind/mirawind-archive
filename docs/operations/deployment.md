# Deployment and operations

This runbook deploys the frozen M1 topology: one Linux host, one Astro Web process, one
worker, one SQLite WAL database, one local persistent data root and Caddy. Do not use
`docker compose up --scale`, run a second worker, or place the SQLite volume on a network
filesystem.

## Local Docker preview

For a localhost-only preview, run:

```bash
./docker/local.sh
```

The launcher uses `docker/compose.local.yaml` on top of the production Compose definition.
It binds Web only to `127.0.0.1:4321`, keeps Web and worker as separate non-root processes,
uses a dedicated `mirawind-local` named volume and disables Caddy for the local HTTP
development origin. On first use it creates a private random authentication secret, runs
the ownership initializer and migrations, and invokes the offline administrator bootstrap
interactively. It never accepts the fallback password from an environment variable or
argument. Secret generation runs in the repository-pinned Node image, so the host does not
need Node.js or OpenSSL.

Use `./docker/local.sh status`, `./docker/local.sh logs`, and
`./docker/local.sh stop` for normal local operation. The stop action preserves the volume.
This local override is not a production deployment and must not be exposed beyond the host. The launcher
marks only its Web process for local development trust, so `/manage` opens as the initialized administrator
without a login cookie. The marker remains gated by development mode, loopback public origin and loopback
allowed Hosts; production and test ignore it even when serving the same built image on localhost.

## 1. Prerequisites

- x86-64 or arm64 Linux with adequate local SSD space;
- Docker Engine with the Compose plugin;
- a DNS name pointing to the host and inbound TCP 80/443;
- enough memory for the largest expected build (the M1 reference peak is recorded in
  `docs/audits/m1-performance-report.md`);
- a host backup destination separate from the live Docker volume.

Clone the repository and create `.env` from `.env.example`. The file must not be committed
and should be readable only by the deployment administrator.

```bash
cp .env.example .env
chmod 0600 .env
```

Set:

- `MIRAWIND_PUBLIC_ORIGIN` to the exact external HTTPS origin;
- `MIRAWIND_PASSKEY_RP_ID` to the same hostname, without scheme or port;
- `MIRAWIND_ALLOWED_HOSTS` to the exact accepted hostname(s);
- `MIRAWIND_AUTH_SECRET` to at least 32 random high-entropy bytes.

The fallback administrator password is not an environment variable. It is entered only in
the offline interactive CLI.

## 2. First installation

Build the pinned image, initialize volume ownership and apply the current database schema:

```bash
docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm data-init
docker compose -f docker/compose.yaml run --rm migrate
```

Create the sole administrator before starting the long-running services:

```bash
docker compose -f docker/compose.yaml run --rm --no-deps web \
  node dist/processes/cli/index.js admin bootstrap \
  --data-dir /var/lib/mirawind
```

The command requires a TTY and prompts for email, display name and a 16–128 character
fallback password. It refuses a second bootstrap.

Start the stack:

```bash
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml ps
```

The startup dependency chain is `data-init → migrate → web → worker`; Caddy starts after
Web is healthy. `data-init` and `migrate` must exit successfully. Web and worker must report
`healthy`. Caddy is the only public service.

The image build runs `pnpm prepare:assets` before Astro compilation. That command
deterministically prepares the pinned KaTeX CSS/WOFF2 closure and versioned reader CSS/JS.
These files are read-only application assets in production; Web and worker never generate
reader assets at runtime. A build that omits the generated renderer, style, or script
closure is incomplete and must not be deployed.

## 3. Container boundary

Web and worker run as UID/GID 10001 with:

- a read-only application root;
- all Linux capabilities dropped;
- `no-new-privileges`;
- a small, private, `noexec` tmpfs at `/tmp`;
- `/var/lib/mirawind` as the only persistent writable volume;
- an init process for signal forwarding and child reaping;
- a 20-second container stop grace period, longer than the worker's 10-second child
  termination grace.

The worker still owns its per-job process group and enforces cancellation, the 30-minute
timeout and forced group termination. Docker health checks also run as UID 10001. The
root-only `data-init` service has no network, runs once, and retains only the capabilities
needed to correct data-volume ownership.

## 4. Persistent layout

The named volume is mounted at `/var/lib/mirawind`:

```text
/var/lib/mirawind/
├── db/mirawind.sqlite{,-wal,-shm}
├── backups/
├── books/<book_id>/
│   ├── import/{record,analysis}.json
│   ├── originals/<file_id>
│   ├── assets/<resource_id>.<extension>
│   ├── quarantine/
│   └── builds/<version_id>/
│       ├── book.json
│       ├── document-manifest.json
│       ├── version.json
│       ├── preview/
│       │   ├── pages/<page_id>.html
│       │   ├── diagnostics.json
│       │   └── preview-model.json
│       └── published/pages/<page_id>.html
├── staging/<job_id>/
└── tmp/
```

Actual layout is always determined by the runtime code and opaque IDs; do not infer identity
from titles or paths. `staging`, `builds` and uploads must stay on the same filesystem so
publication rename is atomic. Never expose this volume through Caddy as a static directory.

SQLite stores editable content in `book_documents` (header/settings) and ordered `book_blocks`
(root JSON), with `book_nodes` indexing nested identities. DBeaver can inspect these tables directly.
Do not write to them outside the application: saved timestamps, validation and build scheduling
must commit together. There is no mutable draft file, save-worker task or independent candidate.

Build directories are immutable. `book.json` is the frozen input for that artifact, not an editor
file. Preview and publication use the same artifact identity. Images and ZIPs live once under the
book; each marker records their shared references. Never edit those files in place. Import records
and analysis are private evidence, not another body representation.

## 5. Lifecycle commands

Inspect status and bounded logs:

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs --tail=200 web worker caddy
```

Restart only the failed long-running process; never start a second copy:

```bash
docker compose -f docker/compose.yaml restart web
docker compose -f docker/compose.yaml restart worker
```

Normal shutdown:

```bash
docker compose -f docker/compose.yaml stop worker web
```

Stop worker first when performing offline administration. A running build receives
cooperative shutdown; after restart an expired lease is marked interrupted and only an
eligible infrastructure interruption is retried, at most once.

## 6. Upgrade and schema transition

Before every upgrade, take a complete persistent-volume backup as described in
`recovery.md`. Then:

```bash
docker compose -f docker/compose.yaml stop worker web
git pull --ff-only
docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm data-init
docker compose -f docker/compose.yaml run --rm migrate
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml ps
```

`migrate` acquires the schema lock and verifies that the data root belongs to the current
release family. Follow the release's documented schema-transition policy before replacing
the image. D-141 uses baseline `mirawind-block-storage-v1`: initialize a new data root and
administrator, then reimport MinerU v2 ZIPs. Do not attach older databases or edit migration
checksums. The owner authorized deleting this project's old `data/library`, `data/development`
and `data/ir-v1` after stopping writers and disconnecting database clients; this is a one-time
reset, not an automatic migration or ordinary upgrade policy. It provides no old-data rollback.

## 7. Monitoring

Use three layers:

1. Compose health: Web HTTP reachability and worker process/data-volume access.
2. Administrator task and health pages: queue/running state, lease expiry, safe failures,
   disk use, read/search percentiles and worker health.
3. Host monitoring: free filesystem space, RAM pressure, container restarts and backup age.

The authenticated `GET /api/manage/health` response includes Web-process request metrics,
WAL bytes and the worker's strict private health snapshot. Worker health schema v2 includes
queued/running counts, oldest queued age, the current or most recent attempt, contiguous
phase durations and nullable process-tree peak RSS. It is private, non-cacheable and must
not be published as an anonymous health endpoint.

The health snapshot is derived and overwrite-only. An old unversioned, unknown, oversized
or malformed file is reported as unavailable until the worker atomically rebuilds it. A
queue/RSS sample or health-file write failure never changes task state; RSS `null` means
unavailable, not zero. Active snapshots refresh at most every five seconds, idle snapshots
at most every 60 seconds, and repeated state changes are coalesced for one second.

The worker runs a PASSIVE WAL checkpoint about once per minute. Investigate
`WAL_CHECKPOINT_BUSY` or a WAL at/above 256 MiB; do not run a forceful checkpoint while Web
or worker is active. Logs contain opaque IDs, closed task/phase/state labels, safe error codes
and bounded numbers. Do not paste credentials,
cookies, raw ZIP paths or private document content into incident tickets.

## 8. Quarantine and retention

Startup reconciliation inventories staging, database rows and immutable versions.
Unreferenced complete version directories move to per-book quarantine; old quarantine
entries are removed only after 24 hours. Idle maintenance repeats every 60 seconds. Replaced
unpublished previews are reclaimed after 1 hour; old published artifacts after 24 hours. Retention
preserves the active preview, current publication and newest verified published predecessor.
Shared resources remain book-owned and are never deleted with an individual artifact.
Failed path deletion remains visible for a later retry.

The current schema includes the rebuildable `book_version_presentations` projection,
irreversible `books.deletion_requested_at` barrier and content-free `book_deletions`
tombstone. Web and worker must use the same release. Startup reconciliation validates
projection digests and current aliases; deletion cleanup remains a book-scoped worker task.
Do not clear deletion barriers or tombstones manually.

Do not manually move quarantine entries into `builds`, delete the current version, remove
the previous verified version, or delete FTS rows. Preserve the volume and follow
`recovery.md` if reconciliation reports a corrupt current version.
