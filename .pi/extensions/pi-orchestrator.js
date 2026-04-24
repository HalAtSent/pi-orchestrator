import { AUTO_BACKEND_MODES } from "../../src/auto-backend-runner.js";
import { createBuildSessionStore } from "../../src/build-session-store.js";
import { createPiExtension } from "../../src/pi-extension.js";
import { createProcessWorkerBackend } from "../../src/process-worker-backend.js";
import { createRunStore } from "../../src/run-store.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(extensionDirectory, "..", "..");

export default createPiExtension({
  runStore: createRunStore({
    rootDir: repositoryRoot
  }),
  buildSessionStore: createBuildSessionStore({
    rootDir: repositoryRoot
  }),
  processWorkerBackend: createProcessWorkerBackend({
    repositoryRoot
  }),
  autoBackendMode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
});
