# Harness Principles

This repository exists to make agentic coding more useful without pretending it is safer, more reliable, or more autonomous than it really is.

The target is not raw autonomy. The target is `quality-adjusted autonomy`: use models where they create real leverage, but contain the failure modes that make long-horizon software work expensive, insecure, or untrustworthy.

## Mission

Build a trustworthy, bounded, evidence-heavy coding harness for day-to-day software work.

That means:

- keep orchestration, policy, and risk control in code
- use subagents for scoped task work, not for owning the whole system
- make decisions reviewable after the fact
- fail closed when scope, evidence, or trust boundaries break down

Companion specs:

- [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md)
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

## Core Principles

### 1. Policy In Code, Not In Prompts

Prompts can help shape behavior. They are not a reliable policy boundary.

Safety-critical rules belong in code:

- role separation
- file ownership
- allowlists and forbidden paths
- approval gates
- repair-loop limits
- validation of worker input and output

### 2. Strong Orchestrator, Narrow Workers

The orchestrator owns:

- decomposition
- sequencing
- risk handling
- integration
- stop conditions

Workers should stay narrow, ephemeral, and task-scoped. They are execution tools, not free-roaming agents.

### 3. Least Privilege Beats Convenience

Every extra tool, connector, hook, or permission expands blast radius.

The default should be:

- read-only unless write access is required
- one writer per file
- explicit file allowlists
- no recursive delegation
- explicit human approval for high-risk work unless policy says otherwise

### 4. Evidence Over Narrative

The harness should produce artifacts that can be inspected without trusting the model's story about what happened.

Important evidence includes:

- commands actually run
- selected provider and model
- stop reason
- persisted run journals
- validation results
- review and verification output

### 5. Decompose Long-Horizon Work

Large goals should be compiled into bounded contracts with clear ownership and checkpoints.

The harness should prefer:

- staged lifecycle artifacts
- narrow contracts
- explicit dependencies
- resumable execution
- clean terminal states

This is how the system resists long-horizon drift.

### 6. Tests Are Necessary, Not Sufficient

Passing tests matter, but they are not enough.

The harness should also protect for:

- structural quality
- extension robustness
- architectural coherence
- security
- operator comprehension

### 7. Review Is The Bottleneck

Agentic coding often shifts the limiting factor from code production to judgment.

The harness should optimize for review efficiency, not just code volume. Good features reduce the amount of ambiguous output a human has to validate.

### 8. Specification Quality Matters More Than Generation Speed

A fast model with a weak brief is still a liability.

The harness should help narrow intent before execution through:

- explicit planning stages
- operator guidance
- clear approvals
- bounded clarification loops

### 9. Simplicity On The Surface, Strictness Underneath

The operator experience should be easy to use.

The internals should not be casual.

Non-technical users should see:

- plain-English intake
- plain-English plans
- clear approvals
- readable blocked states

The kernel should still enforce the same underlying guardrails.

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
- clearer evidence
- lower review burden
- better operator comprehension
- stronger architectural discipline
- better control of risk, cost, or drift

New features should be harder to approve when they mainly increase:

- hidden autonomy
- implicit permissions
- prompt dependence
- context sprawl
- review load without stronger evidence
- system complexity without a clear control benefit

## Acceptance Questions For Future Changes

Before promoting a feature, ask:

1. Does it keep policy in code rather than relying on instruction-following?
2. Does it reduce or expand trust boundaries?
3. Does it improve evidence quality and post-run inspectability?
4. Does it make long-horizon drift less likely?
5. Does it reduce or increase the human review bottleneck?
6. Does it preserve architecture boundaries?
7. Does it keep the operator surface simple while leaving the kernel strict?
8. Does it fail closed when assumptions break?

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
