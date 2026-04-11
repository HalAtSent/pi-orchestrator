function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function parseBooleanFlag(value, {
  flagName = "flag",
  defaultValue = false
} = {}) {
  assert(typeof flagName === "string" && flagName.trim().length > 0, "flagName must be a non-empty string");
  assert(typeof defaultValue === "boolean", "defaultValue must be a boolean");

  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${flagName} must be a boolean or the exact string "true" or "false".`);
}
