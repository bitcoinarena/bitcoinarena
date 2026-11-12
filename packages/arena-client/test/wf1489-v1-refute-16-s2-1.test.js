// kanban #1489 v1-refute-16-s2 (#1508, #1687): THE BOUND MUST NOT CUT HONEST SEATS THAT ARE STILL SENDING.
// The #1508 fix races each node's fetch AND its whole body read against one 8 s timer (NODE_WAIT_MS), and the page
// (ARENA_SECURE_RUN) never passes waitMs. secureTranscript downloads the whole transcript from every committee seat at once,
// so on one shared link the seven bodies finish together at 7 x size / bandwidth. A Tick Tock run is 4920 ticks
// (82 s x 60): its transcript is ~117 KB before any mark or sample (encodeTranscript of 164 batches of 30 ticks).
// On a slow mobile link (Chrome's "Slow 3G" preset: 400 kbit/s = 50 KB/s, 400 ms latency) all seven honest seats are
// still sending at 8 s, every one is aborted as "no answer in 8000 ms", and the run is reported not held. The page's retry
// (30 tries, 3 s apart) starts every download from zero again, so it never converges: "keep this tab open" for every try,
// then "not yet held", over a run all seven seats hold. Before the fix the same call answered safe after ~16.7 s.
// Safe behaviour: a seat whose body is still arriving is not counted as silent (bound the wait for an answer / a stall,
// not the total transfer), or stop waiting once enough seats agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureTranscript } from '../src/transcript-upload.js';
import { encodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const FINAL = 4920;
const batches = [];
for (let t = 0; t < FINAL; t += 30) batches.push({ roundId: RID, entryId: EID, previousHash: b32(0), firstTick: t, ticks: Array.from({ length: 30 }, () => [1, 2, 3, 4, 5]) });
const T = { roundId: RID, entryId: EID, batches, marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));

// one shared downlink: every 50 ms, BPS/20 bytes are split evenly between the bodies still arriving
function slowLink({ bps = 50_000, latencyMs = 400 } = {}) {
  const active = new Set();
  let tick = null;
  const step = () => {
    if (!active.size) { clearInterval(tick); tick = null; return; }
    const share = Math.floor(bps / 20 / active.size);
    for (const s of [...active]) { s.left -= share; if (s.left <= 0) { active.delete(s); s.done(); } }
  };
  return (url, { signal } = {}) => new Promise((resolve, reject) => {
    const t0 = setTimeout(() => {
      const s = { left: BYTES.length };
      const body = new Promise((ok, no) => {
        s.done = () => ok(BYTES.slice().buffer);
        signal?.addEventListener('abort', () => { active.delete(s); no(new DOMException('aborted', 'AbortError')); });
      });
      active.add(s);
      if (!tick) tick = setInterval(step, 50);
      resolve({ ok: true, status: 200, headers: new Headers({ 'x-ticks': String(FINAL), 'x-transcript-hash': HASH }), arrayBuffer: () => body });
    }, latencyMs);
    signal?.addEventListener('abort', () => { clearTimeout(t0); reject(new DOMException('aborted', 'AbortError')); });
  });
}

test('control: the same link, not cut, delivers all seven copies (~17 s) and the run is safe', async () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `http://${x}`);
  const got = await secureTranscript({ roundId: RID, entryId: EID, nodes, finalTick: FINAL, fetcher: slowLink(), waitMs: 60000 });
  assert.equal(got.safe, true, got.why);
});

test('seven honest seats on a slow link: the run they all hold is reported safe (page defaults, two tries)', async () => {
  assert.ok(BYTES.length > 110_000, `a 4920-tick transcript is ${BYTES.length} bytes`);
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `http://${x}`);
  const fetcher = slowLink();
  // the page's own call: no waitMs, no need - the defaults the bundle ships; tried twice as ARENA_SECURE_RUN retries
  const tries = [];
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    const got = await secureTranscript({ roundId: RID, entryId: EID, nodes, finalTick: FINAL, fetcher });
    tries.push(`try ${i + 1} (${Date.now() - started} ms): ${got.safe ? 'safe' : got.why}`);
    if (got.safe) break;
  }
  assert.match(tries[tries.length - 1], /: safe$/, `all seven seats hold the run and were still sending, yet:\n${tries.join('\n')}`);
});
