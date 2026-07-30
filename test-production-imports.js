"use strict";

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const fixtureReferences = /(?:fallback-data|transit-data|tests\/fixtures|cooper-union-(?:graph|transit))/;
const sourceFiles = (await readdir(".")).filter(file => file.endsWith(".js") && !file.startsWith("test-"));

for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  assert.equal(
    fixtureReferences.test(source),
    false,
    `${file} must not import or reference a local teaching fixture in production.`
  );
}

console.log("All production modules are isolated from local teaching fixtures.");
