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
  // BlwpSetGround IS GONE, and its absence is the rule.
  //
  // Unity used to upload `MempoolTerrain.HeightGrid` into the core and the core
  // felt those hills; every committee replaying the same drive stepped a flat
  // table, 33.500 m away after six hundred ticks. The relief comes from the
  // round's seed now (letter 36), so there is nothing for a page to send and
  // no way for one to put its player in a world nobody else can reproduce.

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
    var net = Module.blwpNet = {
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

    crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      .then(function (pair) {
        keys = pair;
        return crypto.subtle.exportKey('raw', pair.publicKey);
      })
      .then(function (raw) {
        net.sessionPubkey = new Uint8Array(raw);
        return net.open(base, sign);
      })
      .catch(function (e) {
        // No client, so the page's own word is the only one there is.
        net.client = null;
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
      var contract = (typeof BLWP_ROUND !== 'undefined') ? BLWP_ROUND : null;
      var seat = (typeof BLWP_ENTRY !== 'undefined') ? BLWP_ENTRY : null;
      if (!contract || !seat) throw new Error('the page did not say which round to play');

      // THE ROUND THE PLAYER WAS GIVEN, off the address bar and not out of the
      // page's own script. Section 25.1 step 1 is "a link, QR, copied round_id"
      // - it comes from whoever invited the player, and it is the one thing in
      // this whole path that the page did not write. `Client.at` refuses unless
      // BLWP_ROUND hashes to it, which is what stops a page naming its own
      // nodes as the committee and then satisfying its own choice.
      var given = null;
      try {
        var q = new URLSearchParams(window.location.search).get('round');
        if (q) given = BLWPCLIENT.fromHex(q);
      } catch (e) { given = null; }
      var entry = Object.assign({}, seat, {
        roundId: C.roundId(contract), sessionPubkey: net.sessionPubkey,
      });
      net.where = { roundId: C.roundId(contract), entryId: C.entryId(entry) };
      var verify = function (sig, msg, key) {
        // NODE SIGNATURES ARE SCHNORR under the bond key (letter 26). The
        // session key below is still Ed25519. Mixing them was the 09:33 fault:
        // A/B http ok, play refused the advert as unsigned.
        if (typeof BLWP_CURVE === 'undefined' || typeof BLWP_CURVE.verify !== 'function')
          return Promise.resolve(false);
        return Promise.resolve(BLWP_CURVE.verify(sig, msg, key));
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
      // HERE, AND NOT AT ROLL-OUT. Every `BlwpStep` is published from the
      // moment there is a client, loading in the bay included, so a core put
      // in the right world at roll-out would already have published thousands
      // of ticks of the wrong one. `net.client` does not exist until the
      // promise below resolves, so nothing has been recorded yet.
      //
      // A ROUND WHOSE NODES NAME TWO WORLDS IS NOT ONE ROUND, and
      // `worldSeedFor` refuses it rather than picking one.
      var nodes = (typeof BLWP_NODES !== 'undefined') ? BLWP_NODES : null;
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
      return C.worldSeedFor({
        entry: entry, round: net.where.roundId, nodes: nodes,
      }).then(function (world) {
        net.seedWord = world.seedWord | 0;
        net.randomness = world.randomness;
        // THE CORE IS RESTARTED INTO IT. `init` is the same door C# reaches
        // through `BlwpCore.Init`; nothing here writes a state word.
        b.st = b.core.init(net.seedWord);
        console.log('[blwp] world seed 0x' + (net.seedWord >>> 0).toString(16)
          + ' from ' + world.agreed + ' node(s) agreeing on the round randomness');
        return C.Client.at(blwpDiscovery(), {
          core: { hash: function (st) { return b.core.hash(st); } },
          sign: signer, verify: verify, contract: contract, roundIdGiven: given,
        });
      }).then(function (client) {
        net.client = client;
        return net.opened(contract, entry);
      });
    };

    net.opened = function (contract, entry) {
      var C = BLWPCLIENT;

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
        console.log('[blwp] run ended ' + word + ': ' + why);
      };
      net.client.onDrop = function () {
        net.client.reconnect(net.where).then(function (r) {
          if (!r) return;              // the run ended; onEnd has already said so
          net.resumedAt = r.nextTick;
          console.log('[blwp] resumed at tick ' + r.nextTick + ' after '
            + net.client.tries + ' try(s), ' + r.batches + ' batches and '
            + r.receipts + ' behind us');
        });
      };

      return net.client.openRound(contract)
        .then(function () { return net.client.join(entry); })
        .then(function () { return net.client.connect(); })
        .then(function () {
          // THE HOLD, THE DRAIN AND THE SKIPPING ALL LIVE IN THE CLIENT.
          //
          // They used to be here, in a promise chain this file appended to on
          // every sixth tick whether or not the one before had finished - a
          // queue nobody bounded, in the one place that cannot be tested.
          // Moved into `@blwp/client` they are measured against a real node by
          // `backpressure.test.js`, and the page and the tests run one set of
          // rules instead of two that look alike.
          net.client.setRound({
            roundId: net.where.roundId, entryId: net.where.entryId,
            blockTicks: contract.blockTicks | 0,
          });

          // AND ASK TO BE SHOWN THE OTHER TRUCKS.
          //
          // The rule for what is kept is not here: `watchGhosts` is in
          // `@blwp/client`, where `node --test` can measure it, for the same
          // reason the hold and the drain moved there. This file only says
          // WHEN to ask - once the round and the entry are known - and holds
          // the field the renderer drains.
          //
          // A ghost is a picture (0.10). Nothing from it ever reaches
          // `Module.blwp`: the core is driven by this player's own inputs and
          // by nothing else.
          try {
            net.ghosts = BLWPCLIENT.watchGhosts(net.client, net.where);
          } catch (e) {
            // A page that cannot be shown the others still plays its own run.
            console.error('[blwp] ghosts unavailable: ' + (e && e.message));
            net.ghosts = null;
          }
        });
    };

    net.tick = function (words) {
      if (!net.client) return;
      net.client.record(words);
      net.seen++;
      if (net.client.state !== 'ready') return;
      if (net.batchEvery > 0 && net.seen % net.batchEvery === 0) net.client.drain();
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
  BlwpNextGhost: function (ptr, cap) {
    var net = Module.blwpNet;
    var field = net && net.ghosts;
    if (!field || cap < 12) return 0;
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

  // The status line, as ASCII, for the debug panel. A status nobody can read is
  // a status nobody checks.
  BlwpNetStatus: function (ptr, cap) {
    var net = Module.blwpNet;
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
  BlwpNetNodeUrl__deps: ['$blwpDiscovery'],
  BlwpNetStart__deps: ['$blwpDiscovery'],
  $blwpDiscovery: function () {
    var d = (typeof BLWP_ADVERT !== 'undefined') ? BLWP_ADVERT : null;
    var c = (typeof BLWP_CHAIN !== 'undefined') ? BLWP_CHAIN : null;
    var round = (typeof BLWP_ROUND !== 'undefined') ? BLWP_ROUND : null;
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
        throw new Error('BLWP_ADVERT still carries ' + handed
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
    // EACH ONE MUST CARRY A `tag` NAMING ITS SOURCE - `BLWPCLIENT.httpProvider`
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
      signedAdvert: (d && d.signedAdvert) ? BLWPCLIENT.fromHex(d.signedAdvert) : undefined,
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
  BlwpNetNodeUrl: function (ptr, cap) {
    var line = '';
    try {
      blwpDiscovery();
      line = 'the chain';
    } catch (e) {
      if (typeof BLWP_CHAIN !== 'undefined')
        console.error('[blwp] ' + (e && e.message ? e.message : e));
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
  BlwpNetEnded: function () {
    var n = Module.blwpNet;
    return (n && n.client && n.client.ended) ? 1 : 0;
  },

  BlwpNetEnding: function (ptr, cap) {
    var n = Module.blwpNet;
    var c = n && n.client;
    if (!c || !c.ended) { Module.HEAPU8[ptr] = 0; return 0; }
    var line = c.ending + ' ' + (c.endingReason || '');
    var k = Math.min(line.length, (cap | 0) - 1);
    for (var i = 0; i < k; i++) Module.HEAPU8[ptr + i] = line.charCodeAt(i) & 255;
    Module.HEAPU8[ptr + k] = 0;
    return k;
  },

  // THE ROUND'S OWN SEED, OR 0 WHEN THERE IS NO ROUND.
  //
  // C# restarts the core at roll-out - `CoreDrivenTruck.StartRound` - and it
  // restarted with its inspector constant, which would have thrown away the
  // world this player was seated in and put them back in the harness one. The
  // daily has no round and keeps the constant, which is what holds the solo
  // apron on bay 13.
  BlwpRoundSeed: function () {
    var n = Module.blwpNet;
    return (n && typeof n.seedWord === 'number') ? (n.seedWord | 0) : 0;
  },

  BlwpNetMarks: function () {
    var n = Module.blwpNet;
    return (n && n.client) ? (n.client.marksSent | 0) : 0;
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
