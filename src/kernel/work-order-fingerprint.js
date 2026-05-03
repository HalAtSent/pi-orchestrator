import crypto from "node:crypto";

const APPROVAL_VOLATILE_FIELDS = new Set([
  "approvalId",
  "approvedAt",
  "approvedBy",
  "approvedFingerprint",
]);

const ORDER_INSENSITIVE_ACTION_CLASS_ARRAY_PATHS = new Set([
  "$.verification.commands[].actionClasses",
  "$.execution.modelToolRoute.tools",
  "$.approval.approvedActionClasses",
]);

export function canonicalJson(value) {
  return serializeCanonical(canonicalize(value, "$"));
}

export function fingerprintWorkOrder(workOrder) {
  const bytes = Buffer.from(canonicalJson(workOrderFingerprintInput(workOrder)), "utf8");
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function workOrderFingerprintInput(workOrder) {
  if (!isPlainObject(workOrder) || !Object.hasOwn(workOrder, "extensions")) {
    return workOrder;
  }

  const input = Object.create(null);

  for (const key of Object.keys(workOrder)) {
    if (key === "extensions") {
      continue;
    }

    input[key] = workOrder[key];
  }

  return input;
}

function canonicalize(value, path) {
  if (Array.isArray(value)) {
    return canonicalizeArray(value, path);
  }

  if (isPlainObject(value)) {
    return canonicalizeObject(value, path);
  }

  return value;
}

function canonicalizeArray(value, path) {
  const canonicalValues = value.map((item) => canonicalize(item, `${path}[]`));

  if (ORDER_INSENSITIVE_ACTION_CLASS_ARRAY_PATHS.has(path)) {
    return [...new Set(canonicalValues)].sort();
  }

  return canonicalValues;
}

function canonicalizeObject(value, path) {
  const canonical = Object.create(null);

  for (const key of Object.keys(value).sort()) {
    if (path === "$.approval" && APPROVAL_VOLATILE_FIELDS.has(key)) {
      continue;
    }

    canonical[key] = canonicalize(value[key], `${path}.${key}`);
  }

  return canonical;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function serializeCanonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item) ?? "null").join(",")}]`;
  }

  if (isPlainObject(value)) {
    const members = [];

    for (const key of Object.keys(value).sort()) {
      const serializedValue = serializeCanonical(value[key]);

      if (serializedValue !== undefined) {
        members.push(`${JSON.stringify(key)}:${serializedValue}`);
      }
    }

    return `{${members.join(",")}}`;
  }

  return JSON.stringify(value);
}
