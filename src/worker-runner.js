import { createWorkerResult } from "./contracts.js";
import { safeClone } from "./safe-clone.js";

function clone(value) {
  return safeClone(value);
}

function blockedResult(role) {
  return createWorkerResult({
    status: "blocked",
    summary: `No local worker handler is configured for the ${role} role.`,
    changedFiles: [],
    commandsRun: [],
    evidence: [],
    openQuestions: [`Configure a ${role} handler before running the workflow.`]
  });
}

export function createLocalWorkerRunner({ handlers = {} } = {}) {
  const calls = [];

  return {
    async run(packet, context = {}) {
      calls.push({
        packet: clone(packet),
        context: clone(context)
      });

      const handler = handlers[packet.role];
      if (typeof handler !== "function") {
        return blockedResult(packet.role);
      }

      const result = await handler({
        packet: clone(packet),
        context: clone(context)
      });

      return createWorkerResult(result);
    },

    getCalls() {
      return clone(calls);
    }
  };
}

export function createScriptedWorkerRunner(script = []) {
  const steps = clone(script) ?? [];
  const calls = [];
  let index = 0;

  return {
    async run(packet, context = {}) {
      calls.push({
        packet: clone(packet),
        context: clone(context)
      });

      if (index >= steps.length) {
        return createWorkerResult({
          status: "failed",
          summary: `The scripted runner has no step for ${packet.role}.`,
          changedFiles: [],
          commandsRun: [],
          evidence: [],
          openQuestions: ["Add another scripted worker step for this packet."]
        });
      }

      const step = steps[index];
      index += 1;

      if (step.role && step.role !== packet.role) {
        throw new Error(`script step ${index} expected role ${step.role} but received ${packet.role}`);
      }

      if (step.packetId && step.packetId !== packet.id) {
        throw new Error(`script step ${index} expected packet ${step.packetId} but received ${packet.id}`);
      }

      return createWorkerResult(step.result ?? step);
    },

    getCalls() {
      return clone(calls);
    },

    getPendingStepCount() {
      return steps.length - index;
    }
  };
}
