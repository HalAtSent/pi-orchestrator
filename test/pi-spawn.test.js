import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  getPiSpawnCommand,
  resolvePiBinScript,
  resolvePiPackageRoot
} from "../src/pi-spawn.js";

test("resolvePiPackageRoot returns package root when package.json is discoverable", () => {
  const result = resolvePiPackageRoot({
    packageName: "@scope/demo",
    requireResolve: (specifier) => {
      assert.equal(specifier, "@scope/demo/package.json");
      return "/tmp/node_modules/@scope/demo/package.json";
    }
  });

  assert.equal(result.packageRoot, "/tmp/node_modules/@scope/demo");
  assert.equal(result.packageJsonPath, "/tmp/node_modules/@scope/demo/package.json");
  assert.equal(result.error, null);
});

test("resolvePiPackageRoot falls back to node_modules search when package.json export is blocked", () => {
  const searchRoot = resolve("repo", "app", "src");
  const expectedPackageJsonPath = resolve("repo", "app", "node_modules", "@scope", "demo", "package.json");

  const result = resolvePiPackageRoot({
    packageName: "@scope/demo",
    requireResolve: () => {
      throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED");
    },
    searchRoots: [searchRoot],
    pathExists: (candidatePath) => candidatePath === expectedPackageJsonPath
  });

  assert.equal(result.packageRoot, resolve("repo", "app", "node_modules", "@scope", "demo"));
  assert.equal(result.packageJsonPath, expectedPackageJsonPath);
  assert.equal(result.error, null);
});

test("resolvePiBinScript selects the preferred pi bin entry", async () => {
  const packageRoot = "/tmp/node_modules/@mariozechner/pi-coding-agent";
  const result = await resolvePiBinScript({
    packageRoot,
    packageJsonPath: `${packageRoot}/package.json`,
    readPackageJson: async () => ({
      bin: {
        "pi-coding-agent": "dist/agent.js",
        pi: "dist/pi.js"
      }
    }),
    checkPath: async () => {}
  });

  assert.equal(result.scriptPath, resolve(packageRoot, "dist/pi.js"));
  assert.equal(result.binKey, "pi");
  assert.equal(result.error, null);
});

test("getPiSpawnCommand resolves to process.execPath plus pi script on Windows", async () => {
  const packageRoot = "/tmp/node_modules/@mariozechner/pi-coding-agent";
  const scriptPath = `${packageRoot}/dist/pi.js`;

  const result = await getPiSpawnCommand({
    platform: "win32",
    execPath: "node",
    resolvePackageRoot: async () => ({
      packageRoot,
      packageJsonPath: `${packageRoot}/package.json`,
      error: null
    }),
    resolveBinScript: async () => ({
      scriptPath,
      error: null
    })
  });

  assert.equal(result.command, "node");
  assert.deepEqual(result.argsPrefix, [scriptPath]);
  assert.equal(result.launcher, "pi_script_via_node");
  assert.equal(result.launcherPath, "node");
  assert.equal(result.piScriptPath, scriptPath);
});

test("getPiSpawnCommand falls back to pi when package resolution is unavailable", async () => {
  const result = await getPiSpawnCommand({
    resolvePackageRoot: async () => ({
      packageRoot: null,
      packageJsonPath: null,
      error: new Error("module not found")
    }),
    resolveBinScript: async () => {
      throw new Error("resolveBinScript must not run when package root is unavailable");
    }
  });

  assert.equal(result.command, "pi");
  assert.deepEqual(result.argsPrefix, []);
  assert.equal(result.launcher, "pi_cli_fallback");
  assert.equal(result.piScriptPath, null);
  assert.match(result.resolutionMessage, /module not found/i);
});
