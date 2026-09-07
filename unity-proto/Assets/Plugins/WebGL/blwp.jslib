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
  // The front line at a world x, Q16.16 metres. The RENDERER asks; it does not
  // work the line out again. The core smooths the price tape before laying it
  // across the map and C# does not, so a second copy of the rule put the drawn
  // territory 22.04 m from the men on average and 49.14 m at worst.
  // Queues a liquidation for the next tick. Size in MILLIONS of USD, Q16.16.
  // The live Binance feed and the simulation clock are two callers of this one
  // function, which is what makes their strikes identical rather than merely
  // similar. Nothing is decided here; the core decides.
  BlwpLiquidation: function (size) {
    var b = Module.blwp;
    if (!b || !b.core.submitLiquidation) return 0;
    return b.core.submitLiquidation(b.st, size | 0) ? 1 : 0;
  },

  // How hard the war hunts what is on the bed, Q16.16, handed over at
  // roll-out. The core clamps it; this only carries it.
  BlwpSetHeat: function (q) {
    var b = Module.blwp;
    if (!b || !b.core.setHeat) return 0;
    return b.core.setHeat(b.st, q | 0) ? 1 : 0;
  },

  BlwpFrontlineZ: function (x) {
    var b = Module.blwp;
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
  BlwpSurfaceAt: function (x, z) {
    var b = Module.blwp;
    if (!b || !b.core.groundAt) return 0;
    return b.core.groundAt(b.st, x | 0, z | 0) | 0;
  },

  BlwpStep: function (throttle, steer, brake, handbrake, practice) {
    var b = Module.blwp;
    if (!b) return 0;
    b.core.step(b.st, throttle | 0, steer | 0, brake | 0, handbrake | 0, practice | 0);

    // AND THE SAME WORDS GO TO THE NETWORK, from here rather than from Unity.
    //
    // A transcript has to be the inputs the core actually stepped on. If Unity
    // kept its own copy to publish, there would be two records of one thing and
    // a bug in either would be invisible until a verifier replayed the round
    // and landed somewhere else. Taken here, they are the same five words by
    // construction - there is no second copy to drift.
    if (Module.blwpNet) Module.blwpNet.tick(
      [throttle | 0, steer | 0, brake | 0, handbrake | 0, practice | 0]);
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
  // ------------------------------------------------------------- the network
  //
  // Unity starts a session and reads a status line. It never builds a message,
  // never signs one and never learns an outcome from one: the client in the
  // page does all of that, and the client computes nothing either - it carries
  // a hash the core produced. This is the whole of the game's reach into BLWP.
  //
  // Everything below is fire-and-forget with a status to poll, because a jslib
  // function returns an int and the client's work is asynchronous.
  BlwpNetStart: function (urlPtr, batchEvery, markEvery) {
    if (typeof BLWPCLIENT === 'undefined') {
      console.error('[blwp] client bundle not loaded - check the WebGL template');
      return 0;
    }
    var b = Module.blwp;
    if (!b) { console.error('[blwp] no core, so nothing to commit to'); return 0; }
    if (Module.blwpNet) return 1;                      // already running

    var base = UTF8ToString(urlPtr);
    var contractTicks = (typeof BLWP_ROUND !== 'undefined' && BLWP_ROUND)
      ? (BLWP_ROUND.blockTicks | 0) : 0;
    var net = Module.blwpNet = {
      state: 'opening', error: '', ticks: [], tick: null,
      batches: 0, marks: 0, batchEvery: batchEvery | 0, markEvery: markEvery | 0,
      seen: 0, client: null, where: null, lost: 0, drops: 0, resumedAt: -1,
      tries: 0, backoff: 0, held: 0, stalls: 0,
      // AT MOST THIS MANY TICKS IN ONE BATCH.
      //
      // The node refuses a batch longer than the round's own `blockTicks`, so
      // a long outage that drained as ONE batch would be refused for ever -
      // the ticks go back in the hold and are re-sent, and the run is stuck
      // from that moment. Measured on this machine the core runs about 43
      // ticks a second, so the wall is reached after roughly two and a half
      // minutes of outage at 60 Hz. Draining in chunks turns that into
      // several ordinary batches.
      chunk: (contractTicks && contractTicks < 600) ? contractTicks : 600,
      // ONE AT A TIME, and this is not tidiness.
      //
      // Both chains hang off state the client updates when an answer comes
      // back - the next tick owed, and the two heads. Two publishes in flight
      // at once build the second from the state the first has not finished
      // moving, so it names a tick the node is not owed and is refused for a
      // gap. Measured before this queue existed: 20 marks went through - about
      // twenty seconds of play, so twelve hundred ticks - and 75 ticks of
      // input reached the node. The rest were refused and thrown away, and
      // section 11 is blunt about what unpublished inputs cost.
      chain: Promise.resolve(),
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

    crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      .then(function (pair) {
        keys = pair;
        return crypto.subtle.exportKey('raw', pair.publicKey);
      })
      .then(function (raw) {
        net.sessionPubkey = new Uint8Array(raw);
        return net.open(base, sign);
      })
      .then(function () { net.state = 'ready'; })
      .catch(function (e) {
        net.state = 'error';
        net.error = String(e && e.message ? e.message : e);
        console.error('[blwp] session: ' + net.error);
      });

    // THE THREE THINGS A SESSION DOES, as closures rather than as helpers on
    // Module: a .jslib has no shared scope, and hanging them off Module would
    // make them reachable from the page, where nothing should be able to sign
    // on the player's behalf.
    net.open = function (base, signer) {
      var C = BLWPCLIENT;
      // The round and the entry the page was told to play. Both contracts are
      // built HERE and their ids computed here, so the node is never asked what
      // this round is called.
      // Named by the page, never by the node and never invented here. A round
      // contract is agreed before anyone moves; a lobby will set this one day
      // and until then whoever runs the page does. Unset means no session,
      // which is the shipping default.
      var contract = (typeof BLWP_ROUND !== 'undefined') ? BLWP_ROUND : null;
      var seat = (typeof BLWP_ENTRY !== 'undefined') ? BLWP_ENTRY : null;
      if (!contract || !seat) throw new Error('the page did not say which round to play');
      var entry = Object.assign({}, seat, {
        roundId: C.roundId(contract), sessionPubkey: net.sessionPubkey,
      });
      net.where = { roundId: C.roundId(contract), entryId: C.entryId(entry) };
      net.client = new C.Client({
        // The "core" the client is given here answers with a hash that was
        // already taken, at the tick the mark names. The client's contract is
        // only that `hash(st)` returns the core's own 64 hex characters, and
        // freezing it is what keeps a queued mark honest about which tick it
        // is for.
        base: base, core: { hash: function (st) { return st.frozen; } },
        sign: signer,
        verify: function (sig, msg, key) {
          // Verifying a receipt is the page's job too, and the same curve.
          return crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
            .then(function (k) { return crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg); });
        },
      });
      // WHEN THE SOCKET GOES, come back on a new one and read both chains
      // off the node. The client answers everything in flight by name, so the
      // queue is not left holding a promise that can never settle; what is
      // left is to reconnect and ask where the node got to.
      //
      // The ticks are NOT thrown away while it is down. A transcript has to be
      // contiguous - the node refuses a gap at intake, where a client can
      // still fix it - so they pile up and go out in order once the socket is
      // back, from the tick the node says it is owed.
      // KEEP TRYING, with a backoff, until the run is over.
      //
      // One attempt was the whole of it before, so a node that was still
      // restarting at that moment left the session in `error` and nothing ever
      // tried again - every tick and every mark from that instant on went
      // unpublished, and section 11 is blunt about what unpublished inputs
      // cost. A one-second blip in the wrong place cost the rest of the round.
      //
      // The backoff doubles from a second to eight, which is slow enough not
      // to hammer a node that is down and quick enough that a blip costs a
      // second rather than a run.
      net.reconnect = function () {
        if (net.state === 'gone') return;
        net.state = 'dropped';
        net.tries++;
        net.chain = net.chain.then(function () {
          return net.client.connect()
            .then(function () { return net.client.resume(net.where); })
            .then(function (r) {
              net.resumedAt = r.nextTick;
              net.backoff = 0;
              net.state = 'ready';
              console.log('[blwp] resumed at tick ' + r.nextTick + ' after ' + net.tries
                + ' try(s), ' + r.batches + ' batches and ' + r.receipts + ' behind us');
            })
            .catch(function (e) {
              net.error = String(e.message || e);
              net.backoff = net.backoff ? Math.min(net.backoff * 2, 8000) : 1000;
              setTimeout(net.reconnect, net.backoff);
            });
        });
      };
      net.client.onDrop = function () {
        if (net.state === 'gone' || net.state === 'dropped') return;
        net.drops++;
        net.tries = 0;
        net.backoff = 0;
        net.reconnect();
      };

      return net.client.openRound(contract)
        .then(function () { return net.client.join(entry); })
        .then(function () { return net.client.connect(); });
    };

    net.publish = function () {
      // AND NEVER MORE THAN A CHUNK AT A TIME. What is left stays held and
      // goes out behind it, so a long outage drains as several ordinary
      // batches instead of one the node is bound to refuse.
      var words = net.ticks.slice(0, net.chunk);
      net.ticks = net.ticks.slice(words.length);
      net.chain = net.chain.then(function () {
        if (net.state !== 'ready') { net.ticks = words.concat(net.ticks); return; }

        // WATCH WHAT IS ALREADY WAITING TO GO OUT. IMPLEMENTATION.md: "ws
        // buffers without limit. Watch bufferedAmount; above a threshold drop
        // ghost frames first - they are non-authoritative by definition - and
        // never receipts." There are no ghost frames yet, so the rule here is
        // the part that does apply: do not add to a socket that is already
        // backed up. The ticks stay held and go out when it has drained.
        var sock = net.client.sock;
        if (sock && sock.bufferedAmount > 262144) {
          net.stalls++;
          net.ticks = words.concat(net.ticks);
          return;
        }
        return net.client.batch(words, net.where).then(function (r) {
          if (r.accepted) { net.batches++; return; }
          // PUT THEM BACK, in front of whatever has arrived since. A refused
          // batch is not a published one, and dropping it would leave a hole
          // in a chain the node refuses to accept across - the run would end
          // at the gap with the inputs after it unusable.
          net.ticks = words.concat(net.ticks);
          net.error = String(r.answer);
        });
      }).catch(function (e) { net.error = String(e.message || e); });
    };

    net.mark = function (core) {
      // The state is read WHEN THE MARK IS TAKEN, not when the queue reaches
      // it: a checkpoint says where the world was at a tick, so hashing it a
      // few frames later would commit to a different world than the tick names.
      var at = net.seen;
      var hash = b.core.hash(core.st);
      net.chain = net.chain.then(function () {
        return net.client.checkpoint({ frozen: hash }, {
          roundId: net.where.roundId, entryId: net.where.entryId, tick: at,
        }).then(function (r) { if (r.answer === 'receipted') net.marks++; });
      }).catch(function (e) { net.error = String(e.message || e); });
    };

    net.tick = function (words) {
      if (net.state === 'gone') return;
      // Kept even while the socket is down, and counted even while it is
      // opening: the tick number is the core's, not the network's, and a
      // transcript with a hole in it is one the node will not accept across.
      net.ticks.push(words);
      net.seen++;
      if (net.state !== 'ready') return;
      net.held = net.ticks.length;
      if (net.batchEvery > 0 && net.ticks.length >= net.batchEvery) net.publish();
      if (net.markEvery > 0 && net.seen % net.markEvery === 0) net.mark(b);
    };
    return 1;
  },

  // The status line, as ASCII, for the debug panel. A status nobody can read is
  // a status nobody checks.
  BlwpNetStatus: function (ptr, cap) {
    var net = Module.blwpNet;
    var line = net
      ? net.state + ' batches ' + net.batches + ' marks ' + net.marks
        + ' tick ' + net.seen + ' held ' + net.ticks.length
        + (net.stalls ? ' stalls ' + net.stalls : '')
        + (net.drops ? ' drops ' + net.drops + ' tries ' + net.tries
                       + ' resumed ' + net.resumedAt : '')
        + (net.error ? ' (' + net.error + ')' : '')
      : 'off';
    var n = Math.min(line.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = line.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  // WHICH NODE, named by the page for the same reason the round is: a lobby
  // will say one day, and until then whoever runs the page does. Empty means
  // no session, which is the shipping default.
  BlwpNetNodeUrl: function (ptr, cap) {
    var url = (typeof BLWP_NODE !== 'undefined' && BLWP_NODE) ? String(BLWP_NODE) : '';
    var n = Math.min(url.length, (cap | 0) - 1);
    for (var i = 0; i < n; i++) Module.HEAPU8[ptr + i] = url.charCodeAt(i);
    Module.HEAPU8[ptr + n] = 0;
    return n;
  },

  // How many marks this node has receipted for us. The one number that says the
  // round is being witnessed rather than merely sent.
  BlwpNetMarks: function () {
    return Module.blwpNet ? (Module.blwpNet.marks | 0) : 0;
  },

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
