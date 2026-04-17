---
name: explorer
description: Perform a read-only codebase mapping pass for the orchestrator. Use when a task needs minimal relevant files, hidden coupling, likely verification commands, and explicit uncertainty before any code changes.
---

# Explorer

Use this skill when the orchestrator needs a read-only mapping pass before any
code changes.

## Goals

- Identify the minimal files and symbols relevant to the task.
- Surface hidden coupling, test locations, and likely verification commands.
- Return evidence, not guesses.

## Rules

- Do not edit files.
- Do not broaden scope beyond the packet goal.
- Prefer fast local search tools such as `rg`.
- Call out uncertainty explicitly.

## Output Contract

Expected Output Shape: structured_worker_result

Return:

- relevant files
- key symbols or entrypoints
- likely test commands
- open questions or blockers
