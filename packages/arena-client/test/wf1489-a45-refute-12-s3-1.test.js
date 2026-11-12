// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 3 (role: a stranger's round link / one seat under two addresses): ONE SEAT, ONE VOTE (#2329) DEDUPLICATES
// SPELLINGS, NOT SEATS. seatKey keeps the URL's path, so 'http://evil' and 'http://evil/r' are two votes; the page asks
// 'http://evil/r/api/round-result', and the evil seat answers every path. One seat outvotes the honest one: FAILED signed by 5, the Correction alert.
// SAFE: one seat cannot set the head-to-head verdict, however its address is spelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { door, honest, evil, mine } from './wf1489-a45-refute-12-s3-common.js';
const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const host = (u) => new URL(u).hostname.replace(/\.$/, '').toLowerCase();

for (const [label, twice] of [['a path', ['http://evil', 'http://evil/r']], ['a trailing-dot host name', ['http://evil', 'http://evil.']], ['another scheme', ['http://evil', 'https://evil']]]) {
  test(`#1489 a45-refute-12-s3-1: one seat named twice by ${label} outvotes the honest seat`, async () => {
    const { result, alerts, asked } = door(PAGE, { evil, h1: honest }, [...twice, 'http://h1'], host);
    const got = await result('aa'.repeat(32));
    const me = got.entries.find((e) => e.entry === mine);
    console.log('  FACTS (a45-refute-12-s3-1, ' + label + '):', JSON.stringify({ nodes: [...twice, 'http://h1'], serversAsked: asked, shownForMe: me, alerts }));
    assert.ok(!(me.outcome === 'FAILED' && me.signedBy > 0), `the page shows FAILED signed by ${me.signedBy} from one seat listed twice, against the honest seat's win`);
    assert.deepEqual(alerts, []);
  });
}
