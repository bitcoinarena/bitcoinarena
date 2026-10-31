// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAGE WITHOUT ITS NOTES (kanban #838: the owner page went out with its comments - ticket numbers, names, a local host, quotes - in view
// source): the comments stay in the source and are dropped here. Each <script> and <style> goes through esbuild, which parses it, so a // in a
// URL, a string, a template or a regular expression is never mistaken for a comment; outside them only <!-- --> comments are taken out. The
// code changes in whitespace and comments only: no names shortened, nothing dropped or moved. Non-ASCII text stays as written (charset).
import { transform } from 'esbuild';

const PARTS = /<!--[\s\S]*?-->|(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const squeeze = async (code, loader) => (await transform(code, { loader, target: 'esnext', charset: 'utf8', legalComments: 'none', minifyWhitespace: true })).code.trim();

export async function withoutNotes(html) {
  let out = '', from = 0;
  for (const m of html.matchAll(PARTS)) {
    out += html.slice(from, m.index);
    from = m.index + m[0].length;
    if (m[1]) out += m[1] + (m[2].trim() ? await squeeze(m[2], 'js') : '') + m[3];
    else if (m[4]) out += m[4] + (m[5].trim() ? await squeeze(m[5], 'css') : '') + m[6];
    // a comment leaves nothing, not even its own line
    else if (html[from] === '\n' && (out.endsWith('\n') || !out)) from++;
  }
  return out + html.slice(from);
}
