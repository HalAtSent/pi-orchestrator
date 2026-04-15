# Harness Principles

This repository exists to make agentic coding more useful without pretending it is safer, more reliable, or more autonomous than it really is.

The target is not raw autonomy or apparent autonomy. The target is trustworthy, reviewable, merge-grade output under strict control boundaries.

`Quality-adjusted autonomy` is only useful shorthand when it still means: use models where they create real leverage, but contain the failure modes that make long-horizon software work expensive, insecure, untrustworthy, or expensive to review.

Harness quality is itself a first-order capability lever. Better context construction, tool contracts, output shaping, evidence quality, and code-enforced control-plane invariants usually create more durable gains than adding more central routing, state, or orchestration ceremony.

This document explains why the harness is shaped this way and what kinds of changes fit. It is doctrine, not an operational override; mandatory behavior, state rules, and inspectability requirements live in [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md), [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md), and [POLICY-PROFILES.md](./POLICY-PROFILES.md).

Normative documents in this repository should describe enforced behavior only. Target-state aspirations, hardening ideas, and roadmap direction belong in separate planning surfaces rather than being smuggled into contract or schema language. The current planning surface for that work is [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Mission

Build a trustworthy, bounded, evidence-heavy coding harness for day-to-day software work.

That means:

- keep permissions, approvals, scope, provenance, persistence, and evidence normalization authoritative in code
- keep the control plane thin, legible, and hard to misread
- treat prompts and skills as execution aids, not as the trust foundation
- use subagents for scoped task work, not for owning the whole system
- make outputs reviewable after the fact
- optimize the execution loop, not orchestration sprawl
- treat roles mainly as capability boundaries and evidence obligations
- prefer governed skills and procedures for reusable task method
- fail closed when scope, evidence, or trust boundaries break down
- optimize for merge-grade correctness, not happy-path green
- judge progress by trustworthy output, review burden, evidence completeness, and policy correctness rather than by apparent autonomy
- keep the surface simple for operators while preserving strict technical judgment underneath

Companion specs:

- [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md)
- [POLICY-PROFILES.md](./POLICY-PROFILES.md)
- [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md)

## What This Harness Is Defending Against

The harness is designed around a specific thesis:

- agentic coding is less reliable than it looks
- benchmark wins are weaker evidence than many people assume
- passing tests is not the same as producing code worth keeping
- tool access creates real trust-boundary and security problems
- long-horizon work drifts unless decomposition and review stay strong
- speed gains can be erased by review, rework, cleanup, and misalignment

In practical terms, the harness is trying to reduce:

- false confidence from polished but weak output
- architectural drift across repeated iterations
- over-broad tool and file access
- prompt-dependent policy enforcement
- review overload from unbounded code generation
- hidden operational cost from retries, model choice, and cleanup work
- patch-shaped fixes that pass once and decay on the next change

## Core Principles

### 1. Deterministic Control-Plane Invariants Belong In Code

Code-enforced control-plane invariants are the main trust foundation in this repository.

Prompts can help shape behavior. They are not a reliable policy boundary.

Safety-critical rules belong in code:

- scope and ownership
- provenance and approval binding
- persistence and truthful status surfaces
- role and permission boundaries
- allowlists and forbidden paths
- fail-closed denial conditions
- bounded execution and repair-loop limits
- evidence normalization and validation of worker input and output

### 2. Thin Control Plane, Strong Execution Loop

The harness should not treat more central orchestration logic as the default path to more capability.

A strong control plane does not imply a thick orchestrator. The design center should remain a thin control plane with a strong execution loop.

The control plane should stay thin, deterministic, and legible. Capability gains should come primarily from better:

- task envelopes
- context construction
- tool contracts
- output shaping
- evidence-producing execution loops

Minimal, truthful, well-bounded interfaces beat elaborate central choreography.

### 3. Roles Are Capability Envelopes

Roles should primarily define:

- permissions
- trust boundaries
- evidence obligations

Roles are not the main reusable-intelligence abstraction. Keep role semantics small, stable, and enforceable.

### 4. Governed Skills Over Hidden Procedure

Reusable task method should preferentially live in versioned, governed,
reviewable skills or procedures rather than in ever-thicker orchestrator
branches. Operational rules for that layer live in
[SKILL-GOVERNANCE.md](./SKILL-GOVERNANCE.md).

Skills can improve execution quality. They are not a substitute for policy,
truth surfaces, or deterministic control-plane enforcement.

Good procedural artifacts should shape:

- context assembly
- tool use
- output structure
- evidence expectations

This is a better reuse layer than prompt folklore or expanding central orchestration logic.

### 5. Least Privilege Beats Convenience

Every extra tool, connector, hook, or permission expands blast radius.

The default should be:

- read-only unless write access is required
- prefer single-write ownership per file; [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md) defines the exact behavioral invariant as one write-capable worker per file within a single execution step
- explicit file allowlists
- no recursive delegation
- explicit human approval for high-risk work, subject to stricter policy-profile handling

### 6. Evidence And Reviewability Are Product Quality

Evidence is not just audit exhaust. Reviewability is part of the product.

Evidence quality and review burden are product-quality concerns, not merely audit concerns. A result that is hard to inspect is a lower-quality product even when the output looks superficially capable.

The harness should produce artifacts that can be inspected without trusting the model's story about what happened.

Important evidence includes:

- commands actually run
- selected provider and model
- changed surface
- stop reason
- persisted run journals
- validation results
- reviewability state
- review and verification output

### 7. Decompose Long-Horizon Work

Large goals should be compiled into bounded contracts with clear ownership and checkpoints.

The harness should prefer:

- staged lifecycle artifacts
- narrow contracts
- explicit dependencies
- resumable execution
- clean terminal states

This is how the system resists long-horizon drift.

### 8. Correctness And Durability Beat Happy-Path Green

Passing tests matter, but they are not enough.

The bar is code worth merging and keeping, not code that only survives the happy path once.

The harness should also protect for:

- structural quality
- extension robustness
- architectural coherence
- security
- operator comprehension

The harness should prefer the smallest sufficient correct change, not the smallest diff for its own sake.

That means:

- fix the underlying cause when it is knowable
- prefer durable changes over brittle local patches
- avoid changes that merely move risk into review, cleanup, or the next iteration
- reject patch-minimization as a goal when it conflicts with correctness or maintainability

### 9. Harness Quality Matters More Than Generation Speed

A fast model behind a weak harness is still a liability.

The highest-leverage harness work is usually better:

- context construction
- tool design
- output shaping
- evidence quality

Planning and clarification still matter, but they are in service of execution quality rather than substitutes for it.

### 10. Simplicity On The Surface, Strictness Underneath

The operator experience should be easy to use.

The internals should not be casual.

Non-technical usability is a first-class product goal, not a replacement for technical approval or technical safety judgment.

Non-technical users should see:

- plain-English intake
- plain-English plans
- clear approvals
- readable blocked states

The kernel should still enforce the same underlying guardrails, and technical approval should stay bound to actual scope, correctness, and evidence.

### 11. Normative Docs Must Stay Honest

Doctrine should explain direction. Normative docs should describe enforced behavior only.

This repository should not:

- hide roadmap intent inside normative language
- use contract or schema text to imply guarantees the code does not enforce
- let summary docs compete with the contract or evidence surfaces

## Non-Goals

This harness is not trying to be:

- a generic AI assistant for every task
- a prompt-only safety system
- an unrestricted autonomous developer
- a benchmark-chasing demo
- a replacement for architectural or security judgment
- a loose playground for agent experiments

## What A Good Feature Looks Like

New features should be easier to approve when they improve one or more of these:

- tighter trust boundaries
- stronger code-enforced control-plane invariants
- better context construction or tool contracts
- better output shaping or evidence quality
- clearer evidence
- lower review burden
- better trustworthy output per unit of human review
- stronger governed procedure without widening role power
- better operator comprehension
- stronger architectural discipline
- better control of risk, cost, or drift

New features should be harder to approve when they mainly increase:

- hidden autonomy
- apparent autonomy that weakens inspectability, reviewability, or control boundaries
- implicit permissions
- prompt dependence
- context sprawl
- central orchestration or routing complexity without stronger evidence
- review load without stronger evidence
- system complexity without a clear control benefit

## Acceptance Questions For Future Changes

Before promoting a feature, ask:

1. Does it keep deterministic control-plane invariants in code rather than relying on instruction-following?
2. Does it preserve a strong control plane without thickening the orchestrator by default?
3. Does it improve the execution loop more than it grows central orchestration complexity?
4. Does it improve context construction, tool contracts, output shaping, or evidence quality?
5. Does it keep roles as capability boundaries rather than intelligence containers?
6. Does it make reusable method clearer through governed skills or procedures?
7. Does it reduce or expand trust boundaries?
8. Does it improve evidence quality and post-run inspectability?
9. Does it improve trustworthy output and reviewability rather than merely making the system appear more autonomous?
10. Does it make long-horizon drift less likely?
11. Does it keep the operator surface simple while leaving the kernel strict?
12. Does it fail closed when assumptions break?

If the answers are weak, the feature probably does not belong in the main harness.

## Selected Background Reading

These references informed the overall doctrine and are worth revisiting when the repo starts drifting toward raw-autonomy hype:

- [Introducing Codex](https://openai.com/index/introducing-codex/)
- [Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution Scenarios](https://arxiv.org/html/2512.18470v5)
- [SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks](https://arxiv.org/abs/2603.24755)
- [CAISI Issues Request for Information About Securing AI Agent Systems](https://www.nist.gov/news-events/news/2026/01/caisi-issues-request-information-about-securing-ai-agent-systems)
- [Guiding AI to Fix Its Own Flaws: An Empirical Study on LLM-Driven Secure Code Generation](https://arxiv.org/html/2506.23034v1)
- [Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)
