<!--
Sync Impact Report (historical 4.1.1; superseded for import trust by the 5.0.0 amendment below)
- Version change: 4.0.0 → 4.1.1
- Modified principles:
  - I. Authoritative Sources and Rebuildability: Mirawind-owned structured content IR replaces
    Markdown as the target editable body authority.
  - IV. Build Off the Request Path: includes structured-document processing explicitly.
- Rationale and impact:
  - D-136/D-137 approve structured content and mutable timestamped drafts; D-138 approves
    direct MinerU v2 ingestion and a new-data-root clean switch without migration adapters.
  - Storage integrity, stable references and immutable publication remain required.
- Added sections: none
- Removed sections: none
- Templates: none; repository-local Spec Kit integration remains removed.
- Runtime guidance:
  - No topology change. The IR runtime uses data/library. Local functional, content,
    security and reader-latency evidence is recorded in docs/operations/content-refactor-acceptance.md.
- Operations guidance:
  - Initialize a new data root. D-139 authorizes retiring the old services and their Docker
    volume; other roots remain untouched and no deleted-volume rollback is promised.
- Evidence:
  - Follow docs/architecture/structured-content-ir.md for the current model and evidence gates.
-->

# Mirawind Library Constitution

## Core Principles

### I. Authoritative Sources and Rebuildability

The target editable body authority MUST be a Mirawind-owned, versioned structured content IR.
Accepted content and portable publishing settings MUST form one consistently captured revision.
The accepted import path MUST directly process MinerU content-list v2 JSON from a validated ZIP.
Independent format adapters, old JSON/Markdown import fallbacks and old-library migration paths
MUST NOT be retained. Markdown fragments MAY be used by the existing block editor. Original
inputs MAY remain as evidence but MUST NOT be a second editable body authority.
Parser ASTs, HTML, search indexes, resource maps, manifests, and other derived artifacts MUST
be reproducible from authoritative IR, referenced source assets and frozen build inputs.
Source offsets, text fingerprints and preprocessing digest chains MUST NOT be mandatory body
fields. Stable content references and storage-level integrity checks MUST retain their distinct
roles; a revision identifier alone does not prove that stored bytes are intact.
The IR, `document-manifest.json` and version integrity marker MUST use independent integer
schema versions, strict validation, and rejection of unsupported newer versions. Every schema change MUST
choose and document one transition policy: an explicit migration with compatibility
evidence, or an owner-approved clean switch that rejects prior formats and defines tested
data remediation. Runtime code MUST NOT silently reinterpret an unsupported format.
Private reading data and credentials MUST NOT enter portable publishing configuration.

D-138 approves a clean switch in a new data root, not automatic migration of the old root.
D-139 explicitly authorizes retiring the old services and their dedicated Docker volume;
other old roots remain untouched unless separately authorized. New IR runtime
MUST reject that database baseline, and MUST NOT clear, reinterpret or automatically migrate it.

Rationale: a single authority prevents silent divergence. Explicit transition policy keeps
routine upgrades recoverable while allowing a deliberate, auditable reset when retaining
legacy compatibility would preserve the wrong system.

### II. Atomic Publication and Recoverability

Readers MUST observe a complete old version or a complete new version, never a partially
built mixture. Published files MUST live in immutable version directories. SQLite's
`current_version_id` MUST be the sole current-version pointer, changed only after files,
manifest, and search data are durable and validated. Any build, index, commit, or recovery
failure MUST preserve or restore the last verified published version. Recovery routines
MUST NOT publish `ready`, staging, or orphaned versions without an explicit publish action.

Rationale: publication crosses database and filesystem boundaries; ordering and recovery
rules are product correctness, not optional implementation detail.

### III. Trusted Imports and Server-Side Access Boundaries

Every request for HTML, images, attachments, search results, administration, and APIs MUST
enforce server-side authentication and resource authorization. Private data and generated
book resources MUST remain outside directly served public directories. Imports assume a
good-faith administrator supplying MinerU output. Imports MUST NOT run a separate hostile
archive or media security review. Standard ZIP parsing, image metadata, content schema
validation, managed filesystem containment, failure cleanup and operational budgets remain
normal correctness requirements. Dedicated hostile-import security tests are not required.
Authentication, WebAuthn,
password hashing, Markdown parsing, sanitization, and cryptographic behavior MUST use
maintained libraries rather than project-specific protocol implementations. Logs MUST NOT
contain credentials, session secrets, private body content, or unsafe raw paths.

Rationale: hiding UI elements or relying on unguessable URLs does not create a security
boundary; protection must cover every representation and failure path.

### IV. Build Off the Request Path

Import parsing, whole-book IR processing, compiler AST creation, KaTeX rendering, code
highlighting, image processing, and search indexing MUST run in bounded background jobs,
never in a reader request. Reader
requests MUST use immutable pre-generated artifacts and remain available on the previous
published version while a rebuild runs. On the reference single-server deployment, an
uncached public reading response MUST meet the approved p95 target of 300 ms. Background
jobs MUST enforce the approved upload, content parsing, concurrency, and timeout
budgets and MUST be terminable without affecting the Web process.

Rationale: large books make build latency variable; separating build from reads keeps the
public product responsive and isolates resource failures.

### V. Evidence Before Completion

Every user-visible feature and every high-risk schema, security, publication, recovery or
architecture change MUST trace intended behavior to an approved decision or focused
specification and MUST include automated evidence for its critical success and failure paths.
Routine fixes, refactors, documentation and UI polish MAY proceed directly from repository
evidence to implementation and tests when they do not change an authoritative contract.
Parser, schema, authorization, publication, recovery, cache, download, migration, and
clean-switch changes require fixture-based integration tests; security and transaction tests
MUST include negative and crash-boundary scenarios. Performance claims MUST be measured with
representative and stress fixtures, not inferred from small examples. Work is not complete
while its intended behavior, implementation, tests and current documentation disagree.

Rationale: this product handles structured content and durable publications, so happy-path
unit tests alone cannot establish correctness.

## Architecture Constraints

- The baseline deployment MUST remain a single Linux host with one Astro Web process, one
  worker process from the same codebase, SQLite in WAL mode, and a local persistent
  filesystem.
- Redis, external queues, object storage, additional databases, microservices, or multiple
  application instances MUST NOT be introduced without an approved constitution amendment
  or a documented upgrade condition already present in the product decisions.
- The Web process MUST own HTTP, sessions, authorization, and response headers. The worker
  MUST own bounded import and build execution through the durable SQLite task queue.
- Public and private cache behavior MUST be explicit for every new response class. Public
  cacheability MUST never include administrator or private reading state.
- Complexity MUST be justified against a simpler maintained component or direct design.
  Mature components MUST be preferred for infrastructure and protocols.

## Risk-Proportional Delivery Gates

1. Routine maintenance MAY use the direct path: inspect current evidence, implement the
   smallest coherent change, run proportionate tests, and synchronize affected documentation.
   It MUST NOT create feature specs, plans, checklists or task ledgers merely to satisfy process.
2. New product behavior, schema transitions, authentication/authorization changes and
   cross-module architecture changes MUST first update the decision log and use a focused
   specification or implementation plan when the change cannot be reviewed safely from the
   decision and code diff alone.
3. Planning for high-risk work MUST identify authoritative data, derived data, transition
   policy, transaction boundaries, recovery behavior, request-path work, resource budgets and
   representative fixtures.
4. Implementation MUST proceed from failing evidence to passing behavior for
   constitution-critical paths. Generated artifacts and schema transitions MUST be
   validated before any publication pointer changes.
5. When specification, plan or task artifacts are created, they MUST remain consistent with
   implementation and receive a focused consistency review. A particular workflow product or
   complete command sequence is not mandatory.
6. Decision changes MUST first update the decision log, then propagate to affected schemas,
   tests, runtime documentation and any feature artifacts that actually exist.

## Governance

This constitution governs engineering and delivery. Approved product intent remains in
`docs/product/product-spec.md` and `docs/decisions/decision-log.md`; feature artifacts MUST
implement that intent without contradicting this constitution.

Amendments require:

1. a written rationale and impact analysis;
2. explicit owner approval;
3. semantic version change;
4. migration or remediation steps for affected specs, templates, code, tests, and data.

Versioning follows semantic versioning:

- MAJOR for removing or redefining a principle incompatibly;
- MINOR for adding a principle or materially expanding mandatory governance;
- PATCH for non-semantic clarification.

Every high-risk feature plan and review MUST perform Constitution Check. Violations block
delivery unless the constitution itself is amended; a plan's Complexity Tracking section may
explain necessary complexity but cannot waive a MUST requirement.

## 5.0.0 Amendment

The owner explicitly approved trusted, good-faith imports on 2026-09-08 (D-140).
Remove custom hostile ZIP inspection, archive rejection budgets and image security scanning,
their dedicated tests and stale workflow labels. Access control and durable publication
retain their existing evidence requirements. No persisted body schema or data migration is
needed; existing books remain readable. Archives are no longer certified against adversarial
input; ordinary parsing errors still fail and clean incomplete work.

**Version**: 5.0.0 | **Ratified**: 2026-07-24 | **Last Amended**: 2026-09-08
