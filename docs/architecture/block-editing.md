# Unified Block Editing

Authority: D-143 and constitution 5.1.0. This replaces the ordinary-root fast path plus whole-book
fallback in D-141. It does not change persisted IR, database or published artifact schemas.

One draft PATCH accepts an optional `blocks` array together with document header/settings edits.
Each block edit identifies the existing block and supplies editor Markdown and/or typed heading
properties. A heading is a block variant, not another editing protocol. The block GET remains;
its separate PATCH and the old heading `changes`/single `block` inputs are removed.

Publishing parses the command, groups target IDs by owning root, applies edits to copied roots,
and validates only affected semantic constraints. Multiple sibling edits share one root copy and
one write. Parent/child targets in the same batch are rejected before changes are applied. Root
IDs and existing nested IDs stay stable; inserted nested nodes receive generated IDs.

Storage supplies roots and indexed identities. Header-only edits require no body roots. A change
to heading structure reads the heading-bearing roots to check ordered levels, page aliases and
nested split restrictions, not unrelated paragraph/table/code roots. Boundary checks use node
order; deleting referenced nodes checks incoming references outside the changed roots. All changed
roots are considered together so a batch may update a reference and its target atomically.

Shared core validators serve complete documents at import/build and scoped edits at save. The
repository must not own heading, inline, table or cross-field semantics. It commits the prepared
change set under the existing short IMMEDIATE transaction, rechecking timestamp and request
receipt, updating only changed roots/header and scheduling one coalesced build. No whole-book
clone or fallback read is permitted in the save path. Rendering remains a worker responsibility.

Verification covers successful edits for all block variants, nested heading/body sibling edits,
mixed header and block saves, scope of reads/writes, structural/reference rejection without partial
commit, no-ops, monotonic time, duplicate requests, save/build/publication races and browser flows.
Existing import fidelity and reader latency evidence must remain valid; this adds neither hostile
import review nor a second editable representation.

## Request Example

```json
{
  "expected_updated_at": 1789940000000,
  "blocks": [
    {
      "block_id": "blk_example_heading_0001",
      "markdown": "Revised heading",
      "level": 2
    },
    {
      "block_id": "blk_example_paragraph_01",
      "markdown": "Revised **paragraph**."
    }
  ],
  "metadata": { "title": "Revised book" }
}
```

Successful saves return the accepted `updated_at` after commit. The request remains administrator-
only, same-origin, non-cacheable and non-indexable, with an Idempotency-Key. Reload previously open
workbenches when deploying HTTP v4; there is no translation of the retired request shapes. Existing
books, block identities, schema versions, source resources and publication pointers are unchanged.

## Acceptance

Verified on 2026-09-22:

- 619 tests across 110 files pass; all 17 desktop, mobile, no-JavaScript and real-book browser
  workflows pass. Typecheck, lint, formatting and the production build pass.
- All 11 block variants and list-item editing use the shared operation, including nested headings,
  mixed batches, stable IDs, incoming references, boundaries, alias/level rejection and rollback.
- Scope tests require header-only edits to request no roots and heading text edits to request no
  outline. SQL update-trigger measurements verify actual root-write counts.
- Fresh observations of all 15 registered real MinerU books match independent reference-v3 truth.
- All 15 books plus the 500-page stress book pass import, build, edit and concurrent-reading gates.
  Same-fixture build wall/RSS remain within the existing regression tolerances. No frozen paired
  speedup percentage is claimed.

| Operation                      | Root Writes | Save Time (ms) |
| ------------------------------ | ----------: | -------------: |
| Metadata                       |           0 |    3.539-7.321 |
| Heading text                   |           1 |   5.707-14.075 |
| Numbering mode                 |           0 |    1.965-4.962 |
| Heading page structure         |           1 |   2.841-24.271 |
| Heading + paragraph + metadata |           2 |    4.104-8.890 |
| Paragraph                      |           1 |   2.453-11.698 |

Times measure server-side edit transactions and scheduling, not subsequent rendering or network
round trips. Worst uncached reading p95, including reads during a rebuild, is 38.321 ms. A real
empty-paragraph fixture exposed an editor round-trip failure; clearing a paragraph now preserves
its ID and valid empty content, while empty headings remain invalid.

Retired code was removed, not wrapped: whole-book edit/accept helpers, the ordinary-root fast path,
its duplicate root validator, the unused whole-book ID map, heading `changes[]`, single `block`
input and the separate block PATCH. Existing fidelity tests now exercise the shared core; no
source-spelling or presentation-copy tests were added. Render/build validation remains necessary
and is not a retired editing path.

Raw measurements and comparison results are under ignored `.cache/block-editing/`; test logs use
`.cache/block-editing-*.log`. Measurements used disposable libraries; the existing 16-book local
library was not reimported or rewritten for this change.
