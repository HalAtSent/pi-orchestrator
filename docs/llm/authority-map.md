---
status: context
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../AGENTS.md
  - ../KERNEL-INVARIANTS.md
  - ../WORK-ORDER-SCHEMA.md
  - ../EVIDENCE-PACK-SCHEMA.md
  - ../REBUILD-GUIDE.md
  - ../CODING-QUALITY-HARNESS.md
  - ../IMPLEMENTATION-SEQUENCE.md
  - ../../src/kernel/work-order.js
  - ../../src/kernel/work-order-fingerprint.js
  - ../../src/kernel/path-safety.js
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
verify_with:
  - git diff --check
---

# Authority Map

This page maps authority. It does not create product authority by itself.

## Current Behavior

Current behavior is authoritative only when backed by current source code and
tests in the working tree.

Do not claim a validation rule, harness behavior, CLI behavior, policy gate, or
persisted artifact contract is enforced unless implementation and tests enforce
it.

Current implemented behavior is `repo-confirmed` only when current
implementation, tests, fixtures, CLI/package metadata, or another executable
repo surface confirms it. Docs can define target policy or contracts, but docs
do not prove current implemented behavior.

## Target Rebuild Behavior

For target rebuild behavior, prefer authority in this order:

1. `docs/KERNEL-INVARIANTS.md`
2. `docs/WORK-ORDER-SCHEMA.md`
3. `docs/EVIDENCE-PACK-SCHEMA.md`
4. `docs/REBUILD-GUIDE.md`
5. `docs/CODING-QUALITY-HARNESS.md`
6. `docs/IMPLEMENTATION-SEQUENCE.md`
7. Existing code and tests for behavior already implemented

If the target docs conflict with current implementation, describe the target as
target behavior and describe the implementation as current behavior.

## Classification Labels

Use these labels when preserving recovered context:

- `repo-confirmed` - current implementation, tests, fixtures, CLI/package
  metadata, or other executable repo surfaces confirm the item. Docs,
  `docs/llm/`, and chat-derived prose are never evidence for this label.
- `documented-target` - rebuild docs describe the target, but current code does
  not necessarily enforce it.
- `authority-cited` - an authoritative rebuild/schema/spec/ADR source defines a
  policy or contract. This is not implementation evidence unless current
  executable repo surfaces also confirm it.
- `implemented-not-documented` - current code/tests enforce behavior that is not
  clearly reflected in general docs.
- `chat-derived` - recovered from chat context only; provisional unless promoted
  into repo authority.
- `conflict` - repo artifacts or chat context disagree; controlling source must
  be named.
- `obsolete` - superseded or history-only.
- `unknown` - insufficient evidence.

## LLM Wiki Status

`docs/llm/` pages are context unless their header declares another status.

Allowed status values:

- `authoritative` - normative only for the scope declared by the page and only
  when source authority is cited.
- `context` - explanatory orientation; not a product authority source.
- `draft` - incomplete working text; not authority.
- `archive` - historical context; not current authority.

A wiki page marked `authoritative` must cite its source authority in
`authority_sources`. Without those citations, treat the page as context even if
the prose sounds normative.

## Conflict Rules

- If `docs/llm/` conflicts with code, tests, schemas, specs, ADRs, or rebuild
  docs, stop and report the conflict.
- If rebuild docs conflict with each other, use the target rebuild behavior
  order above and identify the controlling source.
- If code and tests conflict with target docs, do not silently update either
  side. State whether the task is changing current behavior, target docs, or
  both.
- Prompt text, role docs, skills, model narration, formatter prose, and scratch
  notes are never policy authority.

## Current Conflict Register

No active current-state conflicts are recorded in this default orientation page.

## Recovery Point

The Git tag `pre-rebuild-harness` is the recovery point for old runtime code and
stale docs. Do not delete or move it.
