import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";

// The runtime imports one local ESM file; all npm resolution happens at build time.
const result = await build({
  entryPoints: ["index.mjs"],
  outfile: "dist/acp.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: { js: 'import { createRequire as __omwCreateRequire } from "node:module"; import { fileURLToPath as __omwFileURLToPath } from "node:url"; import { dirname as __omwDirname } from "node:path"; const require = __omwCreateRequire(import.meta.url); const __dirname = __omwDirname(__omwFileURLToPath(import.meta.url));' },
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !isBuiltin(dependency.path)) {
      throw new Error(`ACP bundle has an unbundled runtime dependency: ${dependency.path}`);
    }
  }
}
await writeFile("dist/metafile.json", JSON.stringify(result.metafile, null, 2) + "\n");
await mkdir("dist/licenses", { recursive: true });
// tiktoken's bundled CJS loader still reads its WASM file next to the bundle.
await cp("node_modules/tiktoken/lite/tiktoken_bg.wasm", "dist/tiktoken_bg.wasm");
const plugin = await import("./dist/acp.mjs");
if (typeof plugin.default !== "function") throw new Error("ACP bundle does not export a plugin function");
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
await writeFile("dist/dependencies.json", JSON.stringify(lock.packages, null, 2) + "\n");
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev) continue;
  const entries = await readdir(directory).catch((error) => {
    if (info.optional && error.code === "ENOENT") return [];
    throw error;
  });
  if (!entries.length) continue;
  const destination = `dist/licenses/${directory.replaceAll("/", "_")}`;
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (/^(licen[cs]e|notice|copyright)(\.|$)/i.test(entry) || entry === "package.json") {
      await cp(`${directory}/${entry}`, `${destination}/${entry}`, { recursive: true });
    }
  }
}
// Preserve the exact AGPL Corresponding Source with the distributed artifact.
const revision = "f0502e7eee3430ffb1532d303c4c0b26f6d74494";
const response = await fetch(`https://codeload.github.com/ranxianglei/opencode-acp/tar.gz/${revision}`, {
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`ACP source download failed: ${response.status}`);
const source = Buffer.from(await response.arrayBuffer());
const checksum = createHash("sha256").update(source).digest("hex");
if (checksum !== "0f64c5c4e4ffd73dee296e6428ae9a997402c2c673fdcc4d6e475166b84942ca") {
  throw new Error(`ACP source checksum mismatch: ${checksum}`);
}
await mkdir("dist/source", { recursive: true });
await writeFile(`dist/source/opencode-acp-${revision}.tar.gz`, source);
for (const file of ["package.json", "package-lock.json", "index.mjs", "build.mjs"]) {
  await cp(file, `dist/source/${file}`);
}
