import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateWorkOrder } from "../src/kernel/work-order.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "work-orders");

test("valid lifecycle Work Order fixtures validate with expected executability", async () => {
  const cases = [
    ["valid-active.json", true],
    ["valid-planned.json", false],
    ["valid-completed.json", false],
  ];

  for (const [fixtureName, expectedExecutable] of cases) {
    const workOrder = await loadFixture(fixtureName);
    const result = validateWorkOrder(workOrder);

    assert.equal(result.success, true, fixtureName);
    assert.equal(result.status, "valid", fixtureName);
    assert.equal(result.executable, expectedExecutable, fixtureName);
    assert.deepEqual(result.hardFailures, [], fixtureName);
    assert.deepEqual(result.warnings, [], fixtureName);
    assert.deepEqual(result.errors, [], fixtureName);
  }
});

async function loadFixture(fixtureName) {
  const fixturePath = path.join(fixtureDir, fixtureName);
  return JSON.parse(await readFile(fixturePath, "utf8"));
}
