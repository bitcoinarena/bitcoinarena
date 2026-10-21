// The Unity <-> core bridge, WebGL side.
//
// Unity does NOT simulate. It collects input, hands it over, and renders from
// whatever the core says the world is. The direction is strict: nothing in
// Unity may write to the state except through ArenaSubmit.
//
// The core itself is loaded by the page (see the WebGL template), which puts it
// in the same realm as this glue - so state crosses as a pointer into the Unity
// heap rather than as a string. A JSON round trip at sixty hertz would cost
// more than the simulation.

mergeInto(LibraryManager.library, {

  // Returns 1 on success, 0 if the page never loaded the core. Failing loudly
  // here is better than a truck that silently never moves.
  // THE BROWSER'S OFFSET FROM UTC, in minutes: ChartHud's wall clock is UTC plus this - DateTime.Now made
  // IL2CPP load the time-zone database on the first frame (108 ms of Unity's start at 4x CPU, measured in a named profile).
  ArenaLocalOffsetMinutes: function () {
    return -new Date().getTimezoneOffset();
  },

  // BENCHMARK (2026-10-08: "Add a button to the main lobby next to SPECTATE, call it BENCHMARK ... basically it
  // is spectate with benchmark"): the page's frame-rate test (index.html, arenaBench), once the free camera has settled
  ArenaBenchmark: function () {
    setTimeout(function () { if (typeof window.arenaBench === 'function') window.arenaBench(); }, 3000);
  },

  ArenaInit: function (seed) {
    if (typeof BLWP === 'undefined') {
      console.error('[arena] core bundle not loaded - check the WebGL template');
      return 0;
    }
    Module.arenaCore = { st: BLWP.init(arenaWorldSeed(seed)), core: BLWP };
    return 1;
  },

  // One tick. Inputs are Q16.16 in [-1, 1], the same units the core uses, so
  // no conversion happens at the boundary where a rounding rule could differ.
  // The front line at a world x, Q16.16 metres. The RENDERER asks; it does not
  // work the line out again. The core smooths the price tape before laying it
  // across the map and C# does not, so a second copy of the rule put the drawn
  // territory 22.04 m from the men on average and 49.14 m at worst.
  // Queues a liquidation for the next tick. Size in MILLIONS of USD, Q16.16.
  // The live Binance feed and the simulation clock are two callers of this one
  // function, which is what makes their strikes identical rather than merely
  // similar. Nothing is decided here; the core decides.
  ArenaLiquidation: function (size) {
    var b = Module.arenaCore;
    if (!b || !b.core.submitLiquidation) return 0;
    return b.core.submitLiquidation(b.st, size | 0) ? 1 : 0;
  },

  // WHAT WENT ON THE BED, handed over at roll-out - and it goes to the network
  // in the same breath, from here, for the reason `ArenaStep` publishes from
  // here.
  //
  // This was `ArenaSetHeat` and it carried the ANSWER: Unity worked the wanted
  // level out in floats and wrote it into the core, a host write in no batch,
  // no mark and no transcript. The page's core carried 57229 and every replay
  // of the same transcript carried 0 - so a committee, and every ghost a
  // committee draws, walked a run the war was hunting less hard than it hunted
  // the player. Measured on one drive: the two agree to tick 400 and are
  // 7.217 m apart by tick 900, growing.
  //
  // Sats aboard and hundredths of a BTC. The core decides what that costs;
  // nothing here does arithmetic on it, and there is no second copy to drift.
  // AND THE ROOM IT FILLS (2026-10-04 08:54: C is the bed fill): Unity hands the vsizes on the bed, the core's own
  // roomFor (cargo.js) sums them here, and that one integer goes to the core and on the wire with the load - so a replay
  // sets the same C. A core without roomFor (an older bundle) gets the load as before.
  ArenaSubmitLoad: function (feeSats, btcHundredths, vsizesPtr) {
    var b = Module.arenaCore;
    if (!b || !b.core.submitLoad) return 0;
    var room = arenaRoomOf(b.core, vsizesPtr ? UTF8ToString(vsizesPtr) : '');
    // ONE LOAD A TICK IN THE ROUND'S WORLD (ORDER-2116, measured 2026-10-02 08:00Z): a signer node keeps the first of a kind at
    // a tick, so a second one here - Unity's own beside the one handed over at the world's start - moved this core and not
    // the replay (DELIVERED here, FAILED at all 7, the same 1457 ticks). The second is dropped, here and on the wire.
    var net0 = Module.arenaNet;
    if (net0 && net0.inWorld && net0.client) {
      var at0 = net0.client.offered | 0; net0.lastAt = net0.lastAt || {};
      if (net0.lastAt.load === at0) return 0;
      net0.lastAt.load = at0;
    }
    var ok = (room === null ? b.core.submitLoad(b.st, feeSats | 0, btcHundredths | 0)
      : b.core.submitLoad(b.st, feeSats | 0, btcHundredths | 0, room)) ? 1 : 0;
    if (ok && Module.arenaNet) Module.arenaNet.load(feeSats | 0, btcHundredths | 0, room);
    return ok;
  },

  // THE C A BED OF THESE VSIZES WOULD SET, for the cargo panel before ROLL OUT: the core's fill of the summed room, 0..ONE.
  ArenaBedFill: function (vsizesPtr) {
    var b = Module.arenaCore;
    if (!b || !b.core.bedFill) return 0;
    var room = arenaRoomOf(b.core, vsizesPtr ? UTF8ToString(vsizesPtr) : '');
    // OF THIS RUN'S BED: the larger truck's, when its item is played, as the core counts the load it is handed
    return room === null ? 0 : b.core.bedFill(room, (b.st && b.st.truck) ? b.st.truck.bedLength : undefined) | 0;
  },

  // A LIVE PRICE SAMPLE (2026-09-17 16:01: the chart was frozen, nothing ever submitted one), in the tape's unit
  // (256 a dollar), handed to the core before the next tick - and to the network in the same breath, like a load, so
  // the signer nodes replay the tape the page fought on.
  ArenaSubmitSample: function (price) {
    var b = Module.arenaCore;
    if (!b || !b.core.submitSample) return 0;
    // ONE SAMPLE A TICK IN THE ROUND'S WORLD (ORDER-2116, measured 2026-10-02 08:00Z): a signer node keeps the first of a kind at
    // a tick, so a second one here - Unity's own beside the one handed over at the world's start - moved this core and not
    // the replay (DELIVERED here, FAILED at all 7, the same 1457 ticks). The second is dropped, here and on the wire.
    var net0 = Module.arenaNet;
    if (net0 && net0.inWorld && net0.client) {
      var at0 = net0.client.offered | 0; net0.lastAt = net0.lastAt || {};
      if (net0.lastAt.sample === at0) return 0;
      net0.lastAt.sample = at0;
    }
    var ok = b.core.submitSample(b.st, price | 0) ? 1 : 0;
    if (ok && Module.arenaNet) Module.arenaNet.sample(price | 0);
    return ok;
  },

  // THE LIVE TAPE (2026-09-17 16:44: reload showed the same seeded candles): 64 live prices, oldest first, in the
  // tape's unit, handed to the core before any sample - and to the network beside the tick, like a sample.
  ArenaSubmitTape: function (ptr, n) {
    var b = Module.arenaCore;
    if (!b || !b.core.submitTape || (n | 0) !== 64) return 0;
    // ONE TAPE A TICK IN THE ROUND'S WORLD (ORDER-2116, measured 2026-10-02 08:00Z): a signer node keeps the first of a kind at
    // a tick, so a second one here - Unity's own beside the one handed over at the world's start - moved this core and not
    // the replay (DELIVERED here, FAILED at all 7, the same 1457 ticks). The second is dropped, here and on the wire.
    var net0 = Module.arenaNet;
    if (net0 && net0.inWorld && net0.client) {
      var at0 = net0.client.offered | 0; net0.lastAt = net0.lastAt || {};
      if (net0.lastAt.tape === at0) return 0;
      net0.lastAt.tape = at0;
    }
    var prices = Array.prototype.slice.call(new Int32Array(Module.HEAP32.buffer, ptr, 64));
    var ok = b.core.submitTape(b.st, prices) ? 1 : 0;
    if (ok && Module.arenaNet && Module.arenaNet.tape) Module.arenaNet.tape(prices);
    return ok;
  },

  ArenaFrontlineZ: function (x) {
    var b = Module.arenaCore;
    if (!b || !b.core.frontAt) return 0;
    return b.core.frontAt(b.st, x | 0) | 0;
  },

  // The surface at a world point, Q16.16 metres: the uploaded relief LESS what
  // the craters have taken out of it. The renderer asks; it does not work the
  // hole out again.
  //
  // Unity's own terrain is the relief BEFORE the strike - it has never heard of
  // a crater - so a truck placed on `SampleSurface` hovered over its own hole by
  // the crater's full depth, up to 6.00 m. The core already answers this for its
  // own physics through one function; this is that same function, read out.
  ArenaSurfaceAt: function (x, z) {
    var b = Module.arenaCore;
    if (!b || !b.core.groundAt) return 0;
    return b.core.groundAt(b.st, x | 0, z | 0) | 0;
  },

  ArenaStep: function (throttle, steer, brake, handbrake, practice) {
    var b = Module.arenaCore;
    if (!b) return 0;
    b.core.step(b.st, throttle | 0, steer | 0, brake | 0, handbrake | 0, practice | 0);

    // AND THE SAME WORDS GO TO THE NETWORK, from here rather than from Unity.
    //
    // A transcript has to be the inputs the core actually stepped on. If Unity
    // kept its own copy to publish, there would be two records of one thing and
    // a bug in either would be invisible until a verifier replayed the round
    // and landed somewhere else. Taken here, they are the same five words by
    // construction - there is no second copy to drift.
    if (Module.arenaNet) Module.arenaNet.tick(
      [throttle | 0, steer | 0, brake | 0, handbrake | 0, practice | 0]);
    return 1;
  },

  // Copies the whole state into a buffer Unity owns and polls.
  //
  // The whole buffer, every frame, on purpose: it is a few kilobytes, and
  // copying selected fields is how the two sides start disagreeing about which
  // fields exist.
  ArenaReadState: function (ptr, wordCount) {
    var b = Module.arenaCore;
    if (!b) return 0;
    var src = b.st.i32;
    var n = Math.min(wordCount | 0, src.length);
    var dst = new Int32Array(Module.HEAP32.buffer, ptr, n);
    dst.set(src.subarray(0, n));
    return n;
  },

  // THE HUD'S CHART (WAR_TACTICS.md §0.3), in `range` (0 GROUND, 1 ROUND), as the core lays it out: candles, the seam,
  // the lead, YOU, the gate, the objectives and the assault. The painter reads these words and works none of them out.
  ArenaChartView: function (range, ptr, cap) {
    var b = Module.arenaCore;
    if (!b || !b.core.chartView || (cap | 0) < b.core.CH_WORDS) return 0;
    var out = new Int32Array(Module.HEAP32.buffer, ptr, b.core.CH_WORDS);
    return b.core.chartView(b.st, range | 0, out) | 0;
  },

  // Where a ground point (Q16.16 metres) sits on that chart: t, price, on the range. A ghost's place, by the same
  // mapping the truck's is.
  ArenaChartPoint: function (range, x, z, ptr) {
    var b = Module.arenaCore;
    if (!b || !b.core.chartPoint) return 0;
    var out = new Int32Array(Module.HEAP32.buffer, ptr, 3);
    return b.core.chartPoint(b.st, range | 0, x | 0, z | 0, out) | 0;
  },

  // THE CANDLES AS TERRAIN (WAR_TACTICS.md §4.15): each body's x and z span and plateau height, as the core stands the
  // truck and the tanks on them. CandleTerrain meshes these words and computes none of them.
  ArenaCandleView: function (ptr, cap) {
    var b = Module.arenaCore;
    if (!b || !b.core.candleView || (cap | 0) < b.core.CV_TOTAL) return 0;
    var out = new Int32Array(Module.HEAP32.buffer, ptr, b.core.CV_TOTAL);
    return b.core.candleView(b.st, out) | 0;
  },

  // The surface without the candle layer: what the terrain mesh draws under the candles' own mesh.
  ArenaTerrainAt: function (x, z) {
    var b = Module.arenaCore;
    if (!b) return 0;
    // A core without the candle layer (the Daily's signer-node core before §4.15) has no terrainAt: its ground IS the
    // surface without candles. Answering 0 there drew the whole map flat.
    var f = b.core.terrainAt || b.core.groundAt;
    return f ? f(b.st, x | 0, z | 0) | 0 : 0;
  },

  // The state hash, for a checkpoint. Written as ASCII into a caller-owned
  // buffer because returning a string from a jslib means allocating in the
  // Unity heap and freeing it on the C# side, which is a leak waiting to be
  // written.
  ArenaStateHash: function (ptr, cap) {
    var b = Module.arenaCore;
    if (!b) return 0;
    var hex = b.core.hash(b.st);
    var n = Math.min(hex.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = hex.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  ArenaRunScore: function () {
    var b = Module.arenaCore;
    return b ? (b.core.runScore(b.st) | 0) : 0;
  },

  // THE COLLISION BOXES THE CORE RESOLVES THE TRUCK AGAINST (2026-09-25 20:56/20:57: visible collisions), as
  // it holds them - st.solids, six words a box (cx, cz, hx, hz, yLow, yHigh) - copied, not rebuilt. Returns the
  // core's count; writes at most cap / 6 boxes.
  ArenaSolids: function (ptr, cap) {
    var b = Module.arenaCore;
    if (!b || !b.st || !b.st.solids) return 0;
    var s = b.st.solids;
    var n = Math.min(s.n | 0, Math.floor((cap | 0) / 6));
    new Int32Array(Module.HEAP32.buffer, ptr, n * 6).set(s.box.subarray(0, n * 6));
    return s.n | 0;
  },

  ArenaStateWords: function () {
    return (typeof BLWP === 'undefined') ? 0 : (BLWP.WORDS | 0);
  },

  // The relief the host is drawing, handed over once as round setup.
  //
  // Not recomputed inside the core: Unity's ground uses Mathf.PerlinNoise,
  // which has no seed and no specification, so a core generating its own would
  // feel hills the player cannot see.
  // ArenaSetGround IS GONE, and its absence is the rule.
  //
  // Unity used to upload `MempoolTerrain.HeightGrid` into the core and the core
  // felt those hills; every committee replaying the same drive stepped a flat
  // table, 33.500 m away after six hundred ticks. The relief comes from the
  // round's seed now (letter 36), so there is nothing for a page to send and
  // no way for one to put its player in a world nobody else can reproduce.

  // ArenaSetSolids IS GONE, for the reason ArenaSetGround went.
  //
  // Unity gathered every BoxCollider it had built at runtime and pushed them
  // in, re-pushing whenever the count changed - so the collision world the
  // core resolved against moved mid-run as models streamed - and no replay set
  // any, so a committee resolved every drive against nothing. One box on the
  // path is worth 40.233 m over six hundred ticks. The map's boxes come from
  // the core now (letter 39), which draws them from the map's own geometry and
  // the relief it generated.



  // Start a new round. A host command, and the ONLY way back to RUN_LIVE:
  // `outcome` latches, `init` runs once in Start, and `teleport` moves the
  // truck without touching a single score word - so round two used to be
  // round one's leftovers. The core carries the uploaded relief and solids
  // across itself; nothing here decides what a reset means.
  // WHICH WORLD THE CORE IS PUT IN, DECIDED IN ONE PLACE.
  //
  // Two callers seed it and NOTHING ORDERS THEM: `CoreDrivenTruck.Start` calls
  // `ArenaCore.Init(seed)` with its own constant, and this bridge calls
  // `core.init(seedWord)` when the join resolves. Whichever ran last won, and
  // both outcomes were photographed in one two-Chrome look - one tab drove the
  // round's world (bay 14, z 17.000 m) and the other drove the harness world
  // (bay 13, z 10.200 m) while every other page was shown it at bay 14. A
  // constant 6.800 m apart, one door's pitch, and it never closed because it
  // was not lag: it was two different worlds again.
  //
  // So the argument is a DEFAULT and the round is an answer. Once the bridge
  // knows the round's seed, that is the world, whoever asks and whenever.
  $arenaWorldSeed: function (seed) {
    var n = Module.arenaNet;
    return (n && typeof n.seedWord === 'number') ? (n.seedWord | 0) : (seed | 0);
  },

  // THE ROOM A BED TAKES, by the core's own rule: the sum of core.roomFor over the comma-separated vsizes, or null for a core
  // that has no roomFor (a load then crosses without a room, as before). An empty bed is 0.
  $arenaRoomOf: function (core, list) {
    if (!core || typeof core.roomFor !== 'function') return null;
    var room = 0;
    String(list || '').split(',').forEach(function (v) { if (v !== '') room = (room + (core.roomFor(v | 0) | 0)) | 0; });
    return room;
  },
  // THE UNLOCKS THE RUN PLAYS WITH: the page set them beside the entry it built (index.html ARENA_ITEM_UNLOCKS - the
  // entry's items as its game's catalogue unlocks them); none, and the core is started exactly as before
  $arenaWithItems: function (opts) {
    var u = (typeof window !== 'undefined' && Array.isArray(window.ARENA_ITEM_UNLOCKS)) ? window.ARENA_ITEM_UNLOCKS : [];
    if (u.length) opts.items = u.slice();
    return opts;
  },
  ArenaSubmitLoad__deps: ['$arenaRoomOf'],
  ArenaBedFill__deps: ['$arenaRoomOf'],
  ArenaInit__deps: ['$arenaWorldSeed'],
  ArenaRestart__deps: ['$arenaWorldSeed'],

  ArenaRestart: function (seed) {
    var b = Module.arenaCore;
    if (!b) return 0;
    b.st = b.core.restart(b.st, arenaWorldSeed(seed));
    return 1;
  },

  // HOW MANY TIMES THE PAGE ITSELF PUT THE CORE IN A NEW WORLD (the session start's init), which
  // C# does not see. Read-only; C# adds its own count of Init and Restart to it.
  // THE RUN LENGTH OF THE RUN IN PLAY (the 82/90 fork, 2026-10-01: the round's own, not a constant): the ticks the
  // core ends this run at - its round's blockTicks, or the core's default for a run with no round. 0 before any run.
  ArenaRunTicks: function () {
    var b = Module.arenaCore;
    return (b && b.st && typeof b.st.runTicks === 'number') ? (b.st.runTicks | 0) : 0;
  },

  // THE TRUCK THIS RUN DRIVES: its bed's length in Q16.16 when the run plays with an item that names one (the
  // larger truck, 255590 = 3.9 m), else 0 - the standard truck. Read off the core, which started the run with the entry's unlocks,
  // so what Unity draws is the truck the signer nodes replay.
  ArenaTruckBed: function () {
    var b = Module.arenaCore;
    return (b && b.st && b.st.truck && typeof b.st.truck.bedLength === 'number') ? (b.st.truck.bedLength | 0) : 0;
  },

  ArenaReliefEpoch: function () {
    var b = Module.arenaCore;
    return b ? (b.reliefEpoch | 0) : 0;
  },

  // Put the truck back. A host command: the round ended, or it was written
  // off, and it belongs in the bay.
  ArenaTeleport: function (x, z, heading) {
    var b = Module.arenaCore;
    if (!b) return 0;
    // NOT INTO A SIGNED RUN (PAID-NIGHT-2155, measured live): SpawnMark re-seats a held truck on Unity's own bay mark at
    // every terrain rebuild (bay 13, z 10.200), and the round's world puts it in its own bay (bay 14, z 17.000). A rebuild
    // after the round's world began and before the truck left the bay moved the core's truck 6.8 m in a write no
    // transcript carries: the page DELIVERED and all 7 signer nodes replayed FAILED on the same ticks (rounds 552cd565,
    // 10d734af, 235a6646 - sampled: at tick 21 the one differing word was the truck's z, 10.2 against 17.0). While this
    // session's run is live the core's truck moves only by its inputs; before the run and once it is over, as before.
    var n = Module.arenaNet;
    if (n && n.inWorld && n.client && !n.client.over) {
      console.log('[arena] teleport refused: a signed run is live - no transcript would carry it');
      return 0;
    }
    return b.core.teleport(b.st, x | 0, z | 0, heading | 0) ? 1 : 0;
  },

  // The hardest armour impact since this was last asked, in Q16.16 m/s.
  // Reading it clears it, so one crash is applied once.
  ArenaTakeImpact: function () {
    var b = Module.arenaCore;
    if (!b) return 0;
    var T = 5, T_IMPACT = 12;
    var v = b.st.i32[T + T_IMPACT] | 0;
    b.st.i32[T + T_IMPACT] = 0;
    return v;
  },

  // The same word, READ ONLY (2026-09-16). In a signed run the core is the signer nodes'
  // replay of the transcript and the page writes nothing into it; the clear above did, 35 times in
  // one measured run (0.0.1358), moving the state hash off the replay. No rule reads the word - the
  // core prices a crash from that tick's own impact - so Unity reads it and remembers what it felt.
  ArenaReadImpact: function () {
    var b = Module.arenaCore;
    if (!b) return 0;
    var T = 5, T_IMPACT = 12;
    return b.st.i32[T + T_IMPACT] | 0;
  },

  // A query parameter from the page's own URL, written into a caller-owned
  // buffer. Handing a build to somebody in the mode you meant them to see is
  // what a shared link is for, and it beats asking them to find a switch.
  // ------------------------------------------------------------- the network
  //
  // Unity starts a session and reads a status line. It never builds a message,
  // never signs one and never learns an outcome from one: the client in the
  // page does all of that, and the client computes nothing either - it carries
  // a hash the core produced. This is the whole of the game's reach into BLWP.
  //
  // Everything below is fire-and-forget with a status to poll, because a jslib
  // function returns an int and the client's work is asynchronous.
  ArenaNetStart: function (urlPtr, batchEvery, markEvery) {
    if (typeof ARENACLIENT === 'undefined') {
      console.error('[arena] client bundle not loaded - check the WebGL template');
      return 0;
    }
    var b = Module.arenaCore;
    if (!b) { console.error('[arena] no core, so nothing to commit to'); return 0; }
    // ONE SESSION AT A TIME, AND A NEW ONE ONCE THE LAST RUN HAS ENDED (2026-09-15 16:14,
    // hole 1): a second PLAY in the same tab starts a new round without a reload. A run still live
    // is still running; one whose last publish is still on its way (finishing) is not ready yet.
    if (Module.arenaNet) {
      var was = Module.arenaNet.client;
      // A DIFFERENT ROUND IS A DIFFERENT RUN, AND THE OLD ONE IS CLOSED HERE (2026-09-18 18:00).
      //
      // Measured in two browsers: pressing PLAY again joined the next round at the page's level - both tabs on one
      // round id, each with a client and a ghost field - while this guard kept the session of the round before,
      // because that client had never said it was over. It sat in "opening", net.where went on naming the first
      // round three and a half minutes later, and it kept publishing into a run that had already ended: 902 ticks of
      // it. Neither tab was in the second round at all, which is why neither was ever shown the other.
      //
      // So a join of ANOTHER round closes what was open, whatever word that client was on. A client still opening is
      // not a live run. What is NOT torn down is a session on the SAME round that is merely slow - a live round
      // keeps its trucks through a stall, which is the 0.0.1595 rule.
      var bound = Module.arenaNet.where && Module.arenaNet.where.roundId;
      var joined = null;
      try { joined = window.ARENA_ROUND ? ARENACLIENT.roundId(window.ARENA_ROUND) : null; } catch (e) { joined = null; }
      var elsewhere = !!(bound && joined && ARENACLIENT.toHex(bound) !== ARENACLIENT.toHex(joined));
      // AND A NEW JOIN IS A NEW RUN, on this round or another (2026-09-26 14:08, reproduced: a run that never rolled
      // out left its session open and not over; the next PLAY joined again, no session could open beside it, and that
      // run's card copied the session before's link). A session is its page join's (ARENA_ENTRY); another join replaces it.
      if (!elsewhere && typeof window !== 'undefined' && window.ARENA_ENTRY && Module.arenaNet.pageEntry
          && window.ARENA_ENTRY !== Module.arenaNet.pageEntry) {
        elsewhere = true;
        bound = bound || joined;
      }
      if (!elsewhere) {
        if (!was || !was.over) return 1;               // already running, on this same round
        // 2026-09-16: hang after DELIVERED wasted seconds waiting for
        // `ended` while the last publish drained. `over` is enough; finishing
        // can drain on the old client in the background.
      } else {
        console.log('[arena] another join: closing the session on '
          + (bound ? ARENACLIENT.toHex(bound).slice(0, 8) : '?') + ' before opening ' + (joined ? ARENACLIENT.toHex(joined).slice(0, 8) : '?'));
        try { if (was && was.close) was.close(); } catch (e) { /* already gone */ }
        try { Module.arenaNet.ghosts = null; } catch (e) { /* nothing held */ }
        Module.arenaNet.client = null;
      }
    }

    var base = UTF8ToString(urlPtr);
    // THE TICK CLOCK THIS BROWSER'S TABS SHARE, for the debug label over a ghost (2026-09-17 19:15): one per
    // page, kept across rounds.
    if (!Module.arenaTickClock && ARENACLIENT.tickClock) {
      try { Module.arenaTickClock = ARENACLIENT.tickClock({ Channel: typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null }); } catch (e) { Module.arenaTickClock = null; }
    }
    // THE RUN THAT ENDED, kept when it is this run's session that ended it (see ArenaRunStarts)
    var keepEndedRun = function (n) {
      var run = n && n.winningsRun ? n.winningsRun() : null;
      var mine = n === Module.arenaRunNet
        || (!Module.arenaRunNet && n === Module.arenaNet && n.openedAt >= (Module.arenaRolledOutAt || 0));
      if (run && mine) {
        Module.arenaEndedRun = run;
        if (typeof window !== 'undefined') window.ARENA_ENDED_RUN = { roundHex: run.roundHex, entryHex: run.entryHex, at: Date.now() };
      }
      return run;
    };
    var net = Module.arenaNet = {
      pageEntry: (typeof window !== 'undefined' && window.ARENA_ENTRY) || null,
      openedAt: Date.now(),
      // `state` here is ONLY the word before a client exists - opening, or
      // error if the session never got off the ground. Once there is a client
      // the session's word is `client.state`, in a file `node --test` can
      // load: the page used to keep its own, learned `ended` on the
      // socket-down path alone, and printed `ready` beside a run's ENDED VOID.
      state: 'opening', error: '', ticks: [], tick: null,
      batches: 0, marks: 0, batchEvery: batchEvery | 0, markEvery: markEvery | 0,
      seen: 0, client: null, where: null, resumedAt: -1,
      // ONE AT A TIME, and this is not tidiness - but the queue that enforced
      // it is not here any more. Both chains hang off state the client updates
      // when an answer comes back; two publishes in flight at once build the
      // second from state the first has not finished moving, so it names a
      // tick the node is not owed and is refused for a gap. Measured before
      // anything enforced it: 20 marks went through - about twenty seconds of
      // play, twelve hundred ticks - and 75 ticks of input reached the node.
      // `drain`, `markNow` and now `reconnect` each hold their own one-in-
      // flight in `@blwp/client`, where a test can watch them.
    };

    // THE SESSION KEY, made here and kept here.
    //
    // It is the browser's own Ed25519 through crypto.subtle, not a curve
    // vendored into the page: the key that signs a player's commitments should
    // not be handled by an implementation nobody audits. It is ephemeral and
    // lives exactly as long as the run, which is what the protocol asks of a
    // session key - the long-term entry key signs once, at the entry, and never
    // again per mark. Unity never sees it; it does not cross the bridge.
    var keys = null;
    var sign = function (msg) {
      return crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, msg)
        .then(function (sig) { return new Uint8Array(sig); });
    };

    // THE ONE OTHER THING THE SESSION KEY SIGNS (RULED 2026-09-23): the winner's Lightning address, its UTF-8 bytes and
    // nothing else - no score, no payout, no round id - and only a string that IS a Lightning address. The key does not
    // leave this closure; the page is handed this call, never `sign`.
    // THE SHAPE IS CHECKED HERE, NOT BORROWED: a name@host string and nothing else (the full Lightning-address check is
    // the page's `askForWinnings` before it asks, and every signer node's door after). Here only so the session key can
    // never be made to sign bytes that are not an address - a checkpoint id is not one.
    var ADDRESS_SHAPE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;
    var signAddress = function (address) {
      if (typeof address !== 'string' || !ADDRESS_SHAPE.test(address))
        return Promise.reject(new Error('that is not a Lightning address, so it is not signed'));
      if (!keys) return Promise.reject(new Error('this run has no session key'));
      return sign(new TextEncoder().encode(address));
    };
    // WHAT THE RUN-OVER HOOK IS HANDED: this run's round and entry, the page core's word and score, the round's
    // min_score and signer nodes, and the address call. The page asks once, only a qualifier (`askForWinnings`).
    net.winningsRun = function () {
      var b = Module.arenaCore;
      if (!b || !net.where || !net.contract) return null;
      return {
        roundHex: ARENACLIENT.toHex(net.where.roundId), entryHex: ARENACLIENT.toHex(net.where.entryId),
        word: b.st.i32[18 + 5] | 0, score: b.st.i32[18 + 4] | 0, minScore: Number(net.contract.minScore || 0),
        nodes: (typeof ARENA_NODES !== 'undefined' && ARENA_NODES) ? ARENA_NODES.slice() : [], signAddress: signAddress,
      };
    };

    // THE SESSION KEY KEPT ACROSS A RELOAD, PER ROUND, IN THE TAB'S SESSION STORAGE (2026-10-03, PAID-NIGHT-2155:
    // "Page. Keep the run's signing key across a reload, in the tab's session storage, so the re-sent entry is the same
    // entry"). Measured before (round 241f32fa): a reload while the page sent its entry left that entry at one seat with no
    // stake, signed FORFEIT there, and the reloaded page made another entry under a new key. The key is made once for the
    // round and its private half kept as PKCS#8 in this tab's sessionStorage only; a reload of the tab signs with it again.
    var sessionKeyFor = function () {
      var slot = null, store = null, kept = null;
      // arena.session.key.<round> since kanban #524; a key kept under the old blwp.session.key.<round> (a run across the update) is still read
      try { slot = (typeof ARENA_ROUND !== 'undefined' && ARENA_ROUND) ? 'arena.session.key.' + ARENACLIENT.toHex(ARENACLIENT.roundId(ARENA_ROUND)) : null; } catch (e) { slot = null; }
      try { store = window.sessionStorage; kept = slot ? JSON.parse(store.getItem(slot) || store.getItem(slot.replace(/^arena\./, 'blwp.')) || 'null') : null; } catch (e) { kept = null; }
      if (kept && kept.pkcs8 && kept.raw)
        return crypto.subtle.importKey('pkcs8', ARENACLIENT.fromHex(kept.pkcs8), { name: 'Ed25519' }, false, ['sign'])
          .then(function (privateKey) { console.log('[arena] the session key of this round kept from before the reload'); return { privateKey: privateKey, raw: ARENACLIENT.fromHex(kept.raw) }; });
      return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (pair) {
        return Promise.all([crypto.subtle.exportKey('pkcs8', pair.privateKey), crypto.subtle.exportKey('raw', pair.publicKey)])
          .then(function (x) {
            var raw = new Uint8Array(x[1]);
            try { if (slot && store) store.setItem(slot, JSON.stringify({ pkcs8: ARENACLIENT.toHex(new Uint8Array(x[0])), raw: ARENACLIENT.toHex(raw) })); } catch (e) { /* kept for this page only */ }
            return { privateKey: pair.privateKey, raw: raw };
          });
      });
    };
    sessionKeyFor()
      .then(function (k) {
        keys = { privateKey: k.privateKey };
        net.sessionPubkey = k.raw;
        return net.open(base, sign);
      })
      .catch(function (e) {
        // No client, so the page's own word is the only one there is.
        // CLOSED BEFORE IT IS LET GO (measured live 11:32:15Z): its socket - opened beside the entry - stayed
        // up, dropped ~2 min later, and its onDrop reached net.client.reconnect with net.client null; Unity alerted, the tab held
        try { if (net.client && net.client.close) net.client.close(); } catch (closeErr) { /* already gone */ }
        net.client = null;
        net.state = 'error';
        net.error = String(e && e.message ? e.message : e);
        console.error('[arena] session: ' + net.error);
        // AND ON SCREEN (pick a): a signer node that refuses the entry - "this round mints fee
        // locks: an entry that brings no fee lock is not joined" - is what the chip says,
        // not "stake dealt, unpaid" (measured: the reason reached only the console). The
        // page's own earlier refusal, when there is one, is kept.
        if (typeof window !== 'undefined' && !window.ARENA_JOIN_REFUSED) window.ARENA_JOIN_REFUSED = net.error;
        // AND BACK TO THE LOBBY (2026-09-26, the 21:13 case): a round link reopened after its round closed builds
        // its entry fine and is refused only here, by the node, so the page's join fallback never saw it and the cargo
        // chooser stood over a round nobody can play. The page takes the same fallback from this word.
        if (typeof window !== 'undefined' && typeof window.ARENA_ENTRY_REFUSED === 'function') window.ARENA_ENTRY_REFUSED(net.error);
      });

    // THE THREE THINGS A SESSION DOES, as closures rather than as helpers on
    // Module: a .jslib has no shared scope, and hanging them off Module would
    // make them reachable from the page, where nothing should be able to sign
    // on the player's behalf.
    net.open = function (base, signer) {
      var C = ARENACLIENT;
      // The round and the entry the page was told to play. Both contracts are
      // built HERE and their ids computed here, so the node is never asked what
      // this round is called.
      var contract = (typeof ARENA_ROUND !== 'undefined') ? ARENA_ROUND : null;
      var signerNode = (typeof ARENA_ENTRY !== 'undefined') ? ARENA_ENTRY : null;
      if (!contract || !signerNode) throw new Error('the page did not say which round to play');

      // THE ROUND THE PLAYER WAS GIVEN, off the address bar and not out of the
      // page's own script. Section 25.1 step 1 is "a link, QR, copied round_id"
      // - it comes from whoever invited the player, and it is the one thing in
      // this whole path that the page did not write. `Client.at` refuses unless
      // ARENA_ROUND hashes to it, which is what stops a page naming its own
      // nodes as the committee and then satisfying its own choice.
      var given = null;
      try {
        // THE ROUND THE JOIN READ FROM THE PLAYER'S LINK (index.html ARENA_GIVEN_ROUND), not the address now: a run's end
        // puts the lobby's address back, and a chained join's round= was gone by its session open (2026-10-03 13:33Z)
        var q = (typeof window.ARENA_GIVEN_ROUND === 'string' && /^[0-9a-f]{64}$/.test(window.ARENA_GIVEN_ROUND))
          ? window.ARENA_GIVEN_ROUND : new URLSearchParams(window.location.search).get('round');
        if (q) given = ARENACLIENT.fromHex(q);
      } catch (e) { given = null; }
      var entry = Object.assign({}, signerNode, {
        roundId: C.roundId(contract), sessionPubkey: net.sessionPubkey,
      });
      net.where = { roundId: C.roundId(contract), entryId: C.entryId(entry) };
      net.contract = contract;
      var verify = function (sig, msg, key) {
        // NODE SIGNATURES ARE SCHNORR under the bond key (letter 26). The
        // session key below is still Ed25519. Mixing them was the 09:33 fault:
        // A/B http ok, play refused the advert as unsigned.
        if (typeof ARENA_CURVE === 'undefined' || typeof ARENA_CURVE.verify !== 'function')
          return Promise.resolve(false);
        return Promise.resolve(ARENA_CURVE.verify(sig, msg, key));
      };

      // THE WORLD THIS RUN IS JUDGED IN, BEFORE ONE TICK IS RECORDED.
      //
      // `init(seedWord)` decides which of the 24 loading bays this player
      // parks at and the whole rng stream after it, and the committee replays
      // this entry with `seedWordForEntry(entry, randomness)`. Nothing set
      // that: `CoreDrivenTruck.seed` is the constant 0x5eed1234 and always
      // was, so every player of every round drove the harness world while
      // their transcript was replayed somewhere else. Measured on a real
      // 2-of-2 round - the page's truck at z 10.20 m, the committee's copy of
      // the same truck at 57.80 m and 44.20 m, before either of them moved -
      // and photographed at 17:05 as a ghost on the grass while the truck it
      // pictured stood on its bay.
      //
      // AT THE START OF RECORDING, AND NOT AT ROLL-OUT. Every `ArenaStep` is
      // published from the moment `setRound` names the run, loading in the bay
      // included, so a core put in the right world at roll-out would already
      // have published thousands of ticks of the wrong one. The seed is only
      // LEARNED here; the core enters its world in `net.opened`, in the same
      // step as `setRound`, so no step falls between the two.
      //
      // A ROUND WHOSE NODES NAME TWO WORLDS IS NOT ONE ROUND, and
      // `worldSeedFor` refuses it rather than picking one.
      var nodes = (typeof ARENA_NODES !== 'undefined') ? ARENA_NODES : null;
      if (!nodes || !nodes.length)
        throw new Error('the page did not say which nodes hold this round');

      // THE DOOR. `base` above is only what the gate answered so that C# would
      // ask for a session at all; the address the client actually talks to is
      // resolved again HERE, against this round's own committee and with the
      // advertisement's signature verified, and nothing is sent until it is.
      // Section 25.1 step 3 is computed from the contract and step 4 has to
      // reach those nodes: a bonded stranger with a real proof would otherwise
      // be handed the entry and the whole section 11 transcript, and the first
      // receipt refusing it is a round trip too late to take any of it back.
      // AND THE ROUND'S CONTRACT: its config hash chooses the world rule - one world per round, or per player
      return C.worldSeedFor({
        entry: entry, round: net.where.roundId, nodes: nodes, contract: net.contract,
      }).then(function (world) {
        net.seedWord = world.seedWord | 0;
        net.randomness = world.randomness;
        // THE CORE IS NOT RESTARTED HERE ANY MORE - it enters this world in
        // the same step that starts recording, in `net.opened`. Restarted
        // here, every tick Unity stepped during the four round trips below
        // (Client.at, openRound, join, connect) was simulated and never
        // published: 16, 16, 16 and 24 of them on a tab with 400 ms of
        // latency, measured in two real Chromes on 2026-09-10.
        console.log('[arena] world seed 0x' + (net.seedWord >>> 0).toString(16)
          + ' from ' + world.agreed + ' node(s) agreeing on the round randomness');
        return C.Client.at(arenaDiscovery(), {
          core: { hash: function (st) { return b.core.hash(st); } },
          sign: signer, verify: verify, contract: contract, roundIdGiven: given,
        });
      }).then(function (client) {
        net.client = client;
        return net.opened(contract, entry);
      });
    };

    net.opened = function (contract, entry) {
      var C = ARENACLIENT;

      // THE RECONNECT LIVES IN THE CLIENT NOW, for the same reason the hold
      // and the drain moved there: this file is the one place the JS suites
      // cannot reach, and the rule that decides whether a dropped player keeps
      // their run had no test at all. `client.reconnect()` is one in flight
      // whatever the drop rate, keeps trying with a backoff so a two-second
      // node restart does not end a session, and STOPS once the run has ended
      // - a VOID run must not come back as `ready`.
      // THE RUN ENDING IS ITS OWN EVENT, and it fires on the path the fault
      // took. `endRun` closes the socket, and the close listener returns at
      // its first line once the run is over - so a VOID with the socket still
      // up (a slow node filling the hold) reached nothing here. It does now,
      // before that early return, and the word and the reason are the
      // client's: this prints them and picks neither.
      net.client.onEnd = function (word, why) {
        console.log('[arena] run ended ' + word + ': ' + why);
        var ended = keepEndedRun(net);
        if (typeof window !== 'undefined' && window.ARENA_RUN_OVER) window.ARENA_RUN_OVER(word, ended);
      };
      // ONLY FOR ITS OWN CLIENT: a client let go of - refused, or replaced by another join - is never reconnected
      var client = net.client;
      net.client.onDrop = function () {
        if (net.client !== client) return;
        client.reconnect(net.where).then(function (r) {
          if (!r) return;              // the run ended; onEnd has already said so
          net.resumedAt = r.nextTick;
          console.log('[arena] resumed at tick ' + r.nextTick + ' after '
            + client.tries + ' try(s), ' + r.batches + ' batches and '
            + r.receipts + ' behind us');
        });
      };

      // THE SOCKET OPENS BESIDE THE ROUND AND THE ENTRY, not after them (JOIN-TIME, 2026-10-02: "Join click to the
      // round actually loaded: 2 to 3 seconds at most"): it depends on neither, and opened last it added its whole
      // handshake - measured 1.3 s - after POST /round and POST /entry. Tried until it opens, up to the round's start
      // + 10 s (client.connectFirst).
      var start0 = contract && contract.startTimeMs !== undefined ? Number(contract.startTimeMs) : NaN;
      var socketOpen = net.client.connectFirst({ untilMs: isFinite(start0) ? Math.max(start0 + 10000, Date.now() + 30000) : Date.now() + 30000 });
      socketOpen.catch(function () { /* answered below, where the session waits for it */ });
      return net.client.openRound(contract)
        .then(function () { return net.client.join(entry); })
        .then(function () { return socketOpen; })
        // A JOIN HELD TO THE ROUND'S START ENTERS ITS WORLD AT THAT START, NOT BEFORE (ORDER-2116, measured on testnet4
        // 2026-10-02 00:00Z): the session opens at entry - the round opened, the entry posted before entry closes, the
        // socket up - but the core went into the round's world and recording began right then, 12 min early. A slow page
        // jumped ticks to keep up and the first mark at tick 992 was past the 900-tick start deadline: FORFEIT at every
        // signer node. Held off the session itself instead, the entry reached no node before entry closed (measured at
        // 00:30Z). So the session opens, and only this step waits for the page to release the join (index.html `release`).
        .then(function () {
          return new Promise(function (go) {
            (function wait() {
              var j = (typeof window !== 'undefined') ? window.ARENA_JOIN : null;
              if (j && j.held && !j.cancelled) setTimeout(wait, 100); else go();
            })();
          });
        })
        .then(function () {
          // A RUN THAT STARTED BEFORE THIS TAB WAS RELOADED IS TAKEN BACK, NOT BEGUN AGAIN (2026-10-03: "a reload
          // after the round has started ... That run must not be lost"). The page kept the entry and the session key and
          // named it (index.html ARENA_RESUME); the seats hold its inputs and marks. The client resumes from them (nothing
          // recorded meanwhile), the core enters the same world and is stepped through the transcript as a seat replays
          // it, and the run goes on from the tick the seats are owed, its next mark after the one five carried.
          var R = (typeof window !== 'undefined') ? window.ARENA_RESUME : null;
          if (R && R.entryIdHex === ARENACLIENT.toHex(net.where.entryId)) {
            net.resuming = true;
            return net.client.resumeAfterReload({ roundId: net.where.roundId, entryId: net.where.entryId, blockTicks: contract.blockTicks | 0 })
              .then(function (r) {
                b.st = b.core.init(net.seedWord, arenaWithItems((net.contract && typeof net.contract.blockTicks === 'number')
                  ? { runTicks: net.contract.blockTicks } : {}));
                b.reliefEpoch = (b.reliefEpoch | 0) + 1;
                net.seen = ARENACLIENT.catchUpCore(b.core, b.st, r.transcript);
                // what Unity handed over before this is the lobby's market: the run's own tape, load and samples are in
                // the transcript, at their ticks
                net.queued = [];
                net.inWorld = true;
                net.resumedAt = net.seen;
                net.resuming = false;
                R.caughtUp = true; R.tick = net.seen;
                console.log('[arena] resumed at tick ' + net.seen + ' after the reload: ' + r.batches + ' batches, mark head '
                  + (r.live ? 'carried by ' + r.witnessed : 'none') + ', ' + r.receipts + ' receipts');
                try { net.ghosts = ARENACLIENT.watchGhosts(net.client, net.where); }
                catch (e) { console.error('[arena] ghosts unavailable: ' + (e && e.message)); net.ghosts = null; }
              }, function (e) { net.resuming = false; throw e; });
          }
          // THE HOLD, THE DRAIN AND THE SKIPPING ALL LIVE IN THE CLIENT.
          //
          // They used to be here, in a promise chain this file appended to on
          // every sixth tick whether or not the one before had finished - a
          // queue nobody bounded, in the one place that cannot be tested.
          // Moved into `@blwp/client` they are measured against a real node by
          // `backpressure.test.js`, and the page and the tests run one set of
          // rules instead of two that look alike.
          //
          // THE CORE ENTERS THE ROUND'S WORLD IN THE SAME STEP THAT STARTS
          // RECORDING, so its tick 0 is the transcript's tick 0 however long
          // the join took. Three statements with no await between them: no
          // `ArenaStep` can land between the reset and `setRound`. `net.seen`
          // counts from here too, because a checkpoint is labelled with it and
          // hashes the core as it stands.
          // AT THE ROUND'S OWN RUN LENGTH (the 82/90 fork): its contract's blockTicks, as the signer nodes replay it.
          // A LATE ENTRY'S RUN ENDS WITH THE ROUND'S: the round's run less the ticks before its join tick, and
          // its ticks are counted from that join tick - the HUD's time left is then the round's, and the last tick everybody's.
          var joinTick = (entry && typeof entry.joinTick === 'number' && entry.joinTick > 0) ? (entry.joinTick | 0) : 0;
          b.st = b.core.init(net.seedWord, arenaWithItems((net.contract && typeof net.contract.blockTicks === 'number')
            ? { runTicks: ARENACLIENT.runTicksForEntry(joinTick, net.contract.blockTicks) } : {}));
          // A NEW WORLD IS A NEW RELIEF: the seed names the hills. Counted here, where C# never
          // hears about it, so the drawn terrain knows to rebuild (ArenaCore.ReliefEpoch).
          b.reliefEpoch = (b.reliefEpoch | 0) + 1;
          net.seen = joinTick;
          net.client.setRound({
            roundId: net.where.roundId, entryId: net.where.entryId,
            blockTicks: contract.blockTicks | 0,
          });
          // WHAT UNITY HANDED OVER BEFORE THIS WORLD, now into it and onto the wire together - THE LATEST OF EACH KIND ONLY:
          // a signer node keeps one sample, one tape and one load per tick (its store's key), so ninety samples queued in
          // the hold and all handed over at tick 0 were one sample there and ninety here - DELIVERED on the page, FAILED at
          // all 7 (measured 04:33Z). What came before the latest is the lobby's market, not the round's.
          net.inWorld = true;
          var latest = {};
          (net.queued || []).forEach(function (q) { latest[q[0]] = q; });
          ['tape', 'load', 'sample'].map(function (k) { return latest[k]; }).filter(Boolean).forEach(function (q) {
            if (q[0] === 'tape') { b.core.submitTape(b.st, q[1]); net.client.submitTape(q[1]); }
            else if (q[0] === 'load') {
              if (q[3] === null || q[3] === undefined) { b.core.submitLoad(b.st, q[1], q[2]); net.client.submitLoad(q[1], q[2]); }
              else { b.core.submitLoad(b.st, q[1], q[2], q[3]); net.client.submitLoad(q[1], q[2], q[3]); }
            }
            else if (q[0] === 'sample') { b.core.submitSample(b.st, q[1]); net.client.submitSample(q[1]); }
            (net.lastAt = net.lastAt || {})[q[0]] = net.client.offered | 0;
          });
          net.queued = [];

          // AND ASK TO BE SHOWN THE OTHER TRUCKS.
          //
          // The rule for what is kept is not here: `watchGhosts` is in
          // `@blwp/client`, where `node --test` can measure it, for the same
          // reason the hold and the drain moved there. This file only says
          // WHEN to ask - once the round and the entry are known - and holds
          // the field the renderer drains.
          //
          // A ghost is a picture (0.10). Nothing from it ever reaches
          // `Module.arenaCore`: the core is driven by this player's own inputs and
          // by nothing else.
          try {
            net.ghosts = ARENACLIENT.watchGhosts(net.client, net.where);
          } catch (e) {
            // A page that cannot be shown the others still plays its own run.
            console.error('[arena] ghosts unavailable: ' + (e && e.message));
            net.ghosts = null;
          }
        });
    };

    // THE LOAD, ON ITS WAY TO THE TRANSCRIPT. The client holds it against the
    // tick the run has reached and publishes it with the batch that covers
    // that tick; nothing is decided here.
    // AND NOT BEFORE THE CORE IS IN THE ROUND'S WORLD (ORDER-2116, measured on testnet4 2026-10-02 02:39Z): Unity hands a
    // load, a sample or the round's tape to the core and to this session together. While the session waits for the round's
    // start the core is still the lobby's, so the core's copy was thrown away when it entered the round's world and the
    // client's went out: every signer node replayed a war the page never ran - DELIVERED on the page, FAILED at all 7.
    // Kept here until then, and handed to the round's core and to the client together (`net.opened`).
    var heldUntilWorld = function (kind, a, b2, c3) {
      if (net.inWorld) return false;
      (net.queued = net.queued || []).push([kind, a, b2, c3]);
      return true;
    };
    net.load = function (feeSats, btcHundredths, room) {
      if (!net.client) return;
      if (heldUntilWorld('load', feeSats, btcHundredths, room)) return;
      if (room === null || room === undefined) net.client.submitLoad(feeSats, btcHundredths);
      else net.client.submitLoad(feeSats, btcHundredths, room);
    };

    net.sample = function (price) {
      if (!net.client) return;
      if (heldUntilWorld('sample', price)) return;
      net.client.submitSample(price);
    };

    net.tape = function (prices) {
      if (!net.client) return;
      if (heldUntilWorld('tape', prices)) return;
      net.client.submitTape(prices);
    };

    net.tick = function (words) {
      if (!net.client) return;
      // A RUN BEING TAKEN BACK AFTER A RELOAD records, counts and marks nothing until its core has caught up (net.opened)
      if (net.resuming) return;
      // THE RUN IS OVER ONCE THE CORE SAID SO: the game may keep stepping, none of it is the run.
      if (net.finishing) return;
      // PAST THE RUN'S LAST TICK THE GAME'S TICKS ARE NOT INPUTS. The game keeps
      // stepping after a run ends; recorded, they went out in a batch every signer node
      // refused whole, and the run ended VOID (measured live: an idle page to
      // tick 9113 of a run ending at 8999). Counted, not recorded or marked. What
      // is still HELD is drained as before, every sixth tick: all of it is at or
      // before the last tick, and a drain that found a publish in flight at the
      // last tick would otherwise leave the end of the run unsent.
      if (net.client.runOver()) {
        net.pastEnd = (net.pastEnd | 0) + 1;
        if (net.client.state === 'ready' && net.batchEvery > 0 && net.client.held > 0
            && net.pastEnd % net.batchEvery === 0) net.client.drain();
        return;
      }
      net.client.record(words);
      net.seen++;
      // HOW FAR BEHIND THE OTHER TRUCKS ARE, measured on the page (2026-09-17 17:12: "the ghost must be realtime"):
      // every 300 ticks, this run's own round tick against the newest picture of another truck - the same round clock.
      if (net.ghosts && net.seen % 300 === 0) {
        var pose = ARENACLIENT.newestPose(net.ghosts), own = net.client.offered | 0;
        // AND THE AGE THE PLAYER IS SHOWN, BESIDE THE LAG ON THE WIRE (2026-09-17 19:15: the truck reads
        // 300-600 ms while the wire says ~100). The label's own number, computed the way the overlay computes it, so
        // the two can be read against each other from one console. Nothing on screen changes.
        var shown = ARENACLIENT.ghostLabels ? ARENACLIENT.ghostLabels(net.ghosts, { clock: Module.arenaTickClock }) : [];
        var oldest = shown.reduce(function (a, l) { return a === null || l.ageMs > a.ageMs ? l : a; }, null);
        console.log('[ghost] own tick ' + own + ' newest other picture tick ' + (pose ? pose.tick : '-')
          + (pose ? ' behind ' + (own - pose.tick) + ' ticks' : '')
          + (oldest ? ' overlay age ' + (oldest.estimated ? '~' : '') + oldest.ageMs + ' ms' : '')
          + ' others ' + net.ghosts.others
          + ' collapsed ' + (net.ghosts.collapsed | 0) + ' silenced ' + (net.ghosts.silenced | 0) + ' drawn ' + (net.ghosts.drawn | 0));
      }
      // THE CORE SAID DELIVERED, SO THE RUN ENDS HERE (2026-09-15 16:14). Measured before:
      // every truck that drove into the mouth was DELIVERED in the core and signed so, and its page
      // recorded 10-89 s more, the truck parked at the tunnel's back wall. The word is the core's own
      // (O_SCORE 18 + S_STATE 5, RUN_DELIVERED 1), read, not worked out: this tick is already
      // recorded, `finish` sends what is held and the last checkpoint at this tick, then nothing.
      // The word goes to the client, which acts only for a run it has been told it is playing - the
      // hash is taken only when the word is DELIVERED, so no tick pays for it otherwise.
      // DELIVERED 1, WRECKED 2, MISSED 3 all latch; 0 is a live run and costs no hash.
      var word = b.st.i32[18 + 5] | 0;
      var done = word !== 0 ? net.client.coreWord({ state: word, stateHash: b.core.hash(b.st), tick: net.seen }) : null;
      if (done) {
        net.finishing = done;
        // AND THE PAGE LETS GO OF THE ROUND (hole 2): the address is the lobby's again.
        var endedRun = keepEndedRun(net);
        if (typeof window !== 'undefined' && window.ARENA_RUN_OVER) window.ARENA_RUN_OVER(net.client.endingLine(), endedRun);
        return;
      }
      if (net.client.state !== 'ready') return;
      if (net.batchEvery > 0 && net.seen % net.batchEvery === 0) {
        // WHEN THIS TICK WAS DRIVEN, told to the other tabs: the newest recorded tick and now.
        if (Module.arenaTickClock && net.where) {
          if (!net.entryHex) net.entryHex = ARENACLIENT.toHex(net.where.entryId);
          Module.arenaTickClock.post(net.entryHex, net.client.offered - 1);
        }
        net.client.drain();
      }
      // The hash is taken HERE, at the tick the mark names - a checkpoint says
      // where the world was at that tick, and hashing it when a queue got
      // round to it would commit to a different world.
      if (net.markEvery > 0 && net.seen % net.markEvery === 0)
        net.client.markNow(b.core.hash(b.st), net.seen);
    };
    return 1;
  },

  // ONE PICTURE ACROSS THE BRIDGE, and this is the only ghost channel there
  // is. The rule for WHAT is kept lives in `@blwp/client` where `node --test`
  // can measure it (`watchGhosts`); this hands the oldest kept picture to C#
  // and nothing else. A second channel here would be a rule with no test.
  //
  // Twelve ints: the entry id as eight words, then x, z, heading and the tick
  // those three were taken at. Returns how many were written, 0 when the page
  // is holding nothing.
  ArenaNextGhost: function (ptr, cap) {
    var net = Module.arenaNet;
    var field = net && net.ghosts;
    if (!field || cap < 12) return 0;
    // A NEW WATCH (the next round, a new PLAY) CLEARS EVERY GHOST FIRST (2026-09-17 17:12: "after the next round
    // suddenly 3 ghosts, no updates"): the field of the last round is gone, and nothing in the new one could retire its
    // trucks. One record, entry all zero and tick -2, before the new field's first picture.
    if (Module.arenaGhostFieldShown !== field) {
      Module.arenaGhostFieldShown = field;
      for (var z = 0; z < 11; z++) HEAP32[(ptr >> 2) + z] = 0;
      HEAP32[(ptr >> 2) + 11] = -2;
      return 12;
    }
    var got = field.drain(1);
    if (!got.length) return 0;
    var g = got[0];
    var out = ptr >> 2;
    for (var i = 0; i < 8; i++) {
      var b = i * 4;
      HEAP32[out + i] = (g.entryId[b] << 24) | (g.entryId[b + 1] << 16)
        | (g.entryId[b + 2] << 8) | g.entryId[b + 3];
    }
    HEAP32[out + 8] = g.x | 0;
    HEAP32[out + 9] = g.z | 0;
    HEAP32[out + 10] = g.heading | 0;
    HEAP32[out + 11] = g.tick | 0;
    return 12;
  },

  // THE DEBUG LABEL OVER EACH GHOST (2026-09-17 19:15): one line a truck, `entry TAB name TAB age+arrows`,
  // written as UTF-8 (the arrows are not ASCII). The rule is `ghostLabels` in @blwp/client; the names are the ones the
  // page checked off the nodes. Returns the bytes written, 0 for none.
  ArenaGhostLabels: function (ptr, cap) {
    var net = Module.arenaNet;
    if (!net || !net.ghosts || !ARENACLIENT.ghostLabels) return 0;
    var names = (typeof window !== 'undefined' && window.ARENA_NAMES_BY_PLAYER) || {};
    var text = ARENACLIENT.ghostLabelText(ARENACLIENT.ghostLabels(net.ghosts, {
      nameOf: function (player) { return names[player] || null; }, clock: Module.arenaTickClock }));
    // AND THE SAME STRING IS LEFT WHERE A HEADLESS CLIENT CAN READ IT (2026-09-18 09:00, the two-tab gate).
    // C# draws these two lines over each truck through OnGUI, and no browser automation can read a GUI back. This is
    // the very text the renderer is handed - not a second copy built from something else a moment later.
    Module.arenaGhostLabelText = text || '';
    if (!text) return 0;
    return stringToUTF8(text, ptr, cap | 0);
  },

  // The status line, as ASCII, for the debug panel. A status nobody can read is
  // a status nobody checks.
  // COPY GAME REPLAY (2026-09-25 18:39): this run's round and entry, and the nodes it was played on, handed to
  // the page's own copy (window.ARENA_COPY_REPLAY builds the https link and writes it to the clipboard).
  // 1 once the page's clipboard write of this press's link has resolved (ARENA_REPLAY_COPIED is that link), else 0: the
  // card's "copied!" is the clipboard's answer, not the press (2026-09-26 07:12).
  // THE CARGO PANEL IS OPEN (2026-09-26 14:02): the page's node strip is hidden at once and stays hidden
  // (paintPlayers reads ARENA_LOADOUT_OPEN) until the panel closes.
  // A RUN RESUMED AFTER A RELOAD HAS CAUGHT UP (2026-10-03, the mid-run reload playthrough: the player saw the cargo
  // panel over the resumed run and could not drive - the run ended MISSED): 1 while ARENA_RESUME says the core stands at the
  // tick the seats hold, else 0. LoadoutPanel then closes and hands the truck back; the run's load is already in its record.
  // MS UNTIL THE JOINED ROUND STARTS, or -1 (playtest 2026-10-04 13:32: two phones in one paid round showed
  // clocks ~15 s apart - measured, before the start the HUD counted the lobby's practice run from each page's load). The
  // round's own start, from its contract, against this device's clock: the same on every device.
  ArenaRoundStartsInMs: function () {
    try {
      var r = (typeof window !== 'undefined') ? window.ARENA_ROUND : null;
      if (!r || r.startTimeMs === undefined) return -1;
      var ms = Number(r.startTimeMs) - Date.now();
      return ms > 0 ? Math.min(ms, 2147483647) : -1;
    } catch (e) { return -1; }
  },

  ArenaResumedRun: function () {
    if (typeof window === 'undefined') return 0;
    return window.ARENA_RESUME && window.ARENA_RESUME.caughtUp ? 1 : 0;
  },
  // THE BED OF THIS ROUND'S RUN, KEPT ACROSS A RELOAD (2026-10-03, the redone reload playthrough: the resumed truck
  // drove with an empty bed, "CARGO empty"). The core holds the load as two numbers; the parcels are Unity's, so ROLL OUT
  // keeps them here per round, beside the round's session key, and a resumed run puts them back on the bed.
  // THE RESULT SUMMARY THE PAGE READ (2026-10-04): the round's /api/round-result as index.html projected it
  // (window.ARENA_RESULT.text, ASCII JSON), or 0 bytes before the first answer. Unity draws it on the end card.
  ArenaResultSummary: function (outPtr, cap) {
    var v = (typeof window !== 'undefined' && window.ARENA_RESULT && window.ARENA_RESULT.text) || '';
    if (!v || v.length >= (cap | 0)) { Module.HEAPU8[outPtr] = 0; return 0; }
    for (var i = 0; i < v.length; i++) Module.HEAPU8[outPtr + i] = v.charCodeAt(i) & 255;
    Module.HEAPU8[outPtr + v.length] = 0;
    return v.length;
  },
  ArenaKeepCargo: function (textPtr) {
    var slot = null;
    try { slot = (typeof ARENA_ROUND !== 'undefined' && ARENA_ROUND) ? 'arena.cargo.' + ARENACLIENT.toHex(ARENACLIENT.roundId(ARENA_ROUND)) : null; } catch (e) { slot = null; }
    try { if (slot) window.sessionStorage.setItem(slot, UTF8ToString(textPtr)); } catch (e) { slot = null; }
    return slot ? 1 : 0;
  },
  ArenaKeptCargo: function (outPtr, cap) {
    var v = null;
    // arena.cargo.<round> since kanban #524; cargo kept under the old blwp.cargo.<round> (a run across the update) is still read
    try { if (typeof ARENA_ROUND !== 'undefined' && ARENA_ROUND) { var id = ARENACLIENT.toHex(ARENACLIENT.roundId(ARENA_ROUND)); v = window.sessionStorage.getItem('arena.cargo.' + id) || window.sessionStorage.getItem('blwp.cargo.' + id); } } catch (e) { v = null; }
    if (!v || v.length >= (cap | 0)) { Module.HEAPU8[outPtr] = 0; return 0; }
    for (var i = 0; i < v.length; i++) Module.HEAPU8[outPtr + i] = v.charCodeAt(i) & 255;
    Module.HEAPU8[outPtr + v.length] = 0;
    return v.length;
  },
  ArenaLoadoutOpen: function (open) {
    if (typeof window === 'undefined') return;
    window.ARENA_LOADOUT_OPEN = open !== 0;
    var el = document.getElementById('arena-players');
    if (el && open !== 0) el.style.display = 'none';
  },

  ArenaReplayCopied: function () {
    if (typeof window === 'undefined') return 0;
    var c = window.ARENA_REPLAY_COPIED;
    return (typeof c === 'string' && c.length > 0 && c === window.ARENA_REPLAY_URL) ? 1 : 0;
  },

  // WHETHER THE SESSION ON HAND IS THE CURRENT JOIN'S (2026-09-26 14:08): 1 or 0. A session opened for an earlier
  // page join names the run before - its link is not this card's. (The page's join is the run: one ARENA_ENTRY each.)
  // THE RUN THAT JUST ENDED, AND ONLY IT (2026-09-27 13:19: "It copies the run that just ended, not the one
  // before"; round 5b4bae6c entry 6b0a7e8b, a MISSED run, was copied under another run's card). The copy used to ask
  // the session on hand at the click - `winningsRun()` of whatever `Module.arenaNet` was - and guarded it with
  // window.ARENA_ENTRY, which a run with no fresh entry does not set: an earlier join's session then answered. Now the
  // run is taken at the moment it ends, from the session that ROLL OUT found for it (`ArenaRunStarts`), and kept; the
  // button and the copy read that and nothing else. No such run - nothing to copy, and no button.
  ArenaRunStarts: function () {
    var net = Module.arenaNet;
    Module.arenaRolledOutAt = Date.now();
    Module.arenaRunNet = (net && !(net.client && net.client.ended)) ? net : null;
    Module.arenaEndedRun = null;
    if (typeof window !== 'undefined') window.ARENA_ENDED_RUN = null;
  },

  ArenaReplayForThisRun: function () {
    return Module.arenaEndedRun ? 1 : 0;
  },

  ArenaCopyReplay: function () {
    var run = Module.arenaEndedRun;
    if (!run || typeof window === 'undefined' || typeof window.ARENA_COPY_REPLAY !== 'function') return 0;
    try { window.ARENA_COPY_REPLAY(run.roundHex, run.entryHex, run.nodes); } catch (e) { console.error('[arena] copy game replay: ' + e); return 0; }
    return 1;
  },

  ArenaNetStatus: function (ptr, cap) {
    var net = Module.arenaNet;
    var c = net && net.client;
    // ONE WORD, and it is the client's whenever there is a client. Assembling
    // it here is how `ready` came to be printed beside a run's own ENDED VOID.
    var line = !net ? 'off'
      : c ? c.status(net.seen) + (net.error ? ' (' + net.error + ')' : '')
          : net.state + (net.error ? ' (' + net.error + ')' : '');
    var n = Math.min(line.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = line.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  // THE PAGE'S BYTES, TURNED INTO A CLAIM. Read in one place so the two doors
  // that need it - the gate below and the session itself - cannot drift apart
  // and check different things.
  //
  // Hashes are taken in the order an API PRINTS them, reversed from the order
  // Bitcoin hashes them in, because that is what a page author will copy. The
  // reversal happens here, once, and nowhere else. The committee comes off the
  // round the page named, not off the advertisement: section 25.1 step 3 is
  // computed from the contract, and step 4 has to reach THOSE nodes.
  // Declared on both users because Emscripten includes a `$`-prefixed library
  // helper only when a dependency asks for it; without these the call would be
  // eliminated from the build and fail in the page rather than here.
  ArenaNetNodeUrl__deps: ['$arenaDiscovery'],
  ArenaNetStart__deps: ['$arenaDiscovery', '$arenaWithItems'],
  $arenaDiscovery: function () {
    var d = (typeof ARENA_ADVERT !== 'undefined') ? ARENA_ADVERT : null;
    var c = (typeof ARENA_CHAIN !== 'undefined') ? ARENA_CHAIN : null;
    var round = (typeof ARENA_ROUND !== 'undefined') ? ARENA_ROUND : null;
    if (!c) throw new Error('the page carried no chain providers');

    // A READY-MADE CHAIN IS REFUSED, NOT VERIFIED. The page used to hand over
    // the headers AND the bond proof, and the client checked them against each
    // other - which proves that whoever wrote them wrote a consistent pair and
    // nothing whatever about Bitcoin. If any of these is still being offered,
    // the page is on the old path and should be told so rather than quietly
    // taken at its word.
    for (var i = 0; i < 4; i++) {
      var handed = ['chains', 'chain', 'transaction', 'branch'][i];
      if (d && d[handed] !== undefined)
        throw new Error('ARENA_ADVERT still carries ' + handed
          + ': the chain and the bond come from providers now');
    }

    if (!c.headers || c.headers.length < 2)
      throw new Error('two chain providers are needed, and the page gave '
        + ((c.headers && c.headers.length) | 0));
    if (!c.bonds || !c.bonds.length)
      throw new Error('the page gave nowhere to ask for the bond');
    // THE PROVIDERS ARE FUNCTIONS THE PAGE SUPPLIES, and that is the whole
    // shape of this: the client speaks Bitcoin's own bytes - 80-byte headers
    // and a merkle branch of 32-byte hashes - and never an explorer's JSON.
    // EACH ONE MUST CARRY A `tag` NAMING ITS SOURCE - `ARENACLIENT.httpProvider`
    // sets it from the URL - or the door refuses it: two functions closing over
    // one address are one source, not two.
    // Translating a real chain API into these functions is an adapter and it
    // lives out here, where it can be changed without touching anything that
    // decides.
    //
    // THE ANCHOR IS NOT HERE, and that is the point. The page names WHERE to
    // ask; it does not name the block the client already knows. It used to,
    // and that undid everything above it - whoever supplied the providers also
    // supplied the block his own little mined chain was built on, so it
    // contained the anchor by construction. `Client.at` brings genesis, and
    // refuses an anchor that arrives with the providers.
    return {
      headers: c.headers,
      bonds: c.bonds,
      signedAdvert: (d && d.signedAdvert) ? ARENACLIENT.fromHex(d.signedAdvert) : undefined,
      committee: round ? round.nodes : null,
    };
  },

  // IS THERE A SESSION TO TRY? Not "which node" any more, and the name stays
  // only because renaming it is C# and C# is not this cut.
  //
  // This used to answer with an address. It cannot: the address is now read
  // off a bond transaction proven into a chain two providers agreed on, and
  // every one of those steps is a fetch. What C# does with the answer is ask
  // whether it is empty, so what it needs is whether a session is worth
  // opening - and the address is resolved where it can be, in `net.open`,
  // before a single byte is sent to anybody.
  //
  // An empty answer means no session, which is still the shipping default.
  ArenaNetNodeUrl: function (ptr, cap) {
    var line = '';
    try {
      arenaDiscovery();
      line = 'the chain';
    } catch (e) {
      if (typeof ARENA_CHAIN !== 'undefined')
        console.error('[arena] ' + (e && e.message ? e.message : e));
      line = '';
    }
    var n = Math.min(line.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = line.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  // How many marks this node has receipted for us. The one number that says the
  // round is being witnessed rather than merely sent.
  // HAS THIS RUN ENDED, AND WITH WHICH WORD. The one signal the game acts on:
  // `<WORD> <reason>`, or nothing at all while the run is alive. The client
  // holds both; this copies them out and decides neither.
  //
  // A polled debug string is not this. That is text for a panel, and nothing
  // consumed it - a player went on driving a round that could not be settled
  // because no part of the game was ever told.
  // The same question as a number, because it is asked every tick and every
  // input read: a pinned buffer per frame to learn "no" would be a cost paid
  // by every player for the case that has not happened.
  // OVER, NOT ONLY ENDED (2026-09-15 16:14): the run is over for the game the moment the page
  // took the core's word - nothing is recorded from then - not once the last publish has landed.
  // Measured live on 0.0.1334: waiting for `ended` put the lobby 2241 ms after DELIVERED.
  ArenaNetEnded: function () {
    var n = Module.arenaNet;
    // A SESSION ANOTHER JOIN HAS REPLACED IS OVER (2026-09-26 14:08): the page joined again, so this session's run
    // will not be played - the game may open the new join's session (NetSession opens one only when none is live).
    if (n && n.pageEntry && typeof window !== 'undefined' && window.ARENA_ENTRY && window.ARENA_ENTRY !== n.pageEntry) return 1;
    // A SESSION THE NODE REFUSED IS OVER (2026-09-26, the 21:13 case, second patch): the open failed, the bridge
    // is in error with no client - nothing is live, so the game's running mark ends here and the lobby can come back.
    if (n && !n.client && n.state === 'error') return 1;
    return (n && n.client && n.client.over) ? 1 : 0;
  },

  ArenaNetEnding: function (ptr, cap) {
    var n = Module.arenaNet;
    var c = n && n.client;
    var line = c ? c.endingLine() : '';
    if (!line) { Module.HEAPU8[ptr] = 0; return 0; }
    var k = Math.min(line.length, (cap | 0) - 1);
    for (var i = 0; i < k; i++) Module.HEAPU8[ptr + i] = line.charCodeAt(i) & 255;
    Module.HEAPU8[ptr + k] = 0;
    return k;
  },

  // THE ROUND'S OWN SEED, OR 0 WHEN THERE IS NO ROUND.
  //
  // C# restarts the core at roll-out - `CoreDrivenTruck.StartRound` - and it
  // restarted with its inspector constant, which would have thrown away the
  // world this player was joined in and put them back in the harness one. The
  // daily has no round and keeps the constant, which is what holds the solo
  // apron on bay 13.
  ArenaRoundSeed: function () {
    var n = Module.arenaNet;
    return (n && typeof n.seedWord === 'number') ? (n.seedWord | 0) : 0;
  },

  ArenaNetMarks: function () {
    var n = Module.arenaNet;
    return (n && n.client) ? (n.client.marksSent | 0) : 0;
  },

  // THE DAILY'S LOBBY, DRAWN BY UNITY (M3.3-34, 2026-09-12). The page
  // decides it - the signer nodes' signed listings, the 2-of-2 Join, the tab's key and
  // name (index.html, ARENA_LOBBY_VIEW / ARENA_LOBBY_ACT) - and these only carry
  // it across: the lobby as JSON, and the player's presses back.
  // THE CANVAS'S PIXELS PER CSS PIXEL: a phone draws at 2-3x, and a title
  // screen laid out in device pixels is a quarter of the size a player reads
  // (measured on an iPhone at 3x). Unity scales its title screen by this.
  ArenaUiScale: function () {
    var c = Module.canvas;
    return (c && c.clientWidth > 0) ? c.width / c.clientWidth : 1;
  },

  ArenaLobbyState: function () {
    var s = '';
    try { if (typeof window.ARENA_LOBBY_VIEW === 'function') s = JSON.stringify(window.ARENA_LOBBY_VIEW()); } catch (e) { s = ''; }
    var n = lengthBytesUTF8(s) + 1;
    var p = _malloc(n);
    stringToUTF8(s, p, n);
    return p;
  },

  // ADD-ONS INSIDE UNITY: the page's add-ons view as JSON, a purchase, "Play with it", and a fresh read of what is owned
  ArenaAddonsState: function () {
    var s = '';
    try { if (typeof window.ARENA_ADDONS_VIEW === 'function') s = JSON.stringify(window.ARENA_ADDONS_VIEW()); } catch (e) { s = ''; }
    var n = lengthBytesUTF8(s) + 1;
    var p = _malloc(n);
    stringToUTF8(s, p, n);
    return p;
  },

  ArenaAddonsBuy: function (idPtr) {
    try { return typeof window.ARENA_ADDONS_BUY === 'function' ? (window.ARENA_ADDONS_BUY(UTF8ToString(idPtr)) | 0) : 0; } catch (e) { return 0; }
  },

  ArenaAddonsUse: function (idPtr, on) {
    try { return typeof window.ARENA_ADDONS_USE === 'function' ? (window.ARENA_ADDONS_USE(UTF8ToString(idPtr), !!on) | 0) : 0; } catch (e) { return 0; }
  },

  ArenaAddonsOpen: function () {
    try { return typeof window.ARENA_ADDONS_OPEN === 'function' ? (window.ARENA_ADDONS_OPEN() | 0) : 0; } catch (e) { return 0; }
  },

  ArenaLobbyJoin: function (idPtr) {
    try { return (window.ARENA_LOBBY_ACT && window.ARENA_LOBBY_ACT.join(UTF8ToString(idPtr))) ? 1 : 0; } catch (e) { return 0; }
  },

  ArenaLobbyEditName: function () {
    var s = '';
    try { s = window.ARENA_LOBBY_ACT ? String(window.ARENA_LOBBY_ACT.editName() || '') : ''; } catch (e) { s = String((e && e.message) || e); }
    var n = lengthBytesUTF8(s) + 1;
    var p = _malloc(n);
    stringToUTF8(s, p, n);
    return p;
  },

  ArenaLobbyKeyBackup: function () {
    try { if (window.ARENA_LOBBY_ACT) window.ARENA_LOBBY_ACT.keyBackup(); } catch (e) { /* the prompt was refused */ }
  },

  // WHAT UNITY DREW, for whoever measures the page: rows, buttons, where.
  ArenaLobbyShown: function (jsonPtr) {
    try { window.ARENA_UNITY_LOBBY = JSON.parse(UTF8ToString(jsonPtr)); } catch (e) { /* not JSON: nothing to keep */ }
  },

  // AND WHAT THE WAR SAID, for the same reason: the assault banner and the desktop log are the whole of
  // the owner's 16:22/16:26 letter, and "the owner cannot see them" is only answerable by asking the page what it
  // drew. Same shape as ArenaLobbyShown - a picture of what was on screen, never an input to anything.
  // CLEAN SCREEN (CleanHud.cs, Shift+H): the page's own overlays go with the Unity HUD.
  ArenaHudClean: function (on) {
    window.ARENA_HUD_CLEAN = !!on;
    try { document.body.classList.toggle('arena-clean', !!on); } catch (e) { /* no body yet */ }
  },

  // WHERE THE TOP-RIGHT HUD CORNER ENDS (DriveHud.ConsoleSlot, 2026-10-04): the page's Console button goes under it
  ArenaHudCorner: function (jsonPtr) {
    try { window.ARENA_HUD_CORNER = JSON.parse(UTF8ToString(jsonPtr)); if (window.ARENA_PLACE_CONSOLE) window.ARENA_PLACE_CONSOLE(); } catch (e) { /* not JSON */ }
  },

  ArenaAssaultShown: function (jsonPtr) {
    try { window.ARENA_UNITY_ASSAULT = JSON.parse(UTF8ToString(jsonPtr)); } catch (e) { /* not JSON: nothing to keep */ }
  },

  //: the page's word on a round link's play=1 - -1 not decided yet, 0 held to the round's start, 1 drive, 2 no word (an older page)
  ArenaLinkAutoPlay: function () {
    var v = window.ARENA_LINK_AUTOPLAY;
    return v === null ? -1 : v === false ? 0 : v === true ? 1 : 2;
  },

  ArenaQueryParam: function (namePtr, outPtr, cap) {
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
