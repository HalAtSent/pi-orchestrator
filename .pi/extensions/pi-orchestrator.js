import { AUTO_BACKEND_MODES } from "../../src/auto-backend-runner.js";
import { createPiExtension } from "../../src/pi-extension.js";
import { createProcessWorkerBackend } from "../../src/process-worker-backend.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(extensionDirectory, "..", "..");

export default createPiExtension({
  processWorkerBackend: createProcessWorkerBackend({
    repositoryRoot
  }),
  autoBackendMode: AUTO_BACKEND_MODES.PROCESS_SUBAGENTS
});
