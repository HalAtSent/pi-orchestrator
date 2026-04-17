import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GOVERNED_SKILL_OUTPUT_SHAPES = Object.freeze([
  "structured_worker_result",
  "review_findings",
  "verification_report",
  "doc_update_bundle"
]);

const COMMON_ROLE_DOC_PATH = "docs/agents/COMMON.md";
const MIRROR_SKILL_ENTRY_PATH_PREFIX = ".pi";
const SKILL_ENTRY_OUTPUT_CONTRACT_HEADING = "Output Contract";
const SKILL_ENTRY_OUTPUT_SHAPE_MARKER_PREFIX = "Expected Output Shape:";
const GOVERNED_SKILL_REQUIRED_ENTRY_HEADINGS = Object.freeze([
  SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
]);
const ROLE_DOC_REQUIRED_COMMON_HEADINGS = Object.freeze([
  "Role Envelope Model",
  "Output Discipline"
]);
const ROLE_DOC_REQUIRED_ROLE_HEADINGS = Object.freeze([
  "Capability Envelope",
  "Output Shape"
]);

function freezeGovernedSkillEntry(entry) {
  return Object.freeze({
    ...entry,
    referencedFiles: Object.freeze([...(entry.referencedFiles ?? [])]),
    referencedCommands: Object.freeze([...(entry.referencedCommands ?? [])]),
    requiredDocHeadings: Object.freeze(
      [...(entry.requiredDocHeadings ?? [])].map((requirement) => Object.freeze({
        ...requirement,
        headings: Object.freeze([...(requirement?.headings ?? [])])
      }))
    )
  });
}

export const GOVERNED_SKILLS = Object.freeze([
  freezeGovernedSkillEntry({
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
        path: COMMON_ROLE_DOC_PATH,
        headings: ["Role Envelope Model", "Output Discipline"]
      },
      {
        path: "docs/agents/EXPLORER.md",
        headings: ["Capability Envelope", "Output Shape"]
      }
    ]
  }),
  freezeGovernedSkillEntry({
    id: "implementer",
    owner: "worker-role:implementer",
    entryPath: "skills/implementer/SKILL.md",
    referencedFiles: [
      "docs/agents/COMMON.md",
      "docs/agents/IMPLEMENTER.md"
    ],
    referencedCommands: [],
    expectedOutputShape: "structured_worker_result",
    requiredDocHeadings: [
      {
        path: COMMON_ROLE_DOC_PATH,
        headings: ["Role Envelope Model", "Output Discipline"]
      },
      {
        path: "docs/agents/IMPLEMENTER.md",
        headings: ["Capability Envelope", "Output Shape"]
      }
    ]
  }),
  freezeGovernedSkillEntry({
    id: "reviewer",
    owner: "worker-role:reviewer",
    entryPath: "skills/reviewer/SKILL.md",
    referencedFiles: [
      "docs/agents/COMMON.md",
      "docs/agents/REVIEWER.md"
    ],
    referencedCommands: [],
    expectedOutputShape: "review_findings",
    requiredDocHeadings: [
      {
        path: COMMON_ROLE_DOC_PATH,
        headings: ["Role Envelope Model", "Output Discipline"]
      },
      {
        path: "docs/agents/REVIEWER.md",
        headings: ["Capability Envelope", "Output Shape"]
      }
    ]
  }),
  freezeGovernedSkillEntry({
    id: "verifier",
    owner: "worker-role:verifier",
    entryPath: "skills/verifier/SKILL.md",
    referencedFiles: [
      "docs/agents/COMMON.md",
      "docs/agents/VERIFIER.md"
    ],
    referencedCommands: [],
    expectedOutputShape: "verification_report",
    requiredDocHeadings: [
      {
        path: COMMON_ROLE_DOC_PATH,
        headings: ["Role Envelope Model", "Output Discipline"]
      },
      {
        path: "docs/agents/VERIFIER.md",
        headings: ["Capability Envelope", "Output Shape"]
      }
    ]
  })
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePath(pathValue) {
  return String(pathValue).replace(/\\/gu, "/");
}

function resolveFromRepositoryRoot(repositoryRoot, relativePath) {
  return resolve(repositoryRoot, normalizePath(relativePath));
}

function toMirrorSkillEntryPath(entryPath) {
  const normalizedEntryPath = normalizePath(entryPath)
    .replace(/^\.\/+/u, "")
    .replace(/^\/+/u, "");
  return normalizePath(`${MIRROR_SKILL_ENTRY_PATH_PREFIX}/${normalizedEntryPath}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasMarkdownHeading(markdown, heading) {
  const normalizedMarkdown = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(String(heading).trim())}\\s*$`, "mu");
  return headingPattern.test(normalizedMarkdown);
}

function hasCommandLiteral(markdown, command) {
  const normalizedCommand = String(command).trim();
  const normalizedMarkdown = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const commandPattern = new RegExp(
    `(^|[^A-Za-z0-9_./-])${escapeRegExp(normalizedCommand)}(?=$|[^A-Za-z0-9_./-])`,
    "mu"
  );
  return commandPattern.test(normalizedMarkdown);
}

function parseMarkdownHeadingLine(lineValue) {
  const line = String(lineValue ?? "");
  const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2].trim()
  };
}

function getMarkdownHeadingSection(markdown, heading) {
  const normalizedHeading = String(heading ?? "").trim();
  if (!normalizedHeading) {
    return null;
  }

  const normalizedMarkdown = String(markdown ?? "").replace(/\r\n?/gu, "\n");
  const lines = normalizedMarkdown.split("\n");
  let headingLineIndex = -1;
  let headingLevel = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const parsedHeading = parseMarkdownHeadingLine(lines[lineIndex]);
    if (!parsedHeading || parsedHeading.text !== normalizedHeading) {
      continue;
    }

    headingLineIndex = lineIndex;
    headingLevel = parsedHeading.level;
    break;
  }

  if (headingLineIndex === -1) {
    return null;
  }

  let sectionEndLineIndex = lines.length;
  for (let lineIndex = headingLineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const parsedHeading = parseMarkdownHeadingLine(lines[lineIndex]);
    if (!parsedHeading || parsedHeading.level > headingLevel) {
      continue;
    }

    sectionEndLineIndex = lineIndex;
    break;
  }

  return lines.slice(headingLineIndex + 1, sectionEndLineIndex).join("\n");
}

function getOutputShapeMarkerFromOutputContractSection(sectionMarkdown) {
  const normalizedSectionMarkdown = String(sectionMarkdown ?? "").replace(/\r\n?/gu, "\n");
  const markerPattern = new RegExp(
    `^${escapeRegExp(SKILL_ENTRY_OUTPUT_SHAPE_MARKER_PREFIX)}\\s*(\\S+)\\s*$`,
    "mu"
  );
  const markerMatch = markerPattern.exec(normalizedSectionMarkdown);
  if (!markerMatch) {
    return null;
  }

  return markerMatch[1].trim();
}

function getPathStat(pathValue, { statFn }) {
  try {
    return statFn(pathValue);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function toSkillId(entry, index) {
  return isNonEmptyString(entry?.id)
    ? entry.id.trim()
    : `inventory[${index}]`;
}

function createGovernedSkillError({
  skillId,
  code,
  message,
  path,
  heading,
  command,
  index
}) {
  const error = {
    skillId,
    code,
    message
  };

  if (typeof index === "number") {
    error.index = index;
  }

  if (path !== undefined) {
    error.path = path;
  }

  if (heading !== undefined) {
    error.heading = heading;
  }

  if (command !== undefined) {
    error.command = command;
  }

  return error;
}

function createGovernedSkillReport({ inventory, errors }) {
  return {
    ok: errors.length === 0,
    checkedSkills: Array.isArray(inventory) ? inventory.length : 0,
    errors
  };
}

function validateReferencedFiles({ entry, skillId, errors, repositoryRoot, statFn }) {
  if (!Array.isArray(entry.referencedFiles)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_referenced_files",
      message: "referencedFiles must be an array"
    }));
    return;
  }

  for (let index = 0; index < entry.referencedFiles.length; index += 1) {
    const referencedPath = entry.referencedFiles[index];
    if (!isNonEmptyString(referencedPath)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "invalid_referenced_file_path",
        message: `referencedFiles[${index}] must be a non-empty string`,
        index
      }));
      continue;
    }

    const absolutePath = resolveFromRepositoryRoot(repositoryRoot, referencedPath);
    const pathStat = getPathStat(absolutePath, { statFn });
    if (!pathStat) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "missing_referenced_file",
        message: `referenced file does not exist: ${normalizePath(referencedPath)}`,
        path: normalizePath(referencedPath),
        index
      }));
    }
  }
}

function validateReferencedCommands({ entry, skillId, errors }) {
  if (!Array.isArray(entry.referencedCommands)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_referenced_commands",
      message: "referencedCommands must be an array"
    }));
    return;
  }

  for (let index = 0; index < entry.referencedCommands.length; index += 1) {
    const command = entry.referencedCommands[index];
    if (!isNonEmptyString(command)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "invalid_referenced_command",
        message: `referencedCommands[${index}] must be a non-empty string`,
        index
      }));
    }
  }
}

function isRoleSpecificAgentDocPath(pathValue) {
  if (!isNonEmptyString(pathValue)) {
    return false;
  }

  const normalizedPath = normalizePath(pathValue);
  return normalizedPath.startsWith("docs/agents/")
    && normalizedPath.endsWith(".md")
    && normalizedPath !== COMMON_ROLE_DOC_PATH;
}

function validateRoleDocHeadingDependencies({ entry, skillId, errors }) {
  if (!Array.isArray(entry.referencedFiles)) {
    return;
  }
  const requiredDocHeadings = Array.isArray(entry.requiredDocHeadings)
    ? entry.requiredDocHeadings
    : [];

  const referencedRoleDocPaths = new Set(
    entry.referencedFiles
      .filter((pathValue) => isRoleSpecificAgentDocPath(pathValue))
      .map((pathValue) => normalizePath(pathValue))
  );

  if (referencedRoleDocPaths.size === 0) {
    return;
  }

  const declaredHeadingsByPath = new Map();
  for (const headingRequirement of requiredDocHeadings) {
    if (!headingRequirement || typeof headingRequirement !== "object" || Array.isArray(headingRequirement)) {
      continue;
    }

    if (!isNonEmptyString(headingRequirement.path) || !Array.isArray(headingRequirement.headings)) {
      continue;
    }

    const requirementPath = normalizePath(headingRequirement.path);
    const headingSet = declaredHeadingsByPath.get(requirementPath) ?? new Set();
    for (const headingValue of headingRequirement.headings) {
      if (!isNonEmptyString(headingValue)) {
        continue;
      }

      headingSet.add(headingValue.trim());
    }
    declaredHeadingsByPath.set(requirementPath, headingSet);
  }

  const validateRequiredPathHeadings = (pathValue, requiredHeadings) => {
    const declaredHeadings = declaredHeadingsByPath.get(pathValue);
    if (!declaredHeadings) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "missing_required_role_doc_heading_dependency_path",
        message: `requiredDocHeadings must declare path when role-doc dependency exists: ${pathValue}`,
        path: pathValue
      }));
      return;
    }

    for (const requiredHeading of requiredHeadings) {
      if (!declaredHeadings.has(requiredHeading)) {
        errors.push(createGovernedSkillError({
          skillId,
          code: "missing_required_role_doc_heading_dependency",
          message: `requiredDocHeadings for ${pathValue} must include heading: ${requiredHeading}`,
          path: pathValue,
          heading: requiredHeading
        }));
      }
    }
  };

  validateRequiredPathHeadings(COMMON_ROLE_DOC_PATH, ROLE_DOC_REQUIRED_COMMON_HEADINGS);

  for (const roleDocPath of referencedRoleDocPaths) {
    validateRequiredPathHeadings(roleDocPath, ROLE_DOC_REQUIRED_ROLE_HEADINGS);
  }
}

function validateRequiredDocHeadingsDefinition({ entry, skillId, errors, repositoryRoot, statFn }) {
  if (entry.requiredDocHeadings === undefined) {
    validateRoleDocHeadingDependencies({
      entry,
      skillId,
      errors
    });
    return;
  }

  const normalizedReferencedFiles = Array.isArray(entry.referencedFiles)
    ? new Set(
      entry.referencedFiles
        .filter((pathValue) => isNonEmptyString(pathValue))
        .map((pathValue) => normalizePath(pathValue))
    )
    : null;

  if (!Array.isArray(entry.requiredDocHeadings)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_required_doc_headings",
      message: "requiredDocHeadings must be an array when provided"
    }));
    return;
  }

  for (let index = 0; index < entry.requiredDocHeadings.length; index += 1) {
    const headingRequirement = entry.requiredDocHeadings[index];
    if (!headingRequirement || typeof headingRequirement !== "object" || Array.isArray(headingRequirement)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "invalid_required_doc_heading_requirement",
        message: `requiredDocHeadings[${index}] must be an object`,
        index
      }));
      continue;
    }

    const requirementPath = headingRequirement.path;
    if (!isNonEmptyString(requirementPath)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "invalid_required_doc_heading_path",
        message: `requiredDocHeadings[${index}].path must be a non-empty string`,
        index
      }));
    } else {
      const normalizedRequirementPath = normalizePath(requirementPath);
      if (normalizedReferencedFiles && !normalizedReferencedFiles.has(normalizedRequirementPath)) {
        errors.push(createGovernedSkillError({
          skillId,
          code: "undeclared_required_doc_dependency",
          message: `requiredDocHeadings[${index}].path must also be declared in referencedFiles: ${normalizedRequirementPath}`,
          path: normalizedRequirementPath,
          index
        }));
      }

      const absolutePath = resolveFromRepositoryRoot(repositoryRoot, requirementPath);
      const pathStat = getPathStat(absolutePath, { statFn });
      if (!pathStat) {
        errors.push(createGovernedSkillError({
          skillId,
          code: "missing_required_doc_heading_file",
          message: `required doc file does not exist: ${normalizedRequirementPath}`,
          path: normalizedRequirementPath,
          index
        }));
      }
    }

    if (!Array.isArray(headingRequirement.headings)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "invalid_required_doc_heading_list",
        message: `requiredDocHeadings[${index}].headings must be an array`,
        index
      }));
      continue;
    }

    for (let headingIndex = 0; headingIndex < headingRequirement.headings.length; headingIndex += 1) {
      const heading = headingRequirement.headings[headingIndex];
      if (!isNonEmptyString(heading)) {
        errors.push(createGovernedSkillError({
          skillId,
          code: "invalid_required_doc_heading",
          message: `requiredDocHeadings[${index}].headings[${headingIndex}] must be a non-empty string`,
          index: headingIndex
        }));
      }
    }
  }

  validateRoleDocHeadingDependencies({
    entry,
    skillId,
    errors
  });
}

function validateUniqueSkillIds({ inventory, errors }) {
  const firstIndexBySkillId = new Map();

  for (let entryIndex = 0; entryIndex < inventory.length; entryIndex += 1) {
    const entry = inventory[entryIndex];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !isNonEmptyString(entry.id)) {
      continue;
    }

    const skillId = entry.id.trim();
    if (!firstIndexBySkillId.has(skillId)) {
      firstIndexBySkillId.set(skillId, entryIndex);
      continue;
    }

    const firstIndex = firstIndexBySkillId.get(skillId);
    errors.push(createGovernedSkillError({
      skillId,
      code: "duplicate_skill_id",
      message: `duplicate governed skill id "${skillId}" at inventory[${entryIndex}] (first declared at inventory[${firstIndex}])`,
      index: entryIndex
    }));
  }
}

function validateDefinitionEntry({ entry, entryIndex, errors, repositoryRoot, statFn }) {
  const skillId = toSkillId(entry, entryIndex);

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_inventory_entry",
      message: "governed skill inventory entries must be objects",
      index: entryIndex
    }));
    return;
  }

  if (!isNonEmptyString(entry.id)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_id",
      message: "id must be a non-empty string"
    }));
  }

  if (!isNonEmptyString(entry.owner)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_owner",
      message: "owner must be a non-empty string"
    }));
  }

  if (!isNonEmptyString(entry.entryPath)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "invalid_entry_path",
      message: "entryPath must be a non-empty string"
    }));
  } else {
    const normalizedEntryPath = normalizePath(entry.entryPath);
    const absoluteEntryPath = resolveFromRepositoryRoot(repositoryRoot, entry.entryPath);
    const entryPathStat = getPathStat(absoluteEntryPath, { statFn });
    if (!entryPathStat) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "missing_entry_path",
        message: `entryPath does not exist: ${normalizedEntryPath}`,
        path: normalizedEntryPath
      }));
    }
  }

  validateReferencedFiles({
    entry,
    skillId,
    errors,
    repositoryRoot,
    statFn
  });

  validateReferencedCommands({
    entry,
    skillId,
    errors
  });

  if (!GOVERNED_SKILL_OUTPUT_SHAPES.includes(entry.expectedOutputShape)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "unsupported_expected_output_shape",
      message: `expectedOutputShape must be one of: ${GOVERNED_SKILL_OUTPUT_SHAPES.join(", ")}`
    }));
  }

  validateRequiredDocHeadingsDefinition({
    entry,
    skillId,
    errors,
    repositoryRoot,
    statFn
  });
}

export function validateGovernedSkillDefinitions({
  inventory = GOVERNED_SKILLS,
  repositoryRoot = REPOSITORY_ROOT,
  statFn = statSync
} = {}) {
  const errors = [];

  if (!Array.isArray(inventory)) {
    errors.push(createGovernedSkillError({
      skillId: "inventory",
      code: "invalid_inventory",
      message: "governed skill inventory must be an array"
    }));
    return createGovernedSkillReport({ inventory: [], errors });
  }

  validateUniqueSkillIds({
    inventory,
    errors
  });

  for (let entryIndex = 0; entryIndex < inventory.length; entryIndex += 1) {
    validateDefinitionEntry({
      entry: inventory[entryIndex],
      entryIndex,
      errors,
      repositoryRoot,
      statFn
    });
  }

  return createGovernedSkillReport({ inventory, errors });
}

function auditCommandReferences({
  entry,
  skillId,
  skillEntryMarkdown,
  errors
}) {
  if (!Array.isArray(entry.referencedCommands)) {
    return;
  }

  for (const commandValue of entry.referencedCommands) {
    if (!isNonEmptyString(commandValue)) {
      continue;
    }

    const command = commandValue.trim();
    if (!hasCommandLiteral(skillEntryMarkdown, command)) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "missing_referenced_command_literal",
        message: `entryPath is missing referenced command literal: ${command}`,
        command
      }));
    }
  }
}

function auditEntryOutputContract({
  entry,
  skillId,
  skillEntryMarkdown,
  errors
}) {
  if (!hasMarkdownHeading(skillEntryMarkdown, SKILL_ENTRY_OUTPUT_CONTRACT_HEADING)) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "missing_output_contract_heading",
      message: `entryPath is missing required heading: ${SKILL_ENTRY_OUTPUT_CONTRACT_HEADING}`,
      heading: SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
    }));
    return;
  }

  const outputContractSection = getMarkdownHeadingSection(
    skillEntryMarkdown,
    SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
  );
  if (outputContractSection === null) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "missing_output_contract_heading",
      message: `entryPath is missing required heading: ${SKILL_ENTRY_OUTPUT_CONTRACT_HEADING}`,
      heading: SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
    }));
    return;
  }

  const expectedOutputShape = String(entry.expectedOutputShape ?? "").trim();
  const actualOutputShapeMarker = getOutputShapeMarkerFromOutputContractSection(outputContractSection);
  if (!actualOutputShapeMarker) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "missing_output_contract_shape_marker",
      message: `Output Contract section must include marker: ${SKILL_ENTRY_OUTPUT_SHAPE_MARKER_PREFIX} ${expectedOutputShape}`,
      heading: SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
    }));
    return;
  }

  if (actualOutputShapeMarker !== expectedOutputShape) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "mismatched_output_contract_shape_marker",
      message: `Output Contract shape marker mismatch: expected ${expectedOutputShape}, received ${actualOutputShapeMarker}`,
      heading: SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
    }));
  }
}

function auditRequiredDocHeadings({
  entry,
  skillId,
  repositoryRoot,
  statFn,
  readFileFn,
  errors
}) {
  if (!Array.isArray(entry.requiredDocHeadings)) {
    return;
  }

  for (const headingRequirement of entry.requiredDocHeadings) {
    if (!headingRequirement || typeof headingRequirement !== "object" || Array.isArray(headingRequirement)) {
      continue;
    }

    if (!isNonEmptyString(headingRequirement.path) || !Array.isArray(headingRequirement.headings)) {
      continue;
    }

    const normalizedRequirementPath = normalizePath(headingRequirement.path);
    const absoluteRequirementPath = resolveFromRepositoryRoot(repositoryRoot, headingRequirement.path);
    const requirementStat = getPathStat(absoluteRequirementPath, { statFn });
    if (!requirementStat) {
      continue;
    }

    let markdown;
    try {
      markdown = readFileFn(absoluteRequirementPath, "utf8");
    } catch (error) {
      const reason = error instanceof Error && error.message
        ? error.message
        : "unknown read error";
      errors.push(createGovernedSkillError({
        skillId,
        code: "required_doc_heading_file_unreadable",
        message: `required doc file is unreadable: ${normalizedRequirementPath} (${reason})`,
        path: normalizedRequirementPath
      }));
      continue;
    }

    for (const headingValue of headingRequirement.headings) {
      if (!isNonEmptyString(headingValue)) {
        continue;
      }

      const heading = headingValue.trim();
      if (!hasMarkdownHeading(markdown, heading)) {
        errors.push(createGovernedSkillError({
          skillId,
          code: "missing_required_heading",
          message: `required heading is missing: ${heading} in ${normalizedRequirementPath}`,
          heading,
          path: normalizedRequirementPath
        }));
      }
    }
  }
}

function getOutputContractShapeMarker(skillEntryMarkdown) {
  const outputContractSection = getMarkdownHeadingSection(
    skillEntryMarkdown,
    SKILL_ENTRY_OUTPUT_CONTRACT_HEADING
  );
  if (outputContractSection === null) {
    return null;
  }

  return getOutputShapeMarkerFromOutputContractSection(outputContractSection);
}

function auditMirrorSkillParity({
  entry,
  skillId,
  repositoryRoot,
  statFn,
  readFileFn,
  skillEntryMarkdown,
  errors
}) {
  const mirrorEntryPath = toMirrorSkillEntryPath(entry.entryPath);
  const absoluteMirrorEntryPath = resolveFromRepositoryRoot(repositoryRoot, mirrorEntryPath);
  const mirrorEntryPathStat = getPathStat(absoluteMirrorEntryPath, { statFn });
  if (!mirrorEntryPathStat) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "missing_mirror_entry_path",
      message: `mirror entryPath does not exist: ${mirrorEntryPath}`,
      path: mirrorEntryPath
    }));
    return;
  }

  let mirrorSkillEntryMarkdown;
  try {
    mirrorSkillEntryMarkdown = readFileFn(absoluteMirrorEntryPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error && error.message
      ? error.message
      : "unknown read error";
    errors.push(createGovernedSkillError({
      skillId,
      code: "mirror_entry_path_unreadable",
      message: `mirror entryPath is unreadable: ${mirrorEntryPath} (${reason})`,
      path: mirrorEntryPath
    }));
    return;
  }

  for (const heading of GOVERNED_SKILL_REQUIRED_ENTRY_HEADINGS) {
    const repoHasHeading = hasMarkdownHeading(skillEntryMarkdown, heading);
    const mirrorHasHeading = hasMarkdownHeading(mirrorSkillEntryMarkdown, heading);
    if (repoHasHeading && !mirrorHasHeading) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "missing_mirror_required_heading",
        message: `mirror entryPath is missing required heading: ${heading}`,
        heading,
        path: mirrorEntryPath
      }));
    } else if (!repoHasHeading && mirrorHasHeading) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "stale_mirror_required_heading",
        message: `mirror entryPath has stale required heading that is not present in repo entryPath: ${heading}`,
        heading,
        path: mirrorEntryPath
      }));
    }
  }

  const repoOutputShapeMarker = getOutputContractShapeMarker(skillEntryMarkdown);
  const mirrorOutputShapeMarker = getOutputContractShapeMarker(mirrorSkillEntryMarkdown);
  if (repoOutputShapeMarker !== mirrorOutputShapeMarker) {
    errors.push(createGovernedSkillError({
      skillId,
      code: "mismatched_mirror_output_contract_shape_marker",
      message: `mirror Output Contract shape marker mismatch: repo=${repoOutputShapeMarker ?? "missing"}, mirror=${mirrorOutputShapeMarker ?? "missing"}`,
      heading: SKILL_ENTRY_OUTPUT_CONTRACT_HEADING,
      path: mirrorEntryPath
    }));
  }

  if (!Array.isArray(entry.referencedCommands)) {
    return;
  }

  for (const commandValue of entry.referencedCommands) {
    if (!isNonEmptyString(commandValue)) {
      continue;
    }

    const command = commandValue.trim();
    const repoHasCommand = hasCommandLiteral(skillEntryMarkdown, command);
    const mirrorHasCommand = hasCommandLiteral(mirrorSkillEntryMarkdown, command);
    if (repoHasCommand !== mirrorHasCommand) {
      errors.push(createGovernedSkillError({
        skillId,
        code: "mismatched_mirror_referenced_command_literal",
        message: `mirror referenced command literal mismatch for "${command}": repo=${repoHasCommand}, mirror=${mirrorHasCommand}`,
        command,
        path: mirrorEntryPath
      }));
    }
  }
}

export function validateGovernedSkills({
  inventory = GOVERNED_SKILLS,
  repositoryRoot = REPOSITORY_ROOT,
  statFn = statSync,
  readFileFn = readFileSync
} = {}) {
  const definitionReport = validateGovernedSkillDefinitions({
    inventory,
    repositoryRoot,
    statFn
  });
  const errors = [...definitionReport.errors];

  if (!Array.isArray(inventory)) {
    return createGovernedSkillReport({ inventory: [], errors });
  }

  for (let entryIndex = 0; entryIndex < inventory.length; entryIndex += 1) {
    const entry = inventory[entryIndex];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const skillId = toSkillId(entry, entryIndex);
    if (!isNonEmptyString(entry.entryPath)) {
      continue;
    }

    const normalizedEntryPath = normalizePath(entry.entryPath);
    const absoluteEntryPath = resolveFromRepositoryRoot(repositoryRoot, entry.entryPath);
    const entryPathStat = getPathStat(absoluteEntryPath, { statFn });
    if (!entryPathStat) {
      continue;
    }

    let skillEntryMarkdown;
    try {
      skillEntryMarkdown = readFileFn(absoluteEntryPath, "utf8");
    } catch (error) {
      const reason = error instanceof Error && error.message
        ? error.message
        : "unknown read error";
      errors.push(createGovernedSkillError({
        skillId,
        code: "entry_path_unreadable",
        message: `entryPath is unreadable: ${normalizedEntryPath} (${reason})`,
        path: normalizedEntryPath
      }));
      continue;
    }

    auditCommandReferences({
      entry,
      skillId,
      skillEntryMarkdown,
      errors
    });

    auditEntryOutputContract({
      entry,
      skillId,
      skillEntryMarkdown,
      errors
    });

    auditRequiredDocHeadings({
      entry,
      skillId,
      repositoryRoot,
      statFn,
      readFileFn,
      errors
    });

    auditMirrorSkillParity({
      entry,
      skillId,
      repositoryRoot,
      statFn,
      readFileFn,
      skillEntryMarkdown,
      errors
    });
  }

  return createGovernedSkillReport({ inventory, errors });
}

export function auditGovernedSkills(options = {}) {
  return validateGovernedSkills(options);
}
