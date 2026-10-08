// A REFUSED JOIN NEVER BECOMES "JOINED" (kanban #191, measured live 2026-10-06 05:31Z on core 0.0.2805): PLAY on round
// 49a50535, its hold to the round's start already set; the session refusal then marked the join refused
// (BLWP_REFUSED_JOIN) but did not cancel it, and at the start the hold's release set it 'joined' with the refusal still as
// its why - Unity started a run on a round with no session and the tab stopped answering. index.html's BLWP_REFUSED_JOIN and
// BLWP_JOIN_GOES_ON are lifted out of the page by their text and run as they are; the release and the join's answer must ask
// BLWP_JOIN_GOES_ON before they go on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const lift = (head) => {
  const at = PAGE.indexOf(head);
  assert.ok(at > 0, `index.html has no ${head.trim()}`);
  return PAGE.slice(at, PAGE.indexOf('\n    };\n', at) + '\n    };\n'.length);
};
const pageWith = (window) => pageFunction(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), ['window'], [lift('    window.BLWP_REFUSED_JOIN = '), lift('    window.BLWP_JOIN_GOES_ON = ')], 'return window;')(window);

test('a join refused while it is held to its start does not go on: cancelled, refused, and no longer the join that goes on', () => {
  const w = pageWith({ BLWP_LOBBY: [] });
  const join = { state: 'joining', round: '49a50535'.padEnd(64, '0'), held: true, loaded: true, stage: 'next round starts in 0:15' };
  w.BLWP_JOIN = join;
  assert.equal(w.BLWP_JOIN_GOES_ON(join), true, 'a join going on is not seen as going on');
  const back = w.BLWP_REFUSED_JOIN('the node refused the round: at census height 155088 this network\'s donation set in force is serial 3');
  assert.equal(back, join, 'the refusal is not on the join the page holds');
  assert.equal(join.state, 'refused');
  assert.equal(join.cancelled, true, 'the refused join is not cancelled, so its hold still releases it');
  assert.equal(join.held, false);
  assert.equal(w.BLWP_JOIN_GOES_ON(join), false, 'a refused join still goes on');
  // the release at the start, as the page runs it: it must not set 'joined' on this join
  if (w.BLWP_JOIN_GOES_ON(join)) { join.state = 'joined'; }
  assert.equal(join.state, 'refused');
});

test('a join that is no longer the page\'s join, or cancelled by time, does not go on', () => {
  const w = pageWith({ BLWP_LOBBY: [] });
  const join = { state: 'joining' };
  w.BLWP_JOIN = { state: 'joining' };
  assert.equal(w.BLWP_JOIN_GOES_ON(join), false);
  w.BLWP_JOIN = join; join.cancelled = true;
  assert.equal(w.BLWP_JOIN_GOES_ON(join), false);
});

test('the hold\'s release asks BLWP_JOIN_GOES_ON before it sets "joined"; the join\'s answer drops a cancelled join', () => {
  const release = PAGE.slice(PAGE.indexOf('                const release = () => {'), PAGE.indexOf('                release();'));
  assert.match(release, /if \(!window\.BLWP_JOIN_GOES_ON\(join\)\) return;/, 'release() does not ask BLWP_JOIN_GOES_ON');
  const answer = PAGE.slice(PAGE.indexOf('          joinTheRoundIfOneWasNamed()\n            .then(() => {'), PAGE.indexOf('              // A LATE ENTRY IS HELD TO ITS JOIN TICK'));
  assert.match(answer, /if \(join\.cancelled\) \{[^]*: dropped'\);\s*return;/, 'the join\'s answer does not drop a cancelled join');
});

// AND A ROUND ITS SIGNER NODES REFUSE FOR ITS DONATION SET IS REFUSED BEFORE ANY LOCK (kanban #191): the donation-set step of
// the join refuses on "donation set in force" and returns, ahead of BLWPCLIENT.lockStake.
test('the join refuses on "donation set in force" at its donation-set step, before the stake lock', () => {
  const step = PAGE.indexOf("const ds = await joinStep('fetchDonationSet'");
  const refusal = PAGE.indexOf('/donation set in force/.test(String(ds.why))', step);
  const lock = PAGE.indexOf('await BLWPCLIENT.lockStake(', step);
  assert.ok(step > 0 && lock > step, 'the join has no donation-set step ahead of its lock');
  assert.ok(refusal > step && refusal < lock, 'no refusal on "donation set in force" between the donation-set step and the lock');
  const branch = PAGE.slice(refusal, PAGE.indexOf('else { window.BLWP_DONATION_SET_WHY', refusal));
  assert.match(branch, /window\.BLWP_JOIN_REFUSED = 'the signer nodes refuse this round: '/);
  assert.match(branch, /return;/);
});

// THE TAB NEVER FREEZES ON A REFUSED JOIN (kanban #191, measured live 2026-10-06 11:32:15Z on 0.0.2813, round dad75338, and at
// 05:31Z / 08:02Z before): ~2 min after the refusal the session's socket - opened beside the entry - dropped; the jslib's
// onDrop called net.client.reconnect with net.client already null (the session-error path nulled it without closing the
// client): "TypeError: Cannot read properties of null (reading 'reconnect')"; Unity's loader then ran its error handler, whose
// default is alert() - a modal that holds the tab (CDP Runtime.evaluate and Page.enable unanswered, renderer ~2% CPU).
const JSLIB = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');

test('an uncaught page error is logged, never alerted: the Unity config names an errorHandler that answers true', () => {
  const at = PAGE.indexOf('    const config = {');
  assert.ok(at > 0, 'index.html has no Unity config');
  const config = PAGE.slice(at, PAGE.indexOf('\n    };\n', at));
  assert.match(config, /errorHandler: \(message, filename, lineno\) => \{[^]*?console\.error\([^]*?return true;\s*\}/, 'no errorHandler that logs and answers true');
});

test('the session-error path closes the client before it lets go of it, and onDrop acts only for its own client', () => {
  const at = JSLIB.indexOf("        // No client, so the page's own word is the only one there is.");
  assert.ok(at > 0, 'the session-error path is not where it was');
  const errPath = JSLIB.slice(at, JSLIB.indexOf('net.state = ', at));
  assert.match(errPath, /if \(net\.client && net\.client\.close\) net\.client\.close\(\);[^]*net\.client = null;/, 'the client is nulled without being closed');
  const drop = JSLIB.slice(JSLIB.indexOf('net.client.onDrop = function'), JSLIB.indexOf('// THE SOCKET OPENS BESIDE THE ROUND'));
  assert.match(drop, /if \(net\.client !== client\) return;/, 'onDrop reconnects through net.client whatever it now is');
});
