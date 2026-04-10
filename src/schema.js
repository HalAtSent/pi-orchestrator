const OPTIONAL_FLAG = Symbol("optional");

function cloneSchema(schema) {
  return structuredClone(schema);
}

function markOptional(schema) {
  return {
    ...cloneSchema(schema),
    [OPTIONAL_FLAG]: true
  };
}

function unwrapOptional(schema) {
  const copy = { ...schema };
  delete copy[OPTIONAL_FLAG];
  return copy;
}

export const Type = Object.freeze({
  String(options = {}) {
    return {
      type: "string",
      ...cloneSchema(options)
    };
  },

  Integer(options = {}) {
    return {
      type: "integer",
      ...cloneSchema(options)
    };
  },

  Boolean(options = {}) {
    return {
      type: "boolean",
      ...cloneSchema(options)
    };
  },

  Array(items, options = {}) {
    return {
      type: "array",
      items: cloneSchema(items),
      ...cloneSchema(options)
    };
  },

  Optional(schema) {
    return markOptional(schema);
  },

  Object(properties, options = {}) {
    const normalizedProperties = {};
    const required = [];

    for (const [key, value] of Object.entries(properties)) {
      const optional = Boolean(value?.[OPTIONAL_FLAG]);
      normalizedProperties[key] = unwrapOptional(cloneSchema(value));
      const hasDefault = Object.prototype.hasOwnProperty.call(normalizedProperties[key], "default");
      if (!optional && !hasDefault) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties: normalizedProperties,
      required,
      additionalProperties: false,
      ...cloneSchema(options)
    };
  }
});
