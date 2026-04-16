import {
  normalizeChangedSurfaceObservation,
  normalizeCommandObservations,
  normalizeProviderModelSelection
} from "./run-evidence.js";
import { normalizeContextManifest } from "./context-manifest.js";

export const ROLE_TYPES = Object.freeze([
  "explorer",
  "implementer",
  "reviewer",
  "verifier",
  "orchestrator"
]);

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
export const RESULT_STATUSES = Object.freeze([
  "success",
  "blocked",
  "failed",
  "repair_required"
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertString(name, value) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
}

function assertStringArray(name, value) {
  assert(Array.isArray(value), `${name} must be an array`);
  for (const [index, item] of value.entries()) {
    assert(
      typeof item === "string" && item.trim().length > 0,
      `${name}[${index}] must be a non-empty string`
    );
  }
}

function assertOptionalStringArray(name, value) {
  if (value === undefined) {
    return;
  }

  assertStringArray(name, value);
}

export function validateTaskPacket(packet) {
  assert(packet && typeof packet === "object", "task packet must be an object");
  assertString("packet.id", packet.id);
  assert(ROLE_TYPES.includes(packet.role), `packet.role must be one of: ${ROLE_TYPES.join(", ")}`);
  assert(RISK_LEVELS.includes(packet.risk), `packet.risk must be one of: ${RISK_LEVELS.join(", ")}`);
  assertString("packet.goal", packet.goal);
  assertStringArray("packet.nonGoals", packet.nonGoals);
  assertStringArray("packet.allowedFiles", packet.allowedFiles);
  assertStringArray("packet.forbiddenFiles", packet.forbiddenFiles);
  assertStringArray("packet.acceptanceChecks", packet.acceptanceChecks);
  assertStringArray("packet.stopConditions", packet.stopConditions);
  assertOptionalStringArray("packet.contextFiles", packet.contextFiles);
  if (
    Object.prototype.hasOwnProperty.call(packet, "contextManifest")
    && packet.contextManifest !== undefined
  ) {
    packet.contextManifest = normalizeContextManifest(packet.contextManifest, {
      fieldName: "packet.contextManifest",
      allowMissing: false
    });
  }
  assertOptionalStringArray("packet.commands", packet.commands);
  if (packet.parentTaskId !== undefined) {
    assertString("packet.parentTaskId", packet.parentTaskId);
  }
  return packet;
}

export function validateWorkerResult(result) {
  assert(result && typeof result === "object", "worker result must be an object");
  assert(RESULT_STATUSES.includes(result.status), `result.status must be one of: ${RESULT_STATUSES.join(", ")}`);
  assertString("result.summary", result.summary);
  assertStringArray("result.changedFiles", result.changedFiles);
  assertStringArray("result.commandsRun", result.commandsRun);
  assertStringArray("result.evidence", result.evidence);
  assertStringArray("result.openQuestions", result.openQuestions);
  try {
    if (Object.prototype.hasOwnProperty.call(result, "commandObservations")) {
      const normalizedCommandObservations = normalizeCommandObservations(result.commandObservations, {
        fieldName: "result.commandObservations",
        allowMissing: false
      });
      if (normalizedCommandObservations.length === 0) {
        delete result.commandObservations;
      } else {
        result.commandObservations = normalizedCommandObservations;
      }
    }
  } catch (error) {
    throw new Error(`${error.message}`);
  }
  try {
    // This field is syntax-validated for runner interoperability.
    // Promotion into persisted changed-surface evidence is gated elsewhere by trusted runner provenance.
    result.changedSurfaceObservation = normalizeChangedSurfaceObservation(result.changedSurfaceObservation, {
      fieldName: "result.changedSurfaceObservation"
    });
  } catch (error) {
    throw new Error(`${error.message}`);
  }
  try {
    // This field is syntax-validated for runner interoperability.
    // Promotion into persisted provider/model evidence is gated elsewhere by trusted runner provenance.
    result.providerModelSelection = normalizeProviderModelSelection(result.providerModelSelection, {
      fieldName: "result.providerModelSelection"
    });
  } catch (error) {
    throw new Error(`${error.message}`);
  }
  return result;
}

export function createTaskPacket(packet) {
  return validateTaskPacket(structuredClone(packet));
}

export function createWorkerResult(result) {
  return validateWorkerResult(structuredClone(result));
}
