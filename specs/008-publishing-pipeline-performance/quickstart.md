# Quickstart: Publishing Pipeline Performance Validation

Feature 008 is historical. Its dedicated paired-runner and percentage-reduction gates are retired;
the commands below use the current IR pipeline and regression requirements.

## Prerequisites

- Node.js 24.x and pnpm 11.9.0
- local fifteen-book manifest, ZIPs, reference packs and reference v3 files under the ignored real-fixture directory
- enough free disk for disposable benchmark data roots

Verify the local fixtures before any timed work:

```sh
pnpm fixtures:verify-real --dir "$PWD/tests/fixtures/mineru/real"
pnpm fixtures:observe-references \
  --real-dir "$PWD/tests/fixtures/mineru/real" \
  --output "$PWD/.cache/validation/observed"
pnpm fixtures:compare-references \
  --reference-dir "$PWD/tests/fixtures/mineru/real/references-v3" \
  --observed-dir "$PWD/.cache/validation/observed"
```

Expected: exactly fifteen registered fixtures and `15/15 exact` with no differences.

## Repository Gates

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
MIRAWIND_REAL_FIXTURE_DIR="$PWD/tests/fixtures/mineru/real" pnpm test:e2e
pnpm build
```

Expected: architecture validation is part of lint, all internal product imports are canonical `@/`,
the graph has zero forbidden edges/cycles, and negative architecture fixtures pass.

Publication/recovery tests are included in the repository gates: a `build_book` artifact serves
both preview and publication, publication does not render, and interruption preserves accepted
drafts and the current immutable publication. There is no separate candidate identity.

## Performance And Profiling

Measure all registered books plus the synthetic stress book, including edits and concurrent reads:

```sh
pnpm benchmark:reference \
  --real-dir "$PWD/tests/fixtures/mineru/real" \
  --retain-dir "$PWD/.cache/validation/data" \
  --output-json "$PWD/.cache/validation/performance.json" \
  --output-markdown "$PWD/.cache/validation/performance.md"
```

Targeted repetitions and profiles use the same build runner, without a wrapper command:

```sh
pnpm benchmark:build \
  --real-dir "$PWD/tests/fixtures/mineru/real" \
  --fixture-ids "<comma-separated fixture IDs>" \
  --include-stress false \
  --repetitions 3 \
  --profile-dir "$PWD/.cache/validation/profiles" \
  --output "$PWD/.cache/validation/build.json"
```

Expected gates:

- every run is 15/15 reference exact;
- no single book exceeds `max(5%, 1 s)` regression;
- RSS stays within `max(5%, 64 MiB)` of baseline;
- overlapping uncached reader p95 is at most 300 ms and search p95 is below 1,000 ms.

For a wall/RSS regression, repeat the affected current-version fixture twice and compare its three-run
median with the same-fixture historical measurement. Record source hashes, environment, wall and RSS;
do not present this as a frozen paired speedup result. Diagnose content mismatches instead of changing
independent reference truth. Delete disposable libraries after checking the reports, not source fixtures.
