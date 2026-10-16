// THE STRIP'S NODE PROBE ASKS ONLY A AND B, EVERY 30 S, ONE PROBE AT A TIME (the owner 2026-10-16: "Lower the amount of concurrent
// connections and network load"; measured on preview UI 156 during one run: 1036 of 1050 GET /identity came from probeNodes - every
// node= of the page's address, 14 seats in a round, every 2 s, for a line that names A and B only). The page's own probeNodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const at = html.indexOf('    async function probeNodes() {');
const src = html.slice(at, html.indexOf('\n    }\n', at) + 6);

test('fourteen node= seats: two are asked, and a probe still running is not doubled', async () => {
  const seats = Array.from({ length: 14 }, (_, i) => `https://tn4.example/guardian-${i + 1}`);
  const location = { search: '?node=' + seats.join(',') };
  const asked = [];
  const fetch = async (u) => { asked.push(u); await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200 }; };
  const nodeHealth = {};
  const probe = pageFunction(PAGE, ['location', 'fetch', 'nodeHealth', 'nodeLetter'], src, '; return probeNodes;')(location, fetch, nodeHealth, (i) => (i === 0 ? 'A' : i === 1 ? 'B' : String(i + 1)));
  await Promise.all([probe(), probe()]);
  assert.deepEqual(asked, ['https://tn4.example/guardian-1/identity', 'https://tn4.example/guardian-2/identity']);
  assert.deepEqual(nodeHealth, { A: 'ok', B: 'ok' });
});

test('the probe runs every 30 s, not every 2 s', () => {
  assert.match(html, /\n    probeNodes\(\);\n    setInterval\(probeNodes, 30000\);/);
});
