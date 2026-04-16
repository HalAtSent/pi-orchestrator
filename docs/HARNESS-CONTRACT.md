# Harness Contract

This document defines the normative operating contract for the harness.

Unlike [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md), this file is not a doctrine layer. It is a behavioral contract. It should be reviewed like an interface specification that answers what must hold; the principles explain why the harness is shaped this way.

Future-facing hardening that is not yet enforced belongs in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md), not in this contract.

This contract is about the harness as a thin but strict control plane. It is authoritative for the deterministic enforcement boundary: permissions, approvals, scope, provenance, persistence, evidence normalization, truthful status and approval surfaces, and fail-closed behavior. It is not a requirement that reusable task procedure or central choreography live in controller logic.

## Scope

This contract defines:

- trust classes and boundary crossings
- precedence and conflict rules
- kernel invariants
- correctness, preservation, and durability defaults
- action classes and default approval policy
- evidence rules for terminal claims
- approval-role boundaries and companion-update requirements
- control-plane boundaries, governed procedure boundaries, and current orchestrator and worker responsibilities
- run state machines
- fail-closed rules

## Conformance Status

This is the v1 behavioral contract for the repository.

Rules in this file describe current implemented behavior, current fail-closed normalization, or explicit repo-wide policy defaults that are authoritative for review and promotion today.

Conformance is judged by whether the control-plane surfaces stay truthful, predictable, and reviewable under strict boundaries, not by apparent autonomy or controller complexity. The harness should be able to show what scope was authorized, what ran, what changed, what evidence was captured, and where execution stopped without requiring trust in procedural narration.

Current code enforces or materially normalizes these parts already, especially:

- role separation
- bounded worker scopes
- read-only versus write-capable roles
- explicit run and build-session statuses
- persisted run journals and build sessions
- approval gating for high-risk execution
- protected-path rejection in declared workflow scope
- allowlist and forbidden-scope enforcement for writes
- pre-execution approval-scope checks against the currently derived plan action-class set

Target-state hardening that is not enforced today is tracked separately in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md). This file should not silently rely on stricter reviewability, validation, or audit behavior than the current implementation provides.

## Normative Terms

- Enforced behavior: a rule currently backed by code validation, denial, normalization, or state-machine handling in this repository.
- Control plane: the deterministic code-owned enforcement boundary for permissions, approvals, scope, provenance, persisted status, evidence normalization, and fail-closed handling.
- Governed procedure surface: a reviewable skill, role guide, prompt template, or reusable task method that may shape execution but is not itself a policy authority unless the contract, evidence schema, active profile, and code make it authoritative.
- Repo-wide policy default: a normative planning, review, approval, or promotion rule for this repository when there is not yet a universal detector-backed runtime gate for that concern. It is authoritative for how work may be proposed, approved, and represented, but it is not a claim that every violation is intercepted automatically at runtime.
- Reviewable success: a terminal result that satisfies both the execution-state rules in this contract and the evidence sufficiency rules in this contract plus [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).
- Truthful interface: a tool, status, approval, or operator-facing surface that states only what current validation, persisted evidence, normalization, and policy actually support.

## Precedence

The harness uses layered authority rather than a doctrine-first override chain:

1. [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md) defines design doctrine and admissible direction. It constrains system shape and promotion decisions, but does not override behavioral or state-machine rules.
2. `HARNESS-CONTRACT.md` is authoritative for behavioral invariants, role semantics, approval floors, denial conditions, and state rules.
3. [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md) is authoritative for inspectability, lineage, and required persisted evidence.
4. [POLICY-PROFILES.md](./POLICY-PROFILES.md) defines valid profile ids, default profile resolution, invalid-profile handling, and the stricter-only profile overlay. Profiles may add stricter denials, narrower permissions, extra approvals, or extra evidence requirements, but may not relax or bypass contract or evidence requirements.
5. Code must enforce the resolved requirements from this contract, the evidence schema, and the active profile. Prompt text, model output, operator intent, and explanatory summaries are never authoritative over them.

## Conflict Rules

If two layers conflict:

- doctrinal language in [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md) and summary language in [OPERATING-GUIDE.md](./OPERATING-GUIDE.md) or `README.md` never widen, narrow, or override behavioral requirements
- behavioral, state, approval, denial, and inspectability conflicts are resolved by the stricter applicable rule from this contract, [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md), or the active policy profile
- active profile resolution must be valid under [POLICY-PROFILES.md](./POLICY-PROFILES.md)
- an implementation is non-conformant if it permits behavior forbidden by this contract, omits required persisted-shape fields, or claims reviewable completion without the evidence required by the evidence schema
- governed procedure surfaces such as skills, prompts, role guidance, and reusable task method may shape execution, but they never widen permissions, scope, approvals, or evidence obligations unless the normative docs and code are updated together
- prompt text and model behavior never override a denial condition

## Completeness Rule

A feature is not promotable unless it is:

- aligned with the principles
- representable within this contract
- observable within the evidence schema
- admissible under at least one policy profile

## Trust Classes

The harness treats inputs and artifacts by trust class, not by source optimism.

| Trust class | Examples | Default treatment |
| --- | --- | --- |
| `operator_input` | command arguments, plain-English build ideas, approval requests | trusted for intent, not for safety or scope expansion |
| `repo_content` | source files, tests, docs, configs in the workspace | trusted as current project context, not as policy authority |
| `generated_plan` | proposal sets, blueprints, execution programs, compiled plans | untrusted until validated against contract schemas and policy |
| `worker_output` | worker summaries, file claims, evidence lists, changed files | untrusted until validated and checked against scope and role rules; selected summary/evidence fields may later be forwarded as worker context |
| `tool_output` | shell output, filesystem reads, test results, adapter responses | evidence-bearing, but still subject to parsing and validation; current process backend may persist truncated stdout/stderr and launcher metadata into evidence |
| `external_content` | network content, MCP/tool connector results, downloaded files | untrusted by default |
| `prior_run_artifact` | persisted run journals, build sessions, cached evidence | trusted only after schema validation and lineage checks |
| `secret_material` | `.env`, credentials, tokens, private keys | protected; never exposed beyond explicitly authorized boundaries |
| `verification_output` | verifier output, review findings, audit reports | evidence-bearing, but not self-authorizing |

## Boundary Crossings

The following crossings are security-relevant and must be explicit:

- `operator_input -> generated_plan`
- `repo_content -> generated_plan`
- `generated_plan -> worker_task`
- `worker_output -> repo_write`
- `tool_output -> evidence_record`
- `prior_run_artifact -> resumed_execution`
- `external_content -> prompt_or_context`
- `secret_material -> tool_or_worker_context`

Every boundary crossing must either be:

- allowed by the contract and active profile
- denied explicitly
- or blocked pending human approval

Current implementation notes:

- `worker_output -> prompt_or_context` also exists in practice: `src/auto-workflow.js` forwards prior worker `summary`, `changedFiles`, `commandsRun`, `evidence`, and `openQuestions`, plus repair-loop `reviewResult`, into later worker context objects.
- Current process-backed prompts in `src/process-worker-backend.js` do not interpolate that forwarded context into prompt text, but `src/pi-worker-runner.js` still passes the context object through the runner and adapter surface.
- `tool_output -> evidence_record` is currently concrete in `src/process-worker-backend.js`, which copies truncated launcher `stdout`/`stderr` and launcher metadata into `evidence[]`; `src/program-runner.js` then persists worker `evidence[]`, normalized `changedSurface`, promoted `providerModelSelections`, and per-contract `providerModelEvidenceRequirement` into `run_journal.contractRuns[]`.
- first-class `providerModelSelections` persistence is a trusted-metadata path only: process-backend typed worker metadata (`result.providerModelSelection`) is promoted only when backend-owned provenance attests trust (`run.provenance.providerModelSelectionTrusted = true`).
- first-class `providerModelEvidenceRequirement` persistence is also a trusted-metadata path only: `src/program-contract-executor.js` derives `required` or `unknown` from backend-owned provenance (`run.provenance.providerModelSelectionTrusted`) and does not derive that requirement from prompt text, role labels, or compatibility `evidence[]` strings.
- No repository-wide redaction or secret-scrubbing pass currently runs across those forwarded or persisted strings. See [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md) for the target redaction hardening track.

## Control-Plane Boundary

This contract treats the control plane as the deterministic enforcement boundary. In the current repository, that boundary is carried by code that validates permissions and scope, binds approval to stored plan identity, persists truthful run and build state, normalizes evidence, and blocks invalid execution.

### Control-Plane Responsibilities

- permissions, read/write capability, and role boundaries
- declared scope, allowlists, forbidden paths, protected-path rejection, and single-writer ownership
- approval binding to the current stored `programId`, `planFingerprint`, resolved `policyProfile`, and currently derived action-class scope
- provenance and lineage across build sessions, execution programs, and run journals
- persistence of approval, execution, and reviewability state in the current stores and journals
- evidence normalization, reviewability normalization, and truthful persisted and operator-visible status surfaces
- fail-closed handling when validation, approval coverage, or persisted state is invalid

Tool and result boundaries should therefore stay narrow, truthful, and predictable. In current v1, the code-enforced pieces of that promise are the validated worker-result surface, persisted artifact normalization, approval binding, and operator summaries grounded in stored evidence.

### Governed Procedure Surfaces

Reusable task method may live in governed skills, role guidance, prompts, or other reviewable procedure surfaces outside the core contract.

- They may shape context assembly, tool use, output structure, or review method.
- They may not widen permissions, expand scope, relax approvals, redefine statuses, or replace required persisted evidence.
- Reusable method does not belong in the contract unless it affects safety, policy, persisted interfaces, or evidence obligations.
- They become contract-relevant only when those concerns are affected and the corresponding normative docs and code are updated together.

## Kernel Invariants

These invariants may not be bypassed by prompts, worker output, or policy profiles.

### Scope and Ownership

- A write-capable worker may write only inside its explicit allowlist.
- Forbidden paths always override allowed paths.
- Protected paths are rejected by the current scope-validation surface; no general protected-path approval override is implemented today.
- Only one write-capable worker may own a file within a single execution step.
- Recursive delegation is denied by default.

### Role Boundaries

- Roles are enforced primarily through permissions, file scope, read/write capability, approval gates, and structured output and evidence obligations.
- The current implementation uses an `orchestrator` role for decomposition, sequencing, integration, and denial decisions.
- `explorer`, `reviewer`, and `verifier` are read-only roles by default.
- `implementer` is the primary write-capable worker role.
- Workers, prompts, and governed procedure surfaces may not redefine role semantics, widen permissions, or relax evidence obligations at runtime.

### Policy and Approval

- Policy enforcement lives in code, not in prompt text.
- High-risk execution requires explicit approval unless a stricter profile denies it entirely.
- Build-scoped approval commands must bind approval to the current stored `programId` plus a concrete `planFingerprint` derived from that stored execution program, and may not authorize action classes outside that bound scope.
- Current approval gating is narrower than the broader schema action-class vocabulary. Today the live gate is primarily the workflow-level high-risk approval check plus the pre-execution approval-scope comparison against the currently derived action-class set for the stored plan.
- A profile may tighten approvals, but may not reduce required approvals below the contract floor.

### Validation

- Lifecycle artifacts must validate before execution.
- Worker results must validate before integration.
- Persisted run artifacts must validate before resume or status sync.
- Invalid structured output fails closed.
- Structured execution and evidence surfaces become authoritative only through current validation and normalization, not through procedural narration alone.
- Current worker-result and persisted-artifact validation is primarily structural. Narrative adequacy such as whether summaries or stop reasons are specific enough for human review remains reviewer guidance in the evidence schema, not a machine-decided contract gate.

### Execution Discipline

- Repair loops are bounded.
- Stop conditions are terminal for the current step unless the state machine explicitly allows resume.
- Missing evidence prevents a reviewer or caller from honestly treating a terminal result as reviewable completion, even when structural persistence succeeds.
- Persisted success may still be stored with `validationArtifacts[].status = not_captured`; that is structurally valid persistence, not reviewable success.

## Action Classes

The harness uses the live action-class surface below for current approval scope and behavioral enforcement.

Persisted artifacts may carry a broader enum defined in [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md), but classes without detector-backed runtime treatment are roadmap items rather than current contract guarantees. See [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md) for planned expansion.

### Implemented Today

These classes currently have concrete enforcement owners or concrete derivation paths in code.

| Action class | Current live treatment | Current grounding |
| --- | --- | --- |
| `read_repo` | included in pre-execution approval scope and post-run evidence | derived prospectively from planned packets and inferred conservatively from role evidence |
| `write_allowed` | included in pre-execution approval scope; permitted only for write-capable roles inside allowlist | derived prospectively for `implementer` packets and enforced by scope validation |
| `write_forbidden` | denied | enforced by allowlist and forbidden-scope checks; surfaced through `scope_violation` evidence |
| `write_protected` | denied by current scope validation surface | protected paths are rejected from declared allowlists and may surface conservatively through `protected_path_violation` evidence |
| `execute_local_command` | included in pre-execution approval scope and persisted evidence | derived prospectively when planned packets declare commands |
| `install_dependency` | included in pre-execution approval scope and persisted run evidence when detector-backed command signals exist | derived from concrete dependency-install command signals in stored-plan command surfaces and explicit run command evidence markers |
| `mutate_git_state` | included in pre-execution approval scope and persisted run evidence when detector-backed command signals exist | derived from concrete git-mutating command signals in stored-plan command surfaces and explicit run command evidence markers |

Current approval behavior over those classes is still narrower than a full action-class gate matrix:

- the live human approval gate is primarily risk-based (`humanGate` or `approvedHighRisk`)
- build approval bindings persist the currently derived action-class set and fail closed if the stored plan drifts outside that scope before execution starts
- current code does not implement mid-run step-level reapproval

## Approval Matrix

The current approval and denial surface is:

| Action class | Current requirement | Implemented today |
| --- | --- | --- |
| `read_repo` | no extra approval | yes |
| `write_allowed` | no extra action-class approval beyond contract authorization; still subject to the workflow high-risk gate when `humanGate = true` | yes |
| `write_forbidden` | denied | yes |
| `write_protected` | denied by current scope validation surface; no approval override path is implemented today | yes |
| `execute_local_command` | no separate action-class approval today; included in the bound approval scope when present in the stored plan | yes |
| `install_dependency` | no separate action-class approval today; included in the bound approval scope when concrete install-command signals are present in the stored plan | yes |
| `mutate_git_state` | no separate action-class approval today; included in the bound approval scope when concrete git-mutation command signals are present in the stored plan | yes |

The current build-approval gate therefore operates over the currently derived plan action-class set, but actual operator approval is still primarily the high-risk execution gate rather than a full per-class runtime approval matrix.

Expansion of the action-class surface beyond the implemented set above is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Build Approval Binding

A build approval record must cover:

- one persisted `buildId`
- the current stored `executionProgram.id` for that build session
- the current stored `planFingerprint` for that build session
- the active policy profile for that execution
- the approved action-class set derived prospectively from the current stored execution program before execution begins

`/build-approve <buildId>` authorizes execution of the currently materialized execution program for that build session only.

It does not authorize:

- future regenerated or materially changed plans whose stored `planFingerprint` differs
- action classes outside the approved action-class set for that stored `programId` and `planFingerprint`
- later escalation from one action class to a stricter one without fresh approval

Before build-session execution begins, the harness must recompute the current stored execution-program `programId`, `planFingerprint`, and pre-execution derived action-class set. If that current scope no longer matches the recorded approval binding, or if the current derived set contains a newly introduced or stricter action class outside the recorded approval scope, the run must block pending fresh approval before execution starts. Approval may therefore be recorded first and then fail closed into `blocked` before any contract runs.

Fresh approval may authorize only the current stored scope that introduced the newly required class or classes. It does not retroactively widen prior approval.

## Correctness Default

Current enforced state and validation rules remain authoritative. The rules below add the repository's default correctness bar for planning, review, and approval.

- Unless a contract explicitly narrows responsibility, a scoped change is correct only if it preserves intended behavior across the happy path, relevant edge cases, invalid-input handling, declared state transitions, retry or recovery paths that the slice can trigger, and rollback, cleanup, or migration behavior when the slice changes stateful effects or persisted artifacts.
- A known unresolved correctness gap inside the approved slice is incompatible with claiming reviewable `success`.
- When a known correctness gap means the current slice cannot safely complete under the active plan, the truthful terminal result is `blocked`, `failed`, or `repair_required` under the existing state rules rather than `success`.

## Preservation Default

The default preservation rule for an approved slice is change what the slice intentionally changes and preserve everything else.

- Contract invariants, role boundaries, approval floors, state enums, and evidence floors must continue to hold.
- Backward compatibility is the default for public behavior, operator-visible behavior, and persisted or data semantics unless the approved slice explicitly changes them.
- Out-of-scope public behavior must remain unchanged.
- Persisted shape and data semantics must not drift silently, even when a file format or schema still validates structurally.

## Durability Target

This section is a repo-wide policy default.

- The minimum acceptable fix is the smallest change that is still correct, preserves required behavior, and should survive the next obvious adjacent change in the same surface.
- A change that only passes the currently observed case while leaving the same visible defect ready to recur on the next adjacent variation does not meet the default durability target.

## Scope Widening And Companion Updates

Current runtime approval binding remains enforced through stored `programId`, `planFingerprint`, and derived action classes. The rules below define what widening is acceptable within that shape and what requires fresh approval or explicit replanning.

- Companion widening is allowed only when it is directly required to keep the approved slice coherent and reviewable, remains inside the same bounded goal and architecture slice, stays within the declared file and action-class scope, and does not silently change out-of-scope public behavior.
- Fresh approval or explicit replanning is always required when widening changes the stored plan identity, introduces a newly required or stricter action class, expands into new protected or forbidden scope, changes persisted or data semantics beyond the already approved slice, or changes public or operator-facing behavior beyond what the current slice already says it is changing.
- If a slice changes behavior, schema, or operator-visible surface, same-slice companion updates are required by repo-wide policy default. The slice must include the nearby validation, operator-facing wording, compatibility handling, and documentation updates needed to keep that changed surface truthful as one coherent change.

## Evidence Required For `success`

- `success` in the current state machine means all contracts completed with no terminal non-success result.
- Reviewable `success` requires that terminal `success` state plus enough direct evidence to inspect what was approved, what ran, what was validated, and what remains uncertain.
- Current v1 persists a narrow machine reviewability summary (`reviewability.status` and `reviewability.reasons[]`) on run and build execution artifacts. That summary is authoritative for the machine-checkable surface, not for every reviewer judgment.
- The following must be directly evidenced in persisted artifacts when they are applicable to the claim being made: terminal status and completed-contract state, the approval binding and active `policyProfile` when approval was required, captured validation evidence for validations actually exercised, the concrete source of any blocked, failed, or repair-required outcome, and lineage linking the build session, execution program, and run journal.
- Evidence and reviewability surfaces are part of the runtime contract. Persisted artifacts and operator-facing summaries must distinguish observed execution facts from planned scope, normalized inference, or not-captured evidence.
- The following may be inferred conservatively from current normalization or repository-local backend context: normalized `stopReasonCode`, normalized `validationOutcome`, conservative `actionClasses`, and whether provider or model evidence should have existed for that run.
- Acceptable inference may classify or summarize directly persisted evidence. It may not replace missing required direct evidence.
- If reviewable evidence is incomplete, current v1 may still persist a structurally valid terminal artifact, including persisted `success` with `validationArtifacts[].status = not_captured`. That artifact is persisted state, not reviewable `success`.
- Missing reviewable evidence does not by itself rewrite a structurally persisted terminal status to `blocked`, `failed`, or `repair_required` after the fact. It instead limits what the control plane, reviewer, or caller may truthfully claim about that terminal state.
- When an evidence gap is known while the run is still `running` and a repair or verification path exists inside the active plan, the orchestrator should spend that path before terminalizing.

## Forbidden Shortcuts

These are repository policy defaults. They may not be justified by time pressure, diff size, or a locally green result.

- Do not weaken, remove, or skip validation merely to make the current slice pass, unless the approved change explicitly changes that validation contract itself.
- Do not allow silent contract drift between the declared slice, implemented behavior, persisted evidence, and operator-facing description.
- Do not ship a symptom-only patch when the underlying cause is already visible and can be addressed safely within the current slice.
- Do not treat added controller complexity, routing stages, or reusable procedure inside the control plane as a substitute for explicit permissions, approvals, validation, or evidence.
- Do not treat increased apparent autonomy as a gain if inspectability, reviewability, or control boundaries get weaker.
- Do not widen scope silently, including companion changes that materially alter behavior, schema, or operator surface without making that widening explicit in the same slice or obtaining fresh approval.

## Approval Roles

Current runtime code persists an operator-facing approval binding. The role boundary below is the authoritative repository policy default for what that approval does and does not mean.

- `operator_approval` means approval to execute the current stored scope identified by `buildId`, `programId`, `planFingerprint`, resolved `policyProfile`, and the currently derived approval action-class set. In current code, `build_session.approval` is the persisted evidence of that approval surface.
- `operator_approval` authorizes execution of the stored scope. It is not, by itself, evidence that the resulting change is technically sound, durable, or merge-grade.
- `technical_approval` means a technically competent reviewer accepts the slice's correctness, preservation impact, evidence sufficiency, and hazard tradeoffs for the claimed outcome.
- A zero-coding operator may be sufficient for `operator_approval` when the live gate requests operator consent. A zero-coding operator alone is not sufficient `technical_approval` for technically hazardous work.
- Technically hazardous work includes, at minimum, changes to approval semantics, policy enforcement, state machines, persisted artifact schemas or data semantics, dependency or migration behavior, and operator-visible behavior whose failure would materially misstate scope, correctness, or safety.
- Current v1 does not persist a first-class `technical_approval` artifact or runtime gate. Treat this section as a repo-wide policy default for review and promotion, not as a claim of broader machine enforcement than the code currently provides. Future operator-safe profile work is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Orchestrator Contract

The current implementation uses an orchestrator surface to carry the control-plane duties below. At contract level, the point of this surface is deterministic control and truthful state, not controller complexity.

The orchestrator should stay thin and deterministic. A strong control plane is not a reason to accumulate reusable method or controller choreography in this layer unless doing so materially improves policy enforcement, context quality, evidence quality, reviewability, or operator clarity.

The orchestrator is responsible for:

- defining bounded goals
- producing lifecycle artifacts and compiled execution plans
- assigning roles
- assigning file scope
- applying risk classification and human-gate logic
- deciding whether a run continues, blocks, fails, repairs, or succeeds
- integrating validated worker results
- persisting truthful status, approval, lineage, and execution-evidence surfaces through the current stores and journals

The orchestrator may not:

- silently widen scope after planning
- bypass required approvals
- treat governed procedure or prompt instructions as stronger than contract invariants
- claim changed scope, approval coverage, or reviewability that persisted evidence does not support
- accept malformed worker output as success

## Worker Contract

Every worker invocation must receive a bounded task envelope that includes:

- task id
- assigned role
- bounded goal
- allowed files
- forbidden files
- non-goals
- acceptance checks
- stop conditions
- optional context files
- explicit risk level

Workers must obey all of the following:

- they may act only within the provided scope
- they may not self-expand file access
- they may not redefine the goal
- they may not recursively delegate unless the contract explicitly allows it
- they may return `success`, `blocked`, `failed`, or `repair_required`
- `repair_required` from independent review means the scoped output needs repair before the workflow can succeed
- a review-triggered repair attempt, when budget remains, happens inside the enclosing `running` program run rather than through a separate persisted repair state
- they may request clarification only by returning structured open questions or blocked output
- they may not present free-form narrative as a substitute for structured result fields
- reusable procedure may shape how they work, but it does not widen role power or reduce output and evidence obligations

Worker result fields must be valid and complete before integration.

## State Machines

### Program Run State Machine

Closed enum:

- `running`
- `success`
- `blocked`
- `failed`
- `repair_required`

Allowed transitions:

| From | To | Condition |
| --- | --- | --- |
| `running` | `running` | additional contract progress recorded |
| `running` | `success` | all contracts completed with no terminal non-success result; see [Evidence Required For `success`](#evidence-required-for-success) for reviewable-success evidence rules |
| `running` | `blocked` | stop condition, denial condition, or unresolved precondition |
| `running` | `failed` | execution error or invalid execution result |
| `running` | `repair_required` | independent review still requires repair after the allowed repair budget is exhausted, or no repair loop is available to spend |
| `success` | `success` | return-existing only |
| `blocked` | `blocked` | original run is terminal for normal execution; a later resume attempt is rejected and may return a fresh blocked refusal artifact |
| `failed` | `blocked` | original run is terminal for normal execution; a later resume attempt is rejected and may return a fresh blocked refusal artifact instead of continuing the failed run |
| `repair_required` | `blocked` | original run is terminal for normal execution; a later resume attempt is rejected and may return a fresh blocked refusal artifact instead of continuing the repair-required run |

Resume policy:

- `running` is resumable
- `success` returns the existing result
- `blocked`, `failed`, and `repair_required` are terminal for normal execution

Clarifying note:

- the harness does not expose a separate run-level repair substate
- when review requests repair and budget remains, the orchestrator performs the repair loop while the run stays `running`
- the run reaches terminal `repair_required` only after the configured repair budget is exhausted or unavailable
- a resume attempt against a persisted terminal run does not continue that run; current implementation returns a new `blocked` refusal artifact with a resume-rejection reason

### Build Session State Machine

Closed enum:

- `awaiting_approval`
- `approved`
- `running`
- `success`
- `blocked`
- `failed`
- `repair_required`

Allowed transitions:

| From | To | Condition |
| --- | --- | --- |
| `awaiting_approval` | `approved` | explicit operator approval recorded |
| `approved` | `blocked` | pre-execution approval binding or action-class coverage validation fails or throws before any contract run starts |
| `approved` | `running` | execution begins |
| `running` | `success` | linked program run succeeds |
| `running` | `blocked` | linked program run blocks |
| `running` | `failed` | linked program run fails |
| `running` | `repair_required` | linked program run ends terminal repair-required after the in-run repair budget is exhausted or unavailable |
| `success` | `success` | inspection only |
| `blocked` | `blocked` | inspection only |
| `failed` | `failed` | inspection only |
| `repair_required` | `repair_required` | inspection only; linked program run already terminated after review-triggered repair could not continue |

Transition guards:

- no execution may begin from `awaiting_approval` without recorded approval
- recorded approval must bind to the current stored execution program `programId`, `planFingerprint`, and approved action classes
- execution must block before start when the current pre-execution derived action-class set contains a class outside the recorded approval scope
- `approved` records that approval was captured for the current stored scope; it does not guarantee execution has started yet
- `approved -> blocked` is the required fail-closed path when the pre-execution gate revalidates scope and finds drift, invalid approval metadata, or other approval-coverage errors before execution starts, including gate failures surfaced as thrown errors
- linked program identifiers must match the execution program being run
- build-session execution status must not contradict the linked run journal after synchronization

## Fail-Closed Rules

The harness must deny or block when:

- a scope path is malformed
- allowed and forbidden scopes overlap unsafely
- the allowlist is empty for a write-capable action that requires it
- a worker attempts to write outside scope
- a read-only role changes files
- a lifecycle artifact fails validation
- a worker result fails validation
- a persisted run artifact fails validation
- approval is required but absent
- the active policy profile is missing, ambiguous, or invalid under [POLICY-PROFILES.md](./POLICY-PROFILES.md)
- the current stored plan requires action classes outside the recorded approval scope before execution begins
- evidence required for a claimed reviewable terminal state is missing

## Policy Profile Validity

Valid profile ids, default profile behavior, stricter-only overlay rules, and invalid-profile handling are defined in [POLICY-PROFILES.md](./POLICY-PROFILES.md).

A run is non-conformant if it executes under an unresolved or invalid profile.

## Promotion Gate

A feature should not be promoted into the main harness unless all of the following are true:

1. It is consistent with [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md).
2. It preserves all invariants and state rules in this contract.
3. It is fully representable in [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).
4. It is valid under at least one policy profile without weakening this contract.
5. Any added orchestration materially improves policy enforcement, context quality, evidence quality, reviewability, or operator clarity.
6. It does not trade stronger apparent autonomy for weaker inspectability, reviewability, or control boundaries.
