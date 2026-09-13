/**
 * A15: the provider key and the provider SDK must never reach the browser bundle.
 *
 * The browser talks only to /api/interpret; the key lives in the Netlify function's environment. This
 * script reads everything in dist/ and fails when a forbidden marker appears, so a stray import or a
 * pasted key cannot ship. No dependencies: plain Node.
 *
 * Usage: node scripts/check-bundle.mjs [dist-dir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist");

/** Markers that must not appear anywhere in the built site. */
const FORBIDDEN = [
  { marker: "sk-ant", why: "an Anthropic API key prefix" },
  { marker: "@anthropic-ai/sdk", why: "the provider SDK, which must stay server-side" },
  { marker: "ANTHROPIC_API_KEY", why: "the key's environment variable name" },
];

/** Binary extensions are skipped: a key would be text. */
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".pdf"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`check-bundle: cannot read ${DIST}. Run "npm run build" first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`check-bundle: ${DIST} is empty. Run "npm run build" first.`);
  process.exit(1);
}

const findings = [];
let scanned = 0;
for (const path of files) {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) continue;
  scanned += 1;
  const text = readFileSync(path, "utf8");
  for (const { marker, why } of FORBIDDEN) {
    if (text.includes(marker)) findings.push({ file: relative(process.cwd(), path), marker, why });
  }
}

if (findings.length > 0) {
  console.error("check-bundle: forbidden markers found in the built site:");
  for (const f of findings) console.error(`  ${f.file}: "${f.marker}" (${f.why})`);
  console.error("The browser must never carry the provider key or SDK. Keep provider calls in netlify/functions.");
  process.exit(1);
}

console.log(`check-bundle: ${scanned} text files scanned in ${relative(process.cwd(), DIST) || "dist"}; no provider key or SDK reference found.`);
