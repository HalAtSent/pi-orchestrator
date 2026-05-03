#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { validateWorkOrder } from "../kernel/work-order.js";

const [, , command, filePath, ...extraArgs] = process.argv;

if (command !== "validate-work-order" || filePath === undefined || extraArgs.length > 0) {
  await printDiagnostic("usage", "Usage: pi validate-work-order <file>");
  process.exitCode = 1;
} else {
  try {
    const fileContents = await readFile(filePath, "utf8");
    const workOrder = JSON.parse(fileContents);
    const result = validateWorkOrder(workOrder);

    await writeJson(result);
    process.exitCode = result.success === true ? 0 : 1;
  } catch (error) {
    await printDiagnostic("input_error", error instanceof Error ? error.message : "Unable to read Work Order JSON.");
    process.exitCode = 1;
  }
}

function printDiagnostic(code, message) {
  return writeJson({ diagnostic: true, code, message });
}

function writeJson(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
