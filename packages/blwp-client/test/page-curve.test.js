import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';

test('the page curve is the daemon curve', () => {
  const secret = new Uint8Array(32).fill(7);
  secret[31] = 9;
  assert.deepEqual(pageCurve.pointX(secret), feldmanGroup.pointX(secret));
  const their = feldmanGroup.pointX(new Uint8Array(32).fill(3));
  assert.deepEqual(pageCurve.ecdhShared(secret, their),
    feldmanGroup.ecdhShared(secret, their));
});

test('the page loads the curve before it takes a seat', () => {
  const page = readFileSync(
    new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html',
      import.meta.url).pathname, 'utf8');
  const curveTag = page.indexOf('src="blwp-curve.js"');
  const joinCall = page.indexOf('joinTheRoundIfOneWasNamed');
  assert.ok(curveTag >= 0, 'the page never loads blwp-curve.js');
  assert.ok(joinCall > curveTag, 'the curve script is not in front of the join');
  assert.ok(!page.includes('so it is not taking a seat'),
    'a named round still refuses the seat in silence');
  assert.ok(page.includes('id="blwp-players"'), 'the page never shows who is in the round');
});
