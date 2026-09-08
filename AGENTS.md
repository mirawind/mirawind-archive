# Mirawind Library agent guidance

## Authority

Read these sources before planning or implementation, in this order:

1. `.specify/memory/constitution.md`
2. `docs/decisions/decision-log.md`
3. `docs/product/product-spec.md`
4. The active `specs/<feature>/spec.md`, plan, contracts, and tasks
5. `docs/research/` and `docs/schemas/`

If two artifacts disagree, stop implementation of the conflicting area and update the lower
authority artifact. Do not silently choose one.

## Workflow

- For routine fixes, refactors, documentation and UI polish: inspect current evidence, implement
  the smallest coherent change, run proportionate tests, and synchronize affected docs. Do not
  create Spec Kit artifacts by default.
- Use a focused decision/spec/plan only for new product behavior, schema transitions,
  authentication or authorization boundaries, and substantial cross-module architecture work.
- Spec Kit is optional and only used when the user explicitly asks for it or an existing active
  feature genuinely requires its artifacts. No fixed command sequence is mandatory.
- Do not reopen product grilling for choices already covered by D-001 through D-086.
- New product decisions go into `docs/decisions/decision-log.md` before code.
- Schema changes require a version decision and evidence for the approved transition policy.
  D-138 uses a new-data-root clean switch, without old-format adapters or migration tests.
- Keep specs, plans, tasks, tests, and runtime docs synchronized with behavior.

## Non-negotiable architecture

- One Linux host, one Astro Web process, one same-codebase worker, SQLite WAL, and local
  persistent storage.
- D-138 makes Mirawind-owned structured content IR the body authority. Only MinerU v2 JSON
  ZIPs are accepted; parser AST, HTML, manifest, generated resources
  and search indexes are derived. Source assets remain authoritative inputs.
- Use a new data directory for the IR runtime, without migration or compatibility code.
  D-139 authorizes deleting the old services and their dedicated Docker volume; other roots
  remain untouched. Follow `docs/architecture/structured-content-ir.md`.
- Published versions are immutable. SQLite `current_version_id` is the only current pointer.
- Parsing, rendering, image work, and indexing never run in reader requests.
- All book resources remain outside static public directories and pass through server-side
  authorization.
- Assume good-faith administrator imports (D-140); do not add dedicated hostile-import checks or tests.
- Do not introduce Redis, another database, object storage, microservices, or multiple app
  instances without an approved architecture and constitution change.

## Implementation rules

- Use Tailwind CSS utilities and the global Tailwind theme for product UI. Product source
  must not add literal hex/RGB/HSL/OKLCH colors or parallel custom color namespaces; use the
  approved Tailwind palette tokens from D-106. Generated third-party renderer assets and
  imported fixtures are excluded.
- Reuse maintained libraries for authentication, archive parsing, Markdown, sanitization,
  KaTeX, highlighting, image metadata, and cryptography.
- Preserve user changes and unrelated work. Avoid destructive migrations and in-place
  mutation of published versions.
- Use opaque generated IDs. Do not derive identity from title, path, or mutable text.
- Never log credentials, cookies, complete private content, unsafe raw archive paths, or
  recovery secrets.
- Every response class must declare its authentication, authorization, cache, and indexing
  behavior.
- Enforce resource limits while streaming; metadata-only checks are not sufficient.

## Required evidence

Do not add tests that only pin UI wording, CSS classes or numeric style values, DOM wrappers,
or source-code spelling. UI text may locate a control; assertions must establish a meaningful
behavior or data result. Do not retain one-off browser acceptance scripts that duplicate the
shared test workflows. Content fidelity, accessibility, authorization and durability checks
are not presentation-copy tests and remain required.

Tests are mandatory for:

- ordinary import parsing, cancellation, and failure cleanup (D-140 removes hostile-archive tests);
- schema validation, unknown fields, migrations, and semantic cross-field checks;
- authentication, authorization, private-resource 404 behavior, cache headers, and downloads;
- worker leases, interruption, timeout, cancellation, and retry limits;
- FTS query escaping, current-version filtering, and private/old-version exclusion;
- publication crash boundaries, rollback, orphan recovery, and immutable versions;
- representative and stress MinerU books, including the 300 ms uncached reading target.

Implementation is not complete until these tests pass. When a change actually creates or updates
Spec Kit artifacts, its consistency review must have no unmitigated CRITICAL findings.
