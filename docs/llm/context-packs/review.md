---
status: context
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../../AGENTS.md
  - ../../KERNEL-INVARIANTS.md
  - ../../WORK-ORDER-SCHEMA.md
  - ../../EVIDENCE-PACK-SCHEMA.md
  - ../known-traps.md
verify_with:
  - git diff --check
---

# Review Context Pack

Use this pack for code review, audit, stress-test, or counterexample review.

## Read

1. `AGENTS.md`
2. `docs/llm/authority-map.md`
3. The changed files and directly related tests
4. The source docs that own any changed contract

## Review Focus

Report only serious, actionable issues introduced by the audited change:

- correctness regressions
- security or privacy risks
- broken schema or persisted-artifact contracts
- fail-open validation paths
- binding gaps
- missing tests for changed behavior
- plausible performance or concurrency regressions
- scope creep
- architecture boundary violations

Do not report future-backlog work as a current defect unless the changed
artifact explicitly claims or depends on that behavior now.

For this repo, also check whether the patch:

- introduces a second invariant into a micro Work Order
- changes a forbidden file/surface for the named Work Order
- changes validator behavior while claiming to update only CLI, fixtures,
  fingerprinting, or path primitives
- promotes path-safety reason strings into validator failure codes without a
  Work Order naming that result-shape/rule change
- claims protected-path or scope enforcement before validator code and tests
  enforce it

## Severities

- P0: likely outage, data loss, security compromise, or severe privacy issue.
- P1: serious issue that should block merge.
- P2: meaningful issue that should be fixed soon.
- P3: minor issue or cleanup suggestion.

## Output

Findings first, ordered by severity. Label uncertain concerns as uncertain.
Then include no-finding areas checked, verification performed, and residual
risks.
