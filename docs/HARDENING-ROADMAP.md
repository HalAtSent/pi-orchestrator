# Hardening Roadmap

This document tracks future-facing hardening that is not yet fully enforced in
the current repository.

It is intentionally separate from the normative docs:

- [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md) describes current behavioral
  requirements and repo-wide policy defaults that are authoritative today.
- [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md) describes the current
  persisted evidence and reviewability surface.
- [POLICY-PROFILES.md](./POLICY-PROFILES.md) describes the currently enforced
  profile-resolution surface.
- [SKILL-GOVERNANCE.md](./SKILL-GOVERNANCE.md) describes the current governance
  boundary for reusable method.
- [OPERATING-GUIDE.md](./OPERATING-GUIDE.md) explains how to operate the
  current harness.

Use this file for target-state hardening only. Nothing here should be read as
current enforcement unless and until the normative docs and code are updated
together.

The current strategy is to improve the base execution loop before adding more
orchestration complexity. The next leverage is better context construction, tool
contracts, evidence, reviewability, and governed reusable method while keeping
the control plane thin, deterministic, and legible.

Strong control-plane hardening does not require a thicker orchestrator. By
default, controller growth is downstream work that must justify itself against
simpler improvements to evidence, contracts, context, and governed method.

## Current Baseline

The repository has already moved beyond the earlier cleanup baseline in several
important ways:

- operator-facing summaries now expose changed surfaces, proof collected,
  unproven claims, approval-needed guidance, recovery or undo notes, and next
  action through the current formatter surface
- persisted machine reviewability now exists as a first-class normalized
  surface (`reviewability.status` plus explicit reason codes)
- exact changed-surface capture now has a trusted provenance path for runner
  flows that can attest it
- plan-derived approval scope and post-run evidence now treat
  `install_dependency` and `mutate_git_state` as concrete detector-backed
  classes
- the control plane already stays intentionally narrower than the broader
  vocabulary carried by persisted artifacts

Important future gaps still remain:

- many review-critical facts still rely on mixed embedded fields, evidence
  strings, or formatter reconstruction
- provider/model hardening is only partially landed: typed packet persistence
  now exists for trusted process-backend metadata, and per-contract requirement
  state now exists as a narrow provenance-derived `required` | `unknown`
  surface rather than a backend-complete applicability model
- context construction and retrieval quality are not yet a first-class
  hardening surface
- tool and worker-result contracts are not yet audited as one coherent boundary
- skill governance is now doctrine-backed, but not yet regression-backed
- persisted evidence and forwarded worker context still lack a repository-wide
  redaction pass
- runtime profiles and operator-safe mode are still effectively narrow
- additional orchestration work remains selectively useful, but it is no longer
  the default growth path

## Roadmap Admission Rule

Tracks below are ordered by leverage and dependency, not by arbitrary category.
Earlier tracks strengthen the evidence and execution substrate that later
profile or orchestration work depends on.

Every major roadmap item should pass two admission tests:

- does it reduce the amount of human judgment required per unit of trustworthy
  output?
- does it preserve or strengthen control boundaries?

More controller logic is not a roadmap goal by itself. New orchestration work is
only justified when it clearly improves one or more of:

- policy enforcement
- context quality
- evidence quality
- reviewability
- operator clarity

If a problem can be solved first by sharper evidence surfaces, better tool
contracts, better context construction, or stronger governed skills, that path
should win over adding more central routing or state machinery.

Priority should bias toward:

- evidence and reviewability
- context quality
- tool and result contract quality
- trust-boundary hardening
- skill governance and evaluation
- additional controller complexity only where the gains above cannot be
  captured more simply

## Evaluation Criteria

Use the following as durable governance criteria for roadmap and evaluation
decisions. This is not a benchmark plan; it is the lens for deciding whether
the harness is getting better.

- trustworthy output: does the harness produce merge-grade results under the
  current strict boundaries, rather than merely sounding more autonomous?
- review effort: does reviewer time or decision burden per unit of trustworthy
  output go down?
- evidence completeness: are approvals, changed surfaces, validation, lineage,
  and stop reasons captured well enough to support truthful review?
- policy-violation attempt and block rate: does the harness detect and fail
  closed on invalid, out-of-scope, or under-approved work?
- operator clarity: can an operator tell what happened, what changed, what is
  still uncertain, and what exact next action is required?
- regression rate and rework burden: does accepted output stay durable, or does
  it create avoidable follow-on repair, rollback, or repeated review churn?

These criteria should dominate apparent autonomy, routing novelty, or prompt
cleverness when the roadmap is prioritized.

Current implementation note:

- the canonical criteria above are now instrumented in lifecycle artifacts as
  `ExecutionProgram.evaluationCriteria[]` and `AuditReport.evaluationCoverage[]`
- this is structural instrumentation, not runtime measurement; coverage means
  expected hook surfaces exist and are non-empty in planning artifacts
- coverage does not claim the underlying outcome was achieved; outcome quality
  still depends on later execution evidence and technical review

## Priority Tracks

### 1. First-Class Reviewability And Evidence Surfaces

Current gap:

- approval lineage, command evidence, diff ownership, review findings, and cost
  or validation facts still rely too heavily on mixed embedded fields, evidence
  strings, or formatter logic
- critical review questions are not yet answerable from typed persisted fields
  alone

Hardening target:

- promote review-critical surfaces into typed persisted fields or dedicated
  embedded artifacts where they matter to approval, reviewability, or operator
  claims
- keep string-keyed `evidence[]` conventions only as compatibility shims once a
  typed owner exists
- make approval lineage inspectable without reconstructing intent from mixed
  build-session fields and backend convention
- make changed-surface ownership and structured review findings first-class
  where they are needed for merge-grade review

Landing condition:

- a reviewer can answer what was approved, what ran, what changed, what was
  validated, and what remains unproven from typed persisted evidence rather than
  from narrative reconstruction

### 2. Provider/Model Evidence Hardening

Partial landing already shipped:

- trusted process-backend worker metadata now promotes requested/selected
  provider/model packet entries into first-class persisted
  `run_journal.contractRuns[].providerModelSelections[]` when trusted typed
  packet entries are promoted
- per-contract provider/model evidence requirement is now persisted as
  `run_journal.contractRuns[].providerModelEvidenceRequirement` with the narrow
  enum `required` | `unknown`
- this requirement value is derived only from code-owned backend provenance in
  `src/program-contract-executor.js` (`required` when at least one packet run
  carries trusted provider/model provenance; `unknown` otherwise)
- compatibility provider/model evidence strings remain for human trace and
  legacy interoperability; they are not the first-class persisted truth when
  typed packet entries exist

Current gap:

- there is still no backend-complete applicability model beyond this narrow
  provenance-derived requirement slice
- `required`/`unknown` truth is still intentionally conservative and does not
  claim full backend-wide applicability semantics

Hardening target:

- keep the requirement backend-aware rather than pretending every successful run
  uses the same model-backed execution path
- extend the model only when code-owned runtime facts can truthfully support
  additional states

Landing condition:

- reviewable success no longer depends on informal inference about whether
  provider/model evidence should have existed for fresh runs

### 3. Context Construction And Retrieval Quality

Current gap:

- the harness already bounds scope, but context assembly, retrieval, pruning,
  and carry-forward are not yet treated as first-class hardening surfaces
- prior-run summaries, evidence, and changed-surface context can be forwarded,
  but provenance, freshness, and selection quality are not yet explicit enough
  for stronger review claims

Hardening target:

- define deterministic context builders for task envelopes, repo retrieval,
  prior-run reuse, changed-surface carry-forward, and review-context assembly
- record why a given file, doc, skill, or prior artifact entered context when
  that choice affects worker behavior or later review
- add checks for stale, conflicting, oversized, or weakly grounded context
- prefer smaller, provenance-backed context packets over broader prompt
  accumulation

Landing condition:

- workers receive more relevant context with less drift, and reviewers can
  inspect where that context came from and why it was included

### 4. Tool And Result Contract Audit And Cleanup

Current gap:

- some tool boundaries and worker-result surfaces still mix typed fields with
  narrative convention
- the persisted action-class vocabulary is broader than the detector-backed live
  contract surface
- several trust-boundary crossings are described, but not yet audited as one
  coherent contract set

Hardening target:

- audit each tool and worker-result boundary for canonical inputs, typed
  outputs, stop reasons, changed-surface provenance, redaction expectations, and
  failure semantics
- define one code owner and one evidence path per live action class before
  promoting it into runtime policy claims
- only promote classes such as `read_protected`, `access_network`,
  `access_connector`, `access_secret`, and `irreversible_side_effect` when
  detector owners, tests, and evidence semantics are real
- prevent vocabulary-only classes from reading as enforced behavior until that
  backing exists

Landing condition:

- each live tool and action class has a narrow, truthful, testable contract
  rather than a mixture of schema vocabulary and reviewer convention

### 5. Skill Governance And Skill Regression

Current gap:

- the repository now treats skills as the preferred reusable-method layer, but
  current governance is still mostly documentation and review discipline
- there is no first-class skill registry, pinning surface, or regression
  harness, and no routine proof that high-value skills still reference valid
  commands, files, and output expectations

Hardening target:

- add skill inventory, ownership, compatibility, or pinning surfaces only where
  code can make them truthful
- build regression or fixture-style checks for high-leverage skills so that
  referenced files, commands, and output shapes stay real
- require coupled updates when contract, schema, profile, or role changes would
  otherwise leave a skill stale
- move repeatable task method into governed skills before adding equivalent
  branches to the orchestrator

Landing condition:

- reusable method is reviewable, testable, and governable without silently
  becoming hidden policy or controller sprawl

### 6. Redaction And Trust-Boundary Hardening

Current gap:

- persisted evidence and forwarded worker context still do not pass through a
  repository-wide redaction or secret-scrubbing pipeline
- raw tool output, launcher text, workspace paths, and worker summaries can
  cross persistence or later-context boundaries unredacted

Hardening target:

- add a repository-wide redaction layer for persisted evidence, forwarded
  worker context, and stored tool output
- classify which surfaces may store raw text, summaries, hashes or references,
  or only redacted payloads
- bind redaction behavior to the tool, result, and context-builder contracts
  above rather than handling it as ad hoc formatter cleanup

Landing condition:

- stronger review claims can rely on persisted evidence without assuming
  upstream callers already scrubbed sensitive material correctly

### 7. Operator-Safe Profile And Runtime Enforcement

Current gap:

- runtime profile resolution is still effectively `default` only
- the repository does not yet ship a live operator-safe profile with enforced
  archetypes, escalation rules, and narrower evidence expectations
- current operator summaries are stronger, but operator-safe mode is still not a
  separate runtime envelope

Hardening target:

- implement explicit non-default profile resolution only after the evidence,
  context, and tool-contract surfaces above are strong enough to support it
- introduce an operator-safe profile that narrows admissible work, escalation
  rules, approval handling, and retention or evidence behavior without relaxing
  the contract floor
- promote operator-safe archetypes only when the runtime can fail closed on
  out-of-archetype or technically hazardous work

Landing condition:

- non-technical operators can stay inside a genuinely enforced runtime mode that
  escalates hazardous work instead of relying on implied judgment

### 8. Additional Orchestration Only Where It Pays For Itself

Current gap:

- some future hardening still points toward extra controller logic, such as
  mid-run reapproval, packet-level escalation, or richer routing around stricter
  tool classes
- those changes add state-machine and integration complexity, so they should not
  lead the roadmap

Hardening target:

- treat more orchestration as a downstream lever, not as the default capability
  plan
- add control-plane or packet-level orchestration only when earlier tracks show
  a clear enforcement, context, evidence, reviewability, or operator-clarity
  gain that simpler surfaces cannot provide
- preserve worthwhile future work such as mid-run reapproval, but defer it
  until approval lineage, action-class ownership, evidence quality, and profile
  semantics are strong enough to justify the added complexity

Landing condition:

- any added orchestration demonstrably improves policy enforcement, context
  quality, evidence quality, reviewability, or operator clarity rather than
  merely increasing choreography

## De-Emphasized But Preserved Themes

The roadmap still keeps these themes, but they are no longer the front of the
queue:

- broadening the action-class matrix faster than tool contracts and evidence
  surfaces can support
- mid-run reapproval before approval lineage and provider/model evidence are
  first-class
- proliferating operator archetypes before runtime profile enforcement is real
- formatter-only richness that outruns persisted evidence
- controller growth as a proxy for harness capability

## Update Rule

When a roadmap item becomes enforced in code:

1. update the code and tests
2. move the requirement into the appropriate normative doc
3. remove or narrow the corresponding roadmap entry so this file stays
   future-facing
