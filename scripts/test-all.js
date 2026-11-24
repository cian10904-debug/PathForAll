import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const results = readdirSync(".")
  .filter((name) => /^test-.*\.js$/.test(name))
  .sort()
  .map((file) => {
    const began = performance.now();
    const result = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      timeout: 90_000,
    });
    const status = result.status === 0 ? "passed" : "failed";
    console.log(`${status.toUpperCase()} ${file}`);
    if (status === "failed") console.error(result.stderr || result.error);
    return {
      file,
      status,
      elapsedMs: performance.now() - began,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/unit-results.json",
  JSON.stringify(
    { recordedAt: new Date().toISOString(), node: process.version, results },
    null,
    2,
  ),
);
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
