import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const PI_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
export const PI_FALLBACK_COMMAND = "pi";
const DEFAULT_PREFERRED_BIN = "pi";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function asErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function readPackageJsonFile(packageJsonPath) {
  const raw = await readFile(packageJsonPath, "utf8");
  return JSON.parse(raw);
}

function buildPackageJsonCandidate(rootPath, packageName) {
  return join(rootPath, "node_modules", ...packageName.split("/"), "package.json");
}

function findPackageJsonByWalkingNodeModules({
  packageName,
  searchRoots = [process.cwd(), moduleDirectory],
  pathExists = existsSync
} = {}) {
  assert(Array.isArray(searchRoots), "searchRoots must be an array");
  assert(typeof pathExists === "function", "pathExists(path) must be a function");

  const visitedRoots = unique(
    searchRoots
      .filter((value) => typeof value === "string" && value.length > 0)
      .map((value) => resolve(value))
  );

  for (const searchRoot of visitedRoots) {
    let currentRoot = searchRoot;

    while (true) {
      const candidatePath = buildPackageJsonCandidate(currentRoot, packageName);
      if (pathExists(candidatePath)) {
        return candidatePath;
      }

      const parentRoot = dirname(currentRoot);
      if (parentRoot === currentRoot) {
        break;
      }

      currentRoot = parentRoot;
    }
  }

  return null;
}

function selectBinEntry(binField, { packageName, preferredBinName }) {
  if (typeof binField === "string" && binField.length > 0) {
    return {
      key: null,
      relativePath: binField
    };
  }

  if (!binField || typeof binField !== "object" || Array.isArray(binField)) {
    return null;
  }

  const entries = Object.entries(binField).filter(([key, value]) => (
    typeof key === "string"
    && key.length > 0
    && typeof value === "string"
    && value.length > 0
  ));

  if (entries.length === 0) {
    return null;
  }

  const packageLeafName = packageName.split("/").at(-1) ?? packageName;
  const preferredKeys = unique([
    preferredBinName,
    "pi",
    packageName,
    packageLeafName
  ].filter((value) => typeof value === "string" && value.length > 0));

  for (const preferredKey of preferredKeys) {
    const match = entries.find(([key]) => key === preferredKey);
    if (match) {
      return {
        key: match[0],
        relativePath: match[1]
      };
    }
  }

  const [key, relativePath] = entries[0];
  return { key, relativePath };
}

export function resolvePiPackageRoot({
  packageName = PI_PACKAGE_NAME,
  requireResolve = moduleRequire.resolve,
  searchRoots = [process.cwd(), moduleDirectory],
  pathExists = existsSync
} = {}) {
  assert(typeof packageName === "string" && packageName.length > 0, "packageName must be a non-empty string");
  assert(typeof requireResolve === "function", "requireResolve(specifier) must be a function");

  try {
    const packageJsonPath = requireResolve(`${packageName}/package.json`);
    return {
      packageName,
      packageJsonPath,
      packageRoot: dirname(packageJsonPath),
      error: null
    };
  } catch (error) {
    const packageJsonPath = findPackageJsonByWalkingNodeModules({
      packageName,
      searchRoots,
      pathExists
    });

    if (packageJsonPath) {
      return {
        packageName,
        packageJsonPath,
        packageRoot: dirname(packageJsonPath),
        error: null
      };
    }

    return {
      packageName,
      packageJsonPath: null,
      packageRoot: null,
      error
    };
  }
}

export async function resolvePiBinScript({
  packageName = PI_PACKAGE_NAME,
  packageRoot,
  packageJsonPath = packageRoot ? join(packageRoot, "package.json") : null,
  preferredBinName = DEFAULT_PREFERRED_BIN,
  readPackageJson = readPackageJsonFile,
  checkPath = access
} = {}) {
  assert(typeof packageName === "string" && packageName.length > 0, "packageName must be a non-empty string");
  assert(typeof preferredBinName === "string" && preferredBinName.length > 0, "preferredBinName must be a non-empty string");
  assert(typeof readPackageJson === "function", "readPackageJson(path) must be a function");
  assert(typeof checkPath === "function", "checkPath(path) must be a function");

  if (typeof packageRoot !== "string" || packageRoot.length === 0) {
    return {
      packageName,
      packageRoot: packageRoot ?? null,
      packageJsonPath: packageJsonPath ?? null,
      scriptPath: null,
      binKey: null,
      error: new Error("Pi package root is unavailable")
    };
  }

  if (typeof packageJsonPath !== "string" || packageJsonPath.length === 0) {
    return {
      packageName,
      packageRoot,
      packageJsonPath: packageJsonPath ?? null,
      scriptPath: null,
      binKey: null,
      error: new Error("Pi package.json path is unavailable")
    };
  }

  let packageJson;
  try {
    packageJson = await readPackageJson(packageJsonPath);
  } catch (error) {
    return {
      packageName,
      packageRoot,
      packageJsonPath,
      scriptPath: null,
      binKey: null,
      error
    };
  }

  const binEntry = selectBinEntry(packageJson?.bin, {
    packageName,
    preferredBinName
  });

  if (!binEntry) {
    return {
      packageName,
      packageRoot,
      packageJsonPath,
      scriptPath: null,
      binKey: null,
      error: new Error("Pi package.json does not expose a usable bin entry")
    };
  }

  const scriptPath = isAbsolute(binEntry.relativePath)
    ? binEntry.relativePath
    : resolve(packageRoot, binEntry.relativePath);

  try {
    await checkPath(scriptPath);
  } catch (error) {
    return {
      packageName,
      packageRoot,
      packageJsonPath,
      scriptPath: null,
      binKey: binEntry.key,
      error
    };
  }

  return {
    packageName,
    packageRoot,
    packageJsonPath,
    scriptPath,
    binKey: binEntry.key,
    error: null
  };
}

export async function getPiSpawnCommand({
  platform = process.platform,
  execPath = process.execPath,
  packageName = PI_PACKAGE_NAME,
  preferredBinName = DEFAULT_PREFERRED_BIN,
  fallbackCommand = PI_FALLBACK_COMMAND,
  resolvePackageRoot = resolvePiPackageRoot,
  resolveBinScript = resolvePiBinScript
} = {}) {
  assert(typeof platform === "string" && platform.length > 0, "platform must be a non-empty string");
  assert(typeof execPath === "string" && execPath.length > 0, "execPath must be a non-empty string");
  assert(typeof packageName === "string" && packageName.length > 0, "packageName must be a non-empty string");
  assert(typeof preferredBinName === "string" && preferredBinName.length > 0, "preferredBinName must be a non-empty string");
  assert(typeof fallbackCommand === "string" && fallbackCommand.length > 0, "fallbackCommand must be a non-empty string");
  assert(typeof resolvePackageRoot === "function", "resolvePackageRoot(options) must be a function");
  assert(typeof resolveBinScript === "function", "resolveBinScript(options) must be a function");

  const packageResolution = await resolvePackageRoot({ packageName });
  if (!packageResolution?.packageRoot) {
    return {
      command: fallbackCommand,
      argsPrefix: [],
      launcher: "pi_cli_fallback",
      launcherPath: fallbackCommand,
      piScriptPath: null,
      piPackageRoot: null,
      resolutionMessage: `pi package resolution unavailable: ${asErrorMessage(packageResolution?.error)}`
    };
  }

  const binResolution = await resolveBinScript({
    packageName,
    packageRoot: packageResolution.packageRoot,
    packageJsonPath: packageResolution.packageJsonPath,
    preferredBinName
  });

  if (!binResolution?.scriptPath) {
    return {
      command: fallbackCommand,
      argsPrefix: [],
      launcher: "pi_cli_fallback",
      launcherPath: fallbackCommand,
      piScriptPath: null,
      piPackageRoot: packageResolution.packageRoot,
      resolutionMessage: `pi bin script resolution unavailable: ${asErrorMessage(binResolution?.error)}`
    };
  }

  const command = platform === "win32" ? execPath : binResolution.scriptPath;
  const argsPrefix = platform === "win32" ? [binResolution.scriptPath] : [];

  return {
    command,
    argsPrefix,
    launcher: platform === "win32" ? "pi_script_via_node" : "pi_script_direct",
    launcherPath: command,
    piScriptPath: binResolution.scriptPath,
    piPackageRoot: packageResolution.packageRoot,
    resolutionMessage: `pi bin resolved from ${packageResolution.packageJsonPath}`
  };
}
