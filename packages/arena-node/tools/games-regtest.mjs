#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO GAMES ON ONE PAIR OF SEATS, FOR THE PAGE: a private regtest bitcoind, two seats hosting nextblock and the
// regtest market btc-close (each advertising both), a free round of each kept open, and the page served from a build
// directory - so a browser's lobby offers both games and loads each one's own client. Regtest only; no bond on any other
// chain, no money.
//
//   ARENA_PAGE_DIR=<a built page with games/btc-close/index.html> node tools/games-regtest.mjs <work dir>
// Ports (private, < 32768, clear of the live guardian range): bitcoind RPC 21641 / p2p 21642, seats 21651 21652, page 21660.
// Prints the lobby link; runs until killed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { standUpRound, servePage } from './round-2of2.mjs';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { MARKET } from '../test/plugins/market/index.js';

const env = process.env;
const dir = process.argv[2];
if (!dir || !env.ARENA_PAGE_DIR) { console.error('ARENA_PAGE_DIR=<built page> node tools/games-regtest.mjs <work dir>'); process.exit(2); }
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
// the wallet regtest-bond.mjs pays the bonds from
try { cli('createwallet', 'arena'); } catch { try { cli('loadwallet', 'arena'); } catch { /* loaded */ } }
if (Number(cli('getblockcount')) < 101) cli('generatetoaddress', '101', cli('getnewaddress'));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${RPC}/`, cookiePath: join(rt, 'regtest', '.cookie') });

const pageServer = await servePage(env.ARENA_PAGE_DIR, { host: '127.0.0.1', port: 21660 });
const page = `http://127.0.0.1:${pageServer.port}`;
// A MARKET ROUND: its game, no core, no config, no run
const MARKET_FIELDS = { gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32), blockTicks: 0 };
const round = await standUpRound({ host: '127.0.0.1', portA: 21651, portB: 21652, rpc, cli, page, plugins: [NEXTBLOCK, MARKET.registration] });
say({ step: 'up', first: round.id, nodes: round.nodes, lobby: round.lobbyUrl });
// ONE JOINABLE ROUND OF EACH GAME: whenever a game's last round has under a minute of entry left, its next is opened
const kinds = [{ game: 'nextblock' }, { game: 'btc-close', fields: MARKET_FIELDS }];
const last = new Map([['nextblock', round.contract.entryCloseMs]]);
let opening = false;
const keep = async () => {
  if (opening) return;
  opening = true;
  try {
    for (const k of kinds) {
      if ((last.get(k.game) || 0n) > BigInt(Date.now()) + 60000n) continue;
      try {
        const id = await round.openNext(k.fields ? { fields: k.fields } : {});
        const held = round.rounds().find((r) => r.id === id);
        last.set(k.game, held ? BigInt(held.entryCloseMs) : BigInt(Date.now()) + 120000n);
        say({ step: 'opened', game: k.game, round: id, entryClose: held ? new Date(Number(held.entryCloseMs)).toISOString() : null });
      } catch (e) { say({ step: 'not opened', game: k.game, why: e.message }); }
    }
  } finally { opening = false; }
};
await keep();
setInterval(keep, 10000);
// THE CHAIN MOVES, so each round finds its beacon and is assigned
setInterval(() => { try { cli('generatetoaddress', '1', cli('getnewaddress')); } catch (e) { say({ step: 'mine', why: e.message }); } }, 10000);
say({ step: 'lobby', url: round.lobbyUrl });
