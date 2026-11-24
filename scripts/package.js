import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sourceFiles } from "./source-files.js";
const output = resolve(process.argv[2] || "PathForAll-source.zip");
const result = spawnSync(
  "python3",
  [
    "-c",
    `
import json,sys,zipfile,pathlib
spec=json.load(sys.stdin)
with zipfile.ZipFile(spec['output'],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for path in spec['files']:
  info=zipfile.ZipInfo('PathForAll/'+path,date_time=(2026,1,1,0,0,0))
  info.compress_type=zipfile.ZIP_DEFLATED
  info.external_attr=0o100644<<16
  z.writestr(info,pathlib.Path(path).read_bytes())
print('Packaged',len(spec['files']),'source files')
`,
  ],
  { input: JSON.stringify({ output, files: sourceFiles() }), encoding: "utf8" },
);
if (result.status !== 0)
  throw new Error(result.stderr || result.error?.message || "Packaging failed");
console.log(result.stdout.trim());
console.log(output);
