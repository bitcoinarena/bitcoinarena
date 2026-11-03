// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOND'S slash_presig AT BONDING (spec 5A.3B, RULED 2026-11-02, kanban #1053): an advertisement update carries it, to a hold output with no release leaf, and a template-3 bond counts only with
// it census_confirmations deep. A reader, the page included, checks one signature over the bond, its advertisement and its census key: no panels, no draw, no census.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { censusFromEvidence, entryFromEvidence } from '../../arena-protocol/src/client-committee.js';
import { advertId, decodeAdvert, encodeAdvert, SLASH_PRESIG_BYTES } from '../../arena-protocol/src/advert.js';
import { bond3OutputKey, bondInternalKey } from '../../arena-protocol/src/bond-script.js';
import { bondPresigDigest, bondPresigStands, signSlashPresig } from '../../arena-protocol/src/slash-presig.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { BOND_SUM_VERSION } from '../../arena-protocol/src/constants.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { bondTransaction, advertUpdateTransaction } from '../../arena-protocol/tools/bond.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { censusEvidenceOf } from '../src/roster.js';
import { tweakPoint, combine, bondSetFor } from '../src/curve.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const secretOf = (n) => taggedHash('ARENA/test/BondPresig', Uint8Array.from([n]));
const g = genesisFor('regtest');
const FIRST = 1000, BONDED = 1005, CENSUS = 1040, censusKey = schnorr.getPublicKey(secretOf(99));
const contract = { bondMinSats: 50000n, protocolVersion: BOND_SUM_VERSION, networkId: NETWORK_ID_REGTEST, censusHeight: CENSUS, censusConfirmations: 6 };
const bondSet = () => ({ ...bondSetFor('regtest'), standingKeys: [{ epoch: 0, publicKey: censusKey, height: 0 }] });

const advertOf = (n) => ({ nodePubkey: schnorr.getPublicKey(secretOf(n)), operatorId: `op${n}`, protocolVersions: [BOND_SUM_VERSION], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`,
  region: 'eu-west', capacityClass: 1, softwareHash: new Uint8Array(32).fill(2), settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 3,
  bondMaturityHeight: BONDED + 200, censusKey, ownerPubkey: schnorr.getPublicKey(secretOf(n)), payoutPubkey: new Uint8Array(32).fill(3), guardianOf: [], timestamp: 1788700000000n });

function bondOf(n, previous = 0x31) {
  const advert = advertOf(n), node = advert.nodePubkey;
  const inner = bondInternalKey({ nodeKey: node, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey;
  const { outputKey } = bond3OutputKey({ nodeKey: node, ownerKey: node, censusKey, bondMaturity: advert.bondMaturityHeight }, { tweakPoint });
  const raw = bondTransaction(advert, { outputKey, previousTxid: new Uint8Array(32).fill(previous + n) });
  const tx = parseTransaction(raw), o = tx.outputs[0];
  return { n, advert, raw, txid: tx.txid, bond: { txid: tx.txid, vout: 0, value: o.value, script: o.script } };
}
const presigOf = (b, secret = secretOf(b.n)) => signSlashPresig(bondPresigDigest({ bond: b.bond, advert: b.advert, networkId: NETWORK_ID_REGTEST, tweakPoint }).digest, (d) => schnorr.sign(d, secret));
const update = (b, advert, previous = 0x70) => advertUpdateTransaction(advert, { bondTxid: b.txid, bondVout: 0, signature: schnorr.sign(advertId(advert), secretOf(b.n)), previousTxid: new Uint8Array(32).fill(previous) });
const presigUpdate = (b, presig = presigOf(b), previous = 0x70) => update(b, { ...b.advert, slashPresig: presig, timestamp: 1788700000001n }, previous);

/** A chain holding `at`: height -> raw transactions. */
const chain = (at) => chainOf(Array.from({ length: CENSUS + 10 - FIRST }, (_, i) => ({ transactions: at[FIRST + i] || [] })), FIRST);
const censusOf = (view, c = contract) => {
  const byTxid = new Map();
  for (const b of view.blocks) for (const raw of b.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const r = deriveCensus(view, { contract: c, bond: bondSet(), verifyUpdate: verify, resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(r.ok, true, r.why);
  return r;
};

test('the field: 65 bytes after a marker, only when written, every advertisement before it keeps its bytes, and it reads back beside the others', () => {
  const plain = advertOf(1), bytes = encodeAdvert(plain);
  assert.deepEqual(encodeAdvert({ ...plain, slashPresig: undefined }), bytes);
  const presig = new Uint8Array(SLASH_PRESIG_BYTES).fill(7);
  assert.equal(encodeAdvert({ ...plain, slashPresig: presig }).length, bytes.length + 66);
  // a template-3 advert's emergency key is its owner key (kanban #1093 part 1, ruling #1103): the same 32 bytes when named
  for (const more of [{}, { serving: false }, { emergencyPubkey: plain.ownerPubkey }, { declares: { bondMinSats: 1n, proposalDepositSats: 2n } },
    { declares: { bondMinSats: 1n, proposalDepositSats: 2n }, emergencyPubkey: plain.ownerPubkey, serving: false }]) {
    const back = decodeAdvert(encodeAdvert({ ...plain, ...more, slashPresig: presig }));
    assert.deepEqual(back.slashPresig, presig);
    if (more.serving === false) assert.equal(back.serving, false);
    if (more.emergencyPubkey) assert.deepEqual(back.emergencyPubkey, more.emergencyPubkey);
    if (more.declares) assert.equal(back.declares.proposalDepositSats, 2n);
    const without = decodeAdvert(encodeAdvert({ ...plain, ...more }));
    assert.equal(without.slashPresig, undefined);
  }
  assert.throws(() => encodeAdvert({ ...plain, slashPresig: new Uint8Array(64) }), /65 bytes/);
});

test('the hold has no release leaf, its script takes no census and no panels, and one signature check reads it', () => {
  const b = bondOf(1), built = bondPresigDigest({ bond: b.bond, advert: b.advert, networkId: NETWORK_ID_REGTEST, tweakPoint });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.hold.leaves.release, undefined);
  assert.ok(built.hold.leaves.return && built.hold.leaves.fallback);
  const stands = (presig, over = {}) => bondPresigStands({ presig, bond: b.bond, advert: b.advert, networkId: NETWORK_ID_REGTEST, tweakPoint, verify, ...over });
  assert.equal(stands(presigOf(b)), true);
  assert.equal(stands(presigOf(b, secretOf(7))), false, 'another key');
  assert.equal(stands(presigOf(b), { bond: { ...b.bond, value: b.bond.value + 1n } }), false, 'another amount');
  assert.equal(stands(presigOf(b), { advert: { ...b.advert, bondMaturityHeight: b.advert.bondMaturityHeight + 1 } }), false, 'another maturity');
  assert.equal(stands(presigOf(b), { advert: { ...b.advert, censusKey: schnorr.getPublicKey(secretOf(98)) } }), false, 'another census key');
});

test('a template-3 bond counts only with its presig census_confirmations deep, and is named until then', () => {
  const b = bondOf(1);
  const none = censusOf(chain({ [BONDED]: [b.raw] }));
  assert.deepEqual([none.entries.length, none.excluded.length, none.excluded[0].step], [0, 1, 'presig']);
  assert.match(none.excluded[0].why, /no slash_presig 6 block\(s\) deep/);
  const atDepth = censusOf(chain({ [BONDED]: [b.raw], [CENSUS - 5]: [presigUpdate(b)] }));
  assert.equal(atDepth.entries.length, 1, JSON.stringify(atDepth.excluded.map((x) => x.why)));
  assert.equal(atDepth.entries[0].presigBy.height, CENSUS - 5);
  const short = censusOf(chain({ [BONDED]: [b.raw], [CENSUS - 4]: [presigUpdate(b)] }));
  assert.equal(short.entries.length, 0, 'one block short');
  const above = censusOf(chain({ [BONDED]: [b.raw], [CENSUS + 1]: [presigUpdate(b)] }));
  assert.equal(above.entries.length, 0, 'above the census height is not in this census');
});

test('a presig that does not verify counts for nothing, and neither does one for another bond', () => {
  const a = bondOf(1), other = bondOf(2);
  const bent = presigOf(a).slice(); bent[3] ^= 1;
  assert.equal(censusOf(chain({ [BONDED]: [a.raw], [BONDED + 1]: [presigUpdate(a, bent)] })).entries.length, 0);
  assert.equal(censusOf(chain({ [BONDED]: [a.raw, other.raw], [BONDED + 1]: [presigUpdate(a, presigOf(other))] })).entries.length, 0);
});

test('a later update leaves it standing, and the newest advertisement still decides what the node says', () => {
  const b = bondOf(1);
  const later = { ...b.advert, endpoint: 'ws://elsewhere', timestamp: 1788700000002n };
  const got = censusOf(chain({ [BONDED]: [b.raw], [BONDED + 1]: [presigUpdate(b)], [BONDED + 2]: [update(b, later, 0x71)] }));
  assert.equal(got.entries.length, 1);
  assert.equal(got.entries[0].advert.endpoint, 'ws://elsewhere');
  assert.equal(got.entries[0].presigBy.height, BONDED + 1);
});

test('a page checks what a seat counts: the evidence carries the update, and a seat that keeps it back has handed a bond nobody counts', () => {
  const bonds = [bondOf(1), bondOf(2)];
  const view = chain({ [BONDED]: bonds.map((b) => b.raw), [BONDED + 1]: bonds.map((b, i) => presigUpdate(b, presigOf(b), 0x70 + i)) });
  const census = censusOf(view);
  assert.equal(census.entries.length, 2);
  const ev = censusEvidenceOf(census, view);
  assert.equal(ev.ok, true, ev.why);
  assert.ok(ev.entries.every((x) => x.presig && x.presig.transaction));
  const reader = { contract: { ...contract, censusRoot: census.root }, headers: view.blocks.map((b) => b.header), firstHeight: FIRST, bond: bondSet(), verify };
  const read = censusFromEvidence(ev.entries, reader);
  assert.equal(read.ok, true, read.why);
  assert.equal(toHex(read.root), toHex(census.root), 'the same root as the seat');
  const kept = entryFromEvidence({ ...ev.entries[0], presig: undefined }, reader);
  assert.equal(kept.ok, false);
  assert.match(kept.why, /none was handed/);
  const shallow = entryFromEvidence(ev.entries[0], { ...reader, contract: { ...contract, censusHeight: BONDED + 2 } });
  assert.equal(shallow.ok, false);
  assert.match(shallow.why, /not between the bond and census_confirmations/);
  const swapped = entryFromEvidence({ ...ev.entries[0], presig: ev.entries[1].presig }, reader);
  assert.equal(swapped.ok, false);
  assert.match(swapped.why, /not in an update of this bond/);
});
