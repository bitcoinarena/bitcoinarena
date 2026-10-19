#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS, ALWAYS PLAYABLE ("Two players can always play each other. It is a demo."): a private
// regtest bitcoind, two seats hosting nextblock and rock-paper-scissors (each advertising both), free 15-second rounds of
// Rock Paper Scissors back to back, and the lobby link printed.
// Regtest only: no bond on any other chain, no money. The seats are reached publicly through the named tunnel when
// ARENA_WSS_<port> names them (rps-a / rps-b.bitcoin-arena.io).
//
//   ARENA_PAGE=<the page's URL> ARENA_WSS_21651=wss://rps-a.bitcoin-arena.io ARENA_WSS_21652=wss://rps-b.bitcoin-arena.io \
//     node packages/rock-paper-scissors/tools/demo-regtest.mjs <work dir>
// Ports (private, < 32768, clear of the live guardian range): bitcoind RPC 21641 / p2p 21642, seats 21651 21652.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { standUpRound, keepBackToBack, tableCounter } from '../../arena-node/tools/round-2of2.mjs';
import { bitcoindRpc } from '../../arena-node/src/chain-rpc.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { ROCK_PAPER_SCISSORS, RPS_DECIDE_CORE, RPS_ROUND_FIELDS } from '../plugin/rock-paper-scissors.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } from '../../arena-node/test/plugins/updown/index.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';

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
try { cli('createwallet', 'arena'); } catch { try { cli('loadwallet', 'arena'); } catch { /* loaded */ } }
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${RPC}/`, cookiePath: join(rt, 'regtest', '.cookie') });

// A ROCK PAPER SCISSORS ROUND: its fields as the plugin names them (RPS_ROUND_FIELDS)
const RPS_FIELDS = RPS_ROUND_FIELDS;
// AND THE UP/DOWN MARKET: the seats also host the test market btc-updown-15m (Polymarket's BTC Up or Down
// 15m: its own 15-minute period, its terms, 2 of 3 attestors with test keys) and run it as a series, below; each seat runs
// its order book for those rounds (GET /book?round=). Regtest only: test keys, free rounds.
// THE SEATS' STORES ON DISK: a restart keeps their rounds and keys - the Up/Down series and its measurement go on
// PUBLISHED AHEAD OR NOT AT ALL: without it every 8 s round takes 12-23 s to open and the rounds have holes
if (env.ARENA_PUBLISH_AHEAD !== '1') { console.error('set ARENA_PUBLISH_AHEAD=1: the rounds are opened ahead'); process.exit(2); }
mkdirSync(join(dir, 'seats'), { recursive: true });
const round = await standUpRound({ host: '127.0.0.1', portA: 21651, portB: 21652, rpc, cli, page: env.ARENA_PAGE, store: join(dir, 'seats'),
  plugins: [NEXTBLOCK, ROCK_PAPER_SCISSORS, UPDOWN.registration], closeAtEnd: true });
say({ step: 'up', nodes: round.nodes, lobby: round.lobbyUrl });
// SHORT ROUNDS BACK TO BACK (15 s2026-10-09 17:04: 10 s): each round takes picks for WINDOW_MS,
// and the next one's begin as this one's end - entry closes on that grid. A round is joinable only once both seats took it,
// ~95 s after its committee time on this 10 s chain (its beacon 6 deep), so rounds are opened LEAD_MS ahead and kept in
// flight: whenever the last close is under LEAD_MS + 15 s away, the next is opened 15 s after it.
// 10 S (2026-10-09 17:04: "Set rounds to 10 seconds")
// 8 S (2026-10-09: "reduce the round length to 8 seconds")
const WINDOW_MS = 8000n;
const LEAD_MS = 150000n;
// BACK TO BACK, NO HOLE (measured 2026-10-10 10:52Z: closes 14-23 s apart for 8 s rounds): round-2of2's
// keepBackToBack - published ahead, the 8 s grid kept 150 s ahead
// TABLES: as many rounds a slot as the tables in play now, plus one spare - read off seat A's own listing
const countTables = tableCounter({ min: Number(env.RPS_MIN_TABLES || 3), spare: 1, windowMs: Number(WINDOW_MS), gameId: toHex(ROCK_PAPER_SCISSORS.gameId) });
const rpsTables = async () => { try { const d = await (await fetch('http://127.0.0.1:21651/rounds')).json();
  return countTables(d.rounds || [], Date.now()); } catch { return 3; } };
keepBackToBack(round, { fields: RPS_FIELDS, windowMs: WINDOW_MS, leadMs: LEAD_MS, tables: rpsTables,
  onOpen: ({ id, entryCloseMs, table, tables, tookMs }) => say({ step: 'opened', game: 'rock-paper-scissors', round: id, entryClose: new Date(Number(entryCloseMs)).toISOString(), table, tables, tookMs }),
  onError: (e) => say({ step: 'not opened', why: e.message }) });

// THE 15-MINUTE SERIES (2026-10-09: "one round per UTC quarter hour ... Open at least one quarter hour
// ahead; orders until the window ends"): a round for every window ending within the next 45 minutes - opened at least 15 min
// before its window starts - its entries closing exactly at its window's end (the market's period grid, which every seat
// checks), its locks sized to outlive it (lock-expiry.js). The attestor daemons resolve each one at its window's end.
const UPDOWN_FIELDS = { gameId: UPDOWN.registration.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32) };
const opened = new Set();
let marketOpening = false;
const keepMarket = async () => {
  if (marketOpening) return;
  marketOpening = true;
  try {
    const now = BigInt(Date.now());
    // the first window that starts at least one period from now: its start the first grid point at or after now + 15 min
    const reach = now + UPDOWN_PERIOD_MS;
    const firstStart = reach % UPDOWN_PERIOD_MS === 0n ? reach : reach - (reach % UPDOWN_PERIOD_MS) + UPDOWN_PERIOD_MS;
    // THE WINDOWS ITS SEAT ALREADY HOLDS A ROUND FOR (a restart forgets what it opened; the seat does not)
    let held = [];
    try { const r = await fetch(`http://127.0.0.1:21651/rounds`); const j = await r.json(); held = (Array.isArray(j) ? j : j.rounds || []).filter((x) => x.game && x.game.id === toHex(UPDOWN.registration.gameId)).map((x) => String(x.entryCloseMs)); } catch { /* none known */ }
    for (let end = firstStart + UPDOWN_PERIOD_MS; end <= now + 3n * UPDOWN_PERIOD_MS; end += UPDOWN_PERIOD_MS) {
      if (opened.has(String(end)) || held.includes(String(end))) continue;
      const id = await round.openNext({ fields: UPDOWN_FIELDS, entryCloseAtMs: end,
        stakeExpiryFor: (c) => { const need = marketExpiryBlocks(c, UPDOWN_TERMS); return need.ok ? need.blocks : 144; } });
      opened.add(String(end));
      const kept = round.rounds().find((r) => r.id === id);
      say({ step: 'opened', game: 'btc-updown-15m', round: id, window: [new Date(Number(end - UPDOWN_PERIOD_MS)).toISOString(), new Date(Number(end)).toISOString()],
        entryClose: kept ? new Date(Number(kept.entryCloseMs)).toISOString() : null, book: `${round.nodes[0]}/book?round=${id}` });
    }
  } catch (e) { say({ step: 'market not opened', why: e.message }); } finally { marketOpening = false; }
};
await keepMarket();
setInterval(keepMarket, 20000);
// THE CHAIN MOVES, so each round finds its beacon and is assigned
setInterval(() => { try { cli('generatetoaddress', '1', cli('getnewaddress')); } catch (e) { say({ step: 'mine', why: e.message }); } }, 10000);
say({ step: 'lobby', url: round.lobbyUrl });
