// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MARKETS ON GAMES (feature 6, docs/PLATFORM-RESEARCH.md item 6; protocol 2026.0.6): a market whose outcome is a
// game round's own signed result - Tick Tock's §13 RoundResult, BULLS or BEARS, signed by 5 of the source round's 7 seats - and
// no attestor's. The manifest names its source game, the result kind and a mapping onto its outcomes (marker 0x05); each round
// names its source round (contract tail 0xc4). Both only from version 6: every manifest and contract written before keeps its
// bytes and its id (pinned below from origin/main 0e098626, before the fields existed; versions 1-3 are pinned in
// market-template.test.js, the signed manifests in both).
//
// The committee's signatures here are Ed25519 through the injected `verify` - this package has no curve; the count, the
// distinct keys and the threshold are what is checked, and arena-node/test/game-market-node.test.js signs with BIP-340.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import {
  encodeManifest, decodeManifest, encodeManifestBody, manifestBodyId, gameIdOf, manifestStands, roundFitsManifest, RESULT_TYPE, PAYOUT_RULE,
  NO_PARENT, GAME_SOURCE_MARKER, REQUIRED_VERSION_MARKER, TEMPLATE_MARKER, PAYOUT_SHARES_MARKER, MARKET_TERMS_MARKER, SOURCE_KIND,
  SOURCE_VALUES, GAME_MARKET_REFUND, gameSourceFits, isGameMarket, isTemplate,
} from '../src/manifest.js';
import { encodeRoundContract, decodeRoundContract, roundId, SOURCE_ROUND_MARKER, EVENT_MARKER, RULES_MARKER, CREATOR_MARKER } from '../src/contracts.js';
import { attestationStands, encodeAttestation, decodeAttestation } from '../src/attested.js';
import { gameMarketOutcome, gameMarketFitsSource, gameMarketResolution, gameMarketVoided, sourceRoundEndMs } from '../src/game-market.js';
import { roundResultId, FRONT } from '../src/round-result.js';
import { GAME_MARKET_VERSION, SUPPORTED_PROTOCOL_VERSIONS, speaksVersion } from '../src/constants.js';
import { buildRules } from '../src/rules.js';
import { seriesRound } from '../src/series.js';
import { toHex, fromHex, sha256 } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { HELLO_WORLD_MANIFEST_HEX } from '../../hello-world/plugin/hello-world-manifest.js';
import { NEXTBLOCK_MANIFEST_HEX } from '../../nextblock/plugin/nextblock-manifest.js';
import { UPDOWN_TN4_MANIFEST_HEX } from '../../btc-updown/plugin/updown-tn4-manifest.js';
import { RPS_MANIFEST_HEX } from '../../rock-paper-scissors/plugin/rps-manifest.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { MANIFEST_V2_HEX as UPDOWN_V2_HEX } from '../../btc-updown/plugin/btc-updown-v2.js';
import { MANIFEST_V2_HEX as RPS_V2_HEX } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v2.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verifyEd = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));

// ---- THE BYTES THAT MUST NOT MOVE ------------------------------------------------------------------------------------------

const SIGNED = [
  ['hello-world', HELLO_WORLD_MANIFEST_HEX, '32ee1aa45e485eb2bc6b35d118a79f9724ab8019a0ceeb71eda45a84200c130f'],
  ['nextblock v1', NEXTBLOCK_MANIFEST_HEX, '495516ae59539661062cd72fd8716afbb378bd386297ab09b20aba0a2cd44150'],
  ['nextblock v2', NEXTBLOCK_V2_HEX, 'c693585b01cef147f311e39c304f7b40f99774afc032f58db35ef8094cfa78dc'],
  ['btc-updown-15m testnet4 v1', UPDOWN_TN4_MANIFEST_HEX, '672415c814e61b47ce038cd7f9a9431be8b41123c59502c371d5cd6a79c7684f'],
  ['btc-updown-15m v2', UPDOWN_V2_HEX, 'f5f3f18753b4167fe36d2e18f72c72b6e5cfea93cd5ef98c716d3b9137890375'],
  ['rock-paper-scissors v1', RPS_MANIFEST_HEX, '1e9ab4b7d402d51f46def727e6db58da0ad70c4afafc295c82357d612543cd50'],
  ['rock-paper-scissors v2', RPS_V2_HEX, 'a75f54fd4f978a29ab6d39d9ef85c7adbe0576614634c679ae33d3e1c06164ea'],
];

test('every signed manifest in the repo keeps its bytes and its game id; none reads as a market on a game', () => {
  for (const [name, hex, id] of SIGNED) {
    const m = decodeManifest(fromHex(hex));
    assert.equal(toHex(encodeManifest(m)), hex, `${name}: its bytes moved`);
    assert.equal(toHex(gameIdOf(m)), id, `${name}: its game id moved`);
    assert.equal(m.gameSource, undefined, `${name} read as a market on a game`);
    assert.equal(isGameMarket(m), false);
  }
  console.log(`  ${SIGNED.length} signed manifests: bytes and ids unchanged`);
});

// Manifest bodies of each shape a version-5 build writes, from fixed keys: [shape, sha256 of the body] - printed by origin/main
// 0e098626, before the game source existed
const MANIFEST_PINS = [["attested","ed995e2a6b9ecf9794720c49316c9a8484c88c869994dd9964ca3fc0a014a78d"],["attested+terms","aee5911b670171d011c5378464f0bd0f31b411fc368c48146158294fda6ea18c"],["attested+terms+v5","4fbf3cb9d92daaf5adc026efd39551a2e065428e2c30af6db0590c71492d4e94"],["template","401e7a8f7e2df4882710763df1da907b03ec202843a03eacd4fdf74f400ad7fc"],["top-split","ec585c8b3af4d16b72901dcd92d3bbd9ff00ea4fc2cb8021aa73c4ef63ee9da3"],["head-to-head","2a0175f985f83c4484ac1f2b2234882376dd4554dcd8436612463f210a488b5d"]];
const ATT = {
  gameName: 'event-sports', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['yes', 'no'], attestors: [b32(0xa1), b32(0xa2), b32(0xa3)], attestThreshold: 2,
};
const PIN_TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'Sports results', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 3600000n, sourceRule: 'the organiser' };
const PIN_SHAPES = {
  attested: ATT, 'attested+terms': { ...ATT, marketTerms: PIN_TERMS }, 'attested+terms+v5': { ...ATT, marketTerms: PIN_TERMS, requiredProtocolVersion: 5 },
  template: { ...ATT, marketTerms: PIN_TERMS, template: { category: 'sports', maxOutcomes: 4, resolveWithinMs: 86400000n }, requiredProtocolVersion: 4 },
  'top-split': { gameName: 'split', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
    cores: [{ hash: b32(1), configs: [b32(2)] }], runTicksMax: 9000, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.TOP_SPLIT, rankNumerator: 3, rankDenominator: 4, minScore: 1,
    clients: [], gameDonationSetId: b32(0xd0), payoutShares: [5000, 3000, 2000], requiredProtocolVersion: 4 },
  'head-to-head': { gameName: 'h2h', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: b32(1), configs: [b32(2)] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 2,
    clients: [], gameDonationSetId: b32(0xd0), players: 2, moveCount: 3, revealWindowMs: 60000n, requiredProtocolVersion: 5 },
};

test('every manifest shape a version-5 build writes keeps its bytes (attested, with terms, a template, a top split, head-to-head)', () => {
  for (const [name, sha] of MANIFEST_PINS) {
    const body = encodeManifestBody(PIN_SHAPES[name]);
    assert.equal(toHex(sha256(body)), sha, `${name}: its bytes moved`);
  }
  console.log(`  ${MANIFEST_PINS.length} manifest shapes: bytes unchanged`);
});

// Every contract layout of versions 4 and 5 - deadline, series, rules, creator, a template's question - [variant, sha256 of
// its bytes, its round id], printed by origin/main 0e098626 before the source round's tail existed
const CONTRACT_PINS = [["v4","4320206fb16c973c91ff7faf8be7243ea807783038f31f5363752435b6ad67f7","f65609d056903be280d35c284fe0545e75ed923dc43270db97fb6306c9eba7d4"],["v4+event","4eaa63acaff20ae5925b1be63bfeb6ff658c321be1d9bf5d672bf00d37bde0a8","feaf481d0ce5c97ad9811002b5e1b3a99345ed7e61bd47cb066af24d7d232cfc"],["v4+creator","630cc0ebc1a038a1465b45b45f3a2da560fafc43ca70a1aaf8f726fc325f2591","17512fd2ba05a491cbd3ef5daa0ab03d038949743fce486d7c23c98ad896f0aa"],["v4+creator+event","2b4812b5f54af542645e52fa201c2e5e2b5955ef376fcdf281510c585a712f5f","07d4578cb5d89c7c15d7f30a5b5d29aa1b135376e80b927e184508c8606aa688"],["v4+rules","87636171788611a75c9d1256a2b9f5ab7d76cd55d154c78e1a5b1911fb731574","7312e84674e8e566b2741650007ec3bd8b8f68543f82a05608a1bd22a6ae5faf"],["v4+rules+event","56da29324d2b02c22f327e5e7707f372daa58f5cc42a52bc71d7870dc06a6e15","fe0e93ada6dd80cd0180f6eeb3a44ad821134576a35fc5ea50690f094a1e45b0"],["v4+rules+creator","7a6002a6e0c34dc4e5d357eaedcf7c100b0382a2ae56029c7a8a2776778cbfbf","d481574669f00a0d388459da1ece673d783539fa7db3a618642f4614f3371aab"],["v4+rules+creator+event","93569fa24db72eae122a8cc261fc77987bace826f51e0bbf9a1812e5c26d668b","dc9ba2d020126ea7e6757c6f670f001b0de231e731a007225691fd3d59e89b9a"],["v4+deadline","ad40ad7ec117fff4cb20e217446b3683b8a4de57adc75b6a68af7b67ec0d6e53","dc6bf5845b14de811b28d8bf1bc47fa897e96bae98930e0cd65642304658addf"],["v4+deadline+event","f0287df5f0808545fdfac94d249af766bfa23a7ff3f61bd605e98fc38d6730f8","b75f50b81cae8fe3ba5ac4a0d479d6db1a163ee426f17a9efeeb8f35c8ef061e"],["v4+deadline+creator","8522435b8031a5bfe2fd54d9492f8e35f672725ae91f915db1ddb53282081e8e","a39c9bce50ea8d6ea2bed9fdde3bbf60f1bf765b4d35befe378912b541949d83"],["v4+deadline+creator+event","5fb2dc2907ec014617600ced3ede43f508dea03bd8e18e666fd5b8955a02a1bb","62869c8f5727690d87aab1c1b7bbcedaaa1c6968b254bc7c5490763d4d881e83"],["v4+deadline+rules","76162c6f8694f2c1d15d95ce66ef6508ca4cb77d86b1c4f15a197f8c9ba14cab","867255fccfbb318b2d10dbbcf230340406e9c3d9728a49ecfea123232e7966ae"],["v4+deadline+rules+event","c683bc2ebd324b608ed0b28fd346790931b24b573ce096878c72b6e0f37558a5","372760ac601b4a02164de7a2bb59aa2a9dbfc1248b5273001c8a484af318bccc"],["v4+deadline+rules+creator","196b418078e4550f49ba589cb0d96851cc6c90dcb043e9e3e49ca496961b2c97","5ca4b343333b26ea09a99a4c2e7ae895d364954d9733bb52bc89c1b836ace3a9"],["v4+deadline+rules+creator+event","a5a7efbe01b6e9bcbe19367b7f4a87e2992b9da29c68694e29cf338fd4ab7e7d","734082cdc93c6b8a71fa034e404a5eeff1380cb821b715adf358af6e556e0fc1"],["v4+series","afc862e550ac304b18d5e709451cc6c6a15e0d07ca689d566aac8b9bbb0000ed","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+series+creator","4fd4a99b66d78bfdc171c7e78c43127b0fa13dd3f71e2c34868bd1f5285cc6ee","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+series+rules","2f6680f5ec01befc17b9764301244e5df7a95de7d9d36beac29430e5da6fc71d","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+series+rules+creator","f62dae96aad5f05f4aa822212da8d193c7d930d1d626a61d6cb025c5e5eb699d","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+deadline+series","b1be84c9e6d152bc52cd8b3722ab3756d2e7b6c6861c50cd9ad2fecbaadc80d3","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+deadline+series+creator","982830db19e8f15707246561f29f659f32e68b55e8fcf399a4fee4c0c2ce49bc","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+deadline+series+rules","a41766a1ec5886541791ac74b1941715bba44a0878d48ece558cefd8391d5d2e","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v4+deadline+series+rules+creator","bdf740cbb8155a1a2fe2c0fd2233514ce0877cab59058c4919b9c50faf8cbd4c","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5","bcd23ba43eb7aa3fa0eb012425df581f1ffd59544395ae2ff9641c8dbeba73bc","0507e7f938d42c6abdc4dedc13dac917181e8bd232f1f43b08279cb4ac64a38b"],["v5+event","f01ddd4cc6d1fe4a1a870b4729ac1fafd4a1dbf50e3529830ad736443d760375","9780e0a4185fd94bebc1ae20dd2fce5a22baee7c33934c51d9b932211e613bcc"],["v5+creator","42c3ec2edf015bcc5fe4f4ffee2e9ab770d050091a2007defa50aaffeffb8b7d","9c2f76c689a756b71e210190703dc2235fffed3d7636930624476b4919a841bd"],["v5+creator+event","59f8200efba25922ea9267e829f74e526954d3b96b595baf86b136b96ed7219f","e59bbc2beece451e821de4feb8b7e21ec0ff1f4e982dffd8eab122ceb299119c"],["v5+rules","17995f8ce8a9d1acc13e0661e09ed1f598254594d9e89acad3df2c4dea0e7058","505adfa92f2232c20818247afb85b65ac5f8cedb2eaee1ce28f3b473085e997c"],["v5+rules+event","659ec018e02c2d9935e51af3eef1878c14b489083675a1169bc2cd428f7010c1","81a085c7821b05fc8403a1d0a52644e70c0b996881a632714cf0d275f8405aa3"],["v5+rules+creator","b8e538e857a5e9f8c1c3edd23bf3f76d7ce68fe4c003795cdfc81d1062675bc5","23f4139dc036a1fc0089b8a7dc1a960295550eca5d3df7293249d0e35865197a"],["v5+rules+creator+event","978b01a0b9e9118699b8201e58130ba3eb671e3214a4095c889a4b8fac790789","13f3bf33bb3799d23e089cfc29eeb9aeed1c28b648ed384f3e4383572685510a"],["v5+deadline","de851b3a00abc83105d908fa0eb36a7c65c4e884bc29ae5db0a95e96fc6c975a","cc7c7f446856f88737a95bfabb5e2286707b273355eeaa3194ba82368d37fdf0"],["v5+deadline+event","0fb7a4af7019577cdbdffe07742e4495ca2306a3a76c24cd01798f3a9404c785","017e4e0325bb195d9a110b020301986d7529b59fd2adc2fe8d35cbb0199925c7"],["v5+deadline+creator","20deed7d567761bdacf70c816ad91d40016a2789bf28c9da20c40e3373454798","fe2f389fe3a2722d44131364c59e77c1eee1d3e9a03fc656edb42d5c75a17714"],["v5+deadline+creator+event","f37e9a0e7cbe743e97ba00fa77b76d8e94f7601345a49cc28c46f69cabdf66b9","79c83d23b319e72834bef029717188485de21bb7d55a50e0e30ef08a91b5e63a"],["v5+deadline+rules","5eeea305a626e723830ae1b47c38506c758355e270e668d7de324846e6b7f7ed","789628a57767be0e028183a9a494e500bb6a4dc2060fc49f3acadcb43fa3be61"],["v5+deadline+rules+event","cc704d94fb08582a3d38c07aff9686290edf2d1b536558b6fbfb7c2920d8b6a2","85ddf603901eb0bea5044a365c9cd9a5fa626160d689358e6e21e040629ffe58"],["v5+deadline+rules+creator","2fa5f81fd4794947d9fcbaa00be9ba665b5d17b7e636f4110f07816762485a7b","1f1da9df2433de8db97fe0d49430793398ce83b1b7a67812718367c3e2a6da6d"],["v5+deadline+rules+creator+event","34e8a052c9e5a90dd537dfbddffebd84f620c21cd543db86626e28cdf9aae4b1","8b58e86c1479217f9c22ba458a6b7a26ee435074d42fd9a8ddb1256c8e3ff5eb"],["v5+series","76e4affbb84ecd1358e299d4c713a2c7f4ca2c87494ace7ea03e93e1def67407","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+series+creator","7fa97dcb82a040b9f0b5f7a29e210b884025ec7e450d66701d97d4ed24e4d892","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+series+rules","b1fdc02686bcad4d959614f2193c7bf59f1f0b3c594634222a7a8aab36a8d087","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+series+rules+creator","1f81554f7083aafa27d1a0ec4f0d74d62e582f63e927b979a13f31ac7ab3679e","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+deadline+series","9b253f035391dd2e1260af102b658759d0cda761fecbce2a585236fc7b9a239a","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+deadline+series+creator","df4bc38a70672d18c1a41e1d3983cb733cbd3e3230636d2483afca1690f55f2f","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+deadline+series+rules","448d782671f0e17cba3c5f0bbb561a992a3f924a8300193085458c3fb2ca7809","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"],["v5+deadline+series+rules+creator","4fe8098fb7eba6b67dde1cfe552bb1881382571ffade28116afcfefc5607c66a","225fa1cec070be3f0f1b5a355ce0b0e257ceb7eeef30b7125cd0f143af53846a"]];
const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
};
const RULES = buildRules({ claimWindowDays: 3, bondMinGameVerifySats: 50000n, bondMinSettlementSats: 200000n });
const EVENT = { question: 'Who wins?', outcomes: ['A', 'B', 'C'], resolveAtMs: 1788300000000n };
function* layouts(versions) {
  for (const v of versions)
    for (const more of [{}, { startDeadlineTicks: 100 }, { seriesId: b32(0x5e), roundIndex: 7 }, { startDeadlineTicks: 100, seriesId: b32(0x5e), roundIndex: 7 }])
      for (const rules of [false, true])
        for (const creator of [false, true])
          for (const ev of more.seriesId ? [false] : [false, true])
            yield [`v${v}${more.startDeadlineTicks ? '+deadline' : ''}${more.seriesId ? '+series' : ''}${rules ? '+rules' : ''}${creator ? '+creator' : ''}${ev ? '+event' : ''}`,
              { ...BASE, protocolVersion: v, ...more, ...(rules ? { rules: RULES } : {}), ...(creator ? { creatorPubkey: b32(0x0c) } : {}), ...(ev ? { event: EVENT } : {}) }];
}

test('every contract layout of versions 4 and 5 keeps its bytes and its round id, and reads back with no source round', () => {
  const pinned = new Map(CONTRACT_PINS.map(([n, h, id]) => [n, { h, id }]));
  let n = 0;
  for (const [name, c] of layouts([4, 5])) {
    const bytes = encodeRoundContract(c);
    assert.equal(toHex(sha256(bytes)), pinned.get(name).h, `${name}: its bytes moved`);
    assert.equal(toHex(roundId(c)), pinned.get(name).id, `${name}: its round id moved`);
    const back = decodeRoundContract(bytes);
    assert.equal(back.sourceRoundId, undefined, `${name} read as a market on a game`);
    assert.deepEqual(encodeRoundContract(back), bytes);
    n++;
  }
  assert.equal(n, CONTRACT_PINS.length);
  console.log(`  ${n} contract layouts of v4/v5 (deadline/series/rules/creator/event): bytes and round ids unchanged`);
});

// ---- THE MARKET -----------------------------------------------------------------------------------------------------------

const DEV = edKey();
const COMMITTEE = Array.from({ length: 7 }, edKey);
const STRANGER = edKey();
const TICK_TOCK = decodeManifest(fromHex(NEXTBLOCK_V2_HEX));                  // the source game: nextblock v2, Tick Tock
const TICK_TOCK_ID = gameIdOf(TICK_TOCK);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins this Tick Tock round?', resolveAfterCloseMs: 600000n, deadlineAfterResolveMs: 3600000n,
  sourceRule: 'the source round\'s RoundResult (§13), signed by 5 of its 7 seats' };
const GAME_SOURCE = { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] };
const BODY = {
  gameName: 'tick-tock-fronts', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['BULLS', 'BEARS'], attestors: [], attestThreshold: 0,
  marketTerms: TERMS, gameSource: GAME_SOURCE, requiredProtocolVersion: GAME_MARKET_VERSION,
};
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });
const MARKET = signed(BODY);
const MARKET_ID = gameIdOf(MARKET);

const S = 1788200000000n;                                                       // the source round starts
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: COMMITTEE.map((k) => k.pub) };
const SOURCE_ID = roundId(SOURCE);
const ROUND = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET_ID, simCoreHash: new Uint8Array(32), configHash: new Uint8Array(32),
  startTimeMs: S - 900000n, entryCloseMs: S - 60000n, nodes: [], sourceRoundId: SOURCE_ID };
const RESULT = (openCents, closeCents) => ({ roundId: SOURCE_ID, openCents, closeCents });
const sigsOf = (result, keys) => keys.map((k) => ({ key: toHex(k.pub), signature: toHex(new Uint8Array(sign(null, Buffer.from(roundResultId(result)), k.key))) }));
const resolve = (over = {}) => gameMarketResolution({ market: ROUND, manifest: MARKET, source: SOURCE, committee: COMMITTEE.map((k) => k.pub), verify: verifyEd, ...over });

test('version 6 is spoken: 2026.0.6, markets on games', () => {
  assert.equal(GAME_MARKET_VERSION, 6);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(6));
  assert.equal(speaksVersion(6), true);
  assert.equal(speaksVersion(17), false, '11 is 2026.0.11, the protocol reserves; 12 is 2026.0.12, the leaderboard payout; 13 is 2026.0.13, the seated guardian pool; 14 the cohort, 15 the gateway seats; 16 the liquidity providers; 17 is spoken by no build');
});

test('a game source rides in its manifest after its own marker: read back whole, after the market terms and before the required version', () => {
  const back = decodeManifest(encodeManifest(MARKET));
  assert.deepEqual(back.gameSource, GAME_SOURCE);
  assert.deepEqual(back.attestors, []);
  assert.equal(back.attestThreshold, 0);
  assert.equal(back.requiredProtocolVersion, 6);
  assert.deepEqual(encodeManifest(back), encodeManifest(MARKET));
  assert.equal(isGameMarket(back), true);
  assert.equal(isTemplate(back), false);
  // THE BYTES: the market without the source, then the source's marker and fields (1 + 32 + 1 + 2 + 3), then the required version's
  const plain = encodeManifestBody({ ...BODY, gameSource: undefined, requiredProtocolVersion: undefined, attestors: [b32(0xa1)], attestThreshold: 1 });
  const body = encodeManifestBody(MARKET);
  const sourceAt = body.length - 3 - 39;
  assert.equal(body[sourceAt], GAME_SOURCE_MARKER);
  assert.deepEqual(body.subarray(sourceAt + 1, sourceAt + 33), TICK_TOCK_ID);
  assert.equal(body[sourceAt + 33], SOURCE_KIND.ROUND_RESULT);
  assert.deepEqual([...body.subarray(sourceAt + 36, sourceAt + 39)], [0, 1, 0xff]);
  assert.equal(body[body.length - 3], REQUIRED_VERSION_MARKER);
  assert.equal(body.length - plain.length, 39 + 3 - 32, 'one attestor key fewer, the source and the required version more');
  assert.deepEqual(new Set([MARKET_TERMS_MARKER, REQUIRED_VERSION_MARKER, PAYOUT_SHARES_MARKER, TEMPLATE_MARKER, GAME_SOURCE_MARKER]).size, 5, 'five distinct manifest markers');
  assert.equal(GAME_SOURCE_MARKER, 0x05);
  const st = manifestStands(MARKET, { verify: verifyEd });
  assert.equal(st.ok, true, st.why);
  console.log(`  market on a game ${toHex(MARKET_ID).slice(0, 16)} on Tick Tock ${toHex(TICK_TOCK_ID).slice(0, 8)}: ${body.length} body bytes, marker 0x05 at ${sourceAt}`);
});

test('a market on a game\'s rules, each refused by name', () => {
  const refusals = {
    'below version 6': [{ ...BODY, requiredProtocolVersion: 5 }, /requires protocol version 6 or later/],
    'no required version': [{ ...BODY, requiredProtocolVersion: undefined }, /requires protocol version 6 or later/],
    'an attestor': [{ ...BODY, attestors: [b32(0xa1)], attestThreshold: 1 }, /names no attestors and a threshold of 0/],
    'a threshold of 1': [{ ...BODY, attestThreshold: 1 }, /names no attestors and a threshold of 0/],
    'no market terms': [{ ...BODY, marketTerms: undefined }, /names its market terms/],
    'a template too': [{ ...BODY, template: { category: 'x', maxOutcomes: 2, resolveWithinMs: 86400000n } }, /names its market terms|is no template|template/],
    'on a grid': [{ ...BODY, roundPeriodMs: 900000n }, /runs on no grid/],
    'no source game': [{ ...BODY, gameSource: { ...GAME_SOURCE, sourceGameId: new Uint8Array(32) } }, /names its source game by its 32-byte manifest id/],
    'an unknown kind': [{ ...BODY, gameSource: { ...GAME_SOURCE, sourceKind: 2 } }, /source kind 2 is not one this engine reads/],
    'two mapping bytes': [{ ...BODY, gameSource: { ...GAME_SOURCE, mapping: [0, 1] } }, /maps each of its source's 3 results \(BULLS, BEARS, FLAT\)/],
    'an outcome out of range': [{ ...BODY, gameSource: { ...GAME_SOURCE, mapping: [0, 2, 0xff] } }, /maps BEARS to 2: an outcome index 0 to 1, or 255/],
    'an outcome nobody reaches': [{ ...BODY, gameSource: { ...GAME_SOURCE, mapping: [0, 0, 0xff] } }, /outcome 1 "BEARS" is no source result's/],
    'a replayed game': [{ ...TICK_TOCK, gameSource: GAME_SOURCE }, /only an attested game is a market on a game/],
  };
  const said = {};
  for (const [name, [m, why]] of Object.entries(refusals)) {
    let msg = null;
    try { encodeManifestBody(m); } catch (e) { msg = e.message; }
    assert.ok(msg, `${name}: encoded`);
    assert.match(msg, why, name);
    said[name] = msg;
  }
  // a template with a game source: refused whichever rule reads first, never written
  assert.equal(gameSourceFits(GAME_SOURCE, { ...BODY, template: { category: 'x', maxOutcomes: 2, resolveWithinMs: 86400000n } }).ok, false);
  // FLAT may pay an outcome too (a three-way market), and all three may: the mapping is the dev's, the refund one choice of it
  assert.ok(encodeManifestBody({ ...BODY, outcomes: ['BULLS', 'BEARS', 'FLAT'], gameSource: { ...GAME_SOURCE, mapping: [0, 1, 2] } }));
  // and a manifest that requires a version this build does not speak is no game it hosts
  const tooNew = signed({ ...BODY, requiredProtocolVersion: 17 });
  const st = manifestStands(tooNew, { verify: verifyEd });
  assert.equal(st.ok, false);
  assert.match(st.why, /market on a game under protocol version 17, which this build does not speak/);
  console.log('  FACTS (refusals):', JSON.stringify(said));
});

test('the source round rides in the contract after the creator\'s key, from version 6 only: read back whole, and its id hashes it', () => {
  const bytes = encodeRoundContract(ROUND);
  const back = decodeRoundContract(bytes);
  assert.deepEqual(back.sourceRoundId, SOURCE_ID);
  assert.deepEqual(encodeRoundContract(back), bytes);
  assert.equal(bytes[bytes.length - 1], SOURCE_ROUND_MARKER);
  assert.equal(bytes[bytes.length - 34], SOURCE_ROUND_MARKER);
  assert.deepEqual(bytes.subarray(bytes.length - 33, bytes.length - 1), SOURCE_ID);
  assert.equal(new Set([SOURCE_ROUND_MARKER, EVENT_MARKER, RULES_MARKER, CREATOR_MARKER]).size, 4);
  const without = { ...ROUND, sourceRoundId: undefined };
  assert.deepEqual(encodeRoundContract(without), bytes.subarray(0, bytes.length - 34), 'the source is 34 bytes at the end, nothing else moves');
  assert.notDeepEqual(roundId(ROUND), roundId(without));
  assert.notDeepEqual(roundId(ROUND), roundId({ ...ROUND, sourceRoundId: b32(0x77) }), 'another source is another round');
  // WITH EVERY TAIL A v6 CONTRACT MAY CARRY BEFORE IT: deadline, rules, creator - read back whole, and none without it reads as one
  let n = 0;
  for (const more of [{}, { startDeadlineTicks: 100 }])
    for (const rules of [false, true])
      for (const creator of [false, true]) {
        const c = { ...ROUND, ...more, ...(rules ? { rules: RULES } : {}), ...(creator ? { creatorPubkey: b32(0x0c) } : {}) };
        const b = encodeRoundContract(c);
        assert.deepEqual(encodeRoundContract(decodeRoundContract(b)), b);
        assert.deepEqual(decodeRoundContract(b).sourceRoundId, SOURCE_ID);
        const plain = encodeRoundContract({ ...c, sourceRoundId: undefined });
        assert.equal(decodeRoundContract(plain).sourceRoundId, undefined);
        n++;
      }
  assert.equal(n, 8);
  console.log(`  market round ${toHex(roundId(ROUND)).slice(0, 16)} on source ${toHex(SOURCE_ID).slice(0, 16)}: ${bytes.length} bytes; ${n} v6 layouts read back`);
});

test('a source round below version 6, on a series, beside a question, or of zeros: refused by name at encoding; a v5 contract carrying one does not parse', () => {
  for (const v of [1, 2, 3, 4, 5])
    assert.throws(() => encodeRoundContract({ ...ROUND, protocolVersion: v }), /names a source round from protocol version 6 on/, `v${v}`);
  assert.throws(() => encodeRoundContract({ ...ROUND, seriesId: b32(0x5e), roundIndex: 7 }), /no round of a series/);
  assert.throws(() => encodeRoundContract({ ...ROUND, event: EVENT }), /asks its manifest's question/);
  assert.throws(() => encodeRoundContract({ ...ROUND, sourceRoundId: new Uint8Array(32) }), /names its source round by a 32-byte round id/);
  assert.throws(() => encodeRoundContract({ ...ROUND, sourceRoundId: new Uint8Array(31) }), /names its source round by a 32-byte round id/);
  // THE SAME BYTES AT VERSION 5: a build reads a source round only on a version-6 contract, so this is trailing bytes
  const v6 = encodeRoundContract(ROUND);
  const v5 = new Uint8Array(v6); v5[2] = 5;
  assert.throws(() => decodeRoundContract(v5), /trailing bytes/);
  // and a version 10 contract is no contract of this build (9 is 2026.0.9, the website's fee -)
  const v10 = new Uint8Array(v6); v10[2] = 17;    // 14 and 15 are 2026.0.14/15 since, 16 since (the liquidity providers): the version nobody speaks is 17
  assert.throws(() => decodeRoundContract(v10), /protocol version 17/);
});

test('which rounds name a source: a market on a game\'s round must (v6 or later), any other game\'s must not - each refused by name', () => {
  assert.deepEqual(roundFitsManifest(ROUND, MARKET, MARKET_ID), { ok: true, attested: true, gameMarket: true });
  const none = roundFitsManifest({ ...ROUND, sourceRoundId: undefined }, MARKET, MARKET_ID);
  assert.equal(none.ok, false);
  assert.match(none.why, /is a market on a game: each round of it names the source round/);
  // A ROUND OF THE MARKET BELOW 6 IS REFUSED BY ITS REQUIRED VERSION
  const v5 = roundFitsManifest({ ...ROUND, protocolVersion: 5, sourceRoundId: undefined }, MARKET, MARKET_ID);
  assert.equal(v5.ok, false);
  assert.match(v5.why, /requires protocol version 6; that round runs 5/);
  // A SOURCE ON ANOTHER GAME'S ROUND: an attested market with attestors, and a replayed game
  const plainMarket = signed({ ...BODY, gameSource: undefined, attestors: [b32(0xa1)], attestThreshold: 1 });
  const other = roundFitsManifest({ ...ROUND, gameId: gameIdOf(plainMarket) }, plainMarket);
  assert.equal(other.ok, false);
  assert.match(other.why, /is no market on a game: a round of it names no source round/);
  const replayed = roundFitsManifest({ ...SOURCE, protocolVersion: 6, sourceRoundId: b32(0x77) }, TICK_TOCK, TICK_TOCK_ID);
  assert.equal(replayed.ok, false);
  assert.match(replayed.why, /is no market on a game/);
});

test('timing: a market whose entries close after its source round starts is refused by name - and VOID; one whose source ends after its resolution time likewise', () => {
  const fits = gameMarketFitsSource({ market: ROUND, manifest: MARKET, source: SOURCE });
  assert.equal(fits.ok, true, fits.why);
  assert.equal(fits.sourceEndMs, sourceRoundEndMs(SOURCE));
  assert.ok(fits.sourceEndMs > S + 149000n && fits.sourceEndMs < S + 151000n, `9000 ticks are about 150 s: ${fits.sourceEndMs - S} ms`);
  // AT THE START EXACTLY: still blind (no sample of the source exists before its start)
  assert.equal(gameMarketFitsSource({ market: { ...ROUND, entryCloseMs: S }, manifest: MARKET, source: SOURCE }).ok, true);
  // ONE MILLISECOND AFTER IT: refused, by name, and permanent
  const late = gameMarketFitsSource({ market: { ...ROUND, entryCloseMs: S + 1n }, manifest: MARKET, source: SOURCE });
  assert.equal(late.ok, false);
  assert.equal(late.void, true);
  assert.match(late.why, /entries close at 2026-.*, after its source round [0-9a-f]{16} starts at 2026-.*: a pick would be made with the outcome under way/);
  // THE SOURCE MUST END BY THE MARKET'S RESOLUTION TIME (entry close + 600 s here): a source starting 500 s after the close ends past it
  const longAfter = { ...SOURCE, startTimeMs: ROUND.entryCloseMs + 500000n };
  const far = gameMarketFitsSource({ market: { ...ROUND, sourceRoundId: roundId(longAfter) }, manifest: MARKET, source: longAfter });
  assert.equal(far.ok, false);
  assert.equal(far.void, true);
  assert.match(far.why, /ends at .*, after market "tick-tock-fronts"'s resolution time .* \(600000 ms after its entry close\)/);
  // ANOTHER CONTRACT THAN THE ROUND NAMED: refused, and says nothing of the market (not VOID)
  const wrong = gameMarketFitsSource({ market: ROUND, manifest: MARKET, source: { ...SOURCE, startTimeMs: S + 1n } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.void, undefined);
  assert.match(wrong.why, /that contract is round [0-9a-f]{16}; market "tick-tock-fronts"'s round is on/);
  // A ROUND OF ANOTHER GAME: VOID
  const rps = { ...SOURCE, gameId: b32(0x99) };
  const notTick = gameMarketFitsSource({ market: { ...ROUND, sourceRoundId: roundId(rps) }, manifest: MARKET, source: rps });
  assert.equal(notTick.void, true);
  assert.match(notTick.why, /plays game 9999999999999999; market "tick-tock-fronts" is on game/);
  // AND A RESOLUTION OF A LATE MARKET IS VOID, however well its source's result is signed
  const lateRound = { ...ROUND, entryCloseMs: S + 1n };
  const r = RESULT(8297000, 8298000);
  const res = resolve({ market: lateRound, result: r, sigs: sigsOf(r, COMMITTEE) });
  assert.equal(res.ok, false);
  assert.equal(res.void, true);
  assert.equal(gameMarketVoided(res, { market: lateRound, manifest: MARKET, nowMs: S }).voided, true);
  console.log(`  FACTS (timing): ${late.why} | ${far.why}`);
});

test('a source round of a series (as Tick Tock\'s are) is taken only as its series derives it: its id H(series_id || i) does not hash its times', () => {
  const template = { ...SOURCE };
  const src = seriesRound(template, 3);
  const M = { ...ROUND, sourceRoundId: roundId(src), entryCloseMs: src.startTimeMs - 60000n };
  const bare = gameMarketFitsSource({ market: M, manifest: MARKET, source: src });
  assert.equal(bare.ok, false);
  assert.notEqual(bare.void, true, 'an unchecked series contract says nothing of the market');
  assert.match(bare.why, /is round 3 of a series: its id does not hash its contract, so it is taken only as its series derives it/);
  assert.equal(gameMarketFitsSource({ market: M, manifest: MARKET, source: src, sourceSeries: [template] }).ok, true);
  assert.equal(gameMarketFitsSource({ market: M, manifest: MARKET, source: src, sourceHeld: true }).ok, true);
  // THE SAME ID WITH OTHER TIMES: a contract the series does not derive - refused against the series, and not VOID
  const forged = { ...src, startTimeMs: src.startTimeMs + 1000n };
  assert.deepEqual(roundId(forged), roundId(src), 'a series round\'s id does not hash its times');
  const f = gameMarketFitsSource({ market: M, manifest: MARKET, source: forged, sourceSeries: [template] });
  assert.equal(f.ok, false);
  assert.notEqual(f.void, true);
  assert.match(f.why, /opens and closes its entry at|is not round 3 of series/);
  // and resolution reads it the same way
  const r = RESULT(8297000, 8298000);
  const sigs = COMMITTEE.map((k) => ({ key: toHex(k.pub), signature: toHex(new Uint8Array(sign(null, Buffer.from(roundResultId({ ...r, roundId: roundId(src) })), k.key))) }));
  const res = resolve({ market: M, source: src, sourceSeries: [template], result: { ...r, roundId: roundId(src) }, sigs });
  assert.deepEqual([res.ok, res.outcome], [true, 0], res.why);
});

test('resolution from the source round\'s RoundResult signed by 5 of its 7 seats: BULLS pays outcome 0, BEARS outcome 1', () => {
  const bulls = RESULT(8297000, 8298000);
  const r = resolve({ result: bulls, sigs: sigsOf(bulls, COMMITTEE.slice(0, 5)) });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.outcome, r.label, r.value, r.signers, r.threshold], [0, 'BULLS', 'BULLS', 5, 5]);
  const bears = RESULT(8298000, 8297000);
  const b = resolve({ result: bears, sigs: sigsOf(bears, COMMITTEE.slice(2)) });
  assert.equal(b.ok, true, b.why);
  assert.deepEqual([b.outcome, b.label, b.signers], [1, 'BEARS', 5]);
  // all seven, and the front named as the seats name it (GET /round-result answers 'BULLS')
  const all = resolve({ result: { ...bulls, front: 'BULLS' }, sigs: sigsOf(bulls, COMMITTEE) });
  assert.deepEqual([all.ok, all.outcome, all.signers], [true, 0, 7]);
  assert.equal(gameMarketVoided(r, { market: ROUND, manifest: MARKET, nowMs: S + 10n ** 9n }).voided, false, 'a standing outcome is never VOID, even past the deadline');
  console.log(`  FACTS (resolution): ${r.why}`);
});

test('refused: 4 of 7, 4 of 7 and a stranger, a key signing twice, a forged signature, a front that does not follow, another round\'s result, an oversized committee', () => {
  const bulls = RESULT(8297000, 8298000);
  const said = {};
  const no = (name, over, why) => { const r = resolve(over); assert.equal(r.ok, false, `${name}: stood`); assert.notEqual(r.void, true, `${name}: not VOID`); assert.match(r.why, why, name); said[name] = r.why; };
  no('4 of 7', { result: bulls, sigs: sigsOf(bulls, COMMITTEE.slice(0, 4)) }, /does not stand: 4 of the committee signed it, 5 are needed/);
  no('4 of 7 and a stranger', { result: bulls, sigs: sigsOf(bulls, [...COMMITTEE.slice(0, 4), STRANGER]) }, /4 of the committee signed it, 5 are needed/);
  const twice = sigsOf(bulls, COMMITTEE.slice(0, 4));
  no('a key signing twice', { result: bulls, sigs: [...twice, twice[0]] }, /4 of the committee signed it, 5 are needed/);
  // a stranger's signature under a seat's key: verifies nothing
  const forged = sigsOf(bulls, [STRANGER]).map((s) => ({ ...s, key: toHex(COMMITTEE[4].pub) }));
  no('a forged signature', { result: bulls, sigs: [...sigsOf(bulls, COMMITTEE.slice(0, 4)), ...forged] }, /4 of the committee signed it, 5 are needed/);
  // SIGNATURES OVER ANOTHER RESULT: the seats signed BULLS 8297000 -> 8298000; a BEARS claim with them counts nothing
  no('signed another result', { result: RESULT(8298000, 8297000), sigs: sigsOf(bulls, COMMITTEE) }, /BEARS does not stand: 0 of the committee/);
  no('a front that does not follow', { result: { ...bulls, front: 'BEARS' }, sigs: sigsOf(bulls, COMMITTEE) }, /says BEARS, and 8297000 -> 8298000 cents is BULLS/);
  const other = { ...bulls, roundId: b32(0x77) };
  no('another round\'s result', { result: other, sigs: sigsOf(other, COMMITTEE) }, /that result is round 7777777777777777's; this market is on/);
  no('a committee of 8', { result: bulls, sigs: sigsOf(bulls, COMMITTEE), committee: [...COMMITTEE, STRANGER].map((k) => k.pub) }, /seats 7; a committee of 8 keys is not its committee/);
  no('no committee', { result: bulls, sigs: sigsOf(bulls, COMMITTEE), committee: [] }, /no source committee/);
  // THE STRANGER IN THE COMMITTEE HANDED IN (a contract's `nodes` - which the id does not hash from v2): its key is not a seat's
  // only if the caller's derivation says so; with the seats' own derivation the stranger counts nothing
  const stood = resolve({ result: bulls, sigs: sigsOf(bulls, [...COMMITTEE.slice(0, 4), STRANGER]), committee: [...COMMITTEE.slice(0, 6), STRANGER].map((k) => k.pub) });
  assert.equal(stood.ok, true, 'a committee the caller derived wrongly is the caller\'s fault: the function counts against what it is handed');
  console.log('  FACTS (refusals):', JSON.stringify(said));
});

test('FLAT refunds: every stake back (pari-mutuel VOID); no result by the deadline refunds; before it nothing is decided', () => {
  const flat = RESULT(8297000, 8297000);
  const r = resolve({ result: flat, sigs: sigsOf(flat, COMMITTEE.slice(0, 5)) });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.refund, true);
  assert.equal(r.value, 'FLAT');
  assert.equal(r.outcome, undefined);
  const v = gameMarketVoided(r, { market: ROUND, manifest: MARKET, nowMs: ROUND.entryCloseMs });
  assert.equal(v.voided, true);
  assert.match(v.why, /ended FLAT, which this market refunds: every stake goes back/);
  // NO STANDING RESULT: VOID at entry close + 600 s + 1 h, not a millisecond before
  const deadline = ROUND.entryCloseMs + TERMS.resolveAfterCloseMs + TERMS.deadlineAfterResolveMs;
  const short = resolve({ result: RESULT(8297000, 8298000), sigs: sigsOf(RESULT(8297000, 8298000), COMMITTEE.slice(0, 4)) });
  assert.equal(gameMarketVoided(short, { market: ROUND, manifest: MARKET, nowMs: deadline - 1n }).voided, false);
  assert.equal(gameMarketVoided(null, { market: ROUND, manifest: MARKET, nowMs: deadline - 1n }).voided, false);
  const late = gameMarketVoided(null, { market: ROUND, manifest: MARKET, nowMs: deadline });
  assert.equal(late.voided, true);
  assert.match(late.why, /no signed result of its source round stood by the market's deadline/);
  // a mapping that pays FLAT is not a refund
  const three = signed({ ...BODY, outcomes: ['BULLS', 'BEARS', 'FLAT'], gameSource: { ...GAME_SOURCE, mapping: [0, 1, 2] } });
  const paid = resolve({ manifest: three, market: { ...ROUND, gameId: gameIdOf(three) }, result: flat, sigs: sigsOf(flat, COMMITTEE.slice(0, 5)) });
  assert.deepEqual([paid.ok, paid.outcome, paid.label], [true, 2, 'FLAT']);
});

test('the mapping alone: gameMarketOutcome by front number and by name', () => {
  assert.deepEqual(gameMarketOutcome(FRONT.BULLS, GAME_SOURCE), { ok: true, outcome: 0, value: 'BULLS' });
  assert.deepEqual(gameMarketOutcome('BEARS', GAME_SOURCE), { ok: true, outcome: 1, value: 'BEARS' });
  assert.equal(gameMarketOutcome(FRONT.FLAT, GAME_SOURCE).refund, true);
  assert.equal(gameMarketOutcome(4, GAME_SOURCE).ok, false);
  assert.equal(gameMarketOutcome('SIDEWAYS', GAME_SOURCE).ok, false);
  assert.equal(gameMarketOutcome(1, { ...GAME_SOURCE, sourceKind: 9 }).ok, false);
  assert.deepEqual(SOURCE_VALUES[SOURCE_KIND.ROUND_RESULT], ['BULLS', 'BEARS', 'FLAT']);
});

test('no attestation decides a market on a game: one with no signature at all (its threshold is 0) is refused by name', () => {
  const a = { roundId: roundId(ROUND), outcome: 0, observedAtMs: S + 200000n, signatures: [] };
  const back = decodeAttestation(encodeAttestation(a));
  const st = attestationStands(back, { manifest: MARKET, roundIdBytes: roundId(ROUND), verify: verifyEd, round: ROUND });
  assert.equal(st.ok, false);
  assert.match(st.why, /is a market on a game: its outcome is its source round's signed result, and no attestation decides it/);
});
