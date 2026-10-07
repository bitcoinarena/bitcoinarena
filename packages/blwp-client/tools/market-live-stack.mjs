// A MARKET IN THE LIVE PAGE (kanban #206 slice 2): round-2of2's bonded 2-of-2 on a fresh regtest chain, its seats hosting
// nextblock and the regtest market "btc-close" (the one the page pins), a FREE market round opened and kept open, and the
// built page served beside it. After the first market round's entries close, two of its three attestors' outcome is posted
// to both seats. A TOOL for the two-tab Chrome run: it prints the lobby link and stays up; the browser is driven elsewhere.
//   BUILD=<page dir> RT=<regtest datadir> RPCPORT=<n> BITCOIN_CLI=<path> node market-live-stack.mjs
import { execFileSync } from 'node:child_process';
import { standUpRound, servePage } from '../../blwp-node/tools/round-2of2.mjs';
import { bitcoindRpc } from '../../blwp-node/src/chain-rpc.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET } from '../../blwp-node/test/plugins/market/index.js';
import { attestorSign } from '../../blwp-node/test/plugins/sign.js';
import { encodeAttestation } from '../../protocol/src/attested.js';
import { toHex } from '../../protocol/src/hash.js';

const env = process.env;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${env.RPCPORT}/`, cookiePath: `${env.RT}/regtest/.cookie` });
const cli = (...a) => execFileSync(env.BITCOIN_CLI, ['-regtest', `-datadir=${env.RT}`, `-rpcport=${env.RPCPORT}`, ...a], { encoding: 'utf8' }).trim();
const page = await servePage(env.BUILD, { host: '127.0.0.1', port: Number(env.PAGE_PORT || 29600) });
const pageUrl = `http://127.0.0.1:${page.port}`;
const round = await standUpRound({ host: '127.0.0.1', portA: Number(env.PORT_A || 29501), portB: Number(env.PORT_B || 29502), rpc, cli, page: pageUrl,
  plugins: [NEXTBLOCK, MARKET.registration], entryWindowMs: BigInt(env.ENTRY_WINDOW_MS || 240000),
  roundFields: { gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32) } });
say({ step: 'stood up', round: round.id, entryCloseMs: round.contract.entryCloseMs, gameId: toHex(round.contract.gameId).slice(0, 16), lobbyUrl: round.lobbyUrl });
const keeper = round.keepOpen({ everyMs: 5000, leadMs: 60000, onOpen: (id) => say({ step: 'opener', opened: id }), onError: (e) => say({ step: 'opener', error: e.message }) });
// THE OUTCOME, once the first round's entries have closed: 2 of 3 attestors say "above 100k"
const closeMs = Number(round.contract.entryCloseMs);
while (Date.now() < closeMs + 3000) await wait(1000);
const [A0, , A2] = MARKET.attestors;
const body = { roundId: Buffer.from(round.id, 'hex'), outcome: Number(env.OUTCOME || 0), observedAtMs: BigInt(Date.now()) };
const att = encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) });
for (const n of round.nodes) {
  const r = await fetch(`${n}/outcome?round=${round.id}`, { method: 'POST', body: att });
  say({ step: 'attested', node: n, status: r.status, said: (await r.text()).slice(0, 160) });
}
// UP FOR THE SCREENSHOTS: the round's table at both seats, every 30 s, for LIVE_MIN minutes
for (let i = 0; i < Number(env.LIVE_MIN || 20) * 2; i++) {
  await wait(30000);
  const o = await (await fetch(`${round.nodes[0]}/outcome?round=${round.id}`)).json();
  say({ step: 'outcome', state: o.state, label: o.label, final: o.final, rows: (o.table && o.table.rows || []).map((x) => [x.entryId.slice(0, 8), x.pick, x.won]) });
}
keeper.stop && keeper.stop();
process.exit(0);
