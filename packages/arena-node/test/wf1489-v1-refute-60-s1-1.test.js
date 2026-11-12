// kanban #1489 refute of #1470 ("no message takes the relay down"): the fix wraps the 'message' handler in a catch, but a
// WebSocket frame the ws library itself rejects (larger than maxPayload, a text frame that is not UTF-8, a frame with a
// reserved bit set) never reaches 'message' - ws emits 'error' on the socket, the relay has no 'error' listener, and the
// EventEmitter throws it: the relay process ends, for every player. Each case runs the real launcher (tools/nostr-relay.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const tool = fileURLToPath(new URL('../tools/nostr-relay.mjs', import.meta.url));
const up = async () => {
  const p = spawn(process.execPath, [tool, '0', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', exited = null;
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (code, sig) => { exited = { code, sig }; });
  for (const t = Date.now(); Date.now() - t < 10000 && !/"port":\d+/.test(out); await new Promise((r) => setTimeout(r, 20)));
  const port = Number(/"port":(\d+)/.exec(out)[1]);
  return { p, port, state: () => ({ exited, err: err.split('\n').filter((l) => /Error|error/.test(l)).slice(0, 2).join(' | ') }) };
};
const stillAnswers = async (port) => {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('no open')), 2000); });
    const got = await new Promise((res) => { ws.on('message', (m) => res(JSON.parse(String(m)))); ws.send(JSON.stringify(['REQ', 'x', { kinds: [0] }])); setTimeout(() => res(null), 2000); });
    ws.terminate();
    return Array.isArray(got) && got[0] === 'EOSE';
  } catch { return false; }
};
const check = async (name, attack) => {
  const r = await up();
  try {
    await attack(r.port);
    await new Promise((res) => setTimeout(res, 500));
    const alive = await stillAnswers(r.port);
    console.log(`  FACTS (${name}):`, JSON.stringify({ alive, ...r.state() }));
    assert.equal(r.state().exited, null, `${name}: the relay process ended`);
    assert.equal(alive, true, `${name}: the relay no longer answers a REQ`);
  } finally { if (!r.state().exited) r.p.kill('SIGKILL'); }
};

test('#1470 refute (s1): a frame over maxPayload (128 KB) takes the relay down', () => check('oversized frame', async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  ws.send('x'.repeat(200 * 1024));
}));

test('#1470 refute (s1): a text frame that is not UTF-8 takes the relay down', () => check('bad utf-8', async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('error', () => {});
  await new Promise((r) => ws.on('open', r));
  ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
}));

test('#1470 refute (s1): a raw frame with RSV1 set (no extension agreed) takes the relay down', () => check('rsv1 frame', async (port) => {
  const s = net.connect(port, '127.0.0.1');
  await new Promise((r) => s.on('connect', r));
  s.on('error', () => {});
  s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise((r) => s.once('data', r));
  s.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));   // FIN + RSV1, text, masked, empty
}));
