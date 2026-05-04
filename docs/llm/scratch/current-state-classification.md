---
status: draft
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../../AGENTS.md
  - ../authority-map.md
  - ../../../README.md
  - ../../../src/kernel/work-order.js
  - ../../../src/kernel/work-order-fingerprint.js
  - ../../../src/kernel/path-safety.js
  - ../../../src/cli/pi.js
  - ../../../test/work-order-schema.test.js
  - ../../../test/work-order-fingerprint.test.js
  - ../../../test/path-safety.test.js
  - ../../../test/work-order-cli.test.js
  - ../../../test/work-order-fixtures.test.js
verify_with:
  - git diff --check
---

# Current State Classification Scratch

This scratch note records recovered context from the wiki population pass. It is
not authority.

## Classification Summary

| Item | Classification | Current Handling |
| --- | --- | --- |
| Work Order validator, CLI wrapper, fingerprint primitive, path-safety primitives, and fixtures exist. | `repo-confirmed` | Promoted to `repo-map.md`, `patterns.md`, `testing.md`, and `README.md`. |
| Earlier `README.md` text said runtime code was absent and `src/` / `test/` were placeholder-only. Current `README.md` now describes implemented kernel surfaces. | `obsolete` | Resolved history only; do not preserve this as an active conflict in default wiki pages. |
| Micro Work Order discipline: one invariant, one implementation file, one test file, at most three acceptance criteria, stop after more than two audits. | `documented-target` with `chat-derived` reinforcement | Promoted to `conventions.md`; source authority is `docs/IMPLEMENTATION-SEQUENCE.md`. |
| Implementation guidance is non-authoritative; invariant/scope/acceptance/tests/non-goals win. | `chat-derived`; consistent with target docs | Promoted as context to `conventions.md`; should be promoted into Work Order authoring docs if it must become normative. |
| Approval action-class binding must not sort approved arrays into passing. | `repo-confirmed` | Promoted to `patterns.md` and `known-traps.md`. |
| Approval fingerprint validation must call the fingerprint primitive, not reimplement canonicalization. | `repo-confirmed` | Promoted to `patterns.md` and `known-traps.md`. |
| Canonical JSON `__proto__`, integer-like key ordering, and undeclared `extensions` behavior. | `repo-confirmed` | Promoted to `patterns.md` and `known-traps.md`. |
| Path-safety drive/scheme and embedded segment traps. | `repo-confirmed` | Promoted to `known-traps.md`. |
| Protected-path detection is wired only for Work Order write allowlists. | `repo-confirmed` | Promoted to `patterns.md`, `known-traps.md`, and `repo-map.md`. |
| Evidence Pack validation, artifact store, journal, worker execution, repair loops, model workers, templates, `/build`. | `documented-target` | Promoted as future/non-current behavior in `README.md`, `patterns.md`, and `conventions.md`. |

## Items To Promote Into Real Authority Later

- Keep resolved README placeholder-history out of default orientation pages.
- If Work Order authoring/review guidance should be normative, add it to
  `docs/WORK-ORDER-SCHEMA.md` or a dedicated authoritative Work Order authoring
  document instead of relying on `docs/llm/`.
- When broader protected-path enforcement is wired into runtime scope checks,
  update authoritative schema/implementation docs or tests to distinguish
  allowlist validation from full write enforcement.

## Discarded As Obsolete

- Earlier draft Work Order text that was superseded by narrower accepted
  Work Orders. The durable residue is captured as current boundaries and traps,
  not as history.
