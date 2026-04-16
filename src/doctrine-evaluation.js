const CANONICAL_CRITERIA = Object.freeze([
  Object.freeze({
    id: "trustworthy_output",
    question: "Does the harness produce merge-grade output under strict boundaries instead of only sounding autonomous?",
    artifactHooks: Object.freeze([
      "brief.successCriteria",
      "program.completionChecks",
      "program.contracts[].successCriteria"
    ])
  }),
  Object.freeze({
    id: "review_effort",
    question: "Does reviewer effort or decision burden per unit of trustworthy output go down?",
    artifactHooks: Object.freeze([
      "program.integrationPoints",
      "program.completionChecks",
      "program.contracts[].verificationPlan"
    ])
  }),
  Object.freeze({
    id: "evidence_completeness",
    question: "Are approvals, changed surfaces, validation, lineage, and stop reasons captured well enough for truthful review?",
    artifactHooks: Object.freeze([
      "blueprint.qualityGates",
      "program.completionChecks",
      "program.contracts[].verificationPlan",
      "program.contracts[].stopConditions"
    ])
  }),
  Object.freeze({
    id: "policy_violation_blocking",
    question: "Does the harness detect and fail closed on invalid, out-of-scope, or under-approved work?",
    artifactHooks: Object.freeze([
      "blueprint.qualityGates",
      "program.integrationPoints",
      "program.contracts[].stopConditions"
    ])
  }),
  Object.freeze({
    id: "operator_clarity",
    question: "Can an operator tell what happened, what changed, what remains uncertain, and what exact next action is required?",
    artifactHooks: Object.freeze([
      "brief.successCriteria",
      "program.integrationPoints",
      "program.completionChecks"
    ])
  }),
  Object.freeze({
    id: "regression_rework_burden",
    question: "Does accepted output stay durable without avoidable rework, rollback, or repeated review churn?",
    artifactHooks: Object.freeze([
      "blueprint.qualityGates",
      "program.completionChecks",
      "program.contracts[].verificationPlan",
      "program.contracts[].stopConditions"
    ])
  })
]);

export const DOCTRINE_EVALUATION_CRITERION_IDS = Object.freeze(
  CANONICAL_CRITERIA.map((criterion) => criterion.id)
);

export const DOCTRINE_EVALUATION_HOOK_REFS = Object.freeze([
  "brief.successCriteria",
  "blueprint.qualityGates",
  "program.completionChecks",
  "program.integrationPoints",
  "program.contracts[].successCriteria",
  "program.contracts[].verificationPlan",
  "program.contracts[].stopConditions"
]);

export const EVALUATION_COVERAGE_STATUSES = Object.freeze(["covered", "missing"]);

const CRITERION_INDEX = new Map(
  CANONICAL_CRITERIA.map((criterion) => [criterion.id, criterion])
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPlainObject(name, value) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
}

function normalizeString(name, value) {
  assert(typeof value === "string", `${name} must be a non-empty string`);
  const normalized = value.trim();
  assert(normalized.length > 0, `${name} must be a non-empty string`);
  return normalized;
}

function normalizeHookRefs(name, value) {
  assert(Array.isArray(value), `${name} must be an array`);
  const normalizedHooks = value.map((item, index) => normalizeString(`${name}[${index}]`, item));
  const uniqueHooks = [...new Set(normalizedHooks)];

  assert(uniqueHooks.length === normalizedHooks.length, `${name} must not contain duplicate hook refs`);
  for (const hookRef of uniqueHooks) {
    assert(
      DOCTRINE_EVALUATION_HOOK_REFS.includes(hookRef),
      `${name} contains unsupported hook ref: ${hookRef}`
    );
  }

  return uniqueHooks;
}

function assertCanonicalHookRefs(name, hookRefs, canonicalCriterion) {
  const expectedHooks = canonicalCriterion.artifactHooks;
  const matchesCanonicalOrder = hookRefs.length === expectedHooks.length &&
    hookRefs.every((hookRef, index) => hookRef === expectedHooks[index]);

  assert(
    matchesCanonicalOrder,
    `${name} must match canonical hook refs for criterion ${canonicalCriterion.id}: ${expectedHooks.join(", ")}`
  );
}

function assertCanonicalCriterionOrder(name, criteria, {
  idField
}) {
  assert(
    criteria.length === CANONICAL_CRITERIA.length,
    `${name} must contain exactly ${CANONICAL_CRITERIA.length} canonical criteria`
  );

  for (const [index, criterion] of criteria.entries()) {
    const expectedCriterionId = CANONICAL_CRITERIA[index].id;
    const actualCriterionId = criterion[idField];
    assert(
      actualCriterionId === expectedCriterionId,
      `${name}[${index}].${idField} must be canonical id ${expectedCriterionId} at index ${index}`
    );
  }
}

function normalizeCriterion(name, value) {
  assertPlainObject(name, value);
  const id = normalizeString(`${name}.id`, value.id);
  const question = normalizeString(`${name}.question`, value.question);
  const artifactHooks = normalizeHookRefs(`${name}.artifactHooks`, value.artifactHooks);

  assert(
    DOCTRINE_EVALUATION_CRITERION_IDS.includes(id),
    `${name}.id must be one of: ${DOCTRINE_EVALUATION_CRITERION_IDS.join(", ")}`
  );
  const canonicalCriterion = CRITERION_INDEX.get(id);
  assert(canonicalCriterion !== undefined, `${name}.id must map to a canonical doctrine evaluation criterion`);
  assert(
    question === canonicalCriterion.question,
    `${name}.question must match canonical question for criterion ${id}`
  );
  assertCanonicalHookRefs(`${name}.artifactHooks`, artifactHooks, canonicalCriterion);

  return {
    id,
    question,
    artifactHooks
  };
}

function assertUniqueCriterionIds(name, criteria) {
  const ids = criteria.map((criterion) => criterion.id);
  const uniqueIds = new Set(ids);
  assert(uniqueIds.size === ids.length, `${name} must not contain duplicate criterion ids`);
}

export function getDoctrineEvaluationDefinitions() {
  return CANONICAL_CRITERIA.map((criterion) => ({
    id: criterion.id,
    question: criterion.question,
    artifactHooks: [...criterion.artifactHooks]
  }));
}

export function getDoctrineEvaluationDefinitionById(criterionId) {
  return CRITERION_INDEX.get(criterionId) ?? null;
}

export function validateEvaluationCriteria(evaluationCriteria, {
  fieldName = "program.evaluationCriteria"
} = {}) {
  assert(Array.isArray(evaluationCriteria), `${fieldName} must be an array`);
  const normalizedCriteria = evaluationCriteria.map((criterion, index) => {
    return normalizeCriterion(`${fieldName}[${index}]`, criterion);
  });
  assertUniqueCriterionIds(fieldName, normalizedCriteria);
  assertCanonicalCriterionOrder(fieldName, normalizedCriteria, {
    idField: "id"
  });
  return normalizedCriteria;
}

function assertCriterionSpecificHookRefs(name, hookRefs, canonicalCriterion) {
  const allowedHookRefs = new Set(canonicalCriterion.artifactHooks);
  for (const hookRef of hookRefs) {
    assert(
      allowedHookRefs.has(hookRef),
      `${name} contains hook ref not allowed for criterion ${canonicalCriterion.id}: ${hookRef}`
    );
  }
}

function normalizeCoverageEntry(name, value) {
  assertPlainObject(name, value);
  const criterionId = normalizeString(`${name}.criterionId`, value.criterionId);
  const status = normalizeString(`${name}.status`, value.status).toLowerCase();
  const evidenceHooks = normalizeHookRefs(`${name}.evidenceHooks`, value.evidenceHooks);
  const missingHooks = normalizeHookRefs(`${name}.missingHooks`, value.missingHooks);
  const overlappingHooks = evidenceHooks.filter((hookRef) => missingHooks.includes(hookRef));

  assert(
    DOCTRINE_EVALUATION_CRITERION_IDS.includes(criterionId),
    `${name}.criterionId must be one of: ${DOCTRINE_EVALUATION_CRITERION_IDS.join(", ")}`
  );
  assert(
    EVALUATION_COVERAGE_STATUSES.includes(status),
    `${name}.status must be one of: ${EVALUATION_COVERAGE_STATUSES.join(", ")}`
  );
  const canonicalCriterion = CRITERION_INDEX.get(criterionId);
  assert(canonicalCriterion !== undefined, `${name}.criterionId must map to a canonical doctrine evaluation criterion`);
  assertCriterionSpecificHookRefs(`${name}.evidenceHooks`, evidenceHooks, canonicalCriterion);
  assertCriterionSpecificHookRefs(`${name}.missingHooks`, missingHooks, canonicalCriterion);
  assert(
    overlappingHooks.length === 0,
    `${name}.evidenceHooks and ${name}.missingHooks must not overlap for criterion ${criterionId}`
  );

  const canonicalHooks = canonicalCriterion.artifactHooks;
  const partitionHooks = [...new Set([...evidenceHooks, ...missingHooks])];
  const unexpectedHooks = partitionHooks.filter((hookRef) => !canonicalHooks.includes(hookRef));
  const missingCanonicalHooks = canonicalHooks.filter((hookRef) => !partitionHooks.includes(hookRef));
  assert(
    unexpectedHooks.length === 0,
    `${name} must partition canonical hook refs for criterion ${criterionId}; unexpected hooks: ${unexpectedHooks.join(", ")}`
  );
  assert(
    missingCanonicalHooks.length === 0,
    `${name} must partition canonical hook refs for criterion ${criterionId}; missing from evidenceHooks and missingHooks: ${missingCanonicalHooks.join(", ")}`
  );

  if (status === "covered") {
    assert(
      missingHooks.length === 0,
      `${name}.status cannot be covered when missingHooks is non-empty for criterion ${criterionId}`
    );
  } else {
    assert(
      missingHooks.length > 0,
      `${name}.status cannot be missing when canonical hooks are fully covered for criterion ${criterionId}`
    );
  }

  const coveredHooks = evidenceHooks.length === canonicalHooks.length && missingHooks.length === 0;
  assert(
    (status === "covered") === coveredHooks,
    `${name}.status must match canonical hook coverage partition for criterion ${criterionId}`
  );

  return {
    criterionId,
    status,
    evidenceHooks,
    missingHooks
  };
}

export function validateEvaluationCoverage(evaluationCoverage, {
  fieldName = "auditReport.evaluationCoverage"
} = {}) {
  assert(Array.isArray(evaluationCoverage), `${fieldName} must be an array`);
  const normalizedCoverage = evaluationCoverage.map((entry, index) => {
    return normalizeCoverageEntry(`${fieldName}[${index}]`, entry);
  });

  const criterionIds = normalizedCoverage.map((entry) => entry.criterionId);
  const uniqueCriterionIds = new Set(criterionIds);
  assert(
    uniqueCriterionIds.size === criterionIds.length,
    `${fieldName} must not contain duplicate criterion ids`
  );
  assertCanonicalCriterionOrder(fieldName, normalizedCoverage, {
    idField: "criterionId"
  });

  return normalizedCoverage;
}
