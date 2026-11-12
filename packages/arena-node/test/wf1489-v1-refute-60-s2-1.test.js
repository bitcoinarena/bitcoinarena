// kanban #1489 refute (skeptic 2) of #1470 ("no message takes the relay down"): eventRefusal lets an empty tag through
// (tags: [[]] - every tag is an array of strings, vacuously). The relay INSERTs the event, then tagRows reads t[0].length
// on the empty tag and throws. The #1470 catch around 'message' swallows it, so the live socket survives - but the row is
// already on disk, half handled: quota accounting, the replaceable drop and the fan-out never ran. On the next restart
// (the reload path) startRelay re-indexes the tags of every stored event while the tags table is empty and throws on the
// same row: the relay process never comes back up, for every player, until someone edits the database by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const sign = (k, kind, at, tags, content = 'x') => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('error', () => {}); await new Promise((x, y) => { ws.on('open', x); setTimeout(() => y(new Error('no open')), 3000); }); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); setTimeout(() => { ws.off('message', h); x(got); }, 2000); });
const tool = fileURLToPath(new URL('../tools/nostr-relay.mjs', import.meta.url));
const launch = async (dbPath) => {
  const p = spawn(process.execPath, [tool, '0', dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', exited = null;
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code, sig) => { exited = { code, sig }; });
  for (const t = Date.now(); Date.now() - t < 10000 && !/"port":\d+/.test(out) && !exited; await new Promise((r) => setTimeout(r, 20)));
  const m = /"port":(\d+)/.exec(out);
  return { p, port: m ? Number(m[1]) : null, state: () => ({ exited, err: err.split('\n').filter((l) => /Error/.test(l)).slice(0, 1).join('') }) };
};

test('#1470 refute (s2): one event with an empty tag keeps the relay from ever starting again (restart path)', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'wf1489-60-s2-')), 'relay.db');
  const a = await launch(dbPath);
  assert.ok(a.port, 'first start');
  const ws = await open(a.port);
  const got = await ask(ws, ['EVENT', sign(key(), 0, Math.floor(Date.now() / 1000), [[]], '{"name":"x"}')], (m) => m[0] === 'OK' || m[0] === 'NOTICE');
  ws.terminate();
  a.p.kill('SIGTERM');
  for (const t = Date.now(); Date.now() - t < 5000 && !a.state().exited; await new Promise((r) => setTimeout(r, 20)));
  const b = await launch(dbPath);   // the operator's restart / systemd's
  let alive = false;
  if (b.port) { try { const w2 = await open(b.port); const r = await ask(w2, ['REQ', 's', { kinds: [0] }], (m) => m[0] === 'EOSE'); alive = r.some((m) => m[0] === 'EOSE'); w2.terminate(); } catch { alive = false; } }
  console.log('  FACTS:', JSON.stringify({ firstAnswer: got, restartPort: b.port, alive, ...b.state() }));
  if (!b.state().exited) b.p.kill('SIGKILL');
  assert.equal(b.state().exited, null, 'the relay process ends at start: it cannot come back after one stranger\'s event');
  assert.equal(alive, true, 'the restarted relay answers a REQ');
});

test('#1470 refute (s2): events with an empty tag skip the author and total quotas (#1513) - the swallowed throw is a disk-fill', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 3, totalEvents: 5 } });
  const ws = await open(r.port);
  try {
    const k = key(), t0 = Math.floor(Date.now() / 1000) - 100;
    const answers = [];
    for (let i = 0; i < 12; i++) answers.push((await ask(ws, ['EVENT', sign(k, 8, t0 + i, [['n', String(i)], []])], (m) => m[0] === 'OK' || m[0] === 'NOTICE'))[0]);
    const kept = r.events().filter((e) => e.pubkey === k.pub).length;
    console.log('  FACTS:', JSON.stringify({ kept, total: r.events().length, last: answers.at(-1) }));
    assert.ok(kept <= 3, `one author keeps ${kept} events past authorEvents 3`);
    assert.ok(r.events().length <= 5, `the relay holds ${r.events().length} events past totalEvents 5`);
  } finally { ws.terminate(); await r.close(); }
});

test('#1470 refute (s2): a newer profile with an empty tag is kept beside the old one (replaceable drop skipped) and never reaches subscribers', async () => {
  const r = await startRelay({ port: 0 });
  const sub = await open(r.port), pub = await open(r.port);
  try {
    const k = key(), t0 = Math.floor(Date.now() / 1000) - 100;
    assert.equal((await ask(pub, ['EVENT', sign(k, 0, t0, [], '{"name":"old"}')], (m) => m[0] === 'OK'))[0][2], true);
    const live = [];
    await ask(sub, ['REQ', 'live', { kinds: [0], authors: [k.pub] }], (m) => m[0] === 'EOSE');
    sub.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'EVENT') live.push(m[2]); });
    const ans = await ask(pub, ['EVENT', sign(k, 0, t0 + 10, [[]], '{"name":"new"}')], (m) => m[0] === 'OK' || m[0] === 'NOTICE');
    await new Promise((x) => setTimeout(x, 300));
    const profiles = r.events().filter((e) => e.pubkey === k.pub && e.kind === 0);
    console.log('  FACTS:', JSON.stringify({ answer: ans[0], profiles: profiles.length, liveSeen: live.length }));
    assert.ok(ans[0][0] === 'OK', `the publisher gets no OK (got ${JSON.stringify(ans[0])})`);
    assert.equal(profiles.length, 1, 'a replaceable kind keeps one per author');
  } finally { sub.terminate(); pub.terminate(); await r.close(); }
});
