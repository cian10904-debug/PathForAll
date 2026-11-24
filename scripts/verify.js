import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const results = [];
for (const name of [
  "syntax",
  "lint",
  "typecheck",
  "test:unit",
  "build",
  "test:e2e",
  "package",
]) {
  console.log(`\nRunning ${name}`);
  const start = Date.now();
  const run = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", name],
    { encoding: "utf8", timeout: 300_000 },
  );
  const output = `${run.stdout || ""}${run.stderr || ""}${run.error?.message || ""}`;
  console.log(output);
  results.push({
    command: `npm run ${name}`,
    status: run.status === 0 ? "passed" : "failed",
    durationMs: Date.now() - start,
    exitCode: run.status,
    output,
  });
}
mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/verification.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      checks: results,
      externalChecks:
        "Real-provider smoke checks, field observations, and assistive-technology trials are reported separately.",
    },
    null,
    2,
  ),
);
console.table(
  results.map(({ command, status, durationMs }) => ({
    command,
    status,
    durationMs,
  })),
);
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
