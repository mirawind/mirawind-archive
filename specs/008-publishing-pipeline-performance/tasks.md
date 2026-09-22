# Tasks: Publishing Pipeline Performance

Historical delivery record. The feature-specific paired benchmark runner and its dedicated tests
have been retired during script cleanup. Paths below record the original implementation, not
current entry points. Current build/profile and regression commands are documented in `quickstart.md`.

**Input**: Design documents from `specs/008-publishing-pipeline-performance/`

**Tests**: Add or update tests only for user-visible behavior, data integrity, security boundaries or
measured performance risks. Do not add tests whose sole purpose is proving that deleted names or
paths are absent.

**Organization**: User-story phases follow the execution dependency imposed by the architecture and
clean switch. US4 is delivered before the P1 runtime stories because its boundaries are required to
change the pipeline without recreating coupling. US1 and US2 form one uncommitted clean-switch batch;
the old and new publication job paths must not coexist in a commit.

## Phase 1: Setup - Reproducible Evidence

**Purpose**: Freeze inputs and make measurements machine-verifiable before optimization.

- [x] T001 Add failing result-schema and environment-binding tests for paired runs in `tests/unit/benchmarks/pipeline-paired.test.ts`
- [x] T002 [P] Add failing statistical tests for AB/BA/AB medians, CV expansion, single-book regression and RSS gates in `tests/unit/benchmarks/paired-statistics.test.ts`
- [x] T003 [P] Add failing fixture/reference preflight tests for exactly fifteen hash-bound inputs in `tests/unit/benchmarks/reference-preflight.test.ts`
- [x] T004 Implement versioned paired-result parsing and statistics in `scripts/benchmarks/paired-statistics.ts`
- [x] T005 Implement baseline/candidate worktree orchestration, randomized fixture order and isolated data roots in `scripts/benchmarks/pipeline-paired.ts`
- [x] T006 Extend environment and pipeline profiles with commit, dirty state, lockfile, runtime, filesystem, resource counts, stage timings and process-tree RSS in `scripts/benchmarks/environment.ts` and `scripts/benchmarks/pipeline-profile.ts`
- [x] T007 Add `benchmark:pipeline-paired` and `benchmark:compilation-complexity` commands in `package.json`
- [x] T008 Run the current reference preflight and preserve the frozen reference-exact `93e01432` baseline identity in ignored `.cache/008-publishing-performance/baseline.json`

**Checkpoint**: The runner rejects unbound/noisy/incorrect evidence and can reproduce the old result
without claiming an optimization.

---

## Phase 2: Foundational - Canonical Imports and Architecture Gate

**Purpose**: Make the target dependency rules enforceable before moving business code.

**CRITICAL**: All later source movement and runtime work depends on this phase.

- [x] T009 Add failing production-bundle tests proving `@/` imports work in worker and CLI output in `tests/integration/deployment/process-bundle.test.ts`
- [x] T010 [P] Add forbidden-edge, deep-import, relative-import, type-only, dynamic-import, cycle and coupling fixtures under `tests/fixtures/architecture/`
- [x] T011 Add failing architecture-graph tests for every negative fixture and the real source tree in `tests/architecture/dependency-graph.test.ts`
- [x] T012 Configure the existing Vite toolchain to bundle Node worker/CLI entries with `@/` resolution in `vite.processes.config.ts` and `tsconfig.processes.json`
- [x] T013 Replace process build/start scripts with the bundled entries while retaining strict typecheck in `package.json`
- [x] T014 Implement TypeScript/Astro import extraction, alias resolution, shortest paths, SCC detection and coupling metrics in `scripts/architecture/dependency-graph.ts`
- [x] T015 Define module directions, twelve-import/eight-port limits and zero final exceptions in `scripts/architecture/boundaries.ts`
- [x] T016 Add fast canonical-import editor feedback and the full graph command to standard lint in `eslint.config.js` and `package.json`
- [x] T017 Convert process entrypoint imports needed to pass the production alias smoke test in `src/worker/index.ts` and `src/cli/index.ts`

Phase 2 evidence: canonical import scan reported zero replacements; the complete 205-file source
graph reported zero diagnostics; all twelve positive/negative architecture tests, the production
process bundle smoke test, 639 Vitest tests, format, lint, typecheck and the production build passed.

**Checkpoint**: `pnpm lint`, typecheck and production process smoke tests prove canonical aliases and
reject every architecture violation class.

---

## Phase 3: User Story 4 - Change Without Hidden Coupling (Priority: P2, Enabling)

**Goal**: Establish business-first `core/application/adapters` boundaries without changing output.

**Independent Test**: The full source graph has zero forbidden edges/cycles/coupling violations and
existing compiler/publication parity tests remain byte/semantic equivalent.

### Tests for User Story 4

- [x] T018 [P] [US4] Enforce publishing, reader, catalog and identity public surfaces through the architecture graph and real source-tree analysis
- [x] T019 [P] [US4] Retain domain-owned configured-document, Reader navigation, catalog projection and Passkey policy behavior suites while changing architecture boundaries
- [x] T020 [P] [US4] Cover the discriminated worker-command union, exact ingress shape and exhaustive dispatch in `tests/unit/worker/protocol.test.ts`

### Implementation for User Story 4

- [x] T021 [P] [US4] Create publishing application ports and the only cross-module surface in `src/modules/publishing/application/ports/` and `src/modules/publishing/application/public.ts`
- [x] T022 [P] [US4] Create reader, catalog and identity application public surfaces in `src/modules/reader/application/public.ts`, `src/modules/catalog/application/public.ts` and `src/modules/identity/application/public.ts`
- [x] T023 [US4] Move hostile-input and content-preparation pure logic from `src/compiler/archive/` and `src/compiler/preprocess/` into `src/modules/publishing/core/preparation/` using `@/` imports
- [x] T024 [US4] Move document, render, resource and search pure logic from `src/compiler/` into `src/modules/publishing/core/publication/` without forwarding exports
- [x] T025 [US4] Separate ReaderPageModel/server artifact behavior into `src/modules/reader/core/` and `src/modules/reader/application/`, keeping React/static shell presentation in `src/web/features/reader/`
- [x] T026 [US4] Move public library/version presentation queries into `src/modules/catalog/application/` and `src/modules/catalog/adapters/sqlite/`
- [x] T027 [US4] Move administrator/authentication use cases behind identity ports in `src/modules/identity/application/` and adapters in `src/modules/identity/adapters/`
- [x] T028 [US4] Move business SQL mappings from `src/db/repositories/` into each owning module's `adapters/sqlite/`, leaving connection/transaction primitives in `src/platform/sqlite/`
- [x] T029 [US4] Move business storage paths and durability adapters into module `adapters/filesystem/`, leaving generic fsync/atomic/path primitives in `src/platform/filesystem/`
- [x] T030 [US4] Replace `FrozenJobInput` with a discriminated command union and registry in `src/entrypoints/worker/protocol.ts` and `src/entrypoints/worker/job-registry.ts`
- [x] T031 [US4] Move worker and CLI runtime handlers into `src/entrypoints/worker/` and `src/entrypoints/cli/`, then assemble adapters only in `src/composition/worker.ts` and `src/composition/cli.ts`
- [x] T032 [US4] Add the server composition root and make Astro controllers call application public surfaces in `src/composition/server.ts` and `src/pages/`
- [x] T033 [US4] Move React components/controllers/presenters into `src/web/` ownership and replace direct repository/storage imports in `src/components/` and `src/pages/`
- [x] T034 [US4] Delete empty legacy `src/compiler/`, `src/services/`, business `src/db/repositories/`, old `src/worker/` and forwarding files after all consumers move
- [x] T035 [US4] Run equivalence, architecture, format, lint, typecheck, unit, contract, integration and build gates; record the behavior-preserving checkpoint in `specs/008-publishing-pipeline-performance/tasks.md`

Phase 3 evidence: publishing, reader, catalog and identity expose one application public surface;
Astro pages and process entrypoints no longer import module adapters directly; the complete 222-file
source graph and focused architecture fixtures report zero diagnostics. Configured-document,
Reader navigation, catalog projection and Passkey policy suites remain passing. Format, lint,
typecheck, the production process bundle, the complete Astro/Vite production build and 633 Vitest
tests passed.

**Checkpoint**: Commit as `refactor(architecture): establish acyclic module boundaries` only after
the source migration and focused domain behavior suites pass.

---

## Phase 4: User Story 1 - Reach a Trustworthy Preview Sooner (Priority: P1)

**Goal**: Compile one whole-book model and stream a complete candidate preview without duplicate or
superlinear content work.

**Independent Test**: All fifteen revisions produce reference-exact ready candidate previews;
source-region complexity is below the scale gate and accepted-to-preview improves without RSS or
single-book regression.

### Tests for User Story 1

- [x] T036 [P] [US1] Add 500/1,000/2,000/4,000 root source-region complexity and exact-output tests in `tests/unit/publishing/source-regions-complexity.test.ts`
- [x] T037 [P] [US1] Add typography single-pass, protected-byte and diagnostic-offset regression tests in `tests/unit/publishing/typography-builder.test.ts`
- [x] T038 [P] [US1] Add page-plan range coverage, heading/page lookup and no-page-AST-copy tests in `tests/unit/publishing/compiled-book.test.ts`
- [x] T039 [P] [US1] Add ordered four-page backpressure, bounded retention, deterministic diagnostics and cancellation tests in `tests/unit/publishing/render-pages.test.ts`
- [x] T040 [P] [US1] Add strict `BuildCandidateCommand` and bounded `CandidateBuildArtifact` contract tests in `tests/contract/build-candidate-protocol.test.ts`
- [x] T041 [P] [US1] Add candidate preview auth, sandbox resource, cache/noindex and semantic-page integration tests in `tests/integration/publication/candidate-preview.test.ts`

### Implementation for User Story 1

- [x] T042 [US1] Replace repeated UTF-16-prefix conversions with one internal UTF-8 offset index in `src/modules/publishing/core/preparation/source-text-index.ts`
- [x] T043 [US1] Linearize source-region exclusion and block mapping with ordered interval traversal in `src/modules/publishing/core/preparation/source-regions.ts`
- [x] T044 [US1] Apply typography edits and byte diagnostics through one output builder pass in `src/modules/publishing/core/preparation/typography.ts`
- [x] T045 [US1] Build heading, block, range and page maps once inside `compileBook()` in `src/modules/publishing/core/publication/compile-book.ts`
- [x] T046 [US1] Represent pagination only as ordered `PagePlan` block intervals and IDs in `src/modules/publishing/core/publication/compiled-book.ts`
- [x] T047 [US1] Replace pagination, outline, structure-proposal and manifest lookup rescans with the shared internal indexes in `src/modules/publishing/core/preparation/structure-proposal.ts`, `src/modules/publishing/core/publication/compile-book.ts` and `src/modules/publishing/core/publication/manifest.ts`
- [x] T048 [US1] Implement the ordered at-most-four-page async generator with cancellation probes in `src/modules/publishing/core/publication/render-pages.ts`
- [x] T049 [US1] Materialize preview/public ReaderShell policies and incremental search/manifest spools from each route-neutral page in `src/modules/publishing/adapters/reader-html/candidate-materializer.ts`
- [x] T050 [US1] Implement strict command/artifact types and validators in `src/modules/publishing/application/commands/build-candidate.ts` and `src/entrypoints/worker/protocol.ts`
- [x] T051 [US1] Implement the isolated child candidate builder and stage telemetry in `src/entrypoints/worker/handlers/build-candidate.ts`
- [x] T052 [US1] Add bounded current-candidate fields to draft queries and workbench DTOs in `src/modules/publishing/application/queries/get-draft.ts` and `src/web/contracts/publishing.ts`
- [x] T053 [US1] Run microbenchmarks and fifteen reference comparisons, then record pre-cutover compilation evidence in `docs/audits/008-compilation-performance.md`

Phase 4 linearization checkpoint evidence: source-region 1,000/4,000-root medians changed from
19.08/298.46 ms (15.64x) to 0.94/2.19 ms (2.34x). The typography 4,000-paragraph median changed
from approximately 411 ms to 146 ms and its 1,000-to-4,000 growth is 3.44x. Range-only page plans,
whole-book lookup maps and ordered four-page rendering are active in both existing preview and
publication builds; the old configured-document/page-copy implementation is deleted. Format, lint,
typecheck, 660 Vitest tests, architecture checks and the production build pass. All fifteen local
ZIP bindings pass hash/size preflight and the frozen observed-v2 set remains 15/15 reference exact.
This did not replace T053: candidate-code fifteen-book compilation and final T092 evidence were
still required after a committed checkpoint.

The indexed structure-proposal checkpoint changed the 1,000/4,000-heading medians from
144.00/1,724.98 ms (11.98x) to 41.82/136.68 ms (3.27x). A fresh current-code observation of all
fifteen real books is 15/15 reference-v2 exact; this run also added a regression for restoring an
explicit body role when a nested chapter follows appendix material inside a part. Pagination now
finds first headings without page slices and manifest resource IDs use one position index instead of
rescanning every reference for every block.

Candidate page materialization now renders each page once with validated logical heading/resource
tokens, rewrites only parsed HTML URL attributes, and emits preview/public ReaderShell documents
from the same route-neutral body. Page bodies remain disk-backed until the shared renderer CSS is
known, then are read and released one at a time. Manifest page records and search rows are buffered
to incremental NDJSON spools; integration evidence compares every emitted search row with the
existing canonical spool and verifies preview authorization signing, private no-store/noindex
policy, disabled public-only capabilities, semantic-page parity and temporary-body cleanup.

Final pre-cutover evidence is recorded in `docs/audits/008-compilation-performance.md`: the
source-region 4,000/1,000 ratio is 3.3275x; fresh reference v2 comparison is 15/15 exact; and the
real direct-candidate chain passes 15/15 with zero blocking diagnostics. Total direct wall time is
580.333 seconds and candidate-build time is 114.265 seconds. The long-lived direct harness peak RSS
is explicitly non-gating; committed performance, RSS, Reader and search evidence remained required
by T092 after the clean switch.

**Checkpoint**: Candidate core is reference-exact and measurably linear but is not yet a second
user-selectable runtime path. Do not commit the cutover until US2 removes both old job kinds.

---

## Phase 5: User Story 2 - Publish Exactly What Was Previewed (Priority: P1)

**Goal**: Cleanly activate `build_candidate` and synchronously promote the exact ready candidate.

**Independent Test**: Preview/public normalized content and semantic digests match for all fifteen
books, publish runs no compile/render stage, and repeat/stale requests preserve one atomic result.

### Behavioral Evidence for User Story 2

- [x] T054 [US2] Extend existing storage and draft API suites with candidate/job/version transaction invariants and the bounded current-candidate projection
- [x] T056 [US2] Extend existing candidate-builder and publication suites with preview/public parity, synchronous promotion, idempotency, stale/blocking refusal and one audit event
- [x] T058 [US2] Update the existing publishing workbench browser journey for save, candidate build, ready preview and synchronous publish

### Implementation for User Story 2

- [x] T059 [US2] Revise the single database baseline for `draft_candidates`, `build_candidate`, candidate linkage, discarded versions and uniqueness constraints in `src/platform/sqlite/migrations/0001_clean_slate.sql`
- [x] T060 [US2] Implement one transaction that saves a revision, creates its current attempt and enqueues `build_candidate` in `src/modules/publishing/adapters/sqlite/draft-candidate-repository.ts`
- [x] T061 [US2] Implement candidate-tree durability and the atomic ready registration of version/search/presentation/candidate/job in `src/modules/publishing/application/commands/finalize-candidate.ts`
- [x] T062 [US2] Make draft PATCH perform bounded patch/schema/structure validation only and return the candidate contract in `src/modules/publishing/adapters/filesystem/config-revisions.ts` and `src/pages/api/manage/books/[bookId]/draft.ts`
- [x] T063 [US2] Implement policy/CAS/idempotent synchronous candidate promotion and audit in `src/modules/publishing/application/commands/publish-candidate.ts`
- [x] T064 [US2] Replace the publish endpoint's job creation response with the synchronous promotion contract in `src/pages/api/manage/books/[bookId]/publish.ts`
- [x] T065 [US2] Update workbench candidate state, progress and publish handling without changing its design in `src/web/components/manage/PublishingWorkbench.tsx`
- [x] T066 [US2] Switch worker dispatch/state phases/retry policy to `build_candidate` in `src/entrypoints/worker/job-registry.ts` and `src/modules/publishing/application/job-state.ts`
- [x] T067 [US2] Freeze candidate compiler/renderer/preview identities in the candidate command and align version/manifest validation
- [x] T068 [US2] Delete the old preview/publish handlers, version builder, preview authority, job kinds, protocol shapes and obsolete tests; do not retain compatibility aliases
- [x] T069 [US2] Run the affected contract/integration/E2E/build suites and fifteen reference comparisons once, then record actual deleted and retained paths in `docs/audits/008-candidate-cutover.md`

Phase 5 evidence: only `build_candidate` remains in the worker and schema. Candidate assembly has no
legacy renderer/search fallback, and synchronous repeat publication preserves one version and audit
event. Typecheck, lint/architecture, 621 Vitest tests and the production build pass. The affected
browser journeys pass after migrating the workbench fixture to the candidate DTO. Current source
regenerated all fifteen observations and remains 15/15 reference-v2 exact. The isolated production
worker completed 15/15 real ZIPs in 592.377 s total with 81.873 s slowest wall, 18.237 ms aggregate
publish switching and 2,258,821,120-byte maximum process-tree RSS. Deleted and retained paths are
recorded in `docs/audits/008-candidate-cutover.md`.

**Checkpoint**: Commit T059-T069 with the prepared US1 candidate activation as
`refactor(publishing)!: switch to immutable candidate builds`. No commit may contain two usable
publication paths.

---

## Phase 6: User Story 3 - Recover Every Interrupted Build (Priority: P1)

**Goal**: Give every candidate attempt a deterministic terminal or reclaimable state across crashes,
cancellation, retries, deletion and stale completion.

**Independent Test**: Fault injection at every durable boundary leaves the old public version plus
exactly one registered candidate or one reclaimable orphan; retry creates a new attempt and cannot
publish stale output.

### Behavioral Evidence for User Story 3

- [x] T070 [US3] Cover file sync, rename, ready transaction, promotion commit and stale completion boundaries in the existing recovery suites
- [x] T071 [US3] Cover retry identity, cancellation grace, timeout, lease loss and bounded terminal progress in the existing job/candidate suites
- [x] T072 [US3] Cover restart reconciliation for upload/source/config/candidate orphans without duplicating fixture builders
- [x] T073 [US3] Cover delete-versus-build/publish races in the existing permanent-deletion suite

### Implementation for User Story 3

- [x] T074 [US3] Enforce current-attempt compare-and-set, idempotent ready registration and deterministic stale discard in `src/modules/publishing/adapters/sqlite/candidate-registration.ts` and `src/modules/publishing/adapters/sqlite/draft-candidate-repository.ts`
- [x] T075 [US3] Implement retry as one new candidate/job/version identity transaction with preserved terminal evidence in `src/modules/publishing/adapters/sqlite/jobs.ts`
- [x] T076 [US3] Reconcile aged upload/source/original/config/analysis orphans and candidate/version trees without automatic promotion in `src/modules/publishing/adapters/filesystem/storage-reconciliation.ts` and `src/composition/storage-reconciliation.ts`
- [x] T077 [US3] Integrate cancellation, timeout, lease loss and interruption terminalization with candidate state in `src/composition/worker.ts` and `src/modules/publishing/adapters/sqlite/jobs.ts`
- [x] T078 [US3] Make book deletion cancel current attempts and prevent late finalization/promotion in `src/modules/catalog/adapters/sqlite/book-deletion.ts`

Phase 6 evidence: candidate trees are fault-injected before fsync, after fsync, after rename, within
ready registration, after ready commit and at each publication transaction boundary. Pre-commit
faults roll back version/search/presentation/candidate/job state; lost responses return the one
committed result; a superseded or deleted attempt cannot register or publish. Retry atomically
creates new job, candidate and version IDs while preserving the original terminal error and bounded
progress. Startup recovery completes interrupted retries once and removes only unregistered storage
older than the one-hour Web-write grace. The test-only candidate IPC parser and the discarded-to-
interrupted compatibility mapping were deleted. Format, lint/architecture, typecheck, all 118 Vitest
files with 635 tests, the production build and the focused worker-recovery browser journey pass.

**Checkpoint**: Commit as `refactor(publishing): make candidate recovery deterministic` after every
injected boundary passes.

---

## Phase 7: User Story 5 - Keep Reading Responsive During Builds (Priority: P2)

**Goal**: Keep immutable reading and search responsive while large candidate work is active.

**Independent Test**: At least 200 overlapping uncached page requests retain p95 at most 300 ms,
search p95 remains below 1,000 ms, and old/private/missing resources preserve authorization behavior.

### Behavioral Evidence for User Story 5

- [x] T080 [US5] Cover manifest cold-load single-flight, retry after failed load and page/alias/resource index correctness in the existing Reader artifact suites
- [x] T082 [US5] Make the concurrent runner report and enforce separate page, resource and search p95 values and reject requests that did not overlap a running candidate

### Implementation for User Story 5

- [x] T083 [US5] Implement promise single-flight and immutable page/alias/resource lookup indexes in `src/modules/reader/adapters/filesystem/version-artifact-index.ts`
- [x] T084 [US5] Keep page, resource, original and search routes behind the composition-owned Reader facade; do not add pass-through query wrappers that duplicate the existing use cases
- [x] T085 [US5] Stream authorized preview/public resources and originals from validated metadata through the shared verified-file primitive; delete full-resource buffering and duplicate local stream helpers
- [x] T086 [US5] Profile candidate source/resource inventory work; retain the final closure hash pass because measured duplicate inventory is not material enough to weaken independent durability validation
- [x] T087 [US5] Add a benchmark runner that requires every measured page/resource/search request to overlap a real running candidate in `scripts/benchmarks/read-during-build.ts`
- [x] T088 [US5] Run the existing authorization/cache suites plus the concurrent page/resource/search gate and record the measured result

Phase 7 I/O evidence: a 97-page real candidate spent 4.706 ms in resource resolution, 4.190 ms
in asset copy and 17.743 ms in final file inventory within 279.421 ms child time. A 441-page real
candidate with 166 resources spent 10.427 ms, 307.194 ms and 276.504 ms respectively within
6,519.233 ms child time. The final inventory is an independent closure check after all output writes
and accounts for 4.2% of the representative child time, so descriptor reuse was not implemented.

Phase 7 Reader evidence: the authorization, private-404, cache, deletion and reading suites passed
39 tests. During a real second 441-page candidate build, all 200 page, 200 resource and 200 search
requests observed the running candidate. Their p95 values were 81.346 ms, 76.466 ms and 48.866 ms
against independent 300 ms, 300 ms and 1,000 ms limits. The run also exposed and fixed the ready-to-
discarded transition that had prevented scheduling a new candidate after publication; the published
version remains current while the next candidate builds.

**Checkpoint**: Commit as `perf(reader): bound artifact loading and candidate io`.

---

## Phase 8: Polish, Formal Performance and Convergence

**Purpose**: Prove the complete goal, remove remnants and synchronize all evidence.

- [x] T091 Run the 500-page synthetic stress book and 2,000/20,000 structure bounds, saving machine-readable output under ignored `.cache/008-publishing-performance/`

T091 passed with machine-readable evidence in ignored `t091-stress.json` and
`t091-structure.json`. The synthetic run produced 501 pages, 12,002 blocks and 32 resources in
10.154 seconds wall time, reached preview in 10.084 seconds, switched publication in 0.869 ms and
peaked at 633,589,760 bytes of process-tree RSS. The 2,000/20,000-item workbench regression passed;
the virtualized structure DOM remained bounded to at most 30 rows, and the 20,000-item view remained
navigable and could be exited.

- [x] T092 Verify the saved frozen A binding, run one clean current B over all fifteen books, apply
      D-118 adaptive rerun triggers, validate every frozen threshold and publish the bounded report

The saved pair-01 baseline is commit `93e01432`, clean, `15/15` exact and hash-bound to the current
fifteen-fixture manifest. Its environment fingerprint `10eb6d…9e1` matches current candidate commit
`828d503`; the baseline/reference report hashes were revalidated before reuse. The clean B run
completed all fifteen worker pipelines and a separately regenerated observed-v2 set remained
`15/15` reference exact.

Anchored total wall changed from `887.842 s` to `214.655 s` (`75.82%` faster), accepted-to-preview
from `642.958 s` to `211.885 s` (`67.05%` faster), and publish-to-public from `241.975 s` to
`15.593 ms` (`99.99%` faster). The baseline's slowest five changed from `532.479 s` to `120.165 s`
(`77.43%` faster). Peak process-tree RSS changed from `2.240 GB` to `1.229 GB`; no fixture exceeded
the wall or RSS regression tolerance. Every aggregate gate has more than five percentage points of
margin, and there were no failures or correctness differences, so D-118 triggered no additional B
runs. Raw evidence is under ignored `.cache/008-publishing-performance/current-b-15-fixed/`; the
method and bounded result are recorded in `docs/audits/008-paired-performance.md`.

- [x] T095 After the last source change, run the standard format, lint/architecture, typecheck, full
      Vitest, E2E and build gates once; reuse the T091 stress and T092 anchored-comparison artifacts instead
      of rerunning those workloads

The prior checkpoint passed format, lint and the 235-file architecture graph,
typecheck, all 118 Vitest files with 640 tests, the production Astro/process build and the complete
Playwright suite with 16 passing scenarios plus the conditional real-fixture scenario skipped. The
E2E pass used port 4322 because a local service already owned 4321. It also removed assertions for
the deleted asynchronous publication-result UI and the obsolete expectation that publishing
recompiled a corrupted source; recovery and publication transaction suites retain the actual
old-version and pointer invariants. After the final source change, format, lint and the 236-file
architecture graph passed; typecheck reported zero diagnostics; all 116 Vitest files passed with
641 tests; the production Astro/process build passed; and the complete Playwright suite passed with
16 scenarios plus the conditional real-fixture scenario skipped. The final E2E pass again used port
4322 because a local service owned 4321. T091 stress and T092 anchored-comparison artifacts were
reused as required.

- [x] T096 Update only behaviorally affected product, decision, operations, audit and 008 artifacts

Product and operations text was scanned against the active `build_candidate` protocol and v5
identities. The permanent-deletion summary now names draft preparation, candidate builds and
maintenance work instead of a deleted background publication job. D-117 and the 008 artifacts
already describe synchronous candidate promotion; historical superseded identity decisions remain
unchanged.

- [x] T097 Run Spec Kit analyze, resolve every CRITICAL/HIGH inconsistency, then run converge and append any real residual work to `specs/008-publishing-pipeline-performance/tasks.md`

The prior Spec Kit checkpoint covered all requirements, measurable outcomes, acceptance scenarios and current
tasks with no CRITICAL/HIGH inconsistency or constitution conflict. The only LOW evidence drift was
the pre-T098 architecture/test count above, which is now synchronized. Convergence found no new
implementation gap: final frozen-baseline evidence is already represented by T092, so
no duplicate convergence task was appended. T098-T115 changed product source after that checkpoint;
The final analyze checked 15 functional requirements, 9 non-functional requirements, 10 measurable
outcomes, 14 acceptance scenarios and 107 tasks with complete coverage and no inconsistency or
constitution finding at any severity. Final convergence checked the current implementation against
the same intent plus the six delivery-phase decisions and found zero missing, partial,
contradictory or unrequested gaps. It left `tasks.md` unchanged apart from completing this existing
task; no duplicate convergence phase was appended.

**Checkpoint**: Commit evidence as `test(publishing): close recovery and performance gates`. The
feature is complete only when the formal result satisfies every threshold and Spec Kit reports no
unmitigated CRITICAL finding.

---

## Dependencies and Execution Order

### Phase Dependencies

```text
Setup evidence
      ↓
Alias + architecture foundation
      ↓
US4 behavior-preserving module migration
      ↓
US1 compile/index/candidate core
      ↓
US2 single clean switch and synchronous publish
      ↓
US3 recovery ─────┐
                  ├──> final performance evidence and convergence
US5 reader/I/O ───┘
```

- Phase 1 establishes evidence and does not change runtime behavior.
- Phase 2 blocks all source migration because `@/` must work in production processes first.
- US4 blocks pipeline changes by making the dependency direction enforceable.
- US1 and US2 are implemented consecutively and committed together at the runtime cutover.
- US3 and US5 may proceed in parallel after the clean switch because they own different adapters.
- Phase 8 depends on every user story and uses committed baseline/candidate states.

### Parallel Opportunities

- T001-T003, T009-T011 and T018-T020 are independent test authoring groups.
- Publishing, reader, catalog and identity public surfaces (T021-T022) can be prepared in parallel.
- US1 unit/contract tests T036-T041 can be authored in parallel before implementation.
- Candidate lifecycle, Reader indexing and benchmark runner changes own separate files and may proceed independently after the clean switch.
- After US2, US3 and US5 implementation can proceed independently.

## Implementation Strategy

1. Establish measurement and dependency gates before refactoring.
2. Commit a behavior-preserving module migration with no semantic change.
3. Prove linear algorithms and bounded page rendering against references before activation.
4. Activate candidate schema/job/API/UI and delete both legacy job paths in one commit.
5. Close recovery and reader performance independently.
6. Run final frozen-baseline evidence only on committed states; never accept a dirty one-off run.
7. Mark tasks complete incrementally and create Conventional Commits only at the documented logical
   checkpoints after their gates pass.

## Phase 9: Convergence

- [x] T098 Implement an import-owned sealed extraction with validated atomic handoff into
      `prepare_draft`, fallback re-extraction after a missing or invalid handoff, terminal cleanup,
      recovery/cancellation coverage and focused timing evidence per the Sealed Extraction entity
      and plan Phase E (partial)

T098 keeps the existing archive validator and worker protocol. Successful non-rejected analysis
atomically moves its extracted tree under the registered import with a strict import/count/byte
marker. Preparation claims it once; missing or mismatched markers use the existing extractor.
Cancellation, retry and reconciliation tests prove staging cleanup, fallback re-extraction, manual
confirmation retention and terminal derived-tree removal while preserving the original ZIP.

On the 97-page focused fixture, the previous production bundle spent 73.498 ms in the second
`prepare_draft/archive_extract`. The rebuilt bundle reported `archive_reused=1` and no preparation
archive-extract stage. Prepare child duration was 1,057.729 ms versus 1,052.277 ms; whole-run wall
was noisy because PDF evidence and candidate work varied, so this is evidence of eliminated duplicate
work rather than a new aggregate speed claim. The earlier fifteen-book profiles attribute about
53.2 seconds to the now-removed second extraction. Raw focused results remain under ignored
`.cache/008-publishing-performance/sealed-extraction-current*/`.

- [x] T099 Reuse normalized title bigram and character-frequency profiles within one printed-contents
      detection, retain existing matching behavior, and verify the result against all fifteen
      `references-v2` fixtures (partial)

The largest retained CPU profile identified repeated similarity-profile construction as the next
printed-contents hotspot. One detection-scoped index now reuses those immutable profiles without a
global cache or contract change. On the 1,278-page focused fixture, repaired printed-contents time
improved by 14.6%, draft preparation by 8.0% and total wall by 3.7% by median across two before and
two after runs. Peak RSS showed no median regression, and a fresh all-book comparison remained
`15/15` reference exact. This focused evidence does not complete the then-open T092 gate.

- [x] T100 Replace repeated layout page-label supplementation scans with detection-local page,
      bottom, candidate and nearest-label indexes; delete the old helpers and verify representative
      reference exactness (partial)

The 1,278-page focused fixture reduced repaired printed-contents time by 54.0%, draft preparation
by 10.6% and total wall by 7.4% by median across two before and two after runs. Median RSS decreased,
and four representative books remained `4/4` reference-v2 exact. The post-change CPU profile no
longer lists page-label parsing or supplementation as a hotspot. This focused evidence does not
complete the then-open T092 gate.

- [x] T101 Reuse already-computed typography protection ranges across transformations and verify
      four representative books remain reference exact (partial)

Typography stage time improved by a median 8.4% across the four books. A monotonic protected-range
cursor regressed all four measurements and was deleted; only the independently beneficial range
reuse remains. The regenerated observations stayed `4/4` reference-v2 exact. This focused evidence
does not complete the then-open T092 gate.

- [x] T102 Parse each route-neutral semantic page once, materialize preview/public URL policies from
      the same recorded attribute references, delete the old single-output materializer, and verify
      four representative books remain reference exact (partial)

Candidate materialization improved by `24.1%`, `24.0%`, `11.1%` and `19.3%`, a median `21.6%`,
across the four books. Candidate job duration improved for every fixture; process-tree RSS decreased
for three and increased by only 1.6% (about 16 MiB) for the fourth. The independently regenerated
observations stayed `4/4` reference-v2 exact. Raw stage evidence is under ignored
`.cache/008-publishing-performance/after-route-variants-*`. This focused evidence does not complete
the then-open T092 gate.

- [x] T103 Delete the unused candidate HTML byte-count result and its full preview/public rescans;
      retain no compatibility field or absence-only test (partial)

Candidate materialization improved by `2.1%`, `6.9%`, `-0.6%` and `8.1%`, a median `4.5%`, across
the same four books; all four complete candidate jobs improved. The sole materialization regression
was 13 ms and within run noise. This deletion cannot alter generated content, and the existing
candidate preview integration test, both TypeScript builds and production build passed. Raw evidence
is under ignored `.cache/008-publishing-performance/after-output-byte-removal-*`. This focused
evidence does not complete the then-open T092 gate.

- [x] T104 Replace full parse5 DOM construction/serialization during route materialization with the
      maintained parse5 SAX parser, preserve structured attribute validation and escaping, and verify
      Reader DOM plus four representative references (partial)

Candidate materialization improved by `28.8%`, `8.6%`, `-0.4%` and `22.6%`, a median `15.6%`.
Complete candidate jobs improved by a median `6.3%`; the sole regression was 158 ms and within the
per-book tolerance. Formula-heavy process-tree RSS decreased by `32.1%`. Preview/public behavior,
four representative HTML fragment DOMs and fresh observations stayed exact. Raw evidence is under
ignored `.cache/008-publishing-performance/sax-route-*`. This focused evidence does not complete
the then-open T092 gate.

- [x] T105 Materialize each preview/public ReaderShell while its ordered `RenderedPage` is current,
      inline only that page's renderer CSS, retain the complete shared document stylesheet, and
      delete the intermediate page-body write/read pass (partial)

Across four representative books, candidate materialization improved by `18.0%`, `0.9%` and `7.0%`
in three cases. The initially regressing fourth case reversed from `+17.6%` to `-9.3%` in an adjacent
old/new rerun; its two-run medians differed by only `3.6%`, while complete wall time differed by
`0.6%`. All process-tree RSS results stayed within the per-book gate. The candidate builder and
preview suites passed 14 tests, both TypeScript builds and the production build passed, and four
representative observations remained `4/4` reference-v2 exact. Raw evidence is under ignored
`.cache/008-publishing-performance/immediate-page-write-*`. This focused evidence does not complete
the then-open T092 gate.

- [x] T106 Short-circuit printed-contents recurrence evidence through each entry's already-aligned
      later heading, retain the exhaustive scan as an exact fallback, and verify representative
      structure and performance (partial)

Across three representative books, repaired printed-contents improved by `12.5%`, `17.8%` and
`7.9%`; initial detection improved by up to `15.1%`. Adjacent reruns showed prepare-draft improvements
of `4.6%` and `6.6%` on the two largest beneficiaries. A transient RSS spike on one run disappeared
on the adjacent rerun; all retained comparisons stayed within the per-book memory gate. The focused
92-test suite, both TypeScript builds and production build passed, and newly generated observations
remained `3/3` reference-v2 exact. Raw evidence is under ignored
`.cache/008-publishing-performance/recurrence-*`. This focused evidence does not complete
the then-open T092 gate.

- [x] T107 Build the whole-book heading fragment lookup once in `compileBook()`, require page
      rendering to consume that immutable index without a per-page fallback, and verify four
      representative books remain reference exact (partial)

The heading-heavy `81d` fixture reduced candidate materialization from `2,012.892 ms` to
`1,682.313 ms` (`-16.4%`) and the complete candidate child from `7,359.847 ms` to `6,767.529 ms`
(`-8.0%`). The other three representative books stayed within run noise: complete candidate child
changes were `-1.7%`, `+0.1%` and `+0.1%`, with no per-book wall or RSS regression beyond the
focused tolerance. Production build, both TypeScript builds, lint/architecture and the 20 focused
tests passed; newly generated observations remained `4/4` reference-v2 exact. Raw evidence is under
ignored `.cache/008-publishing-performance/heading-link-index-*`. This focused evidence does not
complete the then-open T092 gate.

- [x] T108 Record route-neutral URL attribute ranges while each semantic page is rendered, consume
      those ranges directly for preview/public materialization, and delete the per-page SAX parse and
      its dependency (partial)

Across four representative books, candidate materialization improved by `29.5%`, `36.4%`, `35.9%`
and `16.8%`; complete candidate-child time improved by `12.5%`, `18.0%`, `9.8%` and `1.5%`.
All wall times improved. Three peak-RSS results decreased; `106e` increased by about `32 MiB` or
`4.2%`, within both memory tolerances. The complete 645-test suite, both TypeScript builds,
lint/architecture and production build passed, and fresh observations remained `4/4` reference-v2
exact. `parse5-sax-parser` is no longer a runtime or lockfile dependency. Raw evidence is under
ignored `.cache/008-publishing-performance/route-offsets-*`. This focused evidence does not complete
the then-open T092 gate.

- [x] T109 Build `version.json` from hashes captured when candidate files are successfully written
      or verified, delete the preceding whole-tree reread, and retain the finalizer's independent
      closure hash/fsync/rename boundary (partial)

The four representative candidates reduced the assembly inventory stage from
`382.909–710.309 ms` to `1.242–1.851 ms`. Complete candidate-child duration improved by `3.9%`,
`6.6%`, `8.8%` and `9.7%`; complete wall changed by `+0.1%`, `-2.9%`, `-4.0%` and `-5.6%`, with the
13.7 ms increase inside run noise. Process-tree RSS remained within `max(5%, 64 MiB)` for every
fixture. Candidate construction, preview and recovery tests, both TypeScript builds, lint and the
236-file architecture graph, production build, and fresh `4/4` reference-v2 comparison passed. Raw
evidence is under ignored `.cache/008-publishing-performance/write-time-inventory-*`. The finalizer
still rereads and hashes every declared file, rejects extra or changed files, fsyncs the complete
tree and atomically renames it. This focused evidence does not complete the then-open T092 gate.

- [x] T110 Record copied originals from their strict frozen `book.yaml` size/SHA-256 metadata,
      delete the immediate destination reread, and retain finalizer closure verification (partial)

Across four representative books, `original_copy` improved by `59.0%`, `67.8%`, `66.1%` and
`67.9%`. Complete candidate-child time changed by `-4.2%`, `-0.0%`, `+0.2%` and `-1.5%`; the sole
increase was 13.3 ms. Wall and process-tree RSS stayed within the per-book tolerances. A focused
integrity test proves mismatched copied bytes are still rejected by the finalizer before immutable
rename, and fresh observations remained `4/4` reference-v2 exact. Raw evidence is under ignored
`.cache/008-publishing-performance/trusted-original-metadata-*`. This focused evidence does not
complete the then-open T092 gate.

- [x] T111 Retain only normalized Markdown and its prepare-resolved resource closure in draft source
      snapshots and candidate source trees; discard MinerU sidecars and unreferenced files without
      reparsing Markdown in the parent (partial)

Across four representative books, draft source snapshots fell from `581–2,873` files and
`146–357 MB` to `64–449` files and `2.37–17.99 MB`. Prepare parent finalization improved by
`24.6%–61.9%`, candidate `source_copy` by `71.3%–96.4%`, complete candidate jobs by `2.0%–17.3%`
and complete wall by `1.6%–10.3%`. RSS decreased for three books and increased by 1.1% for the
fourth. Reprocess and resource-closure tests passed, and fresh observations remained `4/4`
reference-v2 exact. Format, lint/architecture, both TypeScript builds, all 639 tests and the
production build passed. Raw evidence is under ignored
`.cache/008-publishing-performance/prepared-source-files-*`. This focused evidence does not
complete the then-open T092 gate.

- [x] T112 Remove duplicate full raster decoding from draft preparation and retain the isolated
      candidate asset boundary as the single format/animation/dimension/pixel validation pass
      (partial)

Across the same four books, prepare job duration improved by `1.9%–15.0%` and complete wall by
`0.8%–6.8%`; candidate asset materialization did not regress. RSS stayed within the per-book
`max(5%, 64 MiB)` tolerance. A referenced corrupt PNG still fails before candidate readiness and
leaves no immutable version tree. Fresh observations remained `4/4` reference-v2 exact. Raw
evidence is under ignored `.cache/008-publishing-performance/single-image-inspection-*`. Format,
lint/architecture, both TypeScript builds, all 640 tests and the production build passed. This focused
evidence does not complete the then-open T092 gate.

- [x] T113 Skip full-document Markdown masking when no semantic container exists and reuse
      typography protection ranges across length-preserving punctuation passes (partial)

The four representative books reduced typography by `2.7%–14.0%`, parse/normalize by
`4.4%–10.2%`, and complete draft preparation by `3.2%–8.4%`. Two complete wall measurements
improved by `0.9%` and `1.5%`; the other two changed by only `+0.10%` and `+0.39%`. An adjacent
rerun brought the one noisy memory sample back within the 64 MiB tolerance. The existing parser,
typography and compiler suites passed, and fresh observations remained `4/4` reference-v2 exact.
Format, lint and the 236-file architecture graph, both TypeScript builds, all 640 tests and the
production build passed.
Raw evidence is under ignored `.cache/008-publishing-performance/current-f840-profile/`,
`container-fastpath-f840/`, `parser-typography-four/` and `parser-typography-81d-rerun/`. This
focused evidence does not complete the then-open T092 gate.

- [x] T114 Remove the candidate adapter's second full validation of the already validated and
      deeply frozen document manifest (partial)

`buildDocumentManifest()` remains the single schema and semantic validation boundary before any
manifest bytes are written. Across four representative books, `manifest_build` improved by
`14.9%–29.5%`; three complete candidate jobs improved by `2.2%–8.1%` and the fourth changed by
`+0.05%`. Complete wall improved for all four by `0.08%–2.71%`, RSS decreased by
`10.7–43.6 MiB`, and fresh observations remained `4/4` reference-v2 exact. Raw evidence is under
ignored `.cache/008-publishing-performance/single-manifest-validation-*`. This focused evidence
does not complete the then-open T092 gate.

- [x] T115 Reuse each typography leaf's protected-token ranges, fuse punctuation-adjacent
      whitespace cleanup into the mixed-spacing pass, and reuse invariant matchers across leaves

The retained path deletes the second technical-token scan and a separate unprotected-segment output
pass without changing edit order or counters. Across four representative books, typography improved
by up to `16.7%`; complete draft preparation improved for three books by `0.8%–6.0%` and the fourth
changed by `+2.9%`. Complete wall improved for three books and changed by `+1.2%` (`170 ms`) for the
fourth. RSS remained within `max(5%, 64 MiB)`, and fresh observations remained `4/4` reference-v2
exact. Raw evidence is under ignored `.cache/008-publishing-performance/typography-fused-*`. This
focused evidence does not complete the then-open T092 gate. A following four-book comparison compiled
the invariant whitespace and punctuation expressions once per module. Typography improved for all
four books by `3.4%–18.9%`; prepare improved for three books by `1.4%–9.1%` and changed by `+2.6%`
for the fourth. Complete wall improved for two books and changed by only `+0.1%/+1.5%` for the
others; RSS remained within tolerance and fresh observations stayed `4/4` exact. Full typecheck,
the 236-file zero-diagnostic architecture graph, all 640 tests and the production build passed. Raw
evidence is under ignored `.cache/008-publishing-performance/typography-regex-reuse-*`.
