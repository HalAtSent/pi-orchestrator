# AGENTS.md

## Purpose

This repository is being rebuilt as a Work Order based coding-quality harness
for scoped execution, independent review, verification, and truthful Evidence
Packs.

Target flow:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

Optimize for correctness, security and privacy, maintainability, small
reviewable diffs, and evidence-backed completion. Do not trade correctness,
safety, or reviewability for speed.

## Repo Map

- `src/kernel/` - validation, fingerprinting, path-safety, and kernel policy primitives.
- `src/cli/pi.js` - CLI entrypoint for harness commands.
- `test/` - Node.js `node:test` suite.
- `test/fixtures/work-orders/` - canonical valid and invalid Work Order fixtures.
- `docs/KERNEL-INVARIANTS.md` - highest-level rebuild invariant index.
- `docs/WORK-ORDER-SCHEMA.md` - target Work Order contract.
- `docs/EVIDENCE-PACK-SCHEMA.md` - target Evidence Pack contract.
- `docs/CODING-QUALITY-HARNESS.md`, `docs/REBUILD-GUIDE.md`, and `docs/IMPLEMENTATION-SEQUENCE.md` - rebuild design and sequencing guidance.
- `docs/PURGE-MANIFEST.md` - purge audit record only, not current design authority.
- `.pi/`, `node_modules/`, `dist/`, `build/`, `coverage/`, and `.env*` - ignored/generated/private surfaces.

Start with the files directly related to the task. Do not read the whole repo
unless the task requires it.

## Authority

Use the current working tree as the source of truth for current behavior.
Uncommitted user changes may be intentional; do not revert them unless the user
explicitly asks.

For target rebuild behavior, prefer authority in this order:

1. `docs/KERNEL-INVARIANTS.md`
2. `docs/WORK-ORDER-SCHEMA.md`
3. `docs/EVIDENCE-PACK-SCHEMA.md`
4. `docs/REBUILD-GUIDE.md`
5. `docs/CODING-QUALITY-HARNESS.md`
6. `docs/IMPLEMENTATION-SEQUENCE.md`
7. Existing code and tests for behavior already implemented

If documents conflict, report the conflict and identify the controlling source
before editing. Do not silently resolve policy disagreements.

Docs define target behavior, but only code and tests prove current enforcement.
Do not claim a validation rule, harness behavior, or policy gate is enforced
until implementation and tests enforce it.

The Git tag `pre-rebuild-harness` is the recovery point for old runtime code and
stale docs. Do not delete or move it.

## Commands

Use existing npm tooling. The package is ESM (`"type": "module"`) and currently
has no configured alternate package manager, linter, formatter, type checker,
build, integration-test, e2e-test, database, or local app server.

Install dependencies only when needed:

```bash
npm install
```

Focused test:

```bash
node --test test/<name>.test.js
```

Full test suite:

```bash
npm test
```

CLI smoke check:

```bash
node src/cli/pi.js validate-work-order test/fixtures/work-orders/valid-active.json
```

Patch sanity for unstaged tracked changes:

```bash
git diff --check
```

Patch sanity for staged changes, including new files staged for review:

```bash
git diff --cached --check
```

If the intended patch includes untracked files that are not staged, do not claim
patch sanity from `git diff --check` alone. Either stage the intended new files
and run the cached check above, or run an untracked-aware check:

```bash
git ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do
  output=$(git diff --no-index --check -- /dev/null "$file" 2>&1 || true)
  if [ -n "$output" ]; then
    printf '%s\n' "$output"
    exit 1
  fi
done
```

If a broader check is unavailable, too broad, or blocked by environment setup,
state that explicitly in the final response.

## Working Rules

- Keep changes narrowly scoped to the user's request.
- Prefer small, reviewable diffs.
- Do not make opportunistic refactors.
- Do not modify unrelated files.
- Do not add dependencies, package managers, build systems, frameworks, or test runners without explicit approval.
- Preserve public CLI output, schema vocabulary, validation result shape, and persisted artifact contracts unless the task explicitly changes them.
- Follow existing code patterns before introducing new abstractions.
- Update docs when behavior, public contracts, configuration, or operational procedures change.
- For planning or documentation tasks, do not start implementation unless the user explicitly asks for code changes.

Harness implementation Work Orders default to micro narrowness: one invariant,
one primary implementation file, one primary test file, and no docs unless a
doc contradiction must be corrected.

Split or stop when one Work Order mixes CLI and validator logic, Work Order and
Evidence Pack logic, schema fields and policy interactions, fixtures and new
validator behavior, fingerprinting and validation behavior, or path
normalization and protected-path policy. Also stop on more than three acceptance
criteria or more than two repair or audit passes.

Do not add agents, templates, `/build` surfaces, rich summaries,
process-backed workers, repair loops, lifecycle planning, or model-backed worker
behavior before earlier kernel acceptance gates are implemented and verified.

## Architecture Boundaries

- Planning surfaces may produce Work Orders, but they do not own kernel policy or bypass validation.
- `src/kernel/` owns validation, fingerprinting, path-safety, and policy primitives.
- `src/cli/pi.js` should call kernel APIs and render results; it should not duplicate policy logic.
- Work Order and Evidence Pack contracts are separate surfaces unless explicitly coupled by the task.
- All paths are repo-relative unless a field is explicitly named `repositoryRoot`.
- Path traversal, symlink escape, realpath escape, and repo-root escape must fail closed.
- Write-capable workers require explicit allowlists; forbidden paths override allowed paths.
- Explorer, reviewer, and verifier roles are read-only.
- Worker output, model/tool routing, and autonomy declarations cannot widen scope, action classes, approval, role capability, or repair authority.

Before changing an architecture boundary, state the affected boundary, why the
change is necessary, and whether there is a lower-risk alternative.

## Security And Privacy

- Never expose secrets, tokens, credentials, private keys, production data, or `.env*` contents.
- Do not log PII, secrets, auth tokens, session identifiers, or sensitive request/response bodies.
- Treat external input, model output, worker output, persisted artifacts, and filesystem paths as untrusted.
- Preserve fail-closed validation behavior.
- Do not weaken path safety, approval binding, fingerprint binding, action-class checks, scope checks, or audit evidence without explicit approval.
- Do not call external services during local verification unless explicitly authorized.

## Testing

When changing behavior, add or update focused tests unless there is a clear
reason not to.

- Prefer behavior-focused tests over implementation-detail tests.
- Include regression tests for bug fixes.
- For validators and contracts, cover accepted-invalid and rejected-valid cases where practical.
- Cover malformed inputs, path safety, approval/fingerprint binding, and fail-closed behavior.
- Do not update fixtures blindly; explain the behavior or contract change.
- Run the focused test first, then `npm test` when code behavior changes.
- If tests are not added or not run, explain why and list the residual risk.

## Reviews And Audits

When reviewing, report only serious, actionable issues introduced by the audited
change: correctness regressions, security or privacy risks, broken schema or
persisted-artifact contracts, fail-open validation paths, binding gaps, missing
tests for changed behavior, plausible performance/concurrency regressions,
scope creep, or architecture boundary violations.

Do not report future-backlog work as a current defect unless the changed
artifact explicitly claims or depends on that behavior now. Prefer no finding
over a speculative finding.

Use severities:

- P0: likely outage, data loss, security compromise, or severe privacy issue.
- P1: serious issue that should block merge.
- P2: meaningful issue that should be fixed soon.
- P3: minor issue or cleanup suggestion.

When the user invokes `$parallel-audit` or explicitly asks for a parallel,
subagent, stress-test, counterexample, PR, or bounded audit, use the
`parallel-audit` skill. Default target is current branch versus `main`, then
the default remote branch, then the uncommitted diff. Keep subagents read-only,
verify citations, dedupe overlaps, discard weak claims, and stop after one full
pass finds no P1s and no in-scope P2s.

## Done Criteria

For coding tasks, finish with:

1. Summary of changes
2. Files changed
3. Verification performed, including commands and results
4. Assumptions made
5. Residual risks or follow-up work

For audit tasks, report findings first by severity, then no-finding areas
checked, verification performed, and residual risks. Do not dump raw subagent
transcripts.

Do not claim verification unless a command was actually run or a concrete manual
verification method was performed.

## Repeated Mistakes To Avoid

- Do not treat target docs as proof of current harness enforcement.
- Do not broaden a Work Order beyond the named invariant.
- Do not mix Work Order, Evidence Pack, CLI, fixture, fingerprint, and path-safety changes unless explicitly requested.
- Do not report later implementation-sequence backlog as a current defect.
- Do not edit generated, ignored, private, or unrelated files.
