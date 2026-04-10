import test from "node:test";
import assert from "node:assert/strict";

import { Type } from "../src/schema.js";

test("object schemas do not require properties that provide defaults", () => {
  const schema = Type.Object({
    goal: Type.String(),
    allowedFiles: Type.Array(Type.String(), { default: [] }),
    approvedHighRisk: Type.Boolean({ default: false }),
    maxRepairLoops: Type.Integer({ default: 1 }),
    projectName: Type.Optional(Type.String())
  });

  assert.deepEqual(schema.required, ["goal"]);
  assert.equal(schema.properties.allowedFiles.default.length, 0);
  assert.equal(schema.properties.approvedHighRisk.default, false);
  assert.equal(schema.properties.maxRepairLoops.default, 1);
});
