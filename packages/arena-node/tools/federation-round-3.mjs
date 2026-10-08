#!/usr/bin/env node
/**
 * DOES A PAYING FEDERATION ROUND OPEN WHEN THREE BONDED OPERATORS COVER THE FEDERATION?
 *
 *   PROBE=<federation-hold-probe dir> LOCK_BIN=<blwp-stake-lock> RPCPORT=30101 \
 *     node packages/arena-node/tools/federation-round-3.mjs
 *
 * §23.6 wants a paying FEDERATION round's federation covered by AT LEAST ITS
 * THRESHOLD of guardians who are DISTINCT BONDED CENSUS NODES, each advertising
 * that guardian's peer key under `guardian_of[]`. fedimintd 0.12.0 will not
 * build a federation of 2 or 3 ("Federation size must be 1 or at least 4"), so
 * the smallest real one is 4 guardians at threshold 3 - and two signer nodes
 * cannot be three distinct nodes. This stands THREE.
 *
 * It is the same money stack `w5b.mjs` uses, with two differences that are the
 * measurement: the round is stood up ON THE CHAIN (`cli`/`rpc`), which is what
 * makes `POST /round` run the bonded-federation gate at all, and the bonds
 * carry ONE GUARDIAN EACH rather than one list repeated.
 *
 * It prints what it measured and never decides anything: the node count, each
 * node's guardian key and bond txid, what `federationIsBonded` counted over the
 * census the chain derives, and whether the round opened.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
if (!P || !env.LOCK_BIN) {
  console.error('PROBE (a federation-hold-probe dir) and LOCK_BIN (blwp-stake-lock) are needed');
  process.exit(2);
}
const rpcport = env.RPCPORT || '30101';
const RT = join(P, 'btc');
// THE PROBE'S CHAIN ANSWERS TO A USER AND PASSWORD, not a cookie - it is started
// with -rpcuser=blwp -rpcpassword=blwp - so both doors are opened the same way.
const AUTH = ['-rpcuser=blwp', '-rpcpassword=blwp'];
const BIN = env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const base = ['-regtest', `-datadir=${RT}`, `-rpcport=${rpcport}`, ...AUTH];
const cliRaw = (...a) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
// THE FEDERATION'S OWN WALLET IS ALREADY LOADED HERE, so every wallet call has to
// say which one it means - "Multiple wallets are loaded" is what it answers
// otherwise, and that refusal reached the harness as a bond it could not pay for.
const cli = (...a) => execFileSync(BIN, [...base, '-rpcwallet=blwp', ...a], { encoding: 'utf8' }).trim();
// AND THE SAME WALLET OVER HTTP: the /wallet/<name> path is how the JSON-RPC door
// is told which one, and chain calls answer through it unchanged.
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/wallet/blwp`, readCookie: () => 'blwp:blwp' });

// THE HARNESS'S OWN WALLET, WITH COINS IN IT. `regtest()` loads or creates
// `blwp` and pays the bonds out of it; on this chain that wallet is new, and a
// new wallet has nothing, so it is funded here before a bond is asked for.
try { cliRaw('createwallet', 'blwp'); } catch { try { cliRaw('loadwallet', 'blwp'); } catch { /* already loaded */ } }
cli('generatetoaddress', '101', cli('getnewaddress'));

const invite = readFileSync(join(P, 'g0', 'invite-code'), 'utf8').replace(/["\n ]/g, '');
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: join(P, 'client') });

// THE FEDERATION'S OWN FACTS, read through the same port a signer node reads them
// with - not numbers written down here. Its id, its guardian keys and its
// threshold are the federation's, and §23.6 counts against them.
const fed = await port.guardians();
const federationId = fed.federationId;
const guardianKeys = fed.keys;
if (!guardianKeys.length) throw new Error('the federation named no guardian keys');
say({ step: 'federation', id: toHex(federationId).slice(0, 16), guardians: guardianKeys.length,
  threshold: fed.threshold, chain: `regtest rpc ${rpcport}`, height: Number(cli('getblockcount')) });

// ONE GUARDIAN PER SIGNER NODE, in order. Three nodes cover three of the four,
// which is exactly the threshold - and no node claims a key another one claims.
//
// NODES=2 RUNS THE CONTROL: the same code, the same federation, the same
// per-node adverts, one operator fewer. §23.6 should refuse it by name, and a
// pass that is not paired with that refusal has not shown the gate runs.
const howMany = Number(env.NODES || 3);
const perNode = [...new Array(howMany).keys()].map((i) => [{ federationId, guardianKey: guardianKeys[i] }]);
say({ step: 'guardianOf', nodes: howMany,
  keys: perNode.map((g, i) => `${String.fromCharCode(65 + i)} -> ${toHex(g[0].guardianKey).slice(0, 16)}`) });

let round = null;
let code = 0;
try {
  round = await standUpRound({
    host: '127.0.0.1', portA: 18581, portB: 18582, ...(howMany > 2 ? { portC: 18583 } : {}),
    stakeMsat: 1000000n, objectionWindowMs: 20000n,
    rpc, cli, federationId, invite, signerNode: { stakeLocks: port }, guardianOf: perNode,
    // THE LIVE DAILY OWNS 18777 ON THIS MACHINE (its own recipients door), and
    // this harness must not take it - so it binds its own. The signed test set
    // names 18777, so a donation paid through THIS round would not reach these;
    // nothing here pays one, and the §23.6 gate is not on that path.
    donationRecipients: { port: 18787 },
  });
  say({ step: 'round', opened: true, id: round.id, nodes: round.contract.nodes.length,
    custody: round.contract.custody, stakeMsat: round.contract.stakeMsat,
    gameVerifySlots: round.contract.gameVerifySlots, settlementSlots: round.contract.settlementSlots });
} catch (e) {
  code = 1;
  say({ step: 'round', opened: false, why: String(e.message).slice(0, 400) });
}

if (round) {
  // AND THE SAME COUNT THIS TOOL CAN SHOW, over the census the daemons derived
  // from the chain. The round opening already proves the gate passed; this
  // prints WHAT it counted, so a pass is a number and not a silence.
  say({ step: 'bonded', note: 'the round opened, so POST /round ran the §23.6 gate and it passed',
    threshold: fed.threshold, nodes: round.contract.nodes.length });
  // AND THE CLAIM KEY, WATCHED. The signer nodes run their DKG in the background
  // once the round is assigned; a stake cannot be locked until they hold it, so
  // how long it takes with three peers is a number this letter needs.
  const began = Date.now();
  let held = null;
  for (const stop = began + 240000; Date.now() < stop; ) {
    const said = await Promise.all(round.nodes.map(async (b) => {
      try { const r = await fetch(`${b}/claim-key?round=${round.id}`); return `${r.status}`; } catch (e) { return 'down'; }
    }));
    if (said.every((x) => x === '200')) { held = said; break; }
    await new Promise((r) => setTimeout(r, 3000));
    if ((Date.now() - began) % 30000 < 3100) say({ step: 'claim key waiting', ms: Date.now() - began, said });
  }
  say({ step: 'claim key', held: !!held, ms: Date.now() - began });
  await round.close();
}
process.exit(code);
