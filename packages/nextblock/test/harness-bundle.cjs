// The same corpus, run against the BUNDLE rather than the modules.
//
// The bundle is what the browser actually loads, and until now it had only
// ever run under Node - so the artifact players use had never been through
// SpiderMonkey or JavaScriptCore. Concatenation changes scoping, hoisting and
// declaration order; those are exactly the things engines have historically
// disagreed about, and exactly what this file would catch.
//
// Deliberately a plain script, not a module: the engine shells take several
// files in one global scope, so the bundle can be loaded ahead of it.
//   v8  dist/blwp-core.js test/harness-bundle.js
//   sm  dist/blwp-core.js test/harness-bundle.js
//   jsc dist/blwp-core.js test/harness-bundle.js

var say = (typeof print === 'function') ? print : console.log;
var core = (typeof BLWP !== 'undefined') ? BLWP : require('../dist/blwp-core.js');

var TICKS = 36000;
var SEED = 0x5eed1234;

function inputs(t) {
  var a = (Math.imul(t, 1103515245) + 12345) | 0;
  var b = (Math.imul(a, 1103515245) + 12345) | 0;
  return {
    throttle: 32768 + ((a >>> 17) % 32769),
    steer: ((b >>> 16) % 65536) - 32768,
    brake: (t % 700) < 40 ? 65536 : 0,
  };
}

var st = core.init(SEED);
say('# blwp bundle harness');
for (var t = 0; t < TICKS; t++) {
  var i = inputs(t);
  core.step(st, i.throttle, i.steer, i.brake, 0, 0);
  if ((t + 1) % 3600 === 0) say((t + 1) + ' ' + core.hash(st));
}
say('final ' + core.hash(st));
