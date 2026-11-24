import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sourceFiles, forbidden } from './scripts/source-files.js';
const files = sourceFiles();
const ignores = readFileSync('.gitignore', 'utf8').split(/\r?\n/);
for (const name of ['node_modules/', 'dist/', '.vite/', '.git/', '__MACOSX/', '.DS_Store', '.env']) assert.ok(ignores.includes(name));
for (const required of ['app.js', 'osm-network.js', 'route-model.js', 'package-lock.json', 'index.html', 'styles.css', '.env.example', '.github/workflows/ci.yml']) assert.ok(files.includes(required), `${required} must be packaged`);
assert.deepEqual(files.filter(file => forbidden.test(file)), []);
for (const file of files.filter(file => /\.js$/.test(file))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
    const resolved = new URL(match[1], new URL(file, `file://${process.cwd()}/`)).pathname.slice(process.cwd().length + 1);
    assert.ok(files.includes(resolved), `${file} imports unpackaged ${resolved}`);
  }
}
// Git adds a hygiene check. Archive validation above always executes.
if (existsSync('.git')) {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(tracked.filter(file => forbidden.test(file)), []);
}
console.log(`Validated ${files.length} source files, dependency closure and exclusions without requiring Git.`);
