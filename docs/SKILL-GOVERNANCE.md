# Skill Governance

This document governs reusable procedure surfaces such as
`skills/*/SKILL.md`.

It explains what a skill is in this repository, what may live in a skill, what
must remain in code or normative docs, and how skill changes should be
reviewed.

This file supports the design split in
[HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md), the behavioral authority in
[HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md), the persisted truth surfaces in
[RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md), and the
[agent role docs](./agents/COMMON.md). It does not create a new authority
layer over code.

If this file conflicts with code-enforced policy, the harness contract, the
evidence schema, the active policy profile, or role docs, the stricter
authoritative source wins.

## Purpose

- keep deterministic policy and truth surfaces out of prompt-only procedure
- keep reusable method in governed skills without turning skills into policy or truth owners
- make reusable method reviewable and reusable without growing central
  orchestrator logic
- keep role docs compact and enforceable
- give future design work a simple placement test for "code, contract, role,
  or skill?"

## Placement Test

Use this test before adding new instructions anywhere:

1. If the rule must hold deterministically or fail closed, it belongs in code
   and its normative companion docs, not only in a skill.
2. If the rule defines authority, capability boundaries, read or write power,
   or evidence duties, it belongs in the role docs and contract surface.
3. If the content is a repeatable way to perform a bounded task well inside an
   already-authorized envelope, it belongs in a skill or procedure.
4. If the content is primarily operator explanation of current behavior, it
   belongs in the operating guide or README, not in a skill.

If removing the skill would create a safety, approval, scope, provenance,
fail-closed, or persisted-truth failure, the logic is in the wrong layer.

## Surface Split

| Surface | Owns | Must not own |
| --- | --- | --- |
| Code / control plane | deterministic enforcement, approvals, scope checks, provenance, persistence, evidence normalization, fail-closed behavior, state handling | prompt-followed procedure as a substitute for enforcement |
| Contract / schema / profiles | behavioral truth, evidence requirements, profile validity, authoritative terms and states | aspirational procedure, operator folklore, unimplemented guarantees |
| Role docs | capability boundaries, read or write authority, stop conditions, evidence obligations | reusable playbooks, broad repo-specific workflow lore, permission widening |
| Skills / procedures | reusable task method, debugging workflows, verification playbooks, repo-specific operating method | permissions, approval semantics, scope enforcement, provenance claims, persisted artifact definitions, fail-closed invariants |
| Operating guide / README | how to use the current harness and where the live limits are | policy authority or hidden runtime guarantees |

## What A Skill Is In This Repo

A skill is a small, reviewable procedure surface for a bounded recurring task.
It should help a worker do one class of work well inside an authority envelope
that is already defined elsewhere.

A skill can improve execution quality. It is not required to make a claim safe,
in-scope, approved, reviewable, or true.

In this repository, a good skill usually does all of the following:

- describes when to use the skill
- states the task goal in a model-friendly way
- gives the smallest high-signal method for doing the task well
- names concrete output expectations, checks, and stop conditions
- stays safe to ignore from a policy standpoint, even if ignoring it would
  lower quality

Current repo convention:

- keep skills under `skills/<name>/SKILL.md`
- keep front matter short and factual
- keep one core task family per skill

Not every instruction file is a skill. Role docs, contract docs, evidence
schema docs, policy profiles, operator guides, and planning notes are distinct
surfaces with different owners.

## What Belongs In A Skill

Skills are the preferred home for reusable task method such as:

- reusable debugging workflows
- repeatable verification playbooks
- repo-specific procedure that benefits from standardization
- model-friendly, high-signal operating method for a bounded task
- concrete search, inspection, or validation sequences that recur across work
- output shaping that makes worker results more reviewable without changing the
  underlying schema or status model

Typical examples in this repo include read-only exploration passes, bounded
implementation method, review method, and proof-collection method.

## What Must Stay Out Of Skills

The following must not live only in a skill:

- permissions or tool-access authority
- approval semantics or approval-binding meaning
- scope enforcement, allowlists, forbidden paths, or protected-path handling
- provenance claims, reviewability claims, or truthfulness guarantees
- persisted artifact definitions, field meaning, or schema enums
- role identity, role power, or evidence obligations that must hold regardless
  of prompt quality
- any fail-closed invariant
- any rule that the repo needs to enforce even when a model ignores
  instructions

A skill may reference those surfaces. It may not replace, redefine, or widen
them.

## Skills And Roles

Roles constrain authority. Skills shape method.

In practical terms:

- the role doc answers "what may this worker do, what must it prove, and when
  must it stop?"
- the skill answers "how should this bounded task be performed well in this
  repo?"
- role docs should stay compact and stable
- repo-specific reusable method should move into skills instead of swelling role
  prose

If a skill conflicts with a role doc, the contract, the evidence schema, the
active profile, or code, the skill loses.

## Skills And The Orchestrator

Use skills to reduce controller sprawl, not to bypass the control plane.

That means:

- skills are the preferred place for reusable method when the alternative is
  controller sprawl
- the orchestrator may select or attach a skill to improve execution quality
- the orchestrator may not hide approval logic, permission decisions, scope
  rules, or persisted truth inside skill prose
- moving a repeated procedure out of controller branches is good
- moving deterministic policy out of code and into skill text is not

Skill output remains untrusted until the current validation and evidence
surfaces accept it.

## Quality Bar

Every skill should meet this bar:

- small
- high signal
- bounded to one task family or method
- versioned and governed through normal repository review
- tested or evaluated where practical
- explicit about inputs, outputs, and stop conditions
- not auto-grown from model output without human review
- written to reduce drift, not to accumulate folklore

Practical authoring rules:

- prefer concrete file paths, commands, checks, and result fields over general
  advice
- reference canonical contract, schema, or role surfaces instead of copying
  their rules
- remove stale steps rather than piling on exceptions
- keep background explanation short; keep the procedure sharp

## Versioning, Review, And Evaluation Today

Current repo truth:

- the repository does not currently have a first-class runtime skill registry,
  skill-version pinning surface, or automatic skill-evaluation harness
- "versioned" currently means normal repository history, review, and rollback
- a skill change is governed like any other repo change: inspectable in git,
  reviewable by a human, and expected to stay aligned with code and docs

Any future first-class skill registry, pinning, or evaluator should remain a
roadmap item until code, tests, and supporting docs land together.

Current review expectation:

- review the skill diff itself, not only the generated output it was inspired
  by
- review any coupled role-doc, contract-doc, or code change together when the
  procedure depends on those surfaces
- reject "model accretion" where a skill quietly absorbs more policy, more
  scope, or more narration without a clear bounded purpose

Current evaluation expectation:

- where practical, exercise the skill on at least one representative local task
  or fixture
- verify that referenced files, commands, and outputs still exist
- verify that the skill does not contradict code, contract, schema, profile, or
  role truth
- verify that the skill improves method or reviewability without becoming hidden
  policy or a substitute for persisted truth
- when no practical evaluation exists, say so explicitly in review rather than
  implying the skill is proven

If reliable behavior needs deterministic enforcement, typed evidence, or
fail-closed handling, promote that behavior into code and normative docs rather
than deepening the skill.

## Avoiding Prompt And Context Drift

Skill drift is a real failure mode. The repo should actively resist it.

Use these rules:

- keep skills short enough that the important parts stay visible
- keep one canonical owner per rule; link to code or normative docs instead of
  restating them in multiple places
- do not let role docs, skills, and orchestrator prompts carry different
  versions of the same rule
- update or remove a skill when repo layout, commands, validation paths, or
  output contracts change
- prefer concrete procedures over broad "best practice" prose
- stop adding skill text when the missing piece is actually code, schema, or
  role enforcement

## Create, Update, Or Retire

Create a skill when:

- the procedure recurs across tasks
- the method is bounded enough to describe clearly
- standardizing it will reduce review burden or controller sprawl
- the content does not belong in code, contract, schema, profile, or role docs

Update a skill when:

- repo-local commands, files, or output expectations changed
- the role or contract surface it depends on changed
- the current text has become longer, vaguer, or more policy-heavy than the
  task requires

Retire or collapse a skill when:

- it duplicates a role doc or contract rule
- the procedure is no longer reused
- code now owns the behavior deterministically
- the remaining text is mostly generic advice

## Review Questions For Future Design Work

Before adding new procedure text, ask:

1. Is this method or policy?
2. If the model ignored this text, would the harness still fail closed?
3. If this skill disappeared, would safety, scope, approval, provenance, or
   persisted truth break?
4. Does this belong in a role boundary rather than a skill?
5. Would code or schema be a more truthful owner?
6. Is the skill getting smaller and sharper, or turning into a second
   orchestrator?

If those answers are weak, do not add the instruction to a skill.
