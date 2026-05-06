---
status: context
owner: engineering
last_verified: 2026-05-06
authority_sources:
  - ../../AGENTS.md
  - ../KERNEL-INVARIANTS.md
  - ../WORK-ORDER-SCHEMA.md
  - ../EVIDENCE-PACK-SCHEMA.md
  - ../REBUILD-GUIDE.md
  - ../CODING-QUALITY-HARNESS.md
  - ../IMPLEMENTATION-SEQUENCE.md
  - ../../src/kernel/work-order.js
  - ../../src/kernel/work-order-fingerprint.js
  - ../../src/kernel/path-safety.js
  - ../../src/cli/pi.js
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
  - ../../test/work-order-cli.test.js
verify_with:
  - git diff --check
---

# LLM Wiki

This directory is agent-readable orientation for the repo. It helps agents
navigate the code, docs, commands, traps, and task-specific context.

Core invariant:

```text
The LLM wiki may compress, map, and explain repo knowledge.
It may not silently create authority.
```

## Read First

For non-trivial work, read in this order:

1. `AGENTS.md`
2. `docs/llm/README.md`
3. `docs/llm/authority-map.md`
4. The relevant context pack under `docs/llm/context-packs/`
5. The source files, tests, specs, schemas, or normative docs named by the task

For a small direct task, start with the files directly related to the request
and use this wiki only when orientation is useful.

## Authority Summary

Current behavior is authoritative only when backed by current source code and
tests.

Target rebuild behavior is guided by these docs, in order:

1. `docs/KERNEL-INVARIANTS.md`
2. `docs/WORK-ORDER-SCHEMA.md`
3. `docs/EVIDENCE-PACK-SCHEMA.md`
4. `docs/REBUILD-GUIDE.md`
5. `docs/CODING-QUALITY-HARNESS.md`
6. `docs/IMPLEMENTATION-SEQUENCE.md`
7. Existing code and tests for behavior already implemented

`docs/llm/` is context by default. A page in this directory is authoritative
only if its header declares `status: authoritative` and cites the source
authority it derives from.

If this wiki conflicts with code, tests, schemas, specs, ADRs, or the rebuild
docs above, stop and report the conflict. Do not create product behavior,
architecture, or policy by implication from wiki prose.

## Page Map

- `repo-map.md` - where major repo surfaces live.
- `authority-map.md` - what owns truth and how conflicts resolve.
- `commands.md` - local commands and when to use them.
- `conventions.md` - working conventions for scoped changes.
- `testing.md` - verification expectations.
- `patterns.md` - recurring harness patterns and boundaries.
- `known-traps.md` - failure modes that have caused bad patches.
- `context-packs/small-change.md` - narrow task context.
- `context-packs/feature-work.md` - implementation task context.
- `context-packs/review.md` - review and audit context.
- `decisions/` - decision records, when deliberately created.
- `scratch/` - temporary notes with no authority.

## Conflict Behavior

When documents conflict:

1. Stop before editing affected behavior.
2. Identify the conflicting files and exact claims.
3. Name the controlling source using `AGENTS.md` and `authority-map.md`.
4. Ask for direction only if the controlling source cannot be determined.

## Current Implemented Kernel Snapshot

Classification: `repo-confirmed` from current source and tests.

- Work Order validation exists in `src/kernel/work-order.js`.
- The `pi validate-work-order <file>` CLI exists in `src/cli/pi.js` and renders
  the validator result as JSON.
- Canonical JSON and Work Order fingerprint primitives exist in
  `src/kernel/work-order-fingerprint.js`.
- Lexical path normalization, protected-path detection, and normalized path
  coverage primitives exist in `src/kernel/path-safety.js`.
- Work Order validation rejects protected paths in `scope.allowed` and
  `scope.allowedNewFiles`; `scope.forbidden` may still list protected paths as
  denial metadata.
- Work Order validation rejects `scope.allowed` entries covered by valid
  `scope.forbidden` entries. An allowed parent may still contain a forbidden
  child. This is lexical validator coverage only.
- Valid lifecycle fixtures and two negative Work Order fixtures exist under
  `test/fixtures/work-orders/`.

Classification: `documented-target`.

- Evidence Pack validation, artifact store, run journal, worker execution,
  repair loops, model-backed workers, `/build`, full scope authorization,
  runtime protected-path write enforcement, root containment, symlink/realpath
  checks, and observed worker path enforcement remain target/backlog behavior
  unless current code and tests say otherwise.
