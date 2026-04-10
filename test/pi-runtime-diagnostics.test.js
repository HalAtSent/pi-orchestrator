import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPiWorkerRuntimeStatus,
  inspectPiWorkerRuntime
} from "../src/pi-runtime-diagnostics.js";

test("worker runtime diagnostics reports host.runWorker support", () => {
  const status = inspectPiWorkerRuntime({
    host: {
      async runWorker() {}
    },
    supportedRoles: ["implementer", "verifier"]
  });

  assert.equal(status.hasHostRunWorker, true);
  assert.equal(status.hasRuntimeRunWorker, false);
  assert.equal(status.selectedInvoker, "host.runWorker");
  assert.deepEqual(status.supportedRoles, ["implementer", "verifier"]);
});

test("worker runtime diagnostics reports host.runtime.runWorker support", () => {
  const status = inspectPiWorkerRuntime({
    host: {
      runtime: {
        async runWorker() {}
      }
    },
    supportedRoles: ["explorer", "implementer", "reviewer", "verifier"]
  });

  assert.equal(status.hasHostRunWorker, false);
  assert.equal(status.hasRuntimeRunWorker, true);
  assert.equal(status.selectedInvoker, "host.runtime.runWorker");
});

test("worker runtime diagnostics reports no runtime worker support when absent", () => {
  const status = inspectPiWorkerRuntime({
    host: {},
    supportedRoles: ["implementer"]
  });

  assert.equal(status.hasHostRunWorker, false);
  assert.equal(status.hasRuntimeRunWorker, false);
  assert.equal(status.selectedInvoker, "none");
  assert.match(formatPiWorkerRuntimeStatus(status), /selected_invoker: none/);
});
