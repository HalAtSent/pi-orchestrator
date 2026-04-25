import assert from "node:assert/strict";
import test from "node:test";

import {
  createCachedProcessModelProbe,
  probeProcessModels
} from "../src/process-model-probe.js";

test("process model probe launches candidate checks with explicit provider/model/thinking args", async () => {
  const commands = [];
  const probe = await probeProcessModels({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    prompt: "Reply with OK and stop.",
    workspaceRoot: "/tmp/work",
    spawnCommandResolver: async () => ({
      command: "node",
      argsPrefix: ["/tmp/pi/dist/pi.js"],
      launcher: "pi_script_via_node",
      launcherPath: "node",
      piScriptPath: "/tmp/pi/dist/pi.js",
      piPackageRoot: "/tmp/pi",
      resolutionMessage: "resolved"
    }),
    runCommandFn: async ({ command, args, cwd }) => {
      commands.push({ command, args, cwd });
      const model = args[args.indexOf("--model") + 1];
      return {
        command,
        args,
        cwd,
        exitCode: model === "gpt-5.4-mini" ? 1 : 0,
        signal: null,
        timedOut: false,
        stdout: model === "gpt-5.4-mini" ? "" : "OK",
        stderr: "",
        error: null,
        durationMs: 5
      };
    }
  });

  assert.equal(commands.length, 3);
  for (const entry of commands) {
    assert.equal(entry.command, "node");
    assert.equal(entry.args[0], "/tmp/pi/dist/pi.js");
    assert.equal(entry.args.includes("--provider"), true);
    assert.equal(entry.args.includes("openai-codex"), true);
    assert.equal(entry.args.includes("--model"), true);
    assert.equal(entry.args.includes("--thinking"), true);
    assert.equal(entry.args.includes("off"), true);
  }

  assert.deepEqual(probe.supportedModels, ["gpt-5.4", "gpt-5.3-codex"]);
  assert.equal(probe.blockedReason, null);
});

test("process model probe records command output buffer truncation", async () => {
  const probe = await probeProcessModels({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4"],
    prompt: "Reply with OK and stop.",
    workspaceRoot: "/tmp/work",
    spawnCommandResolver: async () => ({
      command: "node",
      argsPrefix: ["/tmp/pi/dist/pi.js"],
      launcher: "pi_script_via_node",
      launcherPath: "node",
      piScriptPath: "/tmp/pi/dist/pi.js",
      piPackageRoot: "/tmp/pi",
      resolutionMessage: "resolved"
    }),
    runCommandFn: async ({ command, args, cwd }) => ({
      command,
      args,
      cwd,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "OK",
      stderr: "warning",
      stdoutTruncated: true,
      stderrTruncated: true,
      error: null,
      durationMs: 5
    })
  });

  assert.equal(probe.probes.length, 1);
  assert.equal(probe.probes[0].stdoutTruncated, true);
  assert.equal(probe.probes[0].stderrTruncated, true);
});

test("process model probe fails closed when Pi script resolution is unavailable", async () => {
  const probe = await probeProcessModels({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4"],
    spawnCommandResolver: async () => ({
      command: "pi",
      argsPrefix: [],
      launcher: "pi_cli_fallback",
      launcherPath: "pi",
      piScriptPath: null,
      piPackageRoot: null,
      resolutionMessage: "not resolved"
    }),
    runCommandFn: async () => {
      throw new Error("runCommandFn should not be called");
    }
  });

  assert.equal(probe.supportedModels.length, 0);
  assert.match(probe.blockedReason, /script path was not resolved/i);
  assert.equal(probe.probes.length, 0);
});

test("cached process model probe does not reuse bad workspace results for a good workspace", async () => {
  let runCount = 0;
  const modelProbe = createCachedProcessModelProbe({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4"],
    spawnCommandResolver: async ({ workspaceRoot }) => workspaceRoot === "/tmp/bad-workspace"
      ? {
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: null,
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "unresolved"
      }
      : {
        command: "node",
        argsPrefix: ["/tmp/pi/dist/pi.js"],
        launcher: "pi_script_via_node",
        launcherPath: "node",
        piScriptPath: "/tmp/pi/dist/pi.js",
        piPackageRoot: "/tmp/pi",
        resolutionMessage: "resolved"
      },
    runCommandFn: async ({ command, args, cwd }) => {
      runCount += 1;
      return {
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "OK",
        stderr: "",
        error: null,
        durationMs: 5
      };
    }
  });

  const badWorkspaceResult = await modelProbe({ workspaceRoot: "/tmp/bad-workspace" });
  const goodWorkspaceResult = await modelProbe({ workspaceRoot: "/tmp/good-workspace" });

  assert.match(badWorkspaceResult.blockedReason ?? "", /script path was not resolved/i);
  assert.equal(goodWorkspaceResult.blockedReason, null);
  assert.deepEqual(goodWorkspaceResult.supportedModels, ["gpt-5.4"]);
  assert.equal(runCount, 1);
});

test("cached process model probe blocked result does not poison later successful probe", async () => {
  const badSpawnResolver = async () => ({
    command: "node",
    argsPrefix: ["/tmp/pi/dist/pi.js"],
    launcher: "pi_script_via_node",
    launcherPath: "node",
    piScriptPath: null,
    piPackageRoot: "/tmp/pi",
    resolutionMessage: "unresolved"
  });
  const goodSpawnResolver = async () => ({
    command: "node",
    argsPrefix: ["/tmp/pi/dist/pi.js"],
    launcher: "pi_script_via_node",
    launcherPath: "node",
    piScriptPath: "/tmp/pi/dist/pi.js",
    piPackageRoot: "/tmp/pi",
    resolutionMessage: "resolved"
  });
  let successfulRunCount = 0;
  const successfulRunCommand = async ({ command, args, cwd }) => {
    successfulRunCount += 1;
    return {
      command,
      args,
      cwd,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "OK",
      stderr: "",
      error: null,
      durationMs: 5
    };
  };
  const modelProbe = createCachedProcessModelProbe({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4"],
    workspaceRoot: "/tmp/workspace"
  });

  const blockedResult = await modelProbe({
    spawnCommandResolver: badSpawnResolver,
    runCommandFn: async () => {
      throw new Error("runCommandFn should not run for blocked resolver");
    }
  });
  const recoveredResult = await modelProbe({
    spawnCommandResolver: goodSpawnResolver,
    runCommandFn: successfulRunCommand
  });

  assert.match(blockedResult.blockedReason ?? "", /script path was not resolved/i);
  assert.equal(recoveredResult.blockedReason, null);
  assert.deepEqual(recoveredResult.supportedModels, ["gpt-5.4"]);
  assert.equal(successfulRunCount, 1);
});

test("cached process model probe reuses stable repeated calls in the same workspace", async () => {
  let runCount = 0;
  const modelProbe = createCachedProcessModelProbe({
    providerId: "openai-codex",
    candidateModels: ["gpt-5.4"],
    spawnCommandResolver: async () => ({
      command: "node",
      argsPrefix: ["/tmp/pi/dist/pi.js"],
      launcher: "pi_script_via_node",
      launcherPath: "node",
      piScriptPath: "/tmp/pi/dist/pi.js",
      piPackageRoot: "/tmp/pi",
      resolutionMessage: "resolved"
    }),
    runCommandFn: async ({ command, args, cwd }) => {
      runCount += 1;
      return {
        command,
        args,
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "OK",
        stderr: "",
        error: null,
        durationMs: 5
      };
    }
  });

  const first = await modelProbe({ workspaceRoot: "/tmp/workspace" });
  const second = await modelProbe({ workspaceRoot: "/tmp/workspace" });

  assert.deepEqual(first.supportedModels, ["gpt-5.4"]);
  assert.deepEqual(second.supportedModels, ["gpt-5.4"]);
  assert.equal(runCount, 1);
});
