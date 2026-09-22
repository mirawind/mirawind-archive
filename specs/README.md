# Feature History And Current Contracts

Numbered feature folders record the original M1 and subsequent milestones. Their historical
Markdown, `book.yaml`, config-revision, migration and reference-v2 designs are superseded by
constitution 5.1.0 and D-138 through D-143, not compatibility requirements for the current runtime.

The current IR refactor is specified in `docs/architecture/structured-content-ir.md`, together
with `docs/architecture/block-storage.md`, `docs/product/product-spec.md` and `docs/schemas/`.
It uses a clean data root, a single MinerU v2 JSON import path and transactional SQLite block
drafts. Immutable build snapshots are the only persisted `book.json` files.
The current edit operation and its implementation boundaries are specified in
`docs/architecture/block-editing.md`; HTTP v4 uses one block batch format without old edit adapters.

The live HTTP contract remains at `001-mineru-public-publishing/contracts/openapi.yaml`.
Historical security, authorization, publication durability and performance requirements remain
effective unless an accepted decision explicitly replaces them.
