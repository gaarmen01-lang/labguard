import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const compressed = new URL("../dist/vendor/pdf.worker.mjs.gz", import.meta.url);
const worker = new URL("../dist/vendor/pdf.worker.mjs", import.meta.url);

if (!existsSync(worker)) {
  writeFileSync(worker, gunzipSync(readFileSync(compressed)));
}

console.log("LabGuard static assets are ready in dist/.");
