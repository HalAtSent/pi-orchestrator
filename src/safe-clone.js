const DEFAULT_UNCLONEABLE_SENTINEL = "[uncloneable]";
const DEFAULT_CIRCULAR_SENTINEL = "[circular]";

function cloneArrayBufferView(view, uncloneableSentinel) {
  try {
    if (typeof view.slice === "function") {
      return view.slice(0);
    }

    const Constructor = view.constructor;
    return new Constructor(view);
  } catch {
    return uncloneableSentinel;
  }
}

function sanitizeFallbackValue(value, options, seen) {
  if (value === null || value === undefined) {
    return value;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean" || valueType === "bigint") {
    return value;
  }

  if (valueType === "symbol" || valueType === "function") {
    return options.uncloneableSentinel;
  }

  if (seen.has(value)) {
    return options.circularSentinel;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    const cloned = value.map((entry) => sanitizeFallbackValue(entry, options, seen));
    seen.delete(value);
    return cloned;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags);
  }

  if (value instanceof Map) {
    seen.add(value);
    const entries = [];
    for (const [key, entryValue] of value.entries()) {
      entries.push([
        sanitizeFallbackValue(key, options, seen),
        sanitizeFallbackValue(entryValue, options, seen)
      ]);
    }
    seen.delete(value);
    return {
      __type: "Map",
      entries
    };
  }

  if (value instanceof Set) {
    seen.add(value);
    const values = [...value].map((entry) => sanitizeFallbackValue(entry, options, seen));
    seen.delete(value);
    return {
      __type: "Set",
      values
    };
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: typeof value.stack === "string" ? value.stack : undefined
    };
  }

  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }

  if (ArrayBuffer.isView(value)) {
    return cloneArrayBufferView(value, options.uncloneableSentinel);
  }

  seen.add(value);
  const cloned = {};
  let ownKeys = [];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    seen.delete(value);
    return options.uncloneableSentinel;
  }

  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      continue;
    }

    let propertyValue;
    try {
      propertyValue = value[key];
    } catch {
      cloned[key] = options.uncloneableSentinel;
      continue;
    }

    cloned[key] = sanitizeFallbackValue(propertyValue, options, seen);
  }

  const constructorName = value.constructor?.name;
  if (constructorName && constructorName !== "Object") {
    cloned.__type = constructorName;
  }

  seen.delete(value);
  return cloned;
}

export function safeClone(value, {
  uncloneableSentinel = DEFAULT_UNCLONEABLE_SENTINEL,
  circularSentinel = DEFAULT_CIRCULAR_SENTINEL
} = {}) {
  if (value === undefined) {
    return undefined;
  }

  try {
    return structuredClone(value);
  } catch {
    try {
      return sanitizeFallbackValue(value, {
        uncloneableSentinel,
        circularSentinel
      }, new WeakSet());
    } catch {
      return uncloneableSentinel;
    }
  }
}

export const SAFE_CLONE_DEFAULT_UNCLONEABLE_SENTINEL = DEFAULT_UNCLONEABLE_SENTINEL;
