"use strict";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const [ignoreFile, readme] = await Promise.all([
  readFile(".gitignore", "utf8"),
  readFile("README.md", "utf8")
]);
for (const entry of ["node_modules/", "dist/", ".vite/", ".git/", "__MACOSX/", ".DS_Store", ".env"]) {
  assert.ok(ignoreFile.split(/\r?\n/).includes(entry), `${entry} is excluded from working-directory packages.`);
}
assert.match(readme, /git archive[\s\S]*--format=zip[\s\S]*--output=PathForAll-source\.zip[\s\S]*HEAD/);

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbidden = /(^|\/)(?:node_modules|dist|\.vite|\.git|__MACOSX)(?:\/|$)|(^|\/)(?:\.DS_Store|\.env)$/;
assert.deepEqual(tracked.filter(file => forbidden.test(file)), [], "generated and machine-specific files are not tracked.");

console.log("Source distribution exclusions and git-archive documentation tests passed.");
