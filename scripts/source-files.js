import { readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
const directories = new Set([
  "server",
  "scripts",
  "tests",
  "evaluation",
  "docs",
  ".github",
]);
const rootNames = new Set([
  ".env.example",
  ".gitignore",
  ".htmlvalidate.json",
  ".stylelintrc.json",
  ".nvmrc",
  "LICENSE",
]);
export const forbidden =
  /(^|\/)(?:node_modules|dist|\.vite|\.git|__MACOSX|__pycache__|test-results|playwright-report|otp-data|evidence|data)(?:\/|$)|(^|\/)(?:\.DS_Store|\.env(?:\.(?!example$).*)?|.*\.(?:pem|key|zip|pyc|jar|pbf|obj|log))$/;
export function sourceFiles(root = process.cwd()) {
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (forbidden.test(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error(`Source distribution cannot contain a symlink: ${rel}`);
      if (stat.isDirectory()) {
        if (directory !== root || directories.has(name)) walk(path);
      } else if (
        stat.isFile() &&
        (directory !== root ||
          rootNames.has(name) ||
          /\.(?:js|mjs|ts|json|html|css|md)$/.test(name))
      )
        files.push(rel);
    }
  }
  walk(root);
  const total = files.reduce(
    (sum, path) => sum + lstatSync(join(root, path)).size,
    0,
  );
  if (total > 2_000_000)
    throw new Error(
      "Source distribution exceeds the 2 MB tracked source budget.",
    );
  return files;
}
