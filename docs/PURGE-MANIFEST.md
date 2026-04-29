# Purge Manifest

## Purpose

This manifest is the decision ledger and audit record for the aggressive purge
that reset the current Pi orchestrator repository.

Post-purge status: the classifications below describe the pre-purge repository
and the reasoning used to remove or retain surfaces. They are historical
guidance, not the current active file map and not design authority for the
rebuilt runtime.

The purge target is not to erase lessons. The target is to remove stale active
architecture and rebuild around a small coding-quality harness centered on
Work Orders.

This manifest did not authorize deletion by itself. The purge was executed only
after the recovery tag `pre-rebuild-harness` and replacement rebuild docs were
in place.

This document is not:

- an implementation plan for the rebuild
- current design authority for the rebuilt runtime
- authority to weaken safety invariants
- a request to refactor runtime code

## North Star

Authoritative rebuild docs:

- [docs/CODING-QUALITY-HARNESS.md](./CODING-QUALITY-HARNESS.md)
- [docs/REBUILD-GUIDE.md](./REBUILD-GUIDE.md)

Target architecture:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

The kernel starts from a precise Work Order, validates scope and policy, runs
isolated worker roles, performs independent review and bounded repair, captures
verification evidence, and emits a truthful Evidence Pack.

Planning surfaces may exist before the Work Order, but they do not belong in
the execution kernel.

## Purge Rules

- Preserve safety invariants before deleting implementations.
- Preserve failure-mode tests or write explicit replacement-test plans.
- Move project-planning and product-lifecycle concerns out of the kernel.
- Do not keep modules just because they exist.
- Do not keep stale docs active if they describe old architecture.
- Do not mix broad deletion with broad new implementation in one commit.
- Do not delete files classified as `defer` until they are reclassified.
- Do not delete `salvage` files until their lessons are covered by replacement
  docs, replacement tests, or replacement code.
- Keep prompt text, role docs, and skills subordinate to code-owned policy.
- Treat broad evidence/profile vocabulary as suspect until it has detector
  owners, tests, and review meaning.

## Target Repo Shape

Intended post-purge shape:

```text
docs/
  CODING-QUALITY-HARNESS.md
  REBUILD-GUIDE.md
  PURGE-MANIFEST.md
  WORK-ORDER-SCHEMA.md
  EVIDENCE-PACK-SCHEMA.md
  archive/

src/kernel/
  work-order validation
  scope and path safety
  policy and approval binding
  state machine
  evidence normalization

src/execution/
  work-order execution loop
  bounded repair
  run journal

src/runners/
  local/scripted/process runner interfaces

src/roles/
  role envelopes and packet builders

src/adapters/
  Pi or CLI integration surfaces

src/planning/
  optional Work Order producers only

test/
  kernel/
  execution/
  runners/
  adapters/
```

`src/planning/` is optional and must stay outside the kernel. It may produce
Work Orders, but it must not own execution policy.

## Classification Legend

| Classification | Meaning |
| --- | --- |
| `preserve` | Keep active mostly as-is, possibly moved or renamed. |
| `salvage` | Keep the concept, tests, or lessons; rewrite or move the implementation. |
| `archive` | Move out of active docs/code path as historical reference. |
| `delete` | Remove after confirming its lessons are covered elsewhere. |
| `defer` | Do not decide yet; inspect further or keep until replacement exists. |

## Source Module Classification

| Path | Classification | Reason | Future Action |
| --- | --- | --- | --- |
| `src/auto-backend-runner.js` | salvage | Backend selection and trusted provenance guards are useful; `/auto` mode vocabulary is old surface. | Rebuild as runner-selection policy for Work Order execution, keeping trust-marker tests. |
| `src/auto-workflow.js` | salvage | Contains bounded role loop, read-only enforcement, repair loop, context carry-forward, and redaction lessons; current workflow shape is not the final Work Order kernel. | Rewrite as the Work Order execution loop and migrate context/repair tests. |
| `src/boolean-flags.js` | preserve | Small strict boolean parser used to avoid permissive approval parsing. | Keep or move into kernel input normalization if string CLI flags remain. |
| `src/build-session-store.js` | salvage | `/build` session persistence is old operator lifecycle, but approval identity, action scope, locking, and store-safety lessons matter. | Extract approval-binding and persistence lessons; archive old build-session store after Work Order persistence exists. |
| `src/context-manifest.js` | salvage | Runtime context provenance, drift detection, budget checks, and read-only recon admission are core lessons. | Rewrite around Work Order context packets with smaller vocabulary and retained fail-closed tests. |
| `src/contracts.js` | salvage | Task packet and worker result contracts are near the new center, but current shape predates Work Orders. | Split into `WORK-ORDER-SCHEMA` and worker-result or evidence-pack contracts. |
| `src/doctrine-evaluation.js` | archive | Lifecycle evaluation criteria are tied to project-planning doctrine, not the coding-quality kernel. | Extract any durable quality metrics into rebuild docs, then move to archive. |
| `src/helpers.js` | delete | Only exports `identity`; no unique harness lesson beyond a syntax smoke test. | Delete with `test/helpers-syntax.test.js` after confirming no imports remain. |
| `src/operator-formatters.js` | salvage | Old `/build` formatting is miscentered; evidence rendering lessons are valuable. | Extract changed-surface, commands-run, reviewability, and unproven-claims rendering into Evidence Pack formatting. |
| `src/operator-intake.js` | archive | Plain-English `/build` intake is a planning adapter, not kernel behavior. | Archive after a Work Order producer boundary exists, or rewrite later outside `src/kernel/`. |
| `src/orchestrator.js` | salvage | Role sequencing, packet goals, scope validation, and human-gate defaults are useful; the orchestration abstraction is old. | Rewrite as Work Order to role-packet compilation. |
| `src/path-safety.js` | preserve | Root containment, symlink checks, realpath checks, and safe store directory handling are kernel safety. | Move mostly as-is into `src/kernel/` and keep focused tests. |
| `src/path-scopes.js` | preserve | Repository-relative normalization, traversal rejection, scope matching, and overlap checks are core. | Move mostly as-is into `src/kernel/`. |
| `src/pi-adapter.js` | defer | Live Pi boundary may still matter, but native Pi runtime reliability is uncertain and current request shape is old. | Decide after selecting the first rebuild runner backend; salvage fail-closed adapter validation if Pi stays. |
| `src/pi-extension.js` | defer | Contains active command/tool wiring, but most of it exposes old lifecycle commands. | Replace with a minimal Work Order adapter; archive lifecycle commands after new entrypoint exists. |
| `src/pi-runtime-diagnostics.js` | defer | Useful only if Pi host runtime remains a supported adapter. | Keep until adapter decision; otherwise archive with Pi-native path. |
| `src/pi-spawn.js` | defer | Process backend still depends on Pi launcher resolution; fallback behavior is safety-sensitive. | Keep until worker backend choice is final; salvage launcher-resolution evidence if process backend remains. |
| `src/pi-worker-runner.js` | salvage | File claims, read-only write detection, observed/reported diff checks, and trusted root propagation are important. | Rewrite runner boundary around Work Order packets; keep write-detection and context-admission tests. |
| `src/policies.js` | salvage | Protected paths, risk gates, task lanes, and default checks are useful; lane/action vocabulary may be overgrown. | Rebuild as narrow Work Order policy with protected paths denied by default. |
| `src/policy-profiles.js` | salvage | Fail-closed profile resolution and stricter-only policy overlays are useful; current live profile set is narrow and vocabulary-heavy. | Rewrite after Work Order action classes are settled and detector-backed. |
| `src/preflight.js` | salvage | Repo root, test script, protected scope, process backend, sandbox, and model readiness checks match the new Stage 2. | Move into `src/kernel/` or `src/execution/` preflight with Work Order inputs. |
| `src/process-model-probe.js` | salvage | Provider/model availability and explicit selection evidence are useful for model-backed workers. | Keep the concept; bind output to Evidence Pack model evidence. |
| `src/process-worker-backend.js` | salvage | Contains critical workspace isolation, apply/rollback, sandbox, launcher, provider/model, read-only retry, and evidence lessons. | Rewrite or shrink; preserve apply/rollback/sandbox/model-probe tests before deleting old backend. |
| `src/program-compiler.js` | salvage | Contract-to-packet compilation maps to Work Order packet compilation, but `ExecutionContract` is old vocabulary. | Rewrite as Work Order to role packets. |
| `src/program-contract-executor.js` | salvage | Policy decisions, verification planning, claim ledger, changed-surface trust, and provider/model promotion are valuable. | Rewrite as Work Order stage executor and Evidence Pack assembler. |
| `src/program-runner.js` | salvage | Dependency order, terminal states, terminal resume rejection, approval lineage, and persistence behavior matter. | Rebuild as a small Work Order state machine; keep terminal-resume tests. |
| `src/project-contracts.js` | salvage | Mixed file: old proposal/blueprint/program artifacts should leave the kernel; run-journal and validation lessons matter. | Split evidence/run-journal contracts from project lifecycle artifacts, then archive old lifecycle types. |
| `src/project-workflows.js` | archive | Brainstorm, blueprint, slice, bootstrap, and audit are generic project lifecycle planning. | Extract plan fingerprint/action-class derivation if still needed, then archive. |
| `src/redaction.js` | preserve | Boundary path and secret-material redaction is directly relevant to Evidence Packs and forwarded context. | Move mostly as-is into evidence or boundary utilities. |
| `src/run-evidence.js` | salvage | Strong normalization and reviewability lessons; schema is broad and still tied to run journals/build sessions. | Rewrite into a smaller Evidence Pack schema with detector-owned fields only. |
| `src/run-store.js` | salvage | Persisted artifact validation, envelope drift rejection, locking, redaction, and reviewability backfill are valuable. | Rebuild as Work Order/Evidence Pack store; keep load-fail-closed tests. |
| `src/safe-clone.js` | preserve | Robust boundary cloning avoids crashing on non-cloneable context. | Keep as shared boundary utility. |
| `src/schema.js` | defer | Thin tool-schema builder used by old Pi extension surfaces. | Keep only if the new adapter still needs local schema helpers. |
| `src/skill-governance.js` | salvage | Governance confirms skills are not policy authority and checks role-doc drift; runtime scope may shrink. | Keep a smaller governed-role/skill inventory if skills remain in the rebuild. |
| `src/typed-claim-redaction.js` | salvage | Redaction over typed claim surfaces is useful, but current claim schema may change. | Fold into Evidence Pack redaction once final claim fields exist. |
| `src/verification-planner.js` | salvage | Distinguishes planned verification, required commands, skipped candidates, and spec drift; maps to verifier stage. | Rewrite around Work Order verification requirements and Evidence Pack command truth. |
| `src/worker-result-redaction.js` | salvage | Boundary redaction for worker results is still needed. | Rebuild against the new worker result and Evidence Pack shapes. |
| `src/worker-runner.js` | preserve | Local and scripted runners are useful for deterministic tests and runner contracts. | Keep or move under `src/runners/` for test and adapter development. |

## Documentation Classification

| Path | Classification | Reason | Future Action |
| --- | --- | --- | --- |
| `README.md` | salvage | Accurately records many lessons but still centers old Pi package, `/auto`, `/build`, and lifecycle commands. | Rewrite after purge to describe Work Orders, runner backends, and Evidence Packs. |
| `PURPOSE.txt` | salvage | Still broadly true, but "autonomous coding harness" should be recentered on coding-quality Work Orders. | Update wording after new kernel shape is committed. |
| `docs/CODING-QUALITY-HARNESS.md` | preserve | Current north star. | Keep active. |
| `docs/REBUILD-GUIDE.md` | preserve | Current teardown/rebuild reference. | Keep active. |
| `docs/PURGE-MANIFEST.md` | preserve | This decision ledger for the future purge. | Keep active until purge is complete, then retain as audit history. |
| `docs/HARNESS-CONTRACT.md` | salvage | Contains core invariants, but active contract still describes old program/build surfaces. | Extract into `docs/WORK-ORDER-SCHEMA.md` and a smaller kernel contract; archive old contract after replacement. |
| `docs/RUN-EVIDENCE-SCHEMA.md` | salvage | Evidence, reviewability, redaction, and persistence lessons are central; schema is tied to run/build artifacts. | Rewrite as `docs/EVIDENCE-PACK-SCHEMA.md`; archive old run/build schema after replacement. |
| `docs/HARNESS-PRINCIPLES.md` | salvage | Doctrine largely aligns with the new target but references lifecycle decomposition and old companion docs. | Rewrite or fold into the north-star docs after the kernel docs settle. |
| `docs/HARDENING-ROADMAP.md` | archive | It is an incremental-hardening roadmap for the current repo, not the rebuild plan. | Extract durable hardening themes into rebuild backlog, then archive. |
| `docs/POLICY-PROFILES.md` | salvage | Fail-closed profile rules matter; current profile/action-class scope is narrow and old-schema dependent. | Rewrite for Work Order policy profiles after action classes are detector-backed. |
| `docs/SKILL-GOVERNANCE.md` | salvage | Correctly states skills are not authority; inventory may need shrinkage. | Keep lessons and rewrite around rebuilt role/skill surfaces. |
| `docs/OPERATING-GUIDE.md` | archive | Active guide describes current `/build`, lifecycle, `/auto`, and run-program behavior. | Archive once the Work Order operating guide exists. |
| `docs/QUICKSTART.md` | archive | Non-technical `/build` quickstart is outside the kernel and currently describes old operator shell. | Archive or replace with a Work Order quickstart after rebuild. |
| `docs/agents/COMMON.md` | salvage | Role-envelope rules align with the rebuild, but references current contract and schemas. | Rewrite against Work Order and Evidence Pack docs. |
| `docs/agents/EXPLORER.md` | salvage | Read-only explorer role maps directly to Stage 3. | Keep role concept; update output shape and references. |
| `docs/agents/IMPLEMENTER.md` | salvage | Write-capable scoped implementer maps directly to Stage 4. | Keep role concept; update Work Order allowlist and patch evidence language. |
| `docs/agents/REVIEWER.md` | salvage | Independent critique maps directly to Stage 5. | Keep role concept; align findings with bounded repair inputs. |
| `docs/agents/VERIFIER.md` | salvage | Read-only proof collection maps directly to Stage 7. | Keep role concept; align with Evidence Pack command evidence. |
| `skills/explorer/SKILL.md` | salvage | Useful role method, explicitly read-only. | Update references and output shape after role docs are rewritten. |
| `skills/implementer/SKILL.md` | salvage | Useful bounded patch method. | Update to Work Order terminology and Evidence Pack proof expectations. |
| `skills/reviewer/SKILL.md` | salvage | Useful independent review method. | Update repair-finding format when bounded repair schema exists. |
| `skills/verifier/SKILL.md` | salvage | Useful verification method. | Update to distinguish commands planned from commands actually run in Evidence Packs. |
| `examples/sample-workflow-input.json` | salvage | Similar to a Work Order but lacks final Work Order schema fields. | Rewrite as `examples/sample-work-order.json` after schema lands. |
| `examples/sample-project-brief.json` | archive | Generic project lifecycle brief is outside the kernel. | Archive with old planning examples, or delete after historical docs capture it. |
| `examples/process-backend-model.txt` | delete | Stale `UNKNOWN` provider/model note; provider/model evidence is now covered in code/docs. | Delete after confirming no test or doc references remain. |

## Test Classification

| Behavior Group | Classification | Why |
| --- | --- | --- |
| Scope/path safety | preserve | Path traversal, repo-relative normalization, case handling, protected paths, and allow/forbidden precedence are non-negotiable kernel invariants. |
| Context manifest/runtime context drift | preserve | Runtime context drift must fail closed; carry-forward provenance and budget truth are core rebuild lessons. |
| Worker result contracts | preserve | Invalid worker output must fail closed and worker output must never widen scope. |
| Read-only write detection | preserve | Explorer, reviewer, and verifier cannot write. Tests in Pi runner and process backend capture critical failure modes. |
| Out-of-scope write rejection | preserve | Implementer writes must stay inside allowlist, with forbidden paths overriding allowed paths. |
| Process backend apply/rollback/sandbox/model-probe | salvage | These are some of the most valuable lessons, but current implementation should be reduced or rewritten. Preserve tests before rewriting. |
| Evidence normalization/reviewability | salvage | Reviewability, changed surface, command observations, provider/model evidence, and claim ledgers matter; schema should shrink into Evidence Pack. |
| Run store persistence | salvage | Persisted artifacts must validate on load, reject type/version drift, lock safely, and preserve redaction truth. Rewrite store shape. |
| Repair loop | salvage | Bounded repair and scoped repair packets matter; current workflow vocabulary should become Work Order repair stages. |
| Terminal resume rejection | preserve | Terminal runs must not resume. This is a direct rebuild invariant. |
| Operator/build lifecycle | archive | `/build` lifecycle tests preserve approval-binding and status lessons, but the surface is not kernel. Extract lessons first. |
| Project lifecycle planning | archive | Brainstorm/blueprint/slice/bootstrap/audit tests belong to historical planning, not the rebuild kernel. Extract only fingerprint/action-class or validation ideas if still needed. |

## Must Preserve Concepts

- Explicit Work Order or task packet as the execution handoff.
- Allowed, forbidden, and protected path enforcement.
- No path traversal or repo-root escapes.
- Forbidden paths override allowed paths.
- Protected paths are denied by default.
- Read-only roles cannot write.
- Implementer writes only inside the allowlist.
- Runtime output cannot widen scope.
- Invalid worker output fails closed.
- Runtime context drift fails closed.
- Persisted artifacts validate on load.
- Approval binds to exact plan or Work Order identity and action scope.
- Approval does not authorize future replans.
- Changed-surface evidence distinguishes observed paths from planned scope.
- Verification evidence distinguishes commands actually run from commands merely planned.
- Success and reviewability are separate.
- No-op implementer success without evidence is not reviewable.
- Repair loops are bounded and cannot widen scope.
- Terminal runs do not resume.
- Process backend workspace, apply, rollback, sandbox, hardlink, symlink, and stale-output lessons survive.
- Provider/model evidence is captured when model-backed workers run.
- Prompt text, role docs, and skills are never policy authority.
- Redaction happens at concrete trust boundaries, not only in final formatting.

## Candidate Deletion/Archive Set

These are candidates only after extraction or replacement. This list does not
authorize deletion.

Likely archive after replacement:

- `docs/OPERATING-GUIDE.md`
- `docs/QUICKSTART.md`
- `docs/HARDENING-ROADMAP.md`
- old versions of `docs/HARNESS-CONTRACT.md`
- old versions of `docs/RUN-EVIDENCE-SCHEMA.md`
- `examples/sample-project-brief.json`
- `src/operator-intake.js`
- `src/operator-formatters.js` after Evidence Pack rendering is extracted
- `src/build-session-store.js` after approval-binding lessons are covered
- `src/project-workflows.js`
- `src/doctrine-evaluation.js`
- project-lifecycle portions of `src/project-contracts.js`
- lifecycle command/tool portions of `src/pi-extension.js`
- old lifecycle tests such as `test/operator-intake.test.js`, `test/operator-formatters.test.js`, `test/project-workflows.test.js`, and `test/build-session-store.test.js` after replacement tests exist

Likely delete after confirming no references remain:

- `src/helpers.js`
- `test/helpers-syntax.test.js`
- `examples/process-backend-model.txt`

Do not delete yet:

- `src/process-worker-backend.js`
- `src/pi-worker-runner.js`
- `src/auto-workflow.js`
- `src/program-runner.js`
- `src/run-store.js`
- `src/run-evidence.js`
- `src/context-manifest.js`

Those files contain failure-mode lessons that must be preserved in replacement
tests and docs first.

## Stop Conditions

Block any purge if:

- no replacement doc covers a deleted invariant
- a failure-mode test is removed without replacement
- active docs contradict the Work Order north star
- deletion and new implementation are mixed too broadly
- no rollback plan exists
- uncertain files remain classified as `delete`
- protected path behavior is not represented in replacement tests
- approval identity and scope binding are not represented in replacement tests
- persisted artifact load validation is not represented in replacement tests
- process backend apply/rollback lessons are not represented before backend code is removed
- reviewer/verifier evidence semantics are collapsed into a single success flag

## Suggested Commit Sequence

1. Commit north-star docs.
2. Commit `docs/PURGE-MANIFEST.md`.
3. Archive stale operating and lifecycle docs.
4. Introduce `docs/WORK-ORDER-SCHEMA.md` and `docs/EVIDENCE-PACK-SCHEMA.md`.
5. Add replacement invariant tests for Work Order validation, path safety, approval binding, role write policy, context drift, and Evidence Pack truth.
6. Purge lifecycle/operator planning code from the active kernel path.
7. Rebuild the minimal kernel skeleton.
8. Salvage process backend and persistence tests in focused groups.
9. Reintroduce optional planning or Pi adapters only after the kernel is stable.

## Open Decisions

- Whether a future `/build` exists only as a Work Order producer or is archived indefinitely.
- Whether the first worker backend is process-backed, Pi-native, or local/scripted only.
- Exact Work Order schema, including new-file policy and approval override rules.
- Exact Evidence Pack schema and which current run-evidence fields survive.
- Whether policy profiles are in MVP or deferred until action classes are detector-backed.
- How much skill governance remains active in the minimal rebuild.
- Whether old docs move to `docs/archive/` or are removed after replacement docs land.
- Whether `.pi/runs` and `.pi/build-sessions` migrate to a new persisted artifact layout.
- Which operator-facing summaries are required for MVP versus later adapters.
- Whether project-template planning returns later as a separate `src/planning/` package.
