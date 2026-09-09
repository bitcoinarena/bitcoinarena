// A BUILT index.html THAT STILL CARRIES ITS TEMPLATE TOKENS DOES NOT START.
//
// The page in `build/webgl` is Unity's own output, and Unity fills the
// `{{{ ... }}}` tokens as it writes it. But the WebGL TEMPLATE is where the
// page is actually edited - the chip, the join code, the curve - and the way
// an edit reaches a deploy without a twenty-minute rebuild is to copy the
// template over the built file. That copy brings the tokens back with it, and
// the symptom is not a broken line in a console: `Build/{{{ LOADER_FILENAME }}}`
// is a 404, so Unity never starts and the page sits on its own loading screen
// looking like a slow download. It shipped that way, and the two-Chrome
// close-out of 2026-09-09 16:08 found it by hand-injecting the loader.
//
// So the copy is not the thing to stop - it is how the page gets edited. What
// has to stop is the copy reaching Cloudflare unfilled. This fills the tokens
// from the build that is actually there: the four names in `Build/`, and the
// company, product and version out of ProjectSettings. Nothing is guessed; a
// token this cannot answer is an error, not a blank.
//
//   node unity-proto/tools/fill-template.mjs [--check] [build-dir]
//
// `--check` fills nothing and exits non-zero if any token is left, which is
// what the deploy scripts run before they upload.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.includes('--check');
const BUILD = process.argv.find((a, i) => i > 1 && !a.startsWith('--'))
  || join(HERE, '..', 'build', 'webgl');

const page = join(BUILD, 'index.html');
if (!existsSync(page)) {
  console.error(`no page at ${page} - run BuildWebGL.Run first`);
  process.exit(1);
}
let html = readFileSync(page, 'utf8');

const left = () => [...new Set((html.match(/\{\{\{[^}]*\}\}\}/g) || []))];

if (CHECK) {
  const over = left();
  if (over.length) {
    console.error(`${page} still carries ${over.length} template token(s): ${over.join(' ')}`);
    console.error('The page will not start: `Build/{{{ LOADER_FILENAME }}}` is a 404.');
    console.error('Run: node unity-proto/tools/fill-template.mjs');
    process.exit(1);
  }
  console.log(`${page}: no template tokens left`);
  process.exit(0);
}

// THE FOUR NAMES COME OFF THE BUILD ITSELF, not off a convention. Unity names
// them after the build target, and a page that named a file the build does not
// have is the same 404 by a different route.
const inBuild = existsSync(join(BUILD, 'Build')) ? readdirSync(join(BUILD, 'Build')) : [];
const one = (what, test) => {
  const found = inBuild.filter(test);
  if (found.length !== 1)
    throw new Error(`${found.length} candidates for ${what} in ${join(BUILD, 'Build')}: ${found.join(' ') || 'none'}`);
  return found[0];
};

const settings = readFileSync(join(HERE, '..', 'ProjectSettings', 'ProjectSettings.asset'), 'utf8');
const setting = (key) => {
  const m = settings.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!m) throw new Error(`ProjectSettings names no ${key}`);
  return m[1];
};

const values = {
  LOADER_FILENAME: one('the loader', (f) => /\.loader\.js$/.test(f)),
  DATA_FILENAME: one('the data', (f) => /\.data(\.|$)/.test(f)),
  FRAMEWORK_FILENAME: one('the framework', (f) => /\.framework\.js(\.|$)/.test(f)),
  CODE_FILENAME: one('the wasm', (f) => /\.wasm(\.|$)/.test(f)),
  COMPANY_NAME: setting('companyName'),
  PRODUCT_NAME: setting('productName'),
  PRODUCT_VERSION: setting('bundleVersion'),
};

const unknown = left()
  .map((t) => t.replace(/[{} ]/g, ''))
  .filter((name) => !(name in values));
if (unknown.length) {
  console.error(`this page carries token(s) nothing here can answer: ${unknown.join(' ')}`);
  process.exit(1);
}

for (const [name, value] of Object.entries(values))
  html = html.replaceAll(`{{{ ${name} }}}`, value);

const over = left();
if (over.length) {
  console.error(`still unfilled after substitution: ${over.join(' ')}`);
  process.exit(1);
}
writeFileSync(page, html);
for (const [k, v] of Object.entries(values)) console.log(`  ${k} -> ${v}`);
console.log(`filled ${page}`);
