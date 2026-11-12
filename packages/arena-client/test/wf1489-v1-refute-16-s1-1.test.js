// kanban #1489 v1-refute-16 (#1508): THE FIX MUST REACH THE PAGE. The page's ARENA_SECURE_RUN calls ARENACLIENT.secureTranscript
// from the shipped bundle (src/arena-ui/arena-client.js, built by tools/bundle.js); at 85f803d70 that bundle was last rebuilt in
// a069bb742, one commit BEFORE "Merge audit fix r1:fix:play:1", so the page still runs the Promise.all with no per-node timer.
// The bundle's own secureTranscript is run here on the original attack: six holders, one seat that never answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTranscript, transcriptHash, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const T = { roundId: RID, entryId: EID, batches: [], marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));

for (const file of ['../../../src/arena-ui/arena-client.js', '../dist/arena-client.js']) {
  test(`the shipped bundle ${file}: six holders and one silent seat answer safe in bounded time`, async () => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const at = src.indexOf('async function secureTranscript(');
    assert.ok(at >= 0, 'secureTranscript is in the bundle');
    const end = src.indexOf('\n}\n', at);
    const fn = new Function('toHex', 'decodeTranscript', 'transcriptHash', 'NODES_HOLDING', 'NODE_WAIT_MS',
      `${src.slice(at, end + 2)}\nreturn secureTranscript;`)(toHex, decodeTranscript, transcriptHash, 5, 8000);
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `http://${x}`);
    const fetcher = (url) => url.startsWith('http://g') ? new Promise(() => {})
      : Promise.resolve(new Response(BYTES, { status: 200, headers: { 'x-ticks': '100', 'x-transcript-hash': HASH } }));
    let t; const started = Date.now();
    const got = await Promise.race([fn({ roundId: RID, entryId: EID, nodes, finalTick: 100, fetcher }),
      new Promise((r) => { t = setTimeout(() => r(null), 20000); })]);
    clearTimeout(t);
    assert.ok(got, `the page's secureTranscript still waiting after ${Date.now() - started} ms on one silent seat while six hold the run`);
    assert.equal(got.safe, true, got.why);
  });
}

// kanban #1687: THE CHECK THAT WOULD HAVE CAUGHT IT. The src was fixed and the bundle was not rebuilt; this fails whenever the
// secureTranscript the page runs (both shipped copies) is not, text for text, the one in src/transcript-upload.js.
const fnText = (src, at) => { const i = src.indexOf(at); return i < 0 ? null : src.slice(i, src.indexOf('\n}\n', i) + 2); };
test('the shipped bundles carry src/transcript-upload.js secureTranscript and NODE_WAIT_MS, unchanged', () => {
  const mod = readFileSync(new URL('../src/transcript-upload.js', import.meta.url), 'utf8');
  const want = fnText(mod, 'async function secureTranscript(');
  const wait = mod.match(/\nexport const NODE_WAIT_MS = (\d+);/)[1];
  assert.ok(want);
  for (const file of ['../../../src/arena-ui/arena-client.js', '../dist/arena-client.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(fnText(src, 'async function secureTranscript('), want, `${file}: secureTranscript is not the src's - rebuild with tools/bundle.js`);
    assert.match(src, new RegExp(`\\nconst NODE_WAIT_MS = ${wait};`), `${file}: NODE_WAIT_MS is not the src's`);
  }
});
