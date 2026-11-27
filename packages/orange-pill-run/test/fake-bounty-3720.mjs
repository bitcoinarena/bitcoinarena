// kanban #3720 headless check: the real sim and the real round service on a free test round, the built game page with a stand-in Arena bridge
// (the sign-in signed by this process for one fixed key), X and the Lightning address check on fakes (X: alice follows @bitcoinarena_io,
// bob does not). node test/fake-bounty-3720.mjs <port> <host>  -> prints JSON { base, round, pubkey }
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { eventId } from '../../arena-node/src/nostr-relay.js';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { fakeLnd, fakeChain, keypair } from './server-helpers.mjs';
const port = +(process.argv[2] || 24720), host = process.argv[3] || '127.0.0.1', base = `http://${host}:${port}`;
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));
const day = fx.days[fx.days.length - 1];
const off = Date.parse(day.day + 'T00:00:00Z') + 86400000 + 36000000 - Date.now();   // the service's clock: the day after the chart, 10:00 UTC
const lnd = fakeLnd(), chain = fakeChain();
const xs = { alice: { userId: 'x1', member: true }, bob: { userId: 'x2', member: false } };
const xLookup = async (name) => { const a = xs[String(name).toLowerCase()]; return a ? { userId: a.userId, username: name, member: a.member, why: a.member ? 'follows' : 'does not follow' } : { userId: null, username: name, member: false, why: 'no such X account' }; };
const opr = createOpr({ now: () => Date.now() + off, sim: { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog }, fetchCandles: async () => day.candles,
  checkLevel, invoices: lnd, chain, xLookup, lnCheck: async (a) => ({ ok: true, address: a }), log: () => {},
  cfg: { showTest: true, entrySats: 0, publicBases: [base + '/api/opr'], adminSha: createHash('sha256').update('letmein').digest('hex') } });
const made = opr.testRound({ minutes: 120, chartDay: day.day, maxAttempts: 5 }); if (!made.ok) throw new Error(made.why + ' ' + day.day);
await opr.tick(); await opr.tick(); chain.confirm(); await opr.tick();
const r = opr.roundRow(made.round.id);
const p = keypair();
const sign = (tags) => { const e = { pubkey: p.pk, created_at: Math.floor((Date.now() + off) / 1000), kind: 27235, tags, content: '' }; e.id = eventId(e); e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), p.sk)).toString('hex'); return e; };
const bridge = `<script>window.OPR = { bridge: { v: 1, apiBase: location.origin + "/api/opr", pubkey: () => ${JSON.stringify(p.pk)}, balance: () => ({ sats: 0 }), welcomeComing: () => false,
  signHttpAuth: async (tags) => (await fetch("/sign", { method: "POST", body: JSON.stringify(tags) })).json(), pay: async () => ({ ok: false, why: "no wallet here" }) } };</script>`;
const dist = new URL('../client/dist/', import.meta.url);
const srv = createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/games/orange-pill-run/index.html') { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return s.end(fs.readFileSync(new URL('index.html', dist), 'utf8').replace('<meta charset="utf-8">', () => '<meta charset="utf-8">' + bridge)); }
  if (u.pathname === '/sign' && q.method === 'POST') { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(sign(JSON.parse(b)))); }); return; }
  if (u.pathname.startsWith('/api/opr/')) return opr.handle(q, s);
  s.writeHead(404); s.end('no');
});
srv.listen(port, host, () => console.log(JSON.stringify({ base, round: r.id, phase: r.phase || r.state, pubkey: p.pk })));
