import {
  createCodexCliLauncher,
  createPiCliLauncher,
  createProcessWorkerBackend,
  PROCESS_WORKER_SUPPORTED_ROLE
} from "./process-worker-backend.js";

export { createPiCliLauncher, createCodexCliLauncher };

export function createSpikeWorkerBackend(options = {}) {
  return createProcessWorkerBackend(options);
}

export const SPIKE_WORKER_SUPPORTED_ROLE = PROCESS_WORKER_SUPPORTED_ROLE;
