import { spawnSync } from "node:child_process";
import { sourceFiles } from "./source-files.js";
const files = sourceFiles().filter((file) => /\.(?:js|mjs)$/.test(file));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(file, result.stderr);
    failed++;
  }
}
console.log(
  `${files.length} JavaScript source files checked; ${failed} parse failures.`,
);
if (failed) process.exitCode = 1;
