# Hardening Roadmap

This document tracks future-facing contract, policy, evidence, and operator-mode hardening that is not yet fully enforced in the current repository.

It is intentionally separate from the normative docs:

- [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md) describes current behavioral requirements and repo-wide policy defaults that are authoritative today.
- [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md) describes the current persisted evidence and reviewability surface.
- [POLICY-PROFILES.md](./POLICY-PROFILES.md) describes the currently enforced profile-resolution surface.
- [OPERATING-GUIDE.md](./OPERATING-GUIDE.md) explains how to operate the current harness.

Use this file for target-state hardening only. Nothing here should be read as current enforcement unless and until the normative docs and code are updated together.

## Current Baseline

Today the repository has a narrower live enforcement surface than the long-term policy vocabulary:

- approval is primarily the workflow high-risk gate plus pre-execution scope checks against the stored plan's currently derived action-class set
- persisted `actionClasses` are plan-derived scope or conservative post-run evidence, not a full detector-backed audit trail
- runtime profile resolution is effectively `default` only
- reviewability now has a narrow machine-decided persisted surface (`reviewability.status` plus explicit reason codes), but it is intentionally limited to what current evidence can prove
- persisted evidence does not yet pass through a repository-wide redaction pipeline before storage or later worker-context forwarding

The roadmap below tracks the hardening work needed to move beyond that baseline.

## Target Contract Surface

### Stronger Action-Class Detection And Enforcement

Current gap:

- only `read_repo`, `write_allowed`, `write_forbidden`, `write_protected`, `execute_local_command`, `install_dependency`, and `mutate_git_state` have live contract treatment with concrete derivation or enforcement owners
- the broader vocabulary already exists in persisted evidence, but most classes are not first-class runtime gates

Hardening target:

- promote `read_protected`, `access_network`, `access_connector`, `access_secret`, and `irreversible_side_effect` from vocabulary-only status into detector-backed runtime policy surfaces
- define one code owner or derivation path per class
- make approval, denial, and evidence semantics explicit per class
- prevent target-only classes from appearing to be enforced until detector owners and tests exist

Landing condition:

- the contract can describe each live action class as enforced behavior rather than as roadmap intent
- approval records and terminal evidence can distinguish requested, approved, observed, and denied classes without relying on narrative inference alone

### Mid-Run Reapproval

Current gap:

- approval binding is checked before execution starts
- the repository does not implement step-level reapproval when later execution would cross into a stricter class or materially wider scope

Hardening target:

- add step-level or packet-level reapproval when a running plan would newly require a stricter action class or materially different approval scope
- fail closed before the higher-risk step executes
- persist the escalation reason and the blocked step boundary

Landing condition:

- widened authority inside a running workflow cannot proceed on stale approval
- persisted evidence shows which step triggered reapproval and why

### Machine-Decidable Reviewability

Current gap:

- structural validation is stronger than narrative adequacy validation
- the new persisted reviewability surface is intentionally narrow and does not replace deeper reviewer judgment
- provider/model evidence requirements are still partially inferred; there is no first-class persisted `providerModelEvidenceRequired` field

Hardening target:

- deepen machine-checkable gates where evidence is strong enough while keeping fail-closed semantics
- preserve the explicit separation between structural validity and reviewability
- promote selected currently narrative-only checks into deterministic validators where the evidence model is strong enough

Landing condition:

- the repository can distinguish `persisted`, `structurally valid`, and `reviewable` states without relying on undocumented reviewer convention

## Target Schema And Evidence Surface

### Approval And Reviewability Artifacts

Current gap:

- approval evidence is embedded in `build_session`
- there is no first-class persisted `approval_record`
- there is no first-class persisted `providerModelEvidenceRequired` field

Hardening target:

- add immutable approval artifacts or equivalent first-class approval lineage
- extend reviewability evidence requirements only where current machine checks are still too implicit
- preserve backward-compatible linkage between `build_session`, `persisted_run_record`, and the linked approval surface

Landing condition:

- approval lineage and reviewability state are inspectable without reconstructing intent from mixed embedded fields and backend conventions

### Provider/Model And Execution Evidence Gating

Current gap:

- provider/model facts live mainly as evidence strings emitted by the process backend
- there is no authoritative persisted field saying whether provider/model evidence was required for a given run

Hardening target:

- promote provider/model selection into first-class persisted evidence when model-backed execution is part of the review claim
- record whether provider/model evidence was required, captured, or missing
- make evidence requirements backend-aware without overstating universal coverage

Landing condition:

- success reviewability no longer depends on informal inference about whether backend-emitted provider/model fields should have been present

### Richer Structured Evidence Surfaces

Current gap:

- command, diff, review, and cost evidence still rely heavily on string-keyed `evidence[]`, narrative summaries, or formatter output

Hardening target:

- introduce first-class artifacts or embedded shapes for command logs, diff ownership, structured review findings, and cost records where those surfaces become approval- or review-critical
- keep current evidence-string conventions only as compatibility shims once first-class fields exist

Landing condition:

- critical review questions can be answered from typed evidence rather than from mixed free-form summaries

### Redaction And Trust-Boundary Hardening

Current gap:

- persisted evidence and forwarded worker context do not pass through a repository-wide redaction layer
- raw tool output, launcher text, workspace paths, and worker summaries can cross persistence or later-context boundaries unredacted

Hardening target:

- add a repository-wide redaction and secret-scrubbing pipeline for persisted evidence, forwarded worker context, and stored tool output
- classify which fields may store raw text, hashed references, summaries, or redacted payloads
- preserve enough evidence for reviewability without depending on raw secret-bearing material

Landing condition:

- stronger review claims can rely on persisted evidence without assuming upstream callers already scrubbed sensitive material correctly

## Target Approval And Policy Surface

### Richer Runtime Profile Enforcement

Current gap:

- runtime profile resolution is effectively `default` only
- there is no live multi-profile enforcement matrix over the broader action-class vocabulary

Hardening target:

- support explicit non-default profile resolution in code
- enforce stricter profile overlays through live denial, approval, evidence, and retention behavior
- keep profile semantics additive-only relative to the contract floor

Landing condition:

- profiles are both selectable and detector-backed, or they stay out of normative docs

### Operator-Safe Profile And Escalation

Current gap:

- the repository does not currently ship a live operator-safe profile for zero-coding approval
- non-technical operator restrictions, escalation rules, and archetype narrowing are not yet enforced as a separate runtime mode

Hardening target:

- introduce an enforceable operator-safe profile that narrows admissible work, approver class, and summary requirements
- hard-escalate technically hazardous work instead of leaving that decision to implied operator judgment
- preserve fail-closed handling when a request does not fit an operator-safe archetype

Landing condition:

- a non-technical operator can stay inside a bounded approval surface that is genuinely enforced rather than documented aspirationally

## Target Operator-Mode Hardening

### Richer Operator-Safe Archetypes

Current gap:

- operator-safe archetypes are not yet live classification surfaces
- current `/build` behavior still runs under the general `default` profile

Hardening target:

- add concrete archetypes such as docs-only, bounded wording change, small local implementation, status-only follow-up, and other operator-safe patterns
- classify ambiguous requests into a safe archetype, guided clarification, or blocked escalation

Landing condition:

- broader non-technical usage does not depend on ad hoc technical reinterpretation of the request

### Formatter-Level Summary Enforcement

Current gap:

- the schema defines operator-readable summary content, but formatter coverage is still partial

Hardening target:

- make approval, blocked, and terminal summaries consistently render the required operator-facing fields
- lift the richer eight-field operator-summary model into dedicated formatter coverage: requested outcome, actual outcome, changed surfaces, proof collected, unproven claims, approval needed, recovery / undo notes, and next step
- expose proof gaps, approval state, and next-step guidance with dedicated formatter coverage instead of relying on partial formatter behavior

Landing condition:

- operator summaries answer the required questions consistently across commands, not only in docs or reviewer expectations

## Sequencing

Recommended order:

1. Finish current-doc honesty cleanup first.
2. Harden action-class detection and pre/post-run evidence alignment.
3. Add redaction and trust-boundary controls before depending on stronger review claims.
4. Extend first-class approval evidence and deepen reviewability evidence requirements.
5. Enable richer profile enforcement only after the underlying detector and evidence surfaces exist.
6. Expand zero-coding/operator-safe mode after profile enforcement, summary rendering, and escalation paths are real.

## Update Rule

When a roadmap item becomes enforced in code:

1. update the code and tests
2. move the requirement into the appropriate normative doc
3. remove or narrow the corresponding roadmap entry so this file stays future-facing
