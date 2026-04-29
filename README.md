# Pi Orchestrator Rebuild Workspace

This branch is reset for a rebuild.

The previous implementation state is available at the Git tag
`pre-rebuild-harness`. Do not delete or move that tag; it is the recovery point
for old runtime code, tests, examples, skills, and stale documentation.

## Current State

`main` is being rebuilt from a broad Pi and project-lifecycle orchestrator into
a coding-quality harness.

There is no runtime harness implemented on `main` after this purge. The active
repository surface is intentionally limited to rebuild documentation, minimal
package metadata, and empty target directories for future implementation.

Target flow:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

## Active Rebuild Docs

The current design authority for the rebuild is:

- [docs/CODING-QUALITY-HARNESS.md](./docs/CODING-QUALITY-HARNESS.md)
- [docs/REBUILD-GUIDE.md](./docs/REBUILD-GUIDE.md)
- [docs/WORK-ORDER-SCHEMA.md](./docs/WORK-ORDER-SCHEMA.md)
- [docs/EVIDENCE-PACK-SCHEMA.md](./docs/EVIDENCE-PACK-SCHEMA.md)
- [docs/KERNEL-INVARIANTS.md](./docs/KERNEL-INVARIANTS.md)
- [docs/IMPLEMENTATION-SEQUENCE.md](./docs/IMPLEMENTATION-SEQUENCE.md)

[docs/PURGE-MANIFEST.md](./docs/PURGE-MANIFEST.md) is retained as the audit
record for the aggressive purge that reset this branch. It is not current
design authority for the rebuilt runtime.

## Rebuild Direction

The rebuilt harness should start from a precise Work Order, enforce scoped
execution boundaries, use isolated worker roles, perform independent review,
run bounded repair, capture verification evidence, and emit a truthful Evidence
Pack.

Planning surfaces may produce Work Orders later. They do not belong inside the
execution kernel.

## Repository Shape

Current retained shell:

```text
README.md
PURPOSE.txt
.gitignore
package.json
docs/
src/
test/
```

`src/` and `test/` contain only `.gitkeep` placeholders until the rebuild starts.
