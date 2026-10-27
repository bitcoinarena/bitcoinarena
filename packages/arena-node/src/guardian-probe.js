// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IS THIS NODE'S GUARDIAN THE ONE THAT ANSWERS? (the 2026.1.9.11 install test: the owner area's Services card said "Guardian (fedimintd)
// Running - its API answers" and the Overview "Custody: Guardian" while the node's fedimintd had ended at its start - "Bind address:
// 127.0.0.1:12770 ... Address already in use" - because another node's guardian held that port and the probe was a bare TCP connect).
// The guardian is asked over its API with this node's own admin password (node.db.guardian/admin-password, which fedimintd was started
// with as FM_PASSWORD_API): a running federation answers the admin `auth`, a guardian waiting in setup the admin `get_setup_code`; another
// node's guardian refuses the password (401). The seat's services card (own-services.js) and the installer's status and doctor
// (node-services.js) both ask this, so they say the same. Not ours or not answering: its log's last error line says why.
import { readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The last line of a fedimintd log that names an error, ANSI colours and the timestamp's noise kept out; null when there is none. */
export function lastErrorLine(file, { bytes = 64 * 1024 } = {}) {
  let text;
  try {
    const fd = openSync(file, 'r');
    try { const size = fstatSync(fd).size; const n = Math.min(size, bytes); const b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); text = b.toString('utf8'); } finally { closeSync(fd); }
  } catch { return null; }
  const lines = text.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\b(ERROR|Error|error|panicked|FATAL)\b|already in use/.test(lines[i])) return lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i];
  }
  return null;
}

/** One JSON-RPC call over the guardian's local websocket (fedimint's params [{ auth, params }]): { result } or { error: { code, message } }. */
export async function wsCall(port, method, { auth = null, timeoutMs = 3000, WebSocketImpl = null } = {}) {
  const WS = WebSocketImpl || globalThis.WebSocket || (await import('ws')).default;
  return new Promise((resolve) => {
    let ws;
    const t = setTimeout(() => done({ error: { code: 'timeout', message: 'no answer in time' } }), timeoutMs);
    const done = (v) => { clearTimeout(t); try { ws && ws.close(); } catch { /* closed */ } resolve(v); };
    try { ws = new WS(`ws://127.0.0.1:${port}/`); } catch (e) { done({ error: { code: 'connect', message: e.message } }); return; }
    const on = (ev, f) => (ws.addEventListener ? ws.addEventListener(ev, f) : ws.on(ev, f));
    on('error', (e) => done({ error: { code: 'connect', message: (e && (e.message || (e.error && e.error.message))) || 'it does not answer' } }));
    on('close', () => done({ error: { code: 'connect', message: 'the connection closed' } }));
    on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ auth, params: null }] })));
    on('message', (m) => {
      try {
        const j = JSON.parse(String(m && m.data !== undefined ? m.data : m));
        if (j.id === 1) done(j.error ? { error: { code: j.error.code, message: j.error.message || JSON.stringify(j.error) } } : { result: j.result });
      } catch (e) { done({ error: { code: 'parse', message: e.message } }); }
    });
  });
}

const refused = (e) => e && (e.code === 401 || /authori[sz]/i.test(String(e.message || '')));

/**
 * THIS NODE'S GUARDIAN, ASKED: { ok, ours, setup, says }. `apiPort` its API port (guardian.js guardianPorts: the seat's port + 1000),
 * `dataDir` its data dir (<store>.guardian, the admin password inside). `ok` only when the guardian on that port takes this node's password.
 */
export async function guardianAnswers({ apiPort, dataDir, call = wsCall, timeoutMs = 3000 }) {
  const why = () => { const l = dataDir ? lastErrorLine(join(dataDir, 'fedimintd.log')) : null; return l ? `; its log: ${l}` : ''; };
  if (!apiPort) return { ok: false, ours: null, says: 'no API port is known for it' };
  let password = null;
  try { password = readFileSync(join(dataDir, 'admin-password'), 'utf8').trim(); } catch { password = null; }
  const st = await call(apiPort, 'setup_status', { timeoutMs });
  if (st.error && ['connect', 'timeout'].includes(st.error.code)) return { ok: false, ours: null, says: `nothing listens on its API port ${apiPort}${why()}` };
  if (!password) return { ok: false, ours: null, says: `something answers on its API port ${apiPort}, but this node holds no admin password${dataDir ? ` (${join(dataDir, 'admin-password')})` : ''} to tell it is its own${why()}` };
  const setup = !st.error && st.result !== 'ConsensusIsRunning';
  const r = await call(apiPort, setup ? 'get_setup_code' : 'auth', { auth: password, timeoutMs });
  if (!r.error) return { ok: true, ours: true, setup, says: setup ? `its API answers on port ${apiPort} (in setup)` : `its API answers on port ${apiPort}` };
  if (refused(r.error)) return { ok: false, ours: false, says: `another guardian answers on its API port ${apiPort} and refuses this node's password${why()}` };
  return { ok: false, ours: null, says: `its API port ${apiPort} answers, but not as this node's guardian (${r.error.message})${why()}` };
}
