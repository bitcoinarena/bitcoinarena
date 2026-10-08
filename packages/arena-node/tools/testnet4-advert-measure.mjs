// WHAT THE SEVEN ADVERTISEMENT UPDATES CHANGED, MEASURED ON THE TESTNET4 CHAIN (the owner 2026-09-28, the
// advertisement-update letter: "measure that census and the page both show the seven current guardian keys via the
// newest update, that the runner would select bond 0c82db59 for node 1, and that no new bond transaction was posted").
//
// Read only - it posts nothing. Over the real blocks from ARENA_FROM_HEIGHT to the tip:
//   census  - the node's own Roster derives the census at the tip for a testnet4 round on federation 337ae01a, and
//             answers /guardian-bonds for it, exactly as a node's server does;
//   page    - the client's bondedGuardians proves those offers (bond and update) into the same chain's headers and
//             counts them against the federation's keys, read off the guardians' own consensus config;
//   runner  - findBond, per node, with what the runner asks now (the node's current guardian key);
//   bonds   - every unspent bond of each node key, so a second bond would show.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { readInvite } from '../src/invite.js';
import { Roster } from '../src/roster.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { seriesTemplate, seriesRound, seriesIndexAt } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { guardiansOf, offersFrom, bondedGuardians } from '../../arena-client/src/guardians.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const home = env.ARENA_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`;
const datadir = env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4';
const wallet = env.ARENA_TN4_BOND_WALLET || 'blwp-tn4-bonds';
const cli = (...a) => execFileSync(env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${datadir}`, `-rpcwallet=${wallet}`, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim();
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);

const rt = regtest(cli, { network: 'testnet4', wallet });
const tip = rt.height();
const from = Number(env.ARENA_FROM_HEIGHT || 154160);
const federationId = fromHex(readInvite(readFileSync(join(home, 'invite-code'), 'utf8').replace(/["\s]/g, '')).federationId);

// THE FEDERATION'S KEYS, off its guardians' own config: every guardian must hold the same seven
const configs = [1, 2, 3, 4, 5, 6, 7].map((n) => JSON.parse(readFileSync(join(home, `node-${n}.db.guardian/consensus.json`), 'utf8')).broadcast_public_keys);
if (!configs.every((c) => JSON.stringify(c) === JSON.stringify(configs[0]))) throw new Error('the guardians do not hold one config');
const fedKeys = Object.keys(configs[0]).sort((a, b) => a - b).map((p) => configs[0][p]);
const nodes = [1, 2, 3, 4, 5, 6, 7].map((n) => {
  const store = join(home, `node-${n}.db`);
  const db = openStore(store); const { secret, pubkey } = nodeIdentity(db); db.close?.();
  const peer = JSON.parse(readFileSync(`${store}.guardian/local.json`, 'utf8')).identity;
  return { n, secret, pubkey, guardianKey: configs[0][String(peer)] };
});
say({ tip, from, federation: toHex(federationId).slice(0, 16), keys: fedKeys.map((k) => k.slice(0, 8)) });

// THE BLOCKS, as a node's chain view holds them
const view = rt.blocksFrom(from, tip);

// A TESTNET4 ROUND ON FEDERATION 337ae01a, its census at the tip: the census root is filled from the chain, since the
// question is what the census holds, not whether some round named it
const base = {
  networkId: NETWORK_ID_TESTNET4, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: tip, censusRoot: b32(0), stakeMsat: 1000000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: nodes.map((x) => x.pubkey),
};
const round0 = seriesRound(seriesTemplate(base, seriesIndexAt(base.networkId, Date.now()) + 1), 0);
const rosterFor = (contract) => {
  const rid = roundId(contract);
  const store = { get: (id) => (toHex(id) === toHex(rid) ? { contract: encodeRoundContract(contract) } : null) };
  return { rid, roster: new Roster(store, { chainFor: () => view }) };
};
const probe = rosterFor({ ...round0, censusHeight: tip });
const atTip = probe.roster.censusAtHeight(probe.rid, tip);
if (!atTip.ok) throw new Error(`the census at ${tip}: ${atTip.why}`);
const contract = { ...round0, censusHeight: tip, censusRoot: atTip.root };
const { rid, roster } = rosterFor(contract);
const census = roster.censusFor(rid);
if (!census.ok) throw new Error(`the census: ${census.why}`);
const byNode = new Map(nodes.map((x) => [toHex(x.pubkey), x]));
const censusRows = census.entries.map((e) => {
  const x = byNode.get(toHex(e.pubkey));
  const keys = (e.advert.guardianOf || []).filter((g) => toHex(g.federationId) === toHex(federationId)).map((g) => toHex(g.guardianKey));
  return { node: x ? x.n : null, bond: `${toHex(Uint8Array.from(e.txid).reverse())}:${e.vout}`, height: e.height,
    guardianKey: keys[0] || null, current: !!x && keys.length === 1 && keys[0] === x.guardianKey,
    updatedBy: e.updatedBy ? toHex(Uint8Array.from(e.updatedBy.txid).reverse()) : null };
});
for (const r of censusRows) say({ census: r });

// THE PAGE: /guardian-bonds as the node answers it, then counted by the client on the chain's own headers
const answer = roster.guardianBondsFor(rid);
if (!answer.ok) throw new Error(`/guardian-bonds: ${answer.why}`);
const offers = offersFrom(JSON.stringify(answer));
const guardians = guardiansOf({ federation_id: toHex(federationId), guardians: fedKeys.length, threshold: 5,
  keys: fedKeys.map((key, peer) => ({ peer: String(peer), key })) });
const headers = view.blocks.map((b) => b.header);
const page = await bondedGuardians({ guardians, round: { federationId, bondMinSats: 50000n, censusConfirmations: 6 },
  chain: headers, offers, verify, network: 'testnet4' });
say({ page: { ok: page.ok, bonded: page.bonded, threshold: page.threshold, why: page.why || null,
  offers: offers.length, withUpdate: offers.filter((o) => o.update).length, refused: page.refused } });

// THE RUNNER'S SEARCH, per node, asking for the key the node's guardian holds now; and every unspent bond per key
const runner = nodes.map((x) => {
  const bonds = rt.bondsOf(x.secret);
  const cur = bonds[0];
  const want = cur ? { endpoint: cur.advert.endpoint, guardianCapable: cur.advert.guardianCapable,
    guardianEndpoint: cur.advert.guardianEndpoint, bondSats: 50000n,
    guardianOf: [{ federationId, guardianKey: fromHex(x.guardianKey) }] } : null;
  const found = want ? rt.findBond(x.secret, want) : null;
  const r = { node: x.n, selects: found ? `${found.txid}:${found.vout}` : null, updatedBy: found?.updatedBy?.txid || null,
    guardianKey: x.guardianKey.slice(0, 8), unspentBonds: bonds.map((b) => `${b.txid.slice(0, 8)}@${b.height}`) };
  say({ runner: r });
  return r;
});

const current = censusRows.filter((r) => r.current && r.updatedBy);
const verdict = {
  censusSevenCurrent: new Set(current.map((r) => r.node)).size === 7,
  pageSevenBonded: page.bonded === 7,
  node1: { census: censusRows.find((r) => r.node === 1 && r.current)?.guardianKey?.slice(0, 8) || null, runner: runner[0].selects },
  newestBondHeight: Math.max(...runner.flatMap((r) => r.unspentBonds.map((b) => Number(b.split('@')[1])))),
};
say({ verdict });
