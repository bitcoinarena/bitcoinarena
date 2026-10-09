// A MARKET'S OWN TERMS (kanban #235, the owner 2026-10-09): its fee in its manifest ("per market in manifest"), its question,
// resolution time, attestation deadline and source rule - and "refund at the deadline". The protocol half: the manifest's
// optional terms, the fee as the manifest's rate, the resolution time on attestations, and the deadline's VOID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, marketTermsFit } from '../src/manifest.js';
import { attestationTimely, marketTimes, marketVoided } from '../src/attested.js';
import { entryFeeMsat, feeMatchesEntry, feeBpsOf, NODE_FEE_BPS } from '../src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = (() => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; })();
const BODY = {
  gameName: 'btc-up-down', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['up', 'down'], attestors: [b32(0xa1)], attestThreshold: 1,
};
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Is BTC/USD higher at the resolution time than at entry close?',
  resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 600000n, sourceRule: 'median of the Binance, Coinbase and Kraken BTC/USD last trade at the resolution time' };
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });

test('a market\'s terms ride in its manifest; a market without them keeps its bytes and its id', () => {
  const plain = signed(BODY);
  const withTerms = signed({ ...BODY, marketTerms: TERMS });
  const back = decodeManifest(encodeManifest(withTerms));
  assert.deepEqual(back.marketTerms, TERMS);
  assert.deepEqual(encodeManifest(back), encodeManifest(withTerms));
  assert.equal(decodeManifest(encodeManifest(plain)).marketTerms, undefined);
  const plainBody = encodeManifestBody(BODY), termsBody = encodeManifestBody({ ...BODY, marketTerms: TERMS });
  assert.deepEqual(termsBody.subarray(0, plainBody.length), plainBody, 'the terms are written after everything a market already writes');
  assert.notDeepEqual(gameIdOf(withTerms), gameIdOf(plain));
});

test('a market\'s terms are bounded: its fee within the network\'s, a question, a resolution time, a deadline, a source rule', () => {
  assert.equal(marketTermsFit(TERMS).ok, true);
  assert.match(marketTermsFit({ ...TERMS, nodeFeeBps: 501 }).why, /node fee is 0 to 500/);
  assert.match(marketTermsFit({ ...TERMS, donationBps: 600 }).why, /donation is 0 to 500/);
  // AT MOST 10 % IN ALL, EACH AT MOST 5 % (the owner 2026-10-09: "I mean 10 in total"): 5 % + 5 % stands, 5.01 % of either does not
  assert.equal(marketTermsFit({ ...TERMS, nodeFeeBps: 500, donationBps: 500 }).ok, true);
  assert.equal(marketTermsFit({ ...TERMS, nodeFeeBps: 300, donationBps: 300 }).ok, true);
  assert.match(marketTermsFit({ ...TERMS, nodeFeeBps: 501, donationBps: 0 }).why, /node fee is 0 to 500/);
  assert.match(marketTermsFit({ ...TERMS, nodeFeeBps: 0, donationBps: 501 }).why, /donation is 0 to 500/);
  assert.match(marketTermsFit({ ...TERMS, question: '' }).why, /question/);
  assert.match(marketTermsFit({ ...TERMS, deadlineAfterResolveMs: 1000n }).why, /1 minute to 7 days/);
  assert.match(marketTermsFit({ ...TERMS, sourceRule: '' }).why, /rule/);
  assert.throws(() => encodeManifestBody({ ...BODY, marketTerms: { ...TERMS, nodeFeeBps: 900 } }), /node fee/);
});

test('the market\'s fee is its manifest\'s rate: 0.5 % of a 100,000 msat stake is 500 msat; without terms the network\'s 5 %', () => {
  const m = { ...BODY, marketTerms: TERMS };
  assert.equal(feeBpsOf(m), 50);
  assert.equal(feeBpsOf(BODY), NODE_FEE_BPS);
  assert.equal(entryFeeMsat(100000n, 50), 500n);
  assert.equal(entryFeeMsat(100000n), 5000n);
  const entry = { stakeMsat: 100000n, feeMsat: 500n, donationMsat: 500n };
  assert.equal(feeMatchesEntry(entry, { feeBps: 50 }).ok, true);
  assert.match(feeMatchesEntry(entry).why, /5% of 100000 is 5000/);
  assert.throws(() => entryFeeMsat(100000n, 600), /0 to 500 bps/);
});

test('an attestation is taken only for an outcome observed at or after the market\'s resolution time', () => {
  const entryCloseMs = 1000000n;
  const t = marketTimes({ entryCloseMs, terms: TERMS });
  assert.deepEqual(t, { resolveAtMs: 1900000n, deadlineMs: 2500000n });
  assert.match(attestationTimely({ observedAtMs: 1899999n }, { entryCloseMs, nowMs: 2000000n, terms: TERMS }).why, /before the market's resolution time/);
  assert.equal(attestationTimely({ observedAtMs: 1900000n }, { entryCloseMs, nowMs: 2000000n, terms: TERMS }).ok, true);
  // a market without terms: as before, any outcome seen after entry close
  assert.equal(attestationTimely({ observedAtMs: 1000001n }, { entryCloseMs, nowMs: 2000000n }).ok, true);
});

test('refund at the deadline: no outcome by then, or a contradiction, makes the round VOID; inside the deadline nothing is decided', () => {
  const at = { entryCloseMs: 1000000n, terms: TERMS };
  assert.equal(marketVoided([], { ...at, nowMs: 2499999n }).voided, false);
  assert.match(marketVoided([], { ...at, nowMs: 2500000n }).why, /no outcome was attested by the market's deadline/);
  assert.equal(marketVoided([{ outcome: 0 }], { ...at, nowMs: 9e9 }).voided, false, 'an attested outcome stands past the deadline');
  assert.match(marketVoided([{ outcome: 0 }, { outcome: 1 }], { ...at, nowMs: 2000000n }).why, /contradicted themselves/);
  assert.equal(marketVoided([], { entryCloseMs: 1000000n, terms: null, nowMs: 9e9 }).voided, false, 'a market without terms has no deadline');
});
