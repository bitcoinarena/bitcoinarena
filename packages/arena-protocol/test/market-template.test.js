// EVENT-MARKET TEMPLATES (kanban #362 feature 5, docs/PLATFORM-RESEARCH.md): a manifest may be a TEMPLATE - its attestors,
// threshold, fees, deadline and source rule, a category, the most outcomes a round may name and the latest it may resolve -
// and each ROUND of it carries its own question, 2 to 16 outcome labels and its resolution time, so anyone opens a question
// by publishing one round. Both fields are optional trailing fields after their own marker: every manifest and every
// contract written before keeps its bytes and its id (pinned below from origin/main a3f31b4f, before the fields existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import {
  encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT,
  TEMPLATE_MARKER, REQUIRED_VERSION_MARKER, marketTemplateFits, isTemplate, roundFitsManifest, eventFitsTemplate, marketOfRound,
} from '../src/manifest.js';
import { encodeRoundContract, decodeRoundContract, roundId, EVENT_MARKER, contractEventFits } from '../src/contracts.js';
import { attestationStands, attestationBodyId, attestationTimely, marketVoided, marketTimes, roundTermsOf } from '../src/attested.js';
import { stakeExpiryFits } from '../src/lock-expiry.js';
import { buildRules } from '../src/rules.js';
import { toHex, fromHex, sha256 } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { KNOWN_GOOD_GAMES } from '../src/known-games.js';
import { HELLO_WORLD_MANIFEST_HEX } from '../../hello-world/plugin/hello-world-manifest.js';
import { NEXTBLOCK_MANIFEST_HEX } from '../../nextblock/plugin/nextblock-manifest.js';
import { UPDOWN_TN4_MANIFEST_HEX } from '../../btc-updown/plugin/updown-tn4-manifest.js';
import { RPS_MANIFEST_HEX } from '../../rock-paper-scissors/plugin/rps-manifest.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { MANIFEST_V2_HEX as UPDOWN_V2_HEX } from '../../btc-updown/plugin/btc-updown-v2.js';
import { MANIFEST_V2_HEX as RPS_V2_HEX } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';

const b32 = (n) => new Uint8Array(32).fill(n);

// ---- THE IDS THAT MUST NOT MOVE -------------------------------------------------------------------------------------------

// Every signed manifest in the repo and its game id, as origin/main a3f31b4f computes it (Up/Down 672415c8 and f5f3f187,
// Rock Paper Scissors 1e9ab4b7 and a75f54fd, nextblock 495516ae and c693585b, hello-world 32ee1aa4)
const SIGNED = [
  ['hello-world', HELLO_WORLD_MANIFEST_HEX, '32ee1aa45e485eb2bc6b35d118a79f9724ab8019a0ceeb71eda45a84200c130f'],
  ['nextblock v1', NEXTBLOCK_MANIFEST_HEX, '495516ae59539661062cd72fd8716afbb378bd386297ab09b20aba0a2cd44150'],
  ['nextblock v2 (requires 2026.0.2)', NEXTBLOCK_V2_HEX, 'c693585b01cef147f311e39c304f7b40f99774afc032f58db35ef8094cfa78dc'],
  ['btc-updown-15m testnet4 v1', UPDOWN_TN4_MANIFEST_HEX, '672415c814e61b47ce038cd7f9a9431be8b41123c59502c371d5cd6a79c7684f'],
  ['btc-updown-15m v2', UPDOWN_V2_HEX, 'f5f3f18753b4167fe36d2e18f72c72b6e5cfea93cd5ef98c716d3b9137890375'],
  ['rock-paper-scissors v1', RPS_MANIFEST_HEX, '1e9ab4b7d402d51f46def727e6db58da0ad70c4afafc295c82357d612543cd50'],
  ['rock-paper-scissors v2', RPS_V2_HEX, 'a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea'],
];

test('every signed manifest in the repo keeps its bytes and its game id; none reads as a template', () => {
  for (const [name, hex, id] of SIGNED) {
    const m = decodeManifest(fromHex(hex));
    assert.equal(toHex(encodeManifest(m)), hex, `${name}: its bytes moved`);
    assert.equal(toHex(gameIdOf(m)), id, `${name}: its game id moved`);
    assert.equal(m.template, undefined, `${name} read as a template`);
    assert.equal(isTemplate(m), false);
    if (KNOWN_GOOD_GAMES[id]) assert.equal(KNOWN_GOOD_GAMES[id].name, m.gameName);
  }
  console.log(`  ${SIGNED.length} signed manifests: bytes and ids unchanged (${SIGNED.map(([n, , id]) => `${n} ${id.slice(0, 8)}`).join(', ')})`);
});

// The vectors' contract (test-vectors/protocol/contracts.json), named a relay, at each version and with each tail it can carry
const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
};
const RULES = buildRules({ claimWindowDays: 3, bondMinGameVerifySats: 50000n, bondMinSettlementSats: 200000n });
function* variants() {
  for (const v of [1, 2, 3])
    for (const more of [{}, { startDeadlineTicks: 100 }, { seriesId: b32(0x5e), roundIndex: 7 }, { startDeadlineTicks: 100, seriesId: b32(0x5e), roundIndex: 7 }])
      for (const rules of v === 3 ? [false, true] : [false])
        for (const creator of v === 3 ? [false, true] : [false])
          yield [`v${v}${more.startDeadlineTicks ? '+deadline' : ''}${more.seriesId ? '+series' : ''}${rules ? '+rules' : ''}${creator ? '+creator' : ''}`,
            { ...BASE, protocolVersion: v, ...more, ...(rules ? { rules: RULES } : {}), ...(creator ? { creatorPubkey: b32(0x0c) } : {}) }];
}
// [variant, sha256 of its bytes, its round id] - printed by origin/main a3f31b4f, before the question's tail existed
const PINNED = [["v1","c37af3f65abec839f20bd6fe59ef17bc6c20fb8515c6c8835bfc308d3dc3e4e6","d92c032d2d03ee19e26c2a00eabdb08aa8b1f415df9400b05e00f81637c43f64"],["v1+deadline","f19b5018c1d12518f876a7824d46481a3bd75c20423a7dbeabb5990008326459","c8a4c06dc2d9a6575864a56e08ac424cac98192483e207c04146c42137da17eb"],["v1+series","3a54b9a805995b04e5fe964ff89366f7183f15474115010c75066ac8fdd982a6","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v1+deadline+series","984f102e5cf9b4c29a0032a920aa2e5fce3702f1348e9d37b0486c6572bed9a4","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v2","d36b1af58c528f386e1f6788853682a70179e358f914057c696a86a105a82fcb","91bdd6a223c687bea3373365ad377db9e315896b79a43158b39c3d554d9bb691"],["v2+deadline","19123721de1110d3dc12f59463108c90e73218839c8e506106e90da62fd2533c","fc19384fbcde8d7003164acf03102ede0555a43b049ad89225f1e78bf832155d"],["v2+series","a13c042c32b7da9969ed6ab19447c2cb7aeec88bbb9d3a4839c2091131c3ebc1","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v2+deadline+series","c7e4c315274ffc6d2eeb6043203e3f60b27973216f417a6a429f50a2e050660a","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3","42f020b53d312c5cb47ff95eddc7a90f9aef20252c590a37051c759d8b13273d","8e314631589c6e3cf9c26b1e81e2006bc2453304fed4ecf2f654197361ea8084"],["v3+creator","90961856ad96959e3995e2c29ae3f2c1119784bb48695a2de308ae974a3dca05","02f9fd25c83b77e388ecd3bcac18ff910397a1ebc6d730b2ac035262ec7880fc"],["v3+rules","b918c6ea85f1cd1d56a883819f7343d75a22a09f4d70fe5f30486a9f198be0a7","878b168169808b4dea1582249ff87bbdef368190d3252329a81c39648ef285d2"],["v3+rules+creator","c715c1e8f1fb9e526a38d2cf726053b88103f4f3071bd0a5b35bd7755a42c285","35c028a083ccfdd2fe4ff801b69063647cd1d6d6c72fea15a9a74dfa51cea5c4"],["v3+deadline","374984a1ce3d5c4f98dc7f88d3189b6392d716254b112d95ef3975020e7887e1","f47ebdc9a047b653f2834caa23ce12eae84fd903dae25e0d1816284e32d7a2fa"],["v3+deadline+creator","93869bb9fe87c1d69d1ff162be3fdeb762a95ee4ff2941213a45dbe6c0ba5d09","d5daa9b67dc626db02ebe484e969c9d10736fde95fe2ef152271060b67b4eb3a"],["v3+deadline+rules","3dec19f2e4c76c2913250f196c5d1b380cb7d3e79f9a178032616e6b3bc7ea44","9453d745f8a8e23bc2ad0ccbe0d61a5df6e77d8e54d3fe6be2273d1ceca39237"],["v3+deadline+rules+creator","125e18f9ff1a3d5dc659de45cd79998863124772a62ccf9f7a742e8386417a5e","cc25c84f5bb9ab045dcf240f236c18104cc165a7a44252a994a1673bd7935bff"],["v3+series","731ce216fdb0e5f3fb663eded4f23f1734849e2f6990705ef593434c8b973577","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+series+creator","4df4dd241c8fb61d0d5697f4c1f41c97ef824103c63b1e5e9c3d30d062178542","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+series+rules","756c081598a826971c55bb21744af85c11cf9244777c3e679d88e1bc22f78e88","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+series+rules+creator","3bcfff6db4c350633a97a69a8c15dd8bb34f53ef2613e561a0dba427369f8ffe","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+deadline+series","9b61b2483c97c8901330cd95cec680bbe1b98d6718dc2cb0f0a47c768cf29ff3","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+deadline+series+creator","393997f6e294697ea7b47baaf600ceb55a76d3cbfa89e54a01a8d93b1017781e","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+deadline+series+rules","c8992804e061308532ce02d15306e87be0664aa86574a15d2aa6293a327e69e1","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v3+deadline+series+rules+creator","9b17f11488751e95dcb7065c0b7206ef5e1747296b1c3a4b62ce8b6b907f7f3b","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"]];

test('every contract layout written before keeps its bytes and its round id, and reads back with no question', () => {
  const pinned = new Map(PINNED.map(([n, h, id]) => [n, { h, id }]));
  let n = 0;
  for (const [name, c] of variants()) {
    const bytes = encodeRoundContract(c);
    assert.equal(toHex(sha256(bytes)), pinned.get(name).h, `${name}: its bytes moved`);
    assert.equal(toHex(roundId(c)), pinned.get(name).id, `${name}: its round id moved`);
    const back = decodeRoundContract(bytes);
    assert.equal(back.event, undefined, `${name} read as a round that asks a question`);
    assert.deepEqual(encodeRoundContract(back), bytes);
    n++;
  }
  assert.equal(n, PINNED.length);
  // and the protocol vectors' own contract (test-vectors/protocol/contracts.json; vectors.test.js replays it in full)
  assert.equal(toHex(roundId({ ...BASE, publicationRelays: [] })), 'b25a0b934cf4d6be6a14aab50006196657f32c96aa1242e58540badf594e5d05');
  console.log(`  ${n} contract layouts (v1/v2/v3 x deadline/series/rules/creator): bytes and round ids unchanged`);
});

// ---- THE TEMPLATE -------------------------------------------------------------------------------------------------------

const DEV = (() => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; })();
const ATTESTORS = [0, 1, 2].map(() => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; })
  .sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'Sports results', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 3600000n,
  sourceRule: 'the result the competition\'s organiser publishes on its own site, read by each attestor on its own' };
const TEMPLATE = { category: 'sports', maxOutcomes: 4, resolveWithinMs: 7n * 24n * 3600000n };
const BODY = {
  gameName: 'event-sports', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['yes', 'no'], attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
  marketTerms: TERMS,
};
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });
const TPL = signed({ ...BODY, template: TEMPLATE, requiredProtocolVersion: 3 });

test('a template rides in its manifest after its own marker: read back whole, after the market terms and before the required version', () => {
  const back = decodeManifest(encodeManifest(TPL));
  assert.deepEqual(back.template, TEMPLATE);
  assert.equal(back.requiredProtocolVersion, 3);
  assert.deepEqual(encodeManifest(back), encodeManifest(TPL));
  assert.equal(isTemplate(back), true);
  // THE BYTES: the market without the template, then the template's marker and fields, then the required version's
  const plain = encodeManifestBody({ ...BODY });
  const body = encodeManifestBody(TPL);
  assert.deepEqual(body.subarray(0, plain.length), plain, 'the template is written after everything an attested market already writes');
  assert.equal(body[plain.length], TEMPLATE_MARKER);
  assert.equal(body[body.length - 3], REQUIRED_VERSION_MARKER);
  assert.equal(TEMPLATE_MARKER, 0x03);
  assert.notDeepEqual(gameIdOf(TPL), gameIdOf(signed({ ...BODY, requiredProtocolVersion: 3 })));
  console.log(`  template manifest ${toHex(gameIdOf(TPL)).slice(0, 16)}: ${body.length} body bytes, marker 0x${TEMPLATE_MARKER.toString(16).padStart(2, '0')} at ${plain.length}`);
});

test('a template\'s rules, each refused by name', () => {
  const m = { ...BODY, requiredProtocolVersion: 3 };
  assert.equal(marketTemplateFits(TEMPLATE, m).ok, true);
  const refusals = {
    'no category': [{ ...TEMPLATE, category: '' }, m, /names its category in 1 to 32 characters/],
    'a category of 33': [{ ...TEMPLATE, category: 'x'.repeat(33) }, m, /names its category in 1 to 32 characters/],
    'one outcome': [{ ...TEMPLATE, maxOutcomes: 1 }, m, /at most 2 to 16 outcomes/],
    '17 outcomes': [{ ...TEMPLATE, maxOutcomes: 17 }, m, /at most 2 to 16 outcomes/],
    'resolves within 0': [{ ...TEMPLATE, resolveWithinMs: 0n }, m, /resolve within 1 ms to 30 days/],
    'resolves within 31 days': [{ ...TEMPLATE, resolveWithinMs: 31n * 24n * 3600000n }, m, /resolve within 1 ms to 30 days/],
    'latest before earliest': [{ ...TEMPLATE, resolveWithinMs: 59999n }, m, /latest resolution \(59999 ms after entry close\) is before its earliest \(60000 ms\)/],
    'no market terms': [TEMPLATE, { ...m, marketTerms: undefined }, /names its market terms/],
    'no required version': [TEMPLATE, { ...m, requiredProtocolVersion: undefined }, /requires protocol version 2026\.0\.3 or later/],
    'requires 2026.0.2': [TEMPLATE, { ...m, requiredProtocolVersion: 2 }, /requires protocol version 2026\.0\.3 or later/],
    'on a 15 min grid': [TEMPLATE, { ...m, roundPeriodMs: 900000n }, /runs on no grid/],
  };
  const said = {};
  for (const [name, [t, mm, why]] of Object.entries(refusals)) {
    const f = marketTemplateFits(t, mm);
    assert.equal(f.ok, false, name); assert.match(f.why, why, name);
    assert.throws(() => encodeManifestBody({ ...mm, template: t }), why, `${name}: the encoder took it`);
    said[name] = f.why;
  }
  // ONLY AN ATTESTED GAME IS A TEMPLATE
  assert.throws(() => encodeManifestBody({ ...BODY, resultType: RESULT_TYPE.REPLAY, cores: [{ hash: b32(1), configs: [b32(2)] }], runTicksMax: 10,
    payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 1, template: TEMPLATE, requiredProtocolVersion: 3 }), /only an attested game is a market template/);
  console.log('  refusals:', JSON.stringify(said, null, 1));
});

// ---- A ROUND'S OWN QUESTION ------------------------------------------------------------------------------------------------

const EVENT = { question: 'Who wins the final on 2026-10-18: Ajax, PSV, Feyenoord or a draw after extra time? ⚽ Ünïcödé', outcomes: ['Ajax', 'PSV', 'Feyenoord', 'draw'],
  resolveAtMs: BASE.entryCloseMs + 3600000n };
const ROUND = { ...BASE, protocolVersion: 3, gameId: gameIdOf(TPL), simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32), event: EVENT };

test('a round asks its own question in a tail of its own, last of all: read back whole with every tail before it; none named keeps the id', () => {
  const plain = { ...ROUND }; delete plain.event;
  const pb = encodeRoundContract(plain), eb = encodeRoundContract(ROUND);
  assert.deepEqual(eb.subarray(0, pb.length), pb, 'the question is written after everything a contract already writes');
  assert.equal(eb[pb.length], EVENT_MARKER); assert.equal(eb[eb.length - 1], EVENT_MARKER); assert.equal(EVENT_MARKER, 0xc3);
  assert.equal((eb[eb.length - 3] << 8) | eb[eb.length - 2], eb.length - pb.length, 'its closing length is its own size');
  assert.notDeepEqual(roundId(ROUND), roundId(plain), 'the question is in the round id');
  assert.notDeepEqual(roundId({ ...ROUND, event: { ...EVENT, question: EVENT.question + '?' } }), roundId(ROUND));
  assert.notDeepEqual(roundId({ ...ROUND, event: { ...EVENT, outcomes: ['PSV', 'Ajax', 'Feyenoord', 'draw'] } }), roundId(ROUND), 'the labels\' order is the index the attestors sign');
  let n = 0;
  for (const more of [{}, { startDeadlineTicks: 100 }])
    for (const rules of [false, true]) for (const creator of [false, true]) {
      const c = { ...ROUND, ...more, ...(rules ? { rules: RULES } : {}), ...(creator ? { creatorPubkey: b32(0x0c) } : {}) };
      const back = decodeRoundContract(encodeRoundContract(c));
      assert.deepEqual(back.event, EVENT);
      if (rules) assert.deepEqual(back.rules, RULES);
      if (creator) assert.deepEqual(back.creatorPubkey, b32(0x0c));
      if (more.startDeadlineTicks) assert.equal(back.startDeadlineTicks, 100);
      assert.deepEqual(roundId(back), roundId(c));
      n++;
    }
  // AT THE LIMITS: a 280-byte question (multi-byte UTF-8 counted in bytes), 16 labels of 64 bytes
  const longest = { question: 'é'.repeat(140), outcomes: Array.from({ length: 16 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(62)}`), resolveAtMs: EVENT.resolveAtMs };
  assert.deepEqual(decodeRoundContract(encodeRoundContract({ ...ROUND, event: longest })).event, longest);
  console.log(`  ${n} tail combinations with a question read back; a question tail of ${eb.length - pb.length} bytes; the longest one ${encodeRoundContract({ ...ROUND, event: longest }).length - pb.length} bytes`);
});

test('a round\'s question, each refusal by name: its size, its labels, its time, its version, no series', () => {
  const cases = {
    'a question of 281 bytes': [{ ...EVENT, question: 'é'.repeat(140) + 'x' }, /question in 1 to 280 bytes of UTF-8/],
    'an empty question': [{ ...EVENT, question: '' }, /question in 1 to 280 bytes of UTF-8/],
    'one outcome': [{ ...EVENT, outcomes: ['yes'] }, /names 2 to 16 outcomes/],
    '17 outcomes': [{ ...EVENT, outcomes: Array.from({ length: 17 }, (_, i) => `o${i}`) }, /names 2 to 16 outcomes/],
    'a label of 65 bytes': [{ ...EVENT, outcomes: ['yes', 'x'.repeat(65)] }, /labelled in 1 to 64 bytes of UTF-8/],
    'an empty label': [{ ...EVENT, outcomes: ['yes', ''] }, /labelled in 1 to 64 bytes of UTF-8/],
    'a label twice': [{ ...EVENT, outcomes: ['yes', 'no', 'yes'] }, /names each of its outcomes once/],
    'a time as a number': [{ ...EVENT, resolveAtMs: 5 }, /resolution time as BigInt ms/],
  };
  const said = {};
  for (const [name, [ev, why]] of Object.entries(cases)) {
    assert.match(contractEventFits(ev).why, why, name);
    assert.throws(() => encodeRoundContract({ ...ROUND, event: ev }), why, name);
    said[name] = contractEventFits(ev).why;
  }
  assert.throws(() => encodeRoundContract({ ...ROUND, protocolVersion: 2 }), /asks its own question from protocol version 3 on/);
  assert.throws(() => encodeRoundContract({ ...ROUND, seriesId: b32(0x5e), roundIndex: 1 }), /no round of a series/);
  // BYTES FROM ANYWHERE: a closing marker or length that does not hold is no question, and the tail is then refused as trailing bytes
  const eb = encodeRoundContract(ROUND);
  const bent = eb.slice(); bent[bent.length - 1] = 0x00;
  assert.throws(() => decodeRoundContract(bent), /trailing bytes/);
  const longer = eb.slice(); longer[longer.length - 2] += 1;
  assert.throws(() => decodeRoundContract(longer), /trailing bytes/);
  const v2 = encodeRoundContract({ ...ROUND, protocolVersion: 3 }); v2[2] = 2;   // the same bytes claiming 2026.0.2
  assert.throws(() => decodeRoundContract(v2), /from protocol version 3 on/);
  console.log('  refusals:', JSON.stringify(said, null, 1));
});

// ---- THE ROUND AGAINST ITS MANIFEST ---------------------------------------------------------------------------------------

test('a template round is accepted; a template round with no question, or a non-template round with one, is refused by name', () => {
  const gid = gameIdOf(TPL);
  assert.deepEqual(roundFitsManifest(ROUND, TPL, gid), { ok: true, attested: true, template: true });
  const plain = { ...ROUND }; delete plain.event;
  assert.match(roundFitsManifest(plain, TPL, gid).why, /is a market template: each round of it asks its own question, outcomes and resolution time, and this one names none/);
  // A NON-TEMPLATE MARKET (Up/Down v2, signed) AND A GAME (nextblock v1): a round of either carrying a question is refused
  const updown = decodeManifest(fromHex(UPDOWN_V2_HEX));
  const ud = { ...ROUND, gameId: gameIdOf(updown) };
  assert.match(roundFitsManifest(ud, updown).why, /game "btc-updown-15m" is not a market template: its question is its manifest's, and a round of it carries none of its own/);
  const plainUd = { ...ud }; delete plainUd.event;
  assert.equal(roundFitsManifest(plainUd, updown).ok, true, 'the same round without a question fits Up/Down as before');
  const nb = decodeManifest(fromHex(NEXTBLOCK_MANIFEST_HEX));
  assert.match(roundFitsManifest({ ...ROUND, gameId: gameIdOf(nb) }, nb).why, /game "nextblock" is not a market template/);
  // A TEMPLATE REQUIRES 2026.0.3: a round at version 2 cannot carry a question, and without one it is refused by the version
  assert.match(roundFitsManifest({ ...plain, protocolVersion: 2 }, TPL, gid).why, /requires protocol version 2026\.0\.3/);
});

test('the template bounds its rounds: no more outcomes than its maxOutcomes, a resolution time inside its window', () => {
  const gid = gameIdOf(TPL);
  const five = { ...ROUND, event: { ...EVENT, outcomes: ['a', 'b', 'c', 'd', 'e'] } };
  assert.match(roundFitsManifest(five, TPL, gid).why, /that round names 5 outcomes; template "event-sports" lets a round name 2 to 4/);
  const early = { ...ROUND, event: { ...EVENT, resolveAtMs: ROUND.entryCloseMs + 59999n } };
  assert.match(roundFitsManifest(early, TPL, gid).why, /before template "event-sports"'s earliest .* \(60000 ms after its entry close\)/);
  assert.equal(roundFitsManifest({ ...ROUND, event: { ...EVENT, resolveAtMs: ROUND.entryCloseMs + 60000n } }, TPL, gid).ok, true, 'the earliest itself');
  assert.equal(roundFitsManifest({ ...ROUND, event: { ...EVENT, resolveAtMs: ROUND.entryCloseMs + TEMPLATE.resolveWithinMs } }, TPL, gid).ok, true, 'the latest itself');
  const late = { ...ROUND, event: { ...EVENT, resolveAtMs: ROUND.entryCloseMs + TEMPLATE.resolveWithinMs + 1n } };
  assert.match(roundFitsManifest(late, TPL, gid).why, /past template "event-sports"'s latest/);
  // a series round is refused before its encoding is asked (its id would not hash its question)
  assert.match(eventFitsTemplate({ ...ROUND, seriesId: b32(1), roundIndex: 0 }, TPL).why, /never as a round of a series/);
});

// ---- THE OUTCOME: THE ROUND'S LABELS, THE ROUND'S COUNT, THE ROUND'S CLOCK ------------------------------------------------

const attest = (body, by) => ({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) })) });

test('attestors sign an index into THIS round\'s outcomes: a 4-outcome round of a 2-outcome template takes outcome 3, refuses 4, and names its label', () => {
  const rid = roundId(ROUND);
  const body = { roundId: rid, outcome: 3, observedAtMs: EVENT.resolveAtMs + 1n };
  const ok = attestationStands(attest(body, [ATTESTORS[0], ATTESTORS[2]]), { manifest: TPL, roundIdBytes: rid, verify: verifyEd, round: ROUND });
  assert.equal(ok.ok, true, ok.why); assert.equal(ok.label, 'draw'); assert.equal(ok.outcome, 3);
  const four = attestationStands(attest({ ...body, outcome: 4 }, [ATTESTORS[0], ATTESTORS[2]]), { manifest: TPL, roundIdBytes: rid, verify: verifyEd, round: ROUND });
  assert.match(four.why, /names outcome 4, out of range: game "event-sports" has 4 outcomes \(0 to 3\)/);
  // a template's attestation with no round to read its outcomes from: refused, the template's own YES / NO are not the question
  assert.match(attestationStands(attest(body, [ATTESTORS[0], ATTESTORS[2]]), { manifest: TPL, roundIdBytes: rid, verify: verifyEd }).why,
    /is a market template: an attestation is checked against its round's own outcomes, and no round naming them was given/);
  // the template's threshold and attestor set still bind
  assert.match(attestationStands(attest(body, [ATTESTORS[1]]), { manifest: TPL, roundIdBytes: rid, verify: verifyEd, round: ROUND }).why, /carries 1 attestor signature\(s\), and game "event-sports" asks 2 of its 3/);
  // A NON-TEMPLATE MARKET READS ITS MANIFEST, round or not
  const nt = signed({ ...BODY });
  assert.equal(marketOfRound(nt, ROUND), nt);
  assert.match(attestationStands(attest(body, [ATTESTORS[0], ATTESTORS[2]]), { manifest: nt, roundIdBytes: rid, verify: verifyEd, round: { ...ROUND, event: undefined } }).why,
    /names outcome 3, out of range: game "event-sports" has 2 outcomes/);
  console.log(`  outcome 3 "${ok.label}": ${ok.why}; outcome 4: ${four.why}`);
});

test('the round\'s clock: no outcome before its own resolution time, VOID at its own deadline, locks that last to it', () => {
  const terms = roundTermsOf(TPL, ROUND);
  assert.equal(terms.resolveAfterCloseMs, 3600000n);
  assert.equal(terms.question, EVENT.question);
  assert.equal(roundTermsOf(signed({ ...BODY }), ROUND), TERMS, 'a non-template market keeps its manifest\'s terms');
  const t = marketTimes({ entryCloseMs: ROUND.entryCloseMs, terms });
  assert.equal(t.resolveAtMs, EVENT.resolveAtMs);
  assert.equal(t.deadlineMs, EVENT.resolveAtMs + TERMS.deadlineAfterResolveMs);
  const at = (observedAtMs) => attestationTimely({ observedAtMs }, { entryCloseMs: ROUND.entryCloseMs, nowMs: EVENT.resolveAtMs + 10n, terms });
  assert.match(at(EVENT.resolveAtMs - 1n).why, /before the market's resolution time/);
  assert.equal(at(EVENT.resolveAtMs).ok, true);
  assert.equal(marketVoided([], { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: t.deadlineMs - 1n }).voided, false);
  assert.equal(marketVoided([], { entryCloseMs: ROUND.entryCloseMs, terms, nowMs: t.deadlineMs }).voided, true);
  // THE LOCK SPAN IS THE ROUND'S (lock-expiry.js): the template's view asks more blocks than its earliest resolution would
  const c = { ...ROUND, networkId: NETWORK_ID_REGTEST, committeeTimeMs: ROUND.entryCloseMs - 600000n };
  const need = stakeExpiryFits({ ...c, stakeExpiryBlocks: 1 }, { manifest: marketOfRound(TPL, c) });
  const needTpl = stakeExpiryFits({ ...c, stakeExpiryBlocks: 1 }, { manifest: TPL });
  const blocks = (why) => Number(/must last (\d+) blocks/.exec(why)[1]);
  assert.ok(blocks(need.why) > blocks(needTpl.why), `${need.why} / ${needTpl.why}`);
  console.log(`  resolve ${t.resolveAtMs}, deadline ${t.deadlineMs}; locks ${blocks(need.why)} blocks for the round, ${blocks(needTpl.why)} by the template's earliest`);
});
