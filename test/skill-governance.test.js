import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GOVERNED_SKILLS,
  auditGovernedSkills,
  validateGovernedSkillDefinitions,
  validateGovernedSkills
} from "../src/skill-governance.js";

function hasErrorCode(report, code) {
  return report.errors.some((entry) => entry.code === code);
}

function createFixtureInventory(overrides = {}) {
  return {
    id: "explorer",
    owner: "worker-role:explorer",
    entryPath: "skills/explorer/SKILL.md",
    referencedFiles: [
      "docs/agents/COMMON.md",
      "docs/agents/EXPLORER.md"
    ],
    referencedCommands: [
      "rg"
    ],
    expectedOutputShape: "structured_worker_result",
    requiredDocHeadings: [
      {
        path: "docs/agents/COMMON.md",
        headings: ["Role Envelope Model", "Output Discipline"]
      },
      {
        path: "docs/agents/EXPLORER.md",
        headings: ["Output Shape"]
      }
    ],
    ...overrides
  };
}

async function createFixtureRepository({
  includeEntry = true,
  includeExplorerCommand = true,
  includeCommonHeading = true,
  includeRoleHeading = true
} = {}) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-skill-governance-"));
  await mkdir(join(repositoryRoot, "docs", "agents"), { recursive: true });
  await mkdir(join(repositoryRoot, "skills", "explorer"), { recursive: true });

  const commonHeading = includeCommonHeading
    ? "## Role Envelope Model\n\nShared role envelope.\n\n## Output Discipline"
    : "## Drifted Common Heading";
  const roleHeading = includeRoleHeading
    ? "## Output Shape"
    : "## Output Shape Drifted";

  await writeFile(
    join(repositoryRoot, "docs", "agents", "COMMON.md"),
    `# Common\n\n${commonHeading}\n\nKeep output concrete.\n`,
    "utf8"
  );
  await writeFile(
    join(repositoryRoot, "docs", "agents", "EXPLORER.md"),
    `# Explorer\n\n${roleHeading}\n\nStructured worker result guidance.\n`,
    "utf8"
  );

  if (includeEntry) {
    const commandSnippet = includeExplorerCommand
      ? "- Prefer `rg` for fast local search.\n"
      : "- Prefer fast local search tools.\n";
    await writeFile(
      join(repositoryRoot, "skills", "explorer", "SKILL.md"),
      `# Explorer Skill\n\n${commandSnippet}\n## Output Contract\n\nReturn a structured worker result.\n`,
      "utf8"
    );
  }

  return repositoryRoot;
}

test("governed skill inventory validates for the current repository", () => {
  const report = validateGovernedSkills();

  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.checkedSkills, GOVERNED_SKILLS.length);
  assert.equal(auditGovernedSkills().ok, true);
});

test("missing governed skill entry file fails", async () => {
  const repositoryRoot = await createFixtureRepository({
    includeEntry: false
  });

  try {
    const report = validateGovernedSkills({
      inventory: [createFixtureInventory()],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "missing_entry_path"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("missing referenced file fails", async () => {
  const repositoryRoot = await createFixtureRepository();

  try {
    const report = validateGovernedSkills({
      inventory: [createFixtureInventory({
        referencedFiles: [
          "docs/agents/COMMON.md",
          "docs/agents/MISSING.md"
        ]
      })],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "missing_referenced_file"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("missing required heading in a referenced doc fails", async () => {
  const repositoryRoot = await createFixtureRepository({
    includeRoleHeading: false
  });

  try {
    const report = validateGovernedSkills({
      inventory: [createFixtureInventory()],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "missing_required_heading"), true);
    assert.equal(
      report.errors.some((entry) => (
        entry.code === "missing_required_heading" &&
        entry.path === "docs/agents/EXPLORER.md" &&
        entry.heading === "Output Shape"
      )),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("missing required common role heading fails", async () => {
  const repositoryRoot = await createFixtureRepository({
    includeCommonHeading: false
  });

  try {
    const report = validateGovernedSkills({
      inventory: [createFixtureInventory()],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "missing_required_heading"), true);
    assert.equal(
      report.errors.some((entry) => (
        entry.code === "missing_required_heading" &&
        entry.path === "docs/agents/COMMON.md" &&
        entry.heading === "Output Discipline"
      )),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("malformed inventory entry fails", () => {
  const report = validateGovernedSkillDefinitions({
    inventory: [{
      id: "",
      owner: "",
      entryPath: "",
      referencedFiles: "docs/agents/COMMON.md",
      referencedCommands: [""],
      expectedOutputShape: "structured_worker_result"
    }]
  });

  assert.equal(report.ok, false);
  assert.equal(hasErrorCode(report, "invalid_id"), true);
  assert.equal(hasErrorCode(report, "invalid_owner"), true);
  assert.equal(hasErrorCode(report, "invalid_entry_path"), true);
  assert.equal(hasErrorCode(report, "invalid_referenced_files"), true);
  assert.equal(hasErrorCode(report, "invalid_referenced_command"), true);
});

test("unsupported expectedOutputShape fails", async () => {
  const repositoryRoot = await createFixtureRepository();

  try {
    const report = validateGovernedSkillDefinitions({
      inventory: [createFixtureInventory({
        expectedOutputShape: "narrative_status_blob"
      })],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "unsupported_expected_output_shape"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("duplicate governed skill ids fail definition validation", async () => {
  const repositoryRoot = await createFixtureRepository();

  try {
    const report = validateGovernedSkillDefinitions({
      inventory: [
        createFixtureInventory({
          id: "explorer"
        }),
        createFixtureInventory({
          id: " explorer "
        })
      ],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "duplicate_skill_id"), true);
    assert.equal(
      report.errors.some((entry) => (
        entry.code === "duplicate_skill_id" &&
        entry.skillId === "explorer" &&
        entry.index === 1
      )),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("required doc-heading dependencies must be declared in referencedFiles", async () => {
  const repositoryRoot = await createFixtureRepository();

  try {
    const report = validateGovernedSkillDefinitions({
      inventory: [createFixtureInventory({
        referencedFiles: []
      })],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "undeclared_required_doc_dependency"), true);
    assert.equal(
      report.errors.some((entry) => (
        entry.code === "undeclared_required_doc_dependency" &&
        entry.path === "docs/agents/COMMON.md"
      )),
      true
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("required doc-heading dependency matching normalizes slash variants", async () => {
  const repositoryRoot = await createFixtureRepository();

  try {
    const report = validateGovernedSkillDefinitions({
      inventory: [createFixtureInventory({
        referencedFiles: [
          "docs\\agents\\COMMON.md",
          "docs\\agents\\EXPLORER.md"
        ]
      })],
      repositoryRoot
    });

    assert.equal(report.ok, true);
    assert.equal(hasErrorCode(report, "undeclared_required_doc_dependency"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("missing referenced command literal in entry file fails", async () => {
  const repositoryRoot = await createFixtureRepository({
    includeExplorerCommand: false
  });

  try {
    const report = validateGovernedSkills({
      inventory: [createFixtureInventory()],
      repositoryRoot
    });

    assert.equal(report.ok, false);
    assert.equal(hasErrorCode(report, "missing_referenced_command_literal"), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
