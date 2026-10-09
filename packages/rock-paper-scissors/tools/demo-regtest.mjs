#!/usr/bin/env node
// ROCK PAPER SCISSORS, ALWAYS PLAYABLE (kanban #233, "Two players can always play each other. It is a demo."): a private
// regtest bitcoind, two seats hosting nextblock and rock-paper-scissors (each advertising both), free 15-second rounds of
// Rock Paper Scissors back to back (kanban #279), and the lobby link printed.
// Regtest only: no bond on any other chain, no money. The seats are reached publicly through the named tunnel when
// ARENA_WSS_<port> names them (rps-a / rps-b.bitcoin-arena.io).
//
//   ARENA_PAGE=<the page's URL> ARENA_WSS_21651=wss://rps-a.bitcoin-arena.io ARENA_WSS_21652=wss://rps-b.bitcoin-arena.io \
//     node packages/rock-paper-scissors/tools/demo-regtest.mjs <work dir>
// Ports (private, < 32768, clear of the live guardian range): bitcoind RPC 21641 / p2p 21642, seats 21651 21652.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { bitcoindRpc } from '../../arena-node/src/chain-rpc.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { ROCK_PAPER_SCISSORS, RPS_DECIDE_CORE } from '../plugin/rock-paper-scissors.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { testAttestedGame } from '../../arena-node/test/plugins/sign.js';
import { UP_DOWN_OUTCOMES, upDownWindow } from '../../arena-protocol/src/up-down.js';

const env = process.env;
const dir = process.argv[2];
if (!dir || !env.ARENA_PAGE) { console.error('ARENA_PAGE=<page url> node demo-regtest.mjs <work dir>'); process.exit(2); }
const B = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const RPC = 21641;
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const rt = join(dir, 'btc');
mkdirSync(rt, { recursive: true });
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, ['-regtest', `-datadir=${rt}`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8' }).trim();
if (!existsSync(join(rt, 'regtest', '.cookie'))) {
  execFileSync(`${B}/bitcoind`, ['-regtest', `-datadir=${rt}`, `-rpcport=${RPC}`, '-port=21642', '-listen=0', '-fallbackfee=0.0002', '-txindex=1', '-daemon']);
}
for (let i = 0; ; i++) { try { cli('getblockcount'); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 500)); } }
try { cli('createwallet', 'blwp'); } catch { try { cli('loadwallet', 'blwp'); } catch { /* loaded */ } }
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${RPC}/`, cookiePath: join(rt, 'regtest', '.cookie') });

// A ROCK PAPER SCISSORS ROUND: its game, its decide adapter and config; no run - its 600 ticks and 300-tick deadline make the
// reveal window (entry close to the round's end) about 20 s, inside the game's 120 s
const RPS_FIELDS = { gameId: ROCK_PAPER_SCISSORS.gameId, simCoreHash: fromHex(RPS_DECIDE_CORE.hash),
  configHash: fromHex([...RPS_DECIDE_CORE.configs.keys()][0]), blockTicks: 600, startDeadlineTicks: 300, minScore: 2 };
// AND AN UP/DOWN MARKET'S ORDER BOOK (kanban #278): the seats also host a two-outcome test market (Polymarket's BTC Up or Down
// 15m, its attestors test keys) and keep one Up/Down round open to the next quarter hour, so each seat runs its order book
// for a live round (GET /book?round=). Regtest only: test keys, free rounds.
const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const round = await standUpRound({ host: '127.0.0.1', portA: 21651, portB: 21652, rpc, cli, page: env.ARENA_PAGE,
  plugins: [NEXTBLOCK, ROCK_PAPER_SCISSORS, UPDOWN.registration], closeAtEnd: true });
say({ step: 'up', nodes: round.nodes, lobby: round.lobbyUrl });
// 15-SECOND ROUNDS (kanban #279, the owner 2026-10-09 15:00: "rounds are 15 seconds"): each round takes picks for 15 s, and the
// next one's 15 s begin as this one's end - entry closes on a 15 s grid. A round is joinable only once both seats took it,
// ~95 s after its committee time on this 10 s chain (its beacon 6 deep), so rounds are opened LEAD_MS ahead and kept in
// flight: whenever the last close is under LEAD_MS + 15 s away, the next is opened 15 s after it.
const WINDOW_MS = 15000n;
const LEAD_MS = 150000n;
let lastClose = 0n, opening = false;
const keep = async () => {
  const now = BigInt(Date.now());
  if (opening || lastClose > now + LEAD_MS + WINDOW_MS) return;
  opening = true;
  try {
    // 15 s after the last close, never sooner - and never less than LEAD_MS ahead (the seats must hold it before its window)
    const want = lastClose + WINDOW_MS > now + LEAD_MS ? lastClose + WINDOW_MS : now + LEAD_MS;
    // openNext starts a round 60 s after its committee time (now + 2 s): the entry window after that start lands its close on `want`
    const id = await round.openNext({ fields: RPS_FIELDS, entryAfterStartMs: Number(want - (BigInt(Date.now()) + 62000n)) });
    const held = round.rounds().find((r) => r.id === id);
    lastClose = held ? BigInt(held.entryCloseMs) : want;
    say({ step: 'opened', game: 'rock-paper-scissors', round: id, entryClose: new Date(Number(lastClose)).toISOString() });
  } catch (e) { say({ step: 'not opened', why: e.message }); } finally { opening = false; }
};
await keep();
setInterval(keep, 2000);
// ONE UP/DOWN ROUND OPEN AT A TIME: its entries (its orders) close at the end of the quarter hour after the one now
const UPDOWN_FIELDS = { gameId: UPDOWN.registration.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32) };
let marketClose = 0n, marketOpening = false;
const keepMarket = async () => {
  const now = BigInt(Date.now());
  if (marketOpening || marketClose > now + 60000n) return;
  marketOpening = true;
  try {
    const close = upDownWindow(now + 900000n).endMs;
    const id = await round.openNext({ fields: UPDOWN_FIELDS, entryAfterStartMs: Number(close - (BigInt(Date.now()) + 62000n)) });
    const held = round.rounds().find((r) => r.id === id);
    marketClose = held ? BigInt(held.entryCloseMs) : close;
    say({ step: 'opened', game: 'btc-updown-15m', round: id, entryClose: new Date(Number(marketClose)).toISOString(), book: `${round.nodes[0]}/book?round=${id}` });
  } catch (e) { say({ step: 'market not opened', why: e.message }); } finally { marketOpening = false; }
};
await keepMarket();
setInterval(keepMarket, 10000);
// THE CHAIN MOVES, so each round finds its beacon and is assigned
setInterval(() => { try { cli('generatetoaddress', '1', cli('getnewaddress')); } catch (e) { say({ step: 'mine', why: e.message }); } }, 10000);
say({ step: 'lobby', url: round.lobbyUrl });
