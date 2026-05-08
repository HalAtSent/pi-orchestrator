import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateWorkOrder } from "../src/kernel/work-order.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "work-orders");
const repositoryRoot = path.resolve(".");

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

test("missing context Work Order fixture fails with required context hard failure", async () => {
  const workOrder = await loadFixture("invalid-missing-context.json");
  const result = validateWorkOrder(workOrder);
  const expectedHardFailures = [
    {
      path: "$.context",
      code: "required",
      message: "$.context is required.",
    },
  ];

  assert.equal(result.success, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.executable, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.hardFailures, expectedHardFailures);
  assert.deepEqual(result.errors, expectedHardFailures);
  assert.deepEqual(result.hardFailures, result.errors);
});

test("unknown policyProfile Work Order fixture fails with unsupported policy hard failure", async () => {
  const workOrder = await loadFixture("invalid-unknown-policy-profile.json");
  const result = validateWorkOrder(workOrder);
  const expectedHardFailures = [
    {
      path: "$.policyProfile",
      code: "unsupported_value",
      message: "Unsupported policyProfile.",
      supported: ["default"],
      actual: "permissive",
    },
  ];

  assert.equal(result.success, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.executable, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.hardFailures, expectedHardFailures);
  assert.deepEqual(result.errors, expectedHardFailures);
  assert.deepEqual(result.hardFailures, result.errors);
});

async function loadFixture(fixtureName) {
  const fixturePath = path.join(fixtureDir, fixtureName);
  const workOrder = JSON.parse(await readFile(fixturePath, "utf8"));

  if (Object.hasOwn(workOrder, "repositoryRoot")) {
    workOrder.repositoryRoot = repositoryRoot;
  }

  return workOrder;
}
