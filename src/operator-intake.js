function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (normalized.length === 0) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function splitList(value) {
  return String(value)
    .split(/\r?\n|,|;|\band\b/giu)
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return uniqueCaseInsensitive(value);
  }

  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    if (normalized.length === 0) {
      return [];
    }

    return uniqueCaseInsensitive(splitList(normalized));
  }

  return uniqueCaseInsensitive([value]);
}

function parseRawArgs(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return structuredClone(args);
  }

  if (Array.isArray(args)) {
    return parseRawArgs(args.join(" "));
  }

  if (typeof args === "string") {
    const raw = args.trim();
    assert(raw.length > 0, "Provide a plain-English idea or a JSON object.");

    if (raw.startsWith("{")) {
      return JSON.parse(raw);
    }

    return { idea: raw };
  }

  throw new Error("Provide a plain-English idea or a JSON object.");
}

function parseBooleanLike(value, { defaultValue = false } = {}) {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "approve", "approved", "start"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "n", "hold", "wait"].includes(normalized)) {
      return false;
    }
  }

  throw new Error("approve must be a boolean-like value (true/false).");
}

const WRAPPER_QUOTES = Object.freeze([
  ["\"", "\""],
  ["'", "'"]
]);

function stripSurroundingQuotes(value) {
  let unwrapped = String(value).trim();

  while (unwrapped.length >= 2) {
    let changed = false;

    for (const [open, close] of WRAPPER_QUOTES) {
      if (unwrapped.startsWith(open) && unwrapped.endsWith(close)) {
        unwrapped = unwrapped.slice(open.length, unwrapped.length - close.length).trim();
        changed = true;
        break;
      }
    }

    if (!changed) {
      break;
    }
  }

  return unwrapped;
}

function extractApprovalTokenFromIdea(idea) {
  const rawIdea = String(idea).trim();
  if (rawIdea.length === 0) {
    return {
      idea: "",
      approvalRequested: false
    };
  }

  const hasApprovalToken = /(^|\s)--approve(?=\s|$)/i.test(rawIdea);
  if (!hasApprovalToken) {
    return {
      idea: stripSurroundingQuotes(rawIdea),
      approvalRequested: false
    };
  }

  return {
    idea: stripSurroundingQuotes(rawIdea.replace(/(^|\s)--approve(?=\s|$)/gi, " ").trim()),
    approvalRequested: true
  };
}

const SECTION_PATTERNS = [
  {
    section: "audience",
    inline: /^(audience|users?|target\s+(users?|audience))\s*[:\-]\s*(.+)$/i,
    header: /^(audience|users?|target\s+(users?|audience))\s*:\s*$/i
  },
  {
    section: "constraints",
    inline: /^(constraints?|guardrails?|requirements?)\s*[:\-]\s*(.+)$/i,
    header: /^(constraints?|guardrails?|requirements?)\s*:\s*$/i
  },
  {
    section: "successSignals",
    inline: /^(success(\s+signals?)?|definition\s+of\s+done|done|outcomes?)\s*[:\-]\s*(.+)$/i,
    header: /^(success(\s+signals?)?|definition\s+of\s+done|done|outcomes?)\s*:\s*$/i
  },
  {
    section: "stackPreferences",
    inline: /^(preferences?|stack(\s+preferences?)?|tech(\s+stack)?)\s*[:\-]\s*(.+)$/i,
    header: /^(preferences?|stack(\s+preferences?)?|tech(\s+stack)?)\s*:\s*$/i
  },
  {
    section: "nonGoals",
    inline: /^(non[-\s]?goals?|out\s+of\s+scope|avoid)\s*[:\-]\s*(.+)$/i,
    header: /^(non[-\s]?goals?|out\s+of\s+scope|avoid)\s*:\s*$/i
  }
];

function inferAudienceFromGoal(goal) {
  const match = goal.match(/\bfor\s+([^.,;:]+?)(?:\s+(?:who|that|using|with)\b|[.,;:]|$)/i);
  if (!match) {
    return [];
  }

  const candidate = normalizeWhitespace(match[1]);
  if (candidate.length < 3) {
    return [];
  }

  if (/\b(build|create|make|ship|launch|implement)\b/i.test(candidate)) {
    return [];
  }

  return [candidate];
}

function inferConstraintsFromGoal(goal) {
  const sentenceCandidates = goal
    .split(/[.!?]+/u)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

  return sentenceCandidates.filter((sentence) => (
    /\b(must|must not|cannot|can't|without|within|avoid|no\b)\b/i.test(sentence)
  ));
}

function inferSuccessSignalsFromGoal(goal) {
  const signals = [];
  const successMeansMatch = goal.match(/\bsuccess\s+means\s+([^.!?]+)/i);
  if (successMeansMatch) {
    signals.push(successMeansMatch[1]);
  }

  const shouldBeAbleMatch = goal.match(/\busers?\s+should\s+be\s+able\s+to\s+([^.!?]+)/i);
  if (shouldBeAbleMatch) {
    signals.push(`Users should be able to ${shouldBeAbleMatch[1]}`);
  }

  return uniqueCaseInsensitive(signals);
}

function extractIdeaSections(idea) {
  const extracted = {
    goal: "",
    audience: [],
    constraints: [],
    successSignals: [],
    stackPreferences: [],
    nonGoals: []
  };

  const goalLines = [];
  let activeSection = null;

  for (const rawLine of String(idea).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      activeSection = null;
      continue;
    }

    let matchedHeader = false;
    for (const pattern of SECTION_PATTERNS) {
      if (pattern.header.test(line)) {
        activeSection = pattern.section;
        matchedHeader = true;
        break;
      }
    }

    if (matchedHeader) {
      continue;
    }

    if (activeSection && /^[-*]\s+/u.test(line)) {
      extracted[activeSection] = uniqueCaseInsensitive([
        ...extracted[activeSection],
        ...splitList(line.replace(/^[-*]\s+/u, ""))
      ]);
      continue;
    }

    let matchedInline = false;
    for (const pattern of SECTION_PATTERNS) {
      const match = line.match(pattern.inline);
      if (match) {
        extracted[pattern.section] = uniqueCaseInsensitive([
          ...extracted[pattern.section],
          ...splitList(match[match.length - 1])
        ]);
        activeSection = pattern.section;
        matchedInline = true;
        break;
      }
    }

    if (matchedInline) {
      continue;
    }

    activeSection = null;
    goalLines.push(line);
  }

  extracted.goal = normalizeWhitespace(goalLines.join(" "));
  return extracted;
}

export function createOperatorIntake(args) {
  const parsed = parseRawArgs(args);
  const ideaSource = parsed.idea ?? parsed.goal ?? "";
  const { idea, approvalRequested: approvalFromToken } = extractApprovalTokenFromIdea(ideaSource);
  const usingGoalAsIdea = parsed.idea === undefined && parsed.goal !== undefined;

  const extracted = extractIdeaSections(idea);
  const explicitGoal = usingGoalAsIdea
    ? ""
    : (typeof parsed.goal === "string" ? normalizeWhitespace(parsed.goal) : "");

  const goal = normalizeWhitespace(explicitGoal || extracted.goal || idea);
  assert(goal.length > 0, "Provide a plain-English idea with at least one sentence.");

  const explicitApproval = parsed.approve ?? parsed.approved ?? parsed.approval;
  const approvalRequested = explicitApproval === undefined
    ? approvalFromToken
    : parseBooleanLike(explicitApproval, { defaultValue: approvalFromToken });

  const targetUsers = uniqueCaseInsensitive([
    ...extracted.audience,
    ...normalizeStringArray(parsed.targetUsers),
    ...normalizeStringArray(parsed.audience),
    ...normalizeStringArray(parsed.targetAudience),
    ...inferAudienceFromGoal(goal)
  ]);

  const constraints = uniqueCaseInsensitive([
    ...extracted.constraints,
    ...normalizeStringArray(parsed.constraints),
    ...inferConstraintsFromGoal(goal)
  ]);

  const successSignals = uniqueCaseInsensitive([
    ...extracted.successSignals,
    ...normalizeStringArray(parsed.successSignals),
    ...normalizeStringArray(parsed.successCriteria),
    ...inferSuccessSignalsFromGoal(goal)
  ]);

  const stackPreferences = uniqueCaseInsensitive([
    ...extracted.stackPreferences,
    ...normalizeStringArray(parsed.stackPreferences),
    ...normalizeStringArray(parsed.preferences)
  ]);

  const nonGoals = uniqueCaseInsensitive([
    ...extracted.nonGoals,
    ...normalizeStringArray(parsed.nonGoals),
    ...normalizeStringArray(parsed.outOfScope)
  ]);

  const projectName = typeof parsed.projectName === "string" && parsed.projectName.trim().length > 0
    ? parsed.projectName.trim()
    : undefined;
  const projectType = typeof parsed.projectType === "string" && parsed.projectType.trim().length > 0
    ? parsed.projectType.trim()
    : undefined;
  const autonomyMode = typeof parsed.autonomyMode === "string" && parsed.autonomyMode.trim().length > 0
    ? parsed.autonomyMode.trim()
    : "autonomous";

  return {
    idea: normalizeWhitespace(idea || goal),
    goal,
    targetUsers,
    constraints,
    successSignals,
    stackPreferences,
    nonGoals,
    projectName,
    projectType,
    autonomyMode,
    approvalRequested,
    planningInput: {
      goal,
      projectName,
      projectType,
      constraints,
      nonGoals,
      targetUsers,
      stackPreferences,
      successCriteria: successSignals,
      autonomyMode
    }
  };
}

