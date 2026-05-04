---
status: context
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../../AGENTS.md
  - ../../KERNEL-INVARIANTS.md
  - ../../WORK-ORDER-SCHEMA.md
  - ../../EVIDENCE-PACK-SCHEMA.md
  - ../../IMPLEMENTATION-SEQUENCE.md
  - ../patterns.md
  - ../known-traps.md
verify_with:
  - npm test
  - git diff --check
---

# Feature Work Context Pack

Use this pack for implementation work that changes harness behavior.

## Read

1. `AGENTS.md`
2. `docs/llm/authority-map.md`
3. `docs/llm/conventions.md`
4. `docs/llm/testing.md`
5. The target rebuild docs that own the behavior
6. The implementation and test files directly related to the requested slice

## Slice Rules

Prefer one enforceable invariant per Work Order. Keep one primary implementation
file and one primary test file unless the task explicitly requires more.

Stop and split if the work mixes:

- CLI and validator logic
- Work Order and Evidence Pack behavior
- schema fields and policy interactions
- fixtures and new validator behavior
- fingerprinting and validation behavior
- path normalization and protected-path policy

Current surface-specific boundaries:

- Validator result-shape changes are separate from validator rule changes.
- CLI wrapper changes are separate from validator behavior.
- Fixture additions are separate from new validator behavior.
- Fingerprint primitive changes are separate from approval validation, except
  later approval-binding passes may call the existing primitive.
- Path normalization, protected-path detection, validator wiring, and scope
  authorization are separate Pass 2 slices.

## Testing

Add or update focused behavior tests for changed behavior. Run the focused test
first, then `npm test`.

## Evidence

Report exactly what commands were run and whether they passed. Do not imply
runtime enforcement from target docs alone.
