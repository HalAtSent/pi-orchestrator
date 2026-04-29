# Kernel Invariants

This short index lists non-negotiable rebuild invariants. Detailed field rules
live in [WORK-ORDER-SCHEMA.md](./WORK-ORDER-SCHEMA.md) and
[EVIDENCE-PACK-SCHEMA.md](./EVIDENCE-PACK-SCHEMA.md).

Status: rebuild target guidance, not a current implementation guarantee.

- The harness is a coding-quality harness, not a product lifecycle planner.
- The execution handoff is an explicit Work Order.
- The output is a truthful Evidence Pack.
- Planning surfaces may produce Work Orders, but they do not own kernel policy.
- Prompt text, role docs, skills, model narration, and formatter prose are never policy authority.
- All paths are repo-relative unless explicitly absolute as `repositoryRoot`.
- Path traversal, symlink escape, realpath escape, and repo-root escape fail closed.
- Write-capable workers require explicit allowlists.
- Forbidden paths override allowed paths.
- Protected paths are denied by default.
- New files are denied unless the Work Order explicitly permits them.
- Explorer, reviewer, and verifier roles are read-only.
- Implementer writes only inside Work Order scope.
- Worker output cannot widen scope, action classes, approval, role capability, or repair authority.
- Invalid worker output fails closed.
- Runtime context drift fails closed.
- Persisted artifacts validate on load; invalid persisted artifacts fail closed.
- Approval binds to exact Work Order identity, canonical fingerprint, repository root, action scope, and policy profile.
- Approval does not authorize future replans, wider repair, technical correctness, or reviewable success.
- Changed-surface evidence distinguishes observed paths from planned scope.
- Verification evidence distinguishes commands run from commands merely planned.
- Success and reviewability are separate.
- No-op implementer success without evidence is not reviewable.
- Repair loops are bounded and cannot widen scope.
- Terminal runs do not resume.
- Process backend workspace isolation, apply, rollback, sandbox, symlink, hardlink, stale-output, and changed-surface lessons must survive rebuild.
- Provider and model evidence is recorded when model-backed workers run.
- Redaction happens at concrete trust boundaries and records code-verified metadata.
