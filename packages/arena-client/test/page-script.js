// THE PAGE'S OWN SCRIPT, RUN UNDER THE PAGE'S OWN NAME (kanban #150). Tests lift a slice of a page's inline script by its
// text - index.html's lobbyViewRow, rounds.html's paint - and ran it through `new Function`: V8 ran it, but under no file,
// so coverage could not place a single line of it in the page. `pageFunction` runs the same slices under the page's own
// file URL, in a source exactly as long as the page: every character outside the slices blanked, each slice at its own
// offset, the wrapper written into the blank space around them. V8's ranges then fall on the page's own characters, and
// tools/page-coverage.mjs reads them back as the page's lines. When coverage is collected (NODE_V8_COVERAGE), the slices'
// ranges are written beside it, so only code a test really lifted is counted - never the blanks.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';

let written = 0;

/**
 * A function built from slices of a page, like `new Function(...params, slices.join('') + tail)`, run under the page.
 * `page` is the page's URL (a file URL) or path; each slice is a string the page holds exactly, found at or after `from`
 * (in order: the second slice is looked for after the first). `tail` follows the last slice (`return name;`), `lead` goes
 * just before the first (`return ` for a slice that is an expression).
 */
export function pageFunction(page, params, slices, tail = '', lead = '') {
  const path = page instanceof URL ? fileURLToPath(page) : String(page).startsWith('file:') ? fileURLToPath(page) : String(page);
  const text = readFileSync(path, 'utf8');
  const list = Array.isArray(slices) ? slices : [slices];
  const pieces = [];
  let from = 0;
  for (const s of list) {
    const at = text.indexOf(s, from);
    if (at < 0) throw new Error(`the page ${path} does not hold the slice ${JSON.stringify(s.slice(0, 60))}`);
    pieces.push([at, at + s.length]);
    from = at + s.length;
  }
  const head = `(function (${params.join(', ')}) {${lead}`;
  const foot = `\n${tail}\n})`;
  const first = pieces[0][0], last = pieces[pieces.length - 1][1];
  if (first < head.length) throw new Error('a slice at the very top of the page leaves no room for the wrapper');
  // the page's length of blanks (newlines kept, so a reader of this source sees the page's lines), the slices in place
  const out = text.replace(/[^\n]/g, ' ').split('');
  for (const [a, b] of pieces) for (let i = a; i < b; i++) out[i] = text[i];
  for (let i = 0; i < head.length; i++) out[first - head.length + i] = head[i];
  const source = out.slice(0, last).join('') + foot;
  // ONE NAME PER LIFT: the page's own URL and which lift this is, so each V8 coverage entry is matched to its own slices
  const n = written++;
  const url = `${pathToFileURL(path).href}?slice=${process.pid}-${n}`;
  const dir = process.env.NODE_V8_COVERAGE;
  if (dir) {
    try { writeFileSync(`${dir}/blwp-page-slices-${process.pid}-${n}.json`, JSON.stringify({ url, pieces })); }
    catch { /* coverage of the page is read from what was written; a test runs the same without it */ }
  }
  return vm.runInThisContext(source, { filename: url });
}

/** The same, called at once with `args` - for slices a test runs for what they do rather than what they return. */
export function runPage(page, params, slices, args, tail = '', lead = '') {
  return pageFunction(page, params, slices, tail, lead)(...args);
}
