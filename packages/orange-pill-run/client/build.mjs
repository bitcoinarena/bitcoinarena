// Builds client/dist/index.html: ONE self-contained page with the simulation, the renderer and the loop inlined
// (kanban #3246). No bundler dependency: each ES module is wrapped in its own function scope and its imports
// are bound to the exports of the modules before it. Supported forms (all this package uses):
//   import { a, b as c } from "./x.js";   export function f / export const|let NAME = ... / export { a, b };
// node client/build.mjs [--day day.json] [--out file]
// The page gets the day as window.OPR_DAY = { candles, seed, source, ... }; without --day it is the
// prototype's embedded day (test/fixtures/prototype-day.json, seed = its `to` as the prototype did).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), pkg = path.resolve(here, "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const ENTRY = path.join(here, "src/main.js");

const order = [], seen = new Set();
function visit(file) {
  if (seen.has(file)) return; seen.add(file);
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/^import\s*\{[^}]*\}\s*from\s*"([^"]+)";/gm)) visit(path.resolve(path.dirname(file), m[1]));
  order.push(file);
}
visit(ENTRY);

async function exportNames(file, src) {
  if (file.includes(path.sep + "sim" + path.sep)) return Object.keys(await import(pathToFileURL(file).href));   // pure modules: ask Node
  const names = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\};?/gm)) for (const n of m[1].split(",")) { const t = n.trim(); if (t) names.push(t.split(/\s+as\s+/).pop()); }
  return names;
}
const id = (file) => path.relative(pkg, file).split(path.sep).join("/");
let out = "const __m = Object.create(null);\n";
for (const file of order) {
  let src = fs.readFileSync(file, "utf8");
  const names = await exportNames(file, src);
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/gm, (_, list, spec) => {
    const dep = id(path.resolve(path.dirname(file), spec));
    const binds = list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? a + ": " + b : a; });
    return "const { " + binds.join(", ") + " } = __m[" + JSON.stringify(dep) + "];";
  });
  if (/^\s*import\s/m.test(src)) throw new Error(id(file) + ": unsupported import form");
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, "").replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, "");
  if (/^\s*export\s/m.test(src)) throw new Error(id(file) + ": unsupported export form");
  out += "__m[" + JSON.stringify(id(file)) + "] = (() => {\n" + src + "\nreturn { " + names.join(", ") + " };\n})();\n";
}

const dayFile = arg("--day");
let day;
if (dayFile) day = JSON.parse(fs.readFileSync(dayFile, "utf8"));
else { const p = JSON.parse(fs.readFileSync(path.join(pkg, "test/fixtures/prototype-day.json"), "utf8")); day = { candles: p.candles, seed: p.to | 0, source: p.source, from: p.from, to: p.to, practice: true }; }
const script = "<script>\nwindow.OPR_DAY = window.OPR_DAY || " + JSON.stringify(day) + ";\n(() => {\n\"use strict\";\n" + out + "})();\n</script>";
const tpl = fs.readFileSync(path.join(here, "index.template.html"), "utf8");
if (!tpl.includes("<!--OPR_SCRIPT-->")) throw new Error("template has no <!--OPR_SCRIPT-->");
const html = tpl.replace("<!--OPR_SCRIPT-->", () => script);
const outFile = arg("--out") || path.join(here, "dist/index.html");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log("wrote", path.relative(process.cwd(), outFile), html.length, "bytes,", order.length, "modules:", order.map(id).join(" "));

// THE PUBLIC RULES PAGE (kanban #3251), beside the game: games/orange-pill-run/rules.html, from the same text as the game's Rules sheet
const { RULES, RULES_TITLE } = await import(pathToFileURL(path.join(here, "src/rules.js")).href);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const rules = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(RULES_TITLE)}</title>
<style>
:root { color-scheme: dark; --bg: #0f0a10; --text: #f6ece4; --soft: #c8bab2; --btc: #f7931a; --line: #46343f; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px 40px; }
main { max-width: 680px; margin: 0 auto; }
h1 { font: 700 1.6rem "Space Grotesk", "Segoe UI", system-ui, sans-serif; margin: 0 0 16px; }
ol { padding-left: 1.2em; display: grid; gap: 10px; color: var(--soft); } b { color: var(--text); }
a { color: var(--btc); }
</style>
<main>
<h1>${esc(RULES_TITLE)}</h1>
<ol>
${RULES.map(([k, v]) => `<li><b>${esc(k)}.</b> ${esc(v)}</li>`).join("\n")}
</ol>
<p><a href="../../?game=orange-pill-run">Play the Orange Pill Run</a></p>
</main>
`;
const rulesFile = path.join(path.dirname(outFile), "rules.html");
fs.writeFileSync(rulesFile, rules);
console.log("wrote", path.relative(process.cwd(), rulesFile), rules.length, "bytes");

// THE ADMIN PANEL (kanban #3249): games/orange-pill-run/admin.html, self-contained, copied as written
const adminFile = path.join(path.dirname(outFile), "admin.html");
fs.copyFileSync(path.join(here, "admin.html"), adminFile);
console.log("wrote", path.relative(process.cwd(), adminFile), fs.statSync(adminFile).size, "bytes");
