import { createTaskPacket } from "../src/contracts.js";
import { createProcessWorkerBackend } from "../src/process-worker-backend.js";

function createSmokePacket() {
  return createTaskPacket({
    id: "spike-smoke-implementer",
    parentTaskId: "spike-smoke",
    role: "implementer",
    risk: "low",
    goal: "Attempt one non-interactive isolated implementer worker launch.",
    nonGoals: [
      "Do not edit files outside the one-file allowlist.",
      "Do not recursively delegate to additional workers."
    ],
    allowedFiles: ["examples/smoke-worker-output.md"],
    forbiddenFiles: [],
    acceptanceChecks: ["Allowed file contains exact text SMOKE TEST OK."],
    stopConditions: ["Stop if the worker launcher cannot run non-interactively."],
    contextFiles: [],
    commands: []
  });
}

async function main() {
  const backend = createProcessWorkerBackend();
  const packet = createSmokePacket();
  const context = {
    workflowId: "spike-smoke-local"
  };

  const result = await backend.run(packet, context);
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "success") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
