import assert from "node:assert/strict";
import test from "node:test";

import { identity } from "../src/helpers.js";

test("helpers.js exports a valid helper module", () => {
  assert.equal(identity("smoke-check"), "smoke-check");
});