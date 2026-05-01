# Rebuild Guide

This document is for a deliberate teardown and rebuild of the harness.

It is not a roadmap for incremental hardening. It is the reference for rebuilding the system around the same core idea with cleaner boundaries.

The goal is not to preserve current code. The goal is to preserve the parts of the idea that make the harness useful:

- bounded task execution
- code-owned scope and approval controls
- narrow worker roles
- truthful evidence
- clean stop states
- reviewable output

If rebuilding from scratch, use this guide before writing code.

For the concrete first-pass implementation order, use
[IMPLEMENTATION-SEQUENCE.md](./IMPLEMENTATION-SEQUENCE.md). That document
keeps schema validation, path safety, persistence, worker backends, templates,
and `/build` in the intended order.

## Rebuild Thesis

The harness should be a small deterministic execution kernel with optional planning layers around it.

The kernel answers:

- What is the bounded task?
- What files may be read or written?
- Which worker role is allowed to act?
- What ran?
- What changed?
- What evidence was captured?
- Why did execution continue or stop?

Everything else is a consumer of that kernel, not part of the kernel itself.

That includes:

- operator intake
- `/build`
- project lifecycle planning
- template selection
- template generation
- rich summaries
- governed skills
- non-technical operator mode

Those features may be valuable, but they should not make the execution kernel harder to reason about.

## Keep The Core Idea Small

The core harness should fit in a short mental model:

1. Normalize operator intent into a bounded task or execution program.
2. Validate scope, risk, lane, approvals, and policy profile.
3. Launch one scoped worker packet at a time.
4. Enforce read-only versus write-capable role behavior.
5. Admit only validated worker results.
6. Persist status, changed surface, command evidence, validation evidence, and stop reasons.
7. Fail closed when scope, approval, context, or evidence cannot be trusted.

If a proposed component does not directly serve one of those steps, put it outside the kernel.

## Non-Negotiable Invariants

Do not rebuild without these invariants.

### Scope

- Write-capable workers need explicit allowlists.
- Forbidden paths override allowed paths.
- Protected paths are denied by default.
- One write-capable worker owns a file within a single execution step.
- Runtime output cannot widen scope.
- Companion widening requires explicit plan or approval treatment.

### Roles

- Roles are capability envelopes, not personalities.
- `explorer`, `reviewer`, and `verifier` are read-only by default.
- `implementer` is the primary write-capable role.
- No recursive delegation by default.
- Role prompts and skills cannot change role permissions.

### Approvals

- Approval must bind to a concrete stored plan identity.
- Approval must include the derived action-class scope it covers.
- Approval must not authorize future replans.
- High-risk or review-gated work must not execute without an approval path.
- Operator approval is not technical approval.

### Evidence

- Success is not reviewable unless the evidence supports it.
- Persisted status must distinguish `success`, `blocked`, `failed`, and `repair_required`.
- Command evidence should be typed where possible.
- Changed-surface evidence must distinguish observed paths from planned scope.
- Provider/model selection should be captured when a model-backed worker path runs.
- Missing evidence should be visible, not hidden by formatter optimism.

### Failure

- Invalid input fails closed.
- Invalid worker output fails closed.
- Runtime context drift fails closed.
- Persisted state drift fails closed.
- Unknown policy profile fails closed.
- Missing sandbox or unsupported process confinement must block if the run claims to require it.

## Desired Architecture

Use layers with explicit ownership.

### Layer 1: Kernel

Owns deterministic execution and truth.

Recommended modules:

- task packet contract
- worker result contract
- scope and path safety
- risk and lane classification
- approval binding
- policy profile resolution
- runner interface
- process or native worker adapter boundary
- changed-surface observation
- evidence normalization
- run journal persistence
- state machine

The kernel should not know how to brainstorm a project, pick a product architecture, or write an operator-friendly sales pitch.

### Layer 2: Execution Programs

Owns multi-step sequencing over the kernel.

Recommended responsibilities:

- compile bounded contracts into worker packets
- enforce dependencies
- run contracts in order
- persist contract-run evidence
- resume only valid running journals
- reject terminal resume attempts truthfully

This layer may know about contracts and dependencies. It should not know about every project type.

### Layer 3: Planning And Templates

Owns project-specific planning.

Recommended responsibilities:

- detect project facts from a brief or spec
- resolve a trusted template or compose one from fragments
- generate execution contracts
- explain missing template coverage

This layer must be pluggable. A bad template should not endanger the kernel.

### Layer 4: Operator Surfaces

Owns human-facing command UX.

Recommended responsibilities:

- plain-English intake
- status summaries
- approval prompts
- blocked-result guidance
- non-technical operator wording

Operator surfaces should render persisted truth. They should not invent truth.

## What To Avoid

Avoid rebuilding the current bloat under cleaner filenames.

### Avoid Thick Orchestrators

Do not centralize reusable task method in one giant controller.

Bad signs:

- one file owns parsing, planning, execution, approval, persistence, and formatting
- new project types require new controller branches
- success depends on prompt prose rather than code-owned validation
- lifecycle stages are added because they sound sophisticated, not because they reduce review burden

### Avoid Prompt-Owned Policy

Prompts can tell workers what to do. They cannot be the policy boundary.

Never rely on prompt text to enforce:

- file scope
- write permission
- approval requirements
- protected paths
- role semantics
- evidence requirements

### Avoid Generic Planning That Pretends To Be Specific

If the harness cannot distinguish an iOS SwiftUI app from a web app, it should say so.

Bad output for an iOS app:

- `package.json`
- `src/`
- `public/`
- `npm install`
- `npm test`

The correct result is either:

- a trusted iOS template or composed template, or
- a blocked `template_missing` style result with a path to create one.

### Avoid Formatter-Only Truth

If something matters for review, store it in typed evidence before formatting it.

Do not make operator summaries smarter than the persisted artifacts.

### Avoid Unlimited Schema Vocabulary

Only promote action classes and evidence fields when there is a detector, owner, test, and review meaning.

Vocabulary without enforcement creates false confidence.

### Avoid Ignoring WIP Limits

Rebuild sequencing should keep work in progress narrow enough to review.

Default limits:

- one active Work Order per repository during early rebuild
- no model-backed worker complexity before schema, path safety, artifact store,
  and deterministic loop are working
- no template/operator UX expansion before the kernel can emit truthful Evidence
  Packs
- no broad refactor while verification commands are placeholders

These are operator/rebuild defaults, not permanent kernel invariants.

## Template System Direction

The rebuild should not store only monolithic project templates.

Prefer a composable fragment library.

Example fragments:

- `git-repository`
- `ios-xcode-project`
- `swift-language`
- `swiftui-app`
- `swiftdata-persistence`
- `cloudkit-private-database`
- `local-notifications-ios`
- `xcodebuild-verification`
- `xctest-unit-tests`
- `offline-first-personal-data-app`

Each fragment should declare:

- `id`
- lifecycle state: `candidate`, `reviewed`, or `trusted`
- detection signals
- required evidence from the spec
- repo layout contributions
- execution phase contributions
- verification command contributions
- incompatible fragments
- required companion fragments
- risk notes
- fixture coverage

Template composition should be deterministic:

1. Extract project facts from the brief/spec.
2. Match trusted fragments.
3. Resolve required companion fragments.
4. Reject incompatible combinations.
5. Compose repo layout, phases, and verification commands.
6. Validate the composed template.
7. Produce a dry plan before execution.

Agents may propose missing fragments, but code validates and promotes them.

## Agent Roles In A Rebuild

Use stronger models for judgment, not as hidden authority.

Good agent uses:

- extract project facts from a spec with source references
- propose a candidate fragment
- compare two template compositions
- identify missing evidence
- review a bounded plan
- explain why a run should block

Bad agent uses:

- decide runtime policy without code validation
- silently create a project template during `/build` execution
- widen file scope from prose
- approve its own plan
- claim evidence that was not persisted

The deciding rule is simple: agents can recommend; code authorizes.

## Agent-Readable Infrastructure

The harness should be easy for agents to consume without giving agents
authority.

Prefer:

- Markdown source maps and source manifests
- copyable CLI examples
- structured validation errors
- machine-readable Work Order and Evidence Pack examples
- short repo maps and role packet contracts
- `llms.txt`-style summaries when useful

Kernel-adjacent pieces such as source manifests and validation output should be
typed and testable. Support docs such as `llms.txt` summaries are operator
infrastructure and must not become policy authority.

## Rebuild Stages

### Stage 0: Freeze Current Lessons

Before deleting code, preserve:

- current contract docs
- evidence schema lessons
- process-backend safety lessons
- tests that encode real failure modes
- role skill output contracts
- examples of good and bad planning output

Do not preserve implementation shape just because tests exist.

### Stage 1: Minimal Kernel

Build only:

- `TaskPacket`
- `WorkerResult`
- scope/path validation
- role capability rules
- approval binding model
- runner interface
- run journal state machine
- evidence normalization

No `/build`.
No lifecycle planning.
No project templates.
No rich summaries.

Acceptance gate:

- a scoped single-file edit can run
- a read-only role cannot write
- an out-of-scope write blocks
- invalid worker output blocks
- a run journal records status, evidence, and stop reason

### Stage 2: Worker Backend

Add one real worker path.

Preferred first path:

- process-backed worker with isolated workspace
- allowlist apply
- changed-surface observation
- provider/model evidence
- sandbox policy or explicit observation-only evidence

Acceptance gate:

- implementer writes only allowed files
- read-only workers fail on writes
- no-op implementer success is not accepted without evidence
- launcher failures become blocked or failed evidence

### Stage 3: Execution Programs

Add multi-contract execution over the kernel.

Acceptance gate:

- dependencies execute in order
- blocked contract stops the program
- resume continues only running journals
- terminal journals do not resume
- approval binding persists through program execution

### Stage 4: Basic Operator Surface

Add thin commands:

- `plan_workflow`
- `run_auto_workflow`
- `run_execution_program`
- `resume_execution_program`
- `workflow_status`

Keep text formatting minimal.

Acceptance gate:

- every command returns structured details first
- human text is a rendering of structured details
- blocked results include the next concrete action

### Stage 5: Template Fragment System

Add project planning only after the kernel is stable.

Acceptance gate:

- unknown project archetype blocks honestly
- known fragments compose deterministically
- fixture specs snapshot expected layout and commands
- iOS SwiftUI fixture produces Xcode/Swift paths, not Node/web paths

### Stage 6: `/build`

Add `/build` last.

`/build` should:

- parse plain-English intent
- resolve or compose a trusted template
- create a stored plan
- present approval scope
- execute only after approval
- block on missing templates or unsafe ambiguity

Acceptance gate:

- `/build` is a consumer of the kernel and template layer
- deleting `/build` would not delete the execution kernel
- `/build` never invents untrusted project templates at runtime

## Testing Rules

Tests should protect behavior, not the current architecture.

Required fixture classes:

- good low-risk scoped edit
- high-risk approval required
- read-only worker attempted write
- implementer out-of-scope write
- protected path in allowlist
- invalid worker JSON
- no changed-surface evidence
- process launcher failure
- runtime unavailable
- terminal resume rejected
- template missing
- iOS SwiftUI template composition
- generic web app template composition
- model/role/context regression fixtures
- missing authority fixture
- ambiguous context fixture
- patch budget overrun fixture
- counterexample-review required fixture
- human-review required fixture
- rollback/recovery required fixture

For planning/template tests, snapshot the important outputs:

- repo layout
- contract ids
- scope paths
- verification commands
- rejected/deferred features
- detected project facts

Do not snapshot verbose prose unless the prose is itself the contract.

Agent evaluation fixtures should be saved Work Orders and expected Evidence Pack
properties, not prompt-vibe comparisons. They should cover model routing, role
packets, context truncation, scope violations, missing authority, failed
verification, bounded repair, and reviewer findings that cannot be repaired in
scope.

## Documentation Rules

Keep documentation split by authority.

- Principles: why the harness exists and what direction fits.
- Contract: current enforced behavior only.
- Evidence schema: persisted artifacts and reviewability rules.
- Operating guide: how to use the current implementation.
- Rebuild guide: how to tear down and rebuild without losing the core.
- Roadmap: future hardening that is not yet enforced.

When rebuilding, do not write target-state promises into the contract until code and tests enforce them.

## Workflow Failure Postmortem Loop

Meaningful workflow failures should create at least one durable improvement:

- schema change
- validation rule
- fixture
- role packet change
- template change
- quality-control update
- documentation correction

Do not solve repeated failures by making agents more autonomous before context,
scope, evidence, and validation improve.

## Deletion Guidance

During a teardown, it is acceptable to delete large surfaces if their lessons are preserved elsewhere.

Likely candidates to move out of the kernel:

- generic lifecycle planning
- `/build` operator session logic
- rich operator formatting
- project templates
- skill governance
- broad action-class vocabulary without detector-backed enforcement

Do not delete before preserving:

- safety invariants
- state machines
- evidence rules
- failure fixtures
- process-backend apply and changed-surface lessons

## Decision Checklist

Before adding a feature to the rebuilt core, answer:

1. Does this enforce scope, approval, evidence, or state truth?
2. Would the kernel be unsafe or misleading without it?
3. Can it be represented in typed artifacts?
4. Can it fail closed?
5. Can it be tested without relying on model behavior?
6. Does it reduce review burden?
7. Does it belong in the kernel, or can it live in a plugin/planning layer?

If the answer to 7 is "plugin/planning layer", keep it out of the kernel.

## Minimal Success Definition

A successful rebuild is not one that has the most commands.

A successful rebuild can:

- run a bounded task
- enforce file scope
- separate read-only and write-capable roles
- capture evidence
- persist a truthful run journal
- resume only valid in-progress work
- block unknown or unsafe conditions
- explain what happened without trusting model narration

Only after that should it grow project planning, templates, and `/build`.
