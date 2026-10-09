#!/usr/bin/env node
// ROCK PAPER SCISSORS, ALWAYS PLAYABLE (kanban #233, "Two players can always play each other. It is a demo."): a private
// regtest bitcoind, two seats hosting nextblock and rock-paper-scissors (each advertising both), one free round of
// Rock Paper Scissors kept open - a new one whenever the last has under a minute of entry left - and the lobby link printed.
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
import { fromHex } from '../../arena-protocol/src/hash.js';

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
const round = await standUpRound({ host: '127.0.0.1', portA: 21651, portB: 21652, rpc, cli, page: env.ARENA_PAGE,
  plugins: [NEXTBLOCK, ROCK_PAPER_SCISSORS], closeAtEnd: true });
say({ step: 'up', nodes: round.nodes, lobby: round.lobbyUrl });
let last = 0n, opening = false;
const keep = async () => {
  if (opening || last > BigInt(Date.now()) + 60000n) return;
  opening = true;
  try {
    // ENTRIES CLOSE 2 MIN AFTER START: a seat takes a round ~95 s after its committee time on this 10 s chain (its beacon 6
    // deep), so this leaves about a minute to pick a move; the reveal window follows (~20 s)
    const id = await round.openNext({ fields: RPS_FIELDS, entryAfterStartMs: 120000 });
    const held = round.rounds().find((r) => r.id === id);
    last = held ? BigInt(held.entryCloseMs) : BigInt(Date.now()) + 120000n;
    say({ step: 'opened', game: 'rock-paper-scissors', round: id, entryClose: held ? new Date(Number(held.entryCloseMs)).toISOString() : null });
  } catch (e) { say({ step: 'not opened', why: e.message }); } finally { opening = false; }
};
await keep();
setInterval(keep, 10000);
// THE CHAIN MOVES, so each round finds its beacon and is assigned
setInterval(() => { try { cli('generatetoaddress', '1', cli('getnewaddress')); } catch (e) { say({ step: 'mine', why: e.message }); } }, 10000);
say({ step: 'lobby', url: round.lobbyUrl });
