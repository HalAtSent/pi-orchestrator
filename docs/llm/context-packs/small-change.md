---
status: context
owner: engineering
last_verified: 2026-05-15
authority_sources:
  - ../../../AGENTS.md
  - ../../KERNEL-INVARIANTS.md
  - ../commands.md
  - ../known-traps.md
verify_with:
  - git diff --check
---

# Small Change Context Pack

Use this pack for narrow documentation changes, small tests, or one-surface code
edits.

## Read

1. `AGENTS.md`
2. `docs/llm/authority-map.md`
3. The files directly named by the task
4. The nearest relevant test file when behavior changes
5. `docs/llm/known-traps.md` when touching validator, fingerprint,
   artifact-store, CLI, fixture, or path-safety surfaces

Use the rest of `docs/llm/` only if orientation is needed.

## Defaults

- Keep the diff small and reviewable.
- Preserve public contracts unless explicitly asked to change them.
- Do not add dependencies or new architecture.
- Do not touch unrelated files.
- If existing user changes are present, leave them alone unless they affect the
  task.

## Verification

For docs-only changes, run patch sanity checks.

For behavior changes, run the focused test first, then `npm test`.

If adding or editing untracked files, `git diff --check` does not check them.
Use the untracked-aware check in `docs/llm/commands.md` or stage the intended
files and run `git diff --cached --check`.
