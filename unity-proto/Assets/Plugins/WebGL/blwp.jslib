// The Unity <-> core bridge, WebGL side.
//
// Unity does NOT simulate. It collects input, hands it over, and renders from
// whatever the core says the world is. The direction is strict: nothing in
// Unity may write to the state except through BlwpSubmit.
//
// The core itself is loaded by the page (see the WebGL template), which puts it
// in the same realm as this glue - so state crosses as a pointer into the Unity
// heap rather than as a string. A JSON round trip at sixty hertz would cost
// more than the simulation.

mergeInto(LibraryManager.library, {

  // Returns 1 on success, 0 if the page never loaded the core. Failing loudly
  // here is better than a truck that silently never moves.
  BlwpInit: function (seed) {
    if (typeof BLWP === 'undefined') {
      console.error('[blwp] core bundle not loaded - check the WebGL template');
      return 0;
    }
    Module.blwp = { st: BLWP.init(seed | 0), core: BLWP };
    return 1;
  },

  // One tick. Inputs are Q16.16 in [-1, 1], the same units the core uses, so
  // no conversion happens at the boundary where a rounding rule could differ.
  BlwpStep: function (throttle, steer, brake, handbrake, practice) {
    var b = Module.blwp;
    if (!b) return 0;
    b.core.step(b.st, throttle | 0, steer | 0, brake | 0, handbrake | 0, practice | 0);
    return 1;
  },

  // Copies the whole state into a buffer Unity owns and polls.
  //
  // The whole buffer, every frame, on purpose: it is a few kilobytes, and
  // copying selected fields is how the two sides start disagreeing about which
  // fields exist.
  BlwpReadState: function (ptr, wordCount) {
    var b = Module.blwp;
    if (!b) return 0;
    var src = b.st.i32;
    var n = Math.min(wordCount | 0, src.length);
    var dst = new Int32Array(Module.HEAP32.buffer, ptr, n);
    dst.set(src.subarray(0, n));
    return n;
  },

  // The state hash, for a checkpoint. Written as ASCII into a caller-owned
  // buffer because returning a string from a jslib means allocating in the
  // Unity heap and freeing it on the C# side, which is a leak waiting to be
  // written.
  BlwpStateHash: function (ptr, cap) {
    var b = Module.blwp;
    if (!b) return 0;
    var hex = b.core.hash(b.st);
    var n = Math.min(hex.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = hex.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  BlwpRunScore: function () {
    var b = Module.blwp;
    return b ? (b.core.runScore(b.st) | 0) : 0;
  },

  BlwpStateWords: function () {
    return (typeof BLWP === 'undefined') ? 0 : (BLWP.WORDS | 0);
  },

  // The relief the host is drawing, handed over once as round setup.
  //
  // Not recomputed inside the core: Unity's ground uses Mathf.PerlinNoise,
  // which has no seed and no specification, so a core generating its own would
  // feel hills the player cannot see.
  BlwpSetGround: function (ptr, cols, rows) {
    var b = Module.blwp;
    if (!b) return 0;
    var n = (cols | 0) * (rows | 0);
    var src = new Int32Array(Module.HEAP32.buffer, ptr, n);
    return b.core.setGround(b.st, cols | 0, rows | 0, src.slice()) ? 1 : 0;
  },

  // The solid world, handed over as round setup with the relief.
  BlwpSetSolids: function (ptr, count) {
    var b = Module.blwp;
    if (!b) return 0;
    var n = (count | 0) * 6;
    var src = new Int32Array(Module.HEAP32.buffer, ptr, n);
    return b.core.setSolids(b.st, count | 0, src.slice()) ? 1 : 0;
  },


  // Start a new round. A host command, and the ONLY way back to RUN_LIVE:
  // `outcome` latches, `init` runs once in Start, and `teleport` moves the
  // truck without touching a single score word - so round two used to be
  // round one's leftovers. The core carries the uploaded relief and solids
  // across itself; nothing here decides what a reset means.
  BlwpRestart: function (seed) {
    var b = Module.blwp;
    if (!b) return 0;
    b.st = b.core.restart(b.st, seed | 0);
    return 1;
  },

  // Put the truck back. A host command: the round ended, or it was written
  // off, and it belongs in the bay.
  BlwpTeleport: function (x, z, heading) {
    var b = Module.blwp;
    if (!b) return 0;
    return b.core.teleport(b.st, x | 0, z | 0, heading | 0) ? 1 : 0;
  },

  // The hardest armour impact since this was last asked, in Q16.16 m/s.
  // Reading it clears it, so one crash is applied once.
  BlwpTakeImpact: function () {
    var b = Module.blwp;
    if (!b) return 0;
    var T = 5, T_IMPACT = 12;
    var v = b.st.i32[T + T_IMPACT] | 0;
    b.st.i32[T + T_IMPACT] = 0;
    return v;
  },

  // A query parameter from the page's own URL, written into a caller-owned
  // buffer. Handing a build to somebody in the mode you meant them to see is
  // what a shared link is for, and it beats asking them to find a switch.
  BlwpQueryParam: function (namePtr, outPtr, cap) {
    var name = UTF8ToString(namePtr);
    var v = null;
    try {
      v = new URLSearchParams(window.location.search).get(name);
    } catch (e) { v = null; }
    if (v === null) { Module.HEAPU8[outPtr] = 0; return 0; }
    var n = Math.min(v.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[outPtr + i] = v.charCodeAt(i) & 255;
    Module.HEAPU8[outPtr + n] = 0;
    return n;
  },
});
