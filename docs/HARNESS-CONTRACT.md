# Harness Contract

This document defines the normative operating contract for the harness.

Unlike [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md), this file is not a doctrine layer. It is a behavioral contract. It should be reviewed like an interface specification.

## Scope

This contract defines:

- trust classes and boundary crossings
- precedence and conflict rules
- kernel invariants
- action classes and default approval policy
- orchestrator and worker responsibilities
- run state machines
- fail-closed rules

## Conformance Status

This is the v1 normative contract for the repository.

Current code already conforms to parts of it, especially:

- role separation
- bounded worker scopes
- read-only versus write-capable roles
- explicit run and build-session statuses
- persisted run journals and build sessions
- approval gating for high-risk execution

Other sections are intentionally stricter than the current code and should be treated as the target contract for future hardening work. A code path is non-conformant if it violates a rule in this file, even if that violation is not yet fully prevented in implementation.

## Precedence

The harness is governed by this precedence order:

1. [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md) defines design intent and admissible direction.
2. `HARNESS-CONTRACT.md` defines mandatory behavioral invariants and denial conditions.
3. [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md) defines mandatory inspectability and artifact requirements.
4. Policy profiles may add stricter constraints, narrower permissions, and extra approvals, but may not weaken or bypass contract or evidence requirements.
5. Code must enforce all active requirements above. Prompt text, model output, and operator intent are never authoritative over them.

## Conflict Rules

If two layers conflict:

- the stricter rule wins
- a profile is invalid if it permits behavior forbidden by this contract
- an implementation is non-conformant if it permits behavior forbidden by this contract or omits required evidence defined by the evidence schema
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
| `worker_output` | worker summaries, file claims, evidence lists, changed files | untrusted until validated and checked against scope and role rules |
| `tool_output` | shell output, filesystem reads, test results, adapter responses | evidence-bearing, but still subject to parsing and validation |
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

## Kernel Invariants

These invariants may not be bypassed by prompts, worker output, or policy profiles.

### Scope and Ownership

- A write-capable worker may write only inside its explicit allowlist.
- Forbidden paths always override allowed paths.
- Protected paths may not be written without an explicit contract and approval path that permits them.
- Only one write-capable worker may own a file within a single execution step.
- Recursive delegation is denied by default.

### Role Boundaries

- `orchestrator` owns decomposition, sequencing, integration, and denial decisions.
- `explorer`, `reviewer`, and `verifier` are read-only roles by default.
- `implementer` is the primary write-capable worker role.
- Workers may not redefine role semantics at runtime.

### Policy and Approval

- Policy enforcement lives in code, not in prompt text.
- High-risk execution requires explicit approval unless a stricter profile denies it entirely.
- Approval may widen nothing except the specific denied action class it authorizes.
- A profile may tighten approvals, but may not reduce required approvals below the contract floor.

### Validation

- Lifecycle artifacts must validate before execution.
- Worker results must validate before integration.
- Persisted run artifacts must validate before resume or status sync.
- Invalid structured output fails closed.

### Execution Discipline

- Repair loops are bounded.
- Stop conditions are terminal for the current step unless the state machine explicitly allows resume.
- Missing evidence is a block condition for reviewable completion.

## Action Classes

The harness reasons about permissions by action class.

| Action class | Description | Default policy |
| --- | --- | --- |
| `read_repo` | read files inside the workspace | allow |
| `read_protected` | read protected files or secret-adjacent files | allow-with-approval or deny by profile |
| `write_allowed` | write files inside the explicit allowlist | allow for write-capable roles only |
| `write_forbidden` | write files outside allowlist or inside forbidden scope | deny |
| `write_protected` | write protected paths such as secrets, generated outputs, or restricted dirs | deny unless explicitly approved and profiled |
| `execute_local_command` | run local commands within the workspace | allow in bounded environment |
| `install_dependency` | add or change dependencies or lockfiles | allow-with-approval unless profile tightens |
| `mutate_git_state` | commit, branch, rebase, stage, reset, open PR | allow-with-approval; destructive git operations default deny |
| `access_network` | reach external network resources | deny by default unless profile allows |
| `access_connector` | use external tools, MCP servers, hosted connectors | deny by default unless profile allows |
| `access_secret` | read, pass, or reveal credentials or secret material | deny unless explicitly approved and profiled |
| `irreversible_side_effect` | deploy, publish, delete data, migrate schema, external mutation | deny or allow-with-approval depending on profile; never implicit |
| `recursive_delegate` | spawn nested workers beyond contract shape | deny |

## Approval Matrix

The approval floor for each action class is:

| Action class | Default requirement |
| --- | --- |
| `read_repo` | no approval |
| `read_protected` | explicit approval unless stricter profile denies |
| `write_allowed` | no extra approval beyond contract authorization |
| `write_forbidden` | denied |
| `write_protected` | explicit approval and profile support |
| `execute_local_command` | no extra approval in bounded environment |
| `install_dependency` | explicit approval |
| `mutate_git_state` | explicit approval |
| `access_network` | explicit approval and profile support |
| `access_connector` | explicit approval and profile support |
| `access_secret` | explicit approval and profile support |
| `irreversible_side_effect` | explicit approval and profile support |
| `recursive_delegate` | denied |

## Orchestrator Contract

The orchestrator is responsible for:

- defining bounded goals
- producing lifecycle artifacts and compiled execution plans
- assigning roles
- assigning file scope
- applying risk classification and human-gate logic
- deciding whether a run continues, blocks, fails, repairs, or succeeds
- integrating validated worker results

The orchestrator may not:

- silently widen scope after planning
- bypass required approvals
- treat prompt instructions as stronger than contract invariants
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
- they may request clarification only by returning structured open questions or blocked output
- they may not present free-form narrative as a substitute for structured result fields

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
| `running` | `success` | all contracts completed and validation passed |
| `running` | `blocked` | stop condition, denial condition, or unresolved precondition |
| `running` | `failed` | execution error or invalid execution result |
| `running` | `repair_required` | independent review requires repair and repair budget remains governed |
| `success` | `success` | return-existing only |
| `blocked` | `blocked` | terminal; may be inspected but not resumed |
| `failed` | `failed` | terminal; may be inspected but not resumed |
| `repair_required` | `repair_required` | terminal unless a future contract revision explicitly changes this |

Resume policy:

- `running` is resumable
- `success` returns the existing result
- `blocked`, `failed`, and `repair_required` are terminal

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
| `approved` | `running` | execution begins |
| `running` | `success` | linked program run succeeds |
| `running` | `blocked` | linked program run blocks |
| `running` | `failed` | linked program run fails |
| `running` | `repair_required` | linked program run returns repair-required |
| `success` | `success` | inspection only |
| `blocked` | `blocked` | inspection only |
| `failed` | `failed` | inspection only |
| `repair_required` | `repair_required` | inspection only |

Transition guards:

- no execution may begin from `awaiting_approval` without recorded approval
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
- a requested action class is not permitted by the active profile
- evidence required for the current terminal state is missing

## Invalid Profile Conditions

A policy profile is invalid if it:

- permits an action class denied by this contract
- weakens an approval floor defined by this contract
- disables required evidence capture
- allows prompts or worker output to override contract invariants

## Promotion Gate

A feature should not be promoted into the main harness unless all of the following are true:

1. It is consistent with [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md).
2. It preserves all invariants and state rules in this contract.
3. It is fully representable in [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).
4. It is valid under at least one policy profile without weakening this contract.
