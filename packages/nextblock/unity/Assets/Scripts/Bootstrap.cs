// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
using UnityEngine.Rendering.Universal;

/// <summary>
/// Builds the whole prototype scene in code. Unity scene files are YAML full of
/// GUID references, which are painful to author by hand and merge badly; doing
/// it here means the prototype is one script you can read, and it never has a
/// broken reference.
///
/// Drop this on an empty GameObject in an otherwise empty scene and press play.
/// Assign truckModel / tankModel once you have imported real models; without
/// them it builds proxy boxes so the scene runs immediately.
/// </summary>
public class Bootstrap : MonoBehaviour
{
    [Header("Optional imported models")]
    public GameObject truckModel;
    public GameObject wheelModel;
    [Tooltip("Soldier prefab from an imported pack. Empty falls back to boxes.")]
    public GameObject soldierPrefab;
    public float soldierYawOffset;
    public RuntimeAnimatorController soldierAnimator;
    [Tooltip("Tank prefab from an imported pack. Empty falls back to boxes.")]
    public GameObject tankPrefab;
    public float tankYawOffset;
    public GameObject bombPrefab;

    [Header("Materials (assign URP/Lit with Poly Haven maps)")]
    public Material groundMaterial;
    public Material roadMaterial;
    public Material bodyMaterial;
    public Material wheelMaterial;
    public Material barrierMaterial;
    public Material bullMaterial;
    public Material bearMaterial;
    public Material tracerMaterial;
    public Material flashMaterial;
    public Material blastMaterial;
    public Material fireCoreMaterial;
    public Material fireMaterial;
    public Material smokeMaterial;
    public Material debrisMaterial;

    [Tooltip("Crates on the truck bed. Falls back to a cardboard brown.")]
    public Material crateMaterial;

    [Tooltip("The miner megastructure at the far end. Assigned by " +
             "BuildPrototypeScene; null falls back to posts and a beam.")]
    public GameObject minerModel;

    [Tooltip("The delivery gate. Falls back to a high-visibility yellow.")]
    public Material gateMaterial;

    [Tooltip("Whether incoming fire is withheld when the round starts. The " +
             "URL parameter ?practice=0 or 1 overrides this.")]
    public bool practiceByDefault = true;

    [Tooltip("Cardboard box model for the freight. Falls back to a cube.")]
    public GameObject boxPrefab;
    public Material dustMaterial;
    public Material fireParticleMaterial;
    public Material smokeParticleMaterial;

    [Header("Armies")]
    public int armourPerSide = 11;
    public int infantryPerSide = 90;

    [Header("Look")]
    public UnityEngine.Rendering.VolumeProfile postProfile;

    [Header("Sun")]
    public float sunPitch = 34f;          // low enough for long shadows, high enough to light
    public float sunYaw = -42f;
    public Color sunColour = new Color(1f, 0.95f, 0.86f);
    public float sunIntensity = 1.6f;

    /// <summary>
    /// How far the road ribbon floats above the terrain. Just enough to beat
    /// z-fighting: the road carries NO collider, so it is a painted stripe
    /// rather than a raised deck. A lifted deck with a vertical edge and no
    /// shoulder is something the truck falls off, which is exactly what it did.
    /// </summary>
    public const float RoadLift = 0.3f;

    MempoolTerrain _terrain;
    public MarketFeed Market { get; private set; }
    public Battlefield Field { get; private set; }
    public RoadNetwork Roads { get; private set; }

    public GameAudio Audio { get; private set; }

    public BlockClock Clock { get; private set; }

    public SplashScreen Splash { get; private set; }
    public CombatFx Fx { get; private set; }

    Arena.StrikeTheatre _strike;

    /// <summary>
    /// The simulation clock, for when the feed is quiet.
    ///
    /// Liquidations are rare - the contract says so - and a feature nobody
    /// ever sees is a feature that is not there. So when none has arrived for
    /// as long as the feed itself keeps them, one is fired on a clock.
    ///
    /// Both numbers are the feed's own rather than invented: `MarketFeed`
    /// drops a liquidation at `Age > 90f`, so ninety seconds is what that
    /// feed calls "a while ago", and it is both the silence that starts the
    /// clock and the interval it ticks at. The size is drawn across the span
    /// the core's own crater rule is defined over, one million to a thousand
    /// million; outside it the rule clamps and the hole stops growing.
    ///
    /// It goes through the SAME `ArenaCore.Liquidation` the live feed does.
    /// That is the whole reason a simulated strike and a real one cannot look
    /// different: the core is handed one input and cannot tell which sent it.
    /// `Simulated` says which, for the HUD, and nothing else reads it.
    /// </summary>
    const float LiquidationSilence = 90f;

    float _lastLiquidation, _nextSim;

    /// <summary>True when the last liquidation the core saw was a simulated one.</summary>
    public static bool Simulated { get; private set; }

    /// <summary>
    /// Simulation held ON by hand, from the SIM switch under PRACTICE. While
    /// it is on the silent-market wait is not required: the same simulated
    /// liquidation is offered on its own cadence whether the books are quiet
    /// or busy.
    /// </summary>
    public static bool SimForced { get; private set; }

    /// <summary>
    /// Turn the switch. Switching it ON fires one at once, so the player who
    /// pressed it sees a strike rather than waiting out a cadence.
    /// </summary>
    public static void ToggleSim()
    {
        SimForced = !SimForced;
        var boot = FindFirstObjectByType<Bootstrap>();
        if (SimForced && boot != null) boot.FireSimulated("switch");
    }

    /// <summary>
    /// WHETHER A LIQUIDATION - SIMULATED OR FROM THE LIVE MARKET - MAY WRITE THE CORE: only while no
    /// signed run is live. From the session's `Start` (before the page puts the core in the round's
    /// world) until the run is over, the core is the signer nodes' replay of the transcript, and the
    /// transcript carries neither our clock nor our market feed.
    /// </summary>
    public static bool LiquidationMayWriteCore(bool signedRunLive) => !signedRunLive;

    /// <summary>
    /// ONE simulated liquidation, and it is the only implementation there is.
    /// The silent-market clock calls it and so does the SIM switch, so there
    /// is no second path that could dig a different hole.
    ///
    /// Nothing about the picture is built here. The size goes into
    /// `ArenaCore.Liquidation` and the core decides the crater, the fallout and
    /// the strike; the theatre is told only which side submitted it, and
    /// nobody did, so it is told none.
    /// </summary>
    public bool FireSimulated(string why)
    {
        if (!Arena.ArenaCore.Available) return false;
        _nextSim = Time.time + LiquidationSilence;

        // NOT IN A SIGNED RUN (2026-09-15): the core this writes is the one the score card
        // reads and the signer nodes replay from the transcript, and a simulated liquidation is in no
        // transcript. Measured before on the Daily: one SIM press at tick 192 made the card read
        // DELIVERED 222 at tick 2129 on a run both signer nodes signed FAILED 268. Outside a signed
        // run - practice in the lobby, no node named - it still fires.
        if (!LiquidationMayWriteCore(Arena.ArenaNet.Live))
        {
            Debug.Log($"[sim] simulated liquidation not offered: a signed run is live ({why})");
            return false;
        }

        // one million to a thousand million, the span the crater rule spans
        double usd = UnityEngine.Random.Range(1f, 1000f) * 1e6;
        // No side: nobody submitted this but the clock. The picture flies the
        // default airframe rather than inventing one.
        if (_strike != null) _strike.NoteSubmitter(null, usd);
        if (!Arena.ArenaCore.Liquidation(usd)) return false;
        Simulated = true;
        Debug.Log($"[sim] simulated liquidation ${usd:N0} offered to the core ({why})");
        return true;
    }

    void Update()
    {
        if (Market == null || !Arena.ArenaCore.Available) return;
        if (Market.Liquidations.Count > 0) { _lastLiquidation = Time.time; Simulated = false; }
        // The switch stands in for the silence. Held on, it does not wait for
        // a quiet market; left off, nothing changes and the old rule runs.
        if (!SimForced && Time.time - _lastLiquidation < LiquidationSilence) return;
        if (Time.time < _nextSim) return;
        FireSimulated(SimForced ? "switch cadence" : "silent market");
    }

    void Start()
    {
        SharpenTextures();

        EnsureMaterials();
        BuildLighting();
        _terrain = BuildTerrain();
        // THE CANDLES ON IT (WAR_TACTICS.md §4.15): the core's candle bodies, meshed from its words.
        new GameObject("CandleTerrain").AddComponent<CandleTerrain>();

        // live tape first: the frontline is the price chart, so everything
        // downstream wants it already ticking
        Market = gameObject.AddComponent<MarketFeed>();

        // A forced liquidation is an INPUT to the core, and this is where it
        // becomes one. Without this the whole liquidation arm - the strike,
        // the crater, the paths round it, the irradiation, the warning - is
        // built and unreachable, because the core is never told.
        //
        // `MarketFeed.OnLiquidation` had no subscriber at all before this;
        // the only thing that read its list was a debug line counting them.
        //
        // The SIDE goes past the core, never into it. `l.Long` is a long being
        // liquidated, i.e. a bull blown out, so bear is the other one - and it
        // reaches the renderer only, which is the whole point: a liquidation
        // changes the size, the crater and the fallout, not which mesh hangs in
        // the sky.
        //
        // AND NOT INTO A SIGNED RUN (2026-09-15): a live forced order is in no transcript, so
        // written into the core the score card reads it would be a world the signer nodes never
        // replay. Measured before on the Daily (0.0.1356): four live liquidations ($684 - $294,853)
        // fell inside one signed run, each sent by this handler, which has no filter but usd > 0.
        // Outside a signed run it still fires. Each one held back is logged, so a quiet market and
        // a held one can be told apart.
        Market.OnLiquidation += (l) =>
        {
            if (!LiquidationMayWriteCore(Arena.ArenaNet.Live))
            {
                Debug.Log($"[feed] liquidation {l.Venue} ${l.UsdValue:N0} not offered to the core: a signed run is live");
                return;
            }
            if (_strike != null) _strike.NoteSubmitter(!l.Long, l.UsdValue, l.Venue);
            Arena.ArenaCore.Liquidation(l.UsdValue);
        };
        Field = gameObject.AddComponent<Battlefield>();
        Field.terrain = _terrain;
        Field.market = Market;
        BuildRoads();

        // same trap: TerritoryMap binds its texture to the ground material in
        // Awake, so it has to know the renderer before the component exists
        var territoryGo = new GameObject("Territory");
        territoryGo.transform.SetParent(transform, false);
        territoryGo.SetActive(false);
        var territory = territoryGo.AddComponent<TerritoryMap>();
        territory.terrain = _terrain;
        territory.field = Field;
        territory.target = _terrain.GetComponent<MeshRenderer>();
        territoryGo.SetActive(true);
        BuildArmies();
        // THE EDGE IS A CLAMP, NOT A WALL (ruling 4, 2026-09-22): "the core owes no wall solids,
        // and the client stops drawing walls the core does not build." BuildBoundary is not called.
        // The core clamps every unit and the truck to +-HALF_X / +-HALF_Z after its pushes, so there is
        // nothing here for a collider to do, and a barrier drawn where the core has no solid is exactly
        // the divergence `replay-solids` exists to catch. The method is left below, unreferenced and
        // with its own note, because deleting it would lose why the walls were there.
        // The post office goes up FIRST, because the truck has to be parked in
        // one of its bays and the bay position is arithmetic, not geometry -
        // so it is known before the building has finished streaming.
        var statsGo = new GameObject("ChainStats");
        statsGo.transform.SetParent(transform, false);
        _stats = statsGo.AddComponent<ChainStats>();
        // The projected block, transaction by transaction, off mempool.space's
        // socket. The goggles wall is drawn from this rather than from the
        // freight list: forty parcels is a truckload, not a block.
        statsGo.AddComponent<MempoolBlockStream>();

        var postGo = new GameObject("PostOffice");
        postGo.transform.SetParent(transform, false);
        postGo.SetActive(false);
        var post = postGo.AddComponent<PostOffice>();
        post.terrain = _terrain;
        // FROM THE CORE, not from the terrain's width (2026-09-19 16:0x). `width * 0.44` was a second world length
        // in C#: it happened to give -114.4 on a 260 m map, and the moment the map grew east for the miner it would
        // have walked the post office with it. The core owns where the buildings stand.
        post.postX = Arena.Layout.POST_X / 65536f;
        post.feed = Object.FindFirstObjectByType<MempoolFeed>();
        post.stats = _stats;
        postGo.SetActive(true);
        _post = post;

        var truck = BuildTruck(_terrain);

        // The deterministic core, if this build has one.
        //
        // It attaches always and decides for itself: in a WebGL build with the
        // bundle loaded it takes the wheel and switches the Rigidbody to
        // kinematic; anywhere else it finds no core, says so once, and leaves
        // PhysX alone. That asymmetry is the whole reason it is a component
        // rather than a compile-time switch - the editor has no JavaScript, and
        // a scene that only works in one of the two is a scene nobody can
        // iterate on.
        // THE BLWP SESSION, if this page was given a node to play against.
        //
        // It publishes nothing itself - the inputs go to the network from
        // inside the core's own step, so the transcript is the words the core
        // consumed - and it decides only WHEN a session should exist. With no
        // node named it does nothing at all, which is every build that has
        // shipped so far.
        gameObject.AddComponent<Arena.NetSession>();
        // THE COLLISION, VISIBLE (2026-09-25 20:56): the core's own boxes, coloured over the miner and the post office.
        new GameObject("CollisionBoxes").AddComponent<Arena.CollisionBoxView>();

        var driver = truck.gameObject.AddComponent<Arena.CoreDrivenTruck>();
        driver.terrain = _terrain;
        // The deck, not the bare relief: the truck stands on the road.
        driver.roads = FindFirstObjectByType<RoadNetwork>();

        // THE OTHER PLAYERS' TRUCKS. Nothing built this before, which is the
        // whole reason the hop was dead in a shipped page: `GhostField` was in
        // no scene and no script constructed it, so `ArenaNextGhost` was never
        // called and the pictures the JS client had already queued were drained
        // by nobody. Every test of the field made its own field, so the set
        // stayed green over a player that drew no ghost at all.
        //
        // It is resting on the SAME surface the local truck stands on - a
        // picture carries x, z and a heading and cannot carry a height, because
        // the map is the fee histogram and moves under everyone - and it draws
        // with a body of the same truck, fitted by the same rule and carrying
        // no physics.
        _ghosts = new GameObject("Ghosts");
        _ghosts.transform.SetParent(transform, false);
        var ghosts = _ghosts.AddComponent<Arena.GhostField>();
        ghosts.Model = BuildGhostBody();
        // THE SAME RESTING RULE THE LOCAL TRUCK USES, not a second one. It was
        // `driver.Ground(x, z) + driver.BodyAboveGround` - one sample under the
        // middle - while the truck itself is fitted across its four contact
        // points, and the two differ by 0.58 m at one measured pose on this map.
        ghosts.Rest = (x, z, headingDegrees) => driver.RideAt(x, z, headingDegrees);
        // AND THE SAME TILT THE LOCAL TRUCK IS DRAWN WITH (2026-09-18 10:42): the four contact points at that
        // pose, through the very function that lies the local truck on the ground. No physics is added by this - the
        // local truck has none here either.
        ghosts.Lie = (x, z, headingDegrees) =>
        {
            driver.Contacts(x, z, headingDegrees, out float fl, out float fr, out float rl, out float rr);
            return Arena.CoreDrivenTruck.Lie(headingDegrees, fl, fr, rl, rr,
                                            Arena.CoreDrivenTruck.HalfWheelbase, Arena.CoreDrivenTruck.HalfTrack);
        };

        // What a liquidation looks like: an aircraft, a bomb, and the ground it
        // leaves behind. Theatre - the core has no aircraft, and the hole is
        // already dug by the time the bomb is drawn falling into it.
        // Only with `-autoplay` on the command line: a player that drives its
        // own first ten seconds so a build can be photographed at a shape the
        // editor will not present. Nothing constructs this otherwise.
        if (AutoPlay.Asked) new GameObject("AutoPlay").AddComponent<AutoPlay>();

        var strikeGo = new GameObject("StrikeTheatre");
        strikeGo.transform.SetParent(transform, false);
        var strike = strikeGo.AddComponent<Arena.StrikeTheatre>();
        strike.terrain = _terrain;
        strike.roads = driver.roads;
        // AND THE FX, HERE. It used to be wired inside BuildArmies, which runs
        // long before this object exists, so `if (_strike != null)` was false
        // and the assignment was quietly skipped - the same trap the comment
        // below this describes for the truck. The consequence was silent: the
        // crater wipe called through a null and took nothing, and the running
        // build said so, "1 wreck(s) inside it ... wiped 0, 1 left inside".
        strike.fx = Fx;
        _strike = strike;

        // Practice starts on in this build. The scene's value is the fallback;
        // ?practice=0 in the URL overrides it, so a link can hand somebody the
        // build in the mode it was meant to be seen in.
        Arena.PracticeMode.Configure(practiceByDefault);
        Debug.Log($"[arena] practice {(Arena.PracticeMode.On ? "on" : "off")} " +
                  $"(from {Arena.PracticeMode.Source})");
        Field.courier = truck.transform;

        // Only here: BuildArmies runs before BuildTruck, so wiring this any
        // earlier hooked up a truck that did not exist yet - silently, because
        // every one of these is a null assignment that throws nothing.
        _truckHealth.fx = Fx;
        Field.health = _truckHealth;

        var audio = gameObject.AddComponent<GameAudio>();
        audio.truck = _truck;
        audio.ear = truck.transform;
        Audio = audio;

        // THE WAR HAS NO VOICE FOR NOW, and that is a stated price rather
        // than an oversight. The audio hung off `Fired`, `Shot`, `Destroyed`,
        // `Killed` and `Bombed` - events of the C# army, which no longer runs.
        // The core raises none of them yet; when it does, this and CombatFx
        // come back together. Guessing a bang from a position in C# would be a
        // second simulation of the thing that was just removed.
        // the chase camera is built further down, so both of these find it
        // themselves in Start rather than being handed a null here
        // The C# army no longer hurts the truck. `CourierHit` used to be wired
        // straight into `TruckHealth.Damage`, which computed the loss a second
        // time - the core was already taking the same shell off its own `T_HP`
        // and nothing read that back. One pool, and it is the core's; the view
        // is handed a snapshot in `Update` below.

        var wasted = gameObject.AddComponent<WastedSequence>();
        wasted.health = _truckHealth;
        _wasted = wasted;

        // The loading bay. The truck is held here until freight is aboard, and
        // the bay reopens on every respawn.
        var feed = gameObject.AddComponent<MempoolFeed>();
        var bay = truck.gameObject.AddComponent<CargoBay>();
        bay.crateMaterial = crateMaterial;
        bay.boxPrefab = boxPrefab;
        // THE LARGER TRUCK: the bay and the body drawn at the bed the core drives
        truck.gameObject.AddComponent<LargeTruckView>();

        // The yard: the waiting transactions as crates you can actually tap.
        var yardGo = new GameObject("PackageYard");
        yardGo.transform.SetParent(transform, false);
        yardGo.SetActive(false);                 // wire before Awake, as ever
        var yard = yardGo.AddComponent<PackageYard>();
        yard.feed = feed;
        yard.bay = bay;
        yard.truck = truck.transform;
        yard.crateMaterial = crateMaterial;
        yardGo.SetActive(true);

        var loadout = gameObject.AddComponent<LoadoutPanel>();
        // BUY ADD-ONS: the panel the cargo screen and the next round's countdown open, and the purchase banner
        gameObject.AddComponent<AddonsPanel>();
        loadout.feed = feed;
        loadout.bay = bay;
        loadout.yard = yard;
        loadout.truck = _truck;
        loadout.health = _truckHealth;
        loadout.market = Market;
        _cargo = bay;
        Field.cargo = bay;          // what is aboard sets how hard it is hunted

        // The far end of the run. Without it the freight has nowhere to go and
        // the whole loading bay is decoration.
        var gateGo = new GameObject("DeliveryGate");
        gateGo.transform.SetParent(transform, false);
        gateGo.SetActive(false);                 // wire before Awake, as ever
        var gate = gateGo.AddComponent<DeliveryGate>();
        gate.courier = truck.transform;
        gate.bay = bay;
        gate.truck = _truck;
        gate.health = _truckHealth;
        gate.loadout = loadout;
        // Without this the bay locks the controls but not the physics, and a
        // tank can write the truck off while the player is still choosing.
        if (_truckHealth != null) _truckHealth.loadout = loadout;

        // The start mark follows the ground.
        //
        // Everything above was assembled against the terrain as it stood at
        // boot, which is the flat stand-in it uses until the first fee
        // histogram lands. That histogram moves the ground by several metres,
        // and the truck was the one thing left standing at the old height -
        // inside the new one.
        var mark = _truck.gameObject.AddComponent<SpawnMark>();
        mark.terrain = _terrain;
        mark.post = _post;
        mark.truck = _truck;
        mark.loadout = loadout;
        gate.terrain = _terrain;
        gate.fx = Fx;
        gate.gateX = Arena.Layout.MINER_X / 65536f;        // the core's miner, moved east so the model clears the field
        gate.postMaterial = gateMaterial;
        gate.minerModel = minerModel;
        gateGo.SetActive(true);
        _gate = gate;

        // Section 18A of the P2P spec, made drivable. Subscribes to the gate,
        // so it has to exist before anything reads a score off it.
        var scoreGo = new GameObject("RunScore");
        scoreGo.transform.SetParent(transform, false);
        scoreGo.SetActive(false);
        var score = scoreGo.AddComponent<RunScore>();
        score.courier = truck.transform;
        score.field = Field;
        score.bay = bay;
        score.health = _truckHealth;
        score.truck = _truck;
        score.gate = gate;
        scoreGo.SetActive(true);
        _score = score;

        BuildCamera(truck);

        // the detailed models come in behind the game, not in front of it
        var streamer = gameObject.AddComponent<ModelStreamer>();
        streamer.bootstrap = this;
        streamer.army = Object.FindFirstObjectByType<ArmyRenderer>();
        streamer.fx = Fx;
        _streamer = streamer;
        gameObject.AddComponent<TouchControls>();
        var hud = gameObject.AddComponent<DriveHud>();
        hud.truck = truck;
        hud.market = Market;
        hud.strike = _strike;      // which liquidation the core took, and off which venue
        hud.field = Field;
        hud.streamer = _streamer;
        hud.health = _truckHealth;
        hud.wasted = _wasted;
        hud.gate = _gate;
        hud.runScore = _score;
        hud.loadout = Object.FindFirstObjectByType<LoadoutPanel>();
        // THE CHART (WAR_TACTICS.md §0.3): one TradingView chart with the truck on it, GROUND or ROUND on Tab. It paints
        // the core's chart words and nothing else.
        var chart = gameObject.AddComponent<ChartHud>();
        chart.loadout = hud.loadout;

        // The block is the round: it puts a price on time, without which the
        // safest possible load was also the best one.
        var clock = gameObject.AddComponent<BlockClock>();
        clock.gate = _gate;
        clock.stats = _stats;          // one chain, one height
        clock.audioSource = Audio;
        // The clock running out has to DO something, or it teaches the player
        // that time is free - and time is the only cost left on dawdling.
        clock.BlockClosed += _gate.OnBlockClosed;
        clock.BlockClosed += () => { if (_score != null) _score.Reset(); };
        hud.block = clock;
        Clock = clock;
        if (_post != null)
        {
            _post.clock = clock;
            _post.market = Market;
            if (_post.feed == null) _post.feed = Object.FindFirstObjectByType<MempoolFeed>();
        }

        // The free camera lives on the chase camera's own object, so it can
        // switch the chase behaviour off and take over the same view.
        var chaseCam = Object.FindFirstObjectByType<ChaseCamera>();
        if (chaseCam != null)
        {
            var spec = chaseCam.gameObject.AddComponent<SpectatorCamera>();
            spec.chase = chaseCam;
            spec.truck = truck.transform;
            spec.gate = _gate;
            spec.post = _post;

            // SPECTATE AFTER A WRECKED OR DELIVERED RUN (2026-10-03): the same camera, rising to top-down
            var after = chaseCam.gameObject.AddComponent<RunEndSpectate>();
            after.chase = chaseCam;
            after.truck = truck.transform;
            after.loadout = hud.loadout;
            after.spectator = spec;
            after.wasted = _wasted;          //: the rise waits for the live round's WASTED band to hold and fade
            after.health = _truckHealth;     //: and the next run's bay opens on a whole truck
        }

        var splash = gameObject.AddComponent<SplashScreen>();
        splash.truck = _truck;
        Splash = splash;
        if (hud.loadout != null) hud.loadout.splash = splash;
        hud.bay = _cargo;
    }

    /// <summary>
    /// Fill in any material the scene did not supply.
    ///
    /// Dropping this component on an empty object is the documented way to run
    /// the prototype, and an unassigned slot falls back to Unity's default
    /// material - a Built-in shader that does not exist in a URP build, so
    /// everything renders magenta. The URP/Lit shader is already referenced by
    /// the scene's material assets, so asking for it here cannot be stripped.
    /// </summary>
    void EnsureMaterials()
    {
        groundMaterial = Fallback(groundMaterial, new Color(0.34f, 0.31f, 0.27f), 0.92f);
        crateMaterial = Fallback(crateMaterial, new Color(0.62f, 0.45f, 0.26f), 0.85f);
        gateMaterial = Fallback(gateMaterial, new Color(0.96f, 0.78f, 0.12f), 0.6f);
        bullMaterial = Fallback(bullMaterial, new Color(0.24f, 0.52f, 0.28f), 0.55f);
        bearMaterial = Fallback(bearMaterial, new Color(0.62f, 0.22f, 0.20f), 0.55f);
        // effects are meant to read against sunlit ground, so they are near-white
        tracerMaterial = Fallback(tracerMaterial, new Color(1f, 0.92f, 0.55f), 0.2f);
        flashMaterial = Fallback(flashMaterial, new Color(1f, 0.96f, 0.78f), 0.15f);
        blastMaterial = Fallback(blastMaterial, new Color(1f, 0.55f, 0.14f), 0.35f);
        fireCoreMaterial = Fallback(fireCoreMaterial, new Color(1f, 0.97f, 0.86f), 0.1f);
        fireMaterial = Fallback(fireMaterial, new Color(1f, 0.48f, 0.10f), 0.3f);
        // 0.17 was near-black: as an opaque sphere that reads as a hole in the
        // ground rather than as smoke
        smokeMaterial = Fallback(smokeMaterial, new Color(0.46f, 0.44f, 0.42f), 0.95f);
        // 0.10 was a black rectangle in the air. Scorched metal that still
        // takes a highlight reads as a fragment; a silhouette reads as a bug.
        debrisMaterial = Fallback(debrisMaterial, new Color(0.28f, 0.26f, 0.24f), 0.55f);
        dustMaterial = Fallback(dustMaterial, new Color(0.72f, 0.66f, 0.56f), 0.95f);
        roadMaterial = Fallback(roadMaterial, new Color(0.12f, 0.12f, 0.13f), 0.72f);
        bodyMaterial = Fallback(bodyMaterial, new Color(0.16f, 0.34f, 0.22f), 0.45f);
        wheelMaterial = Fallback(wheelMaterial, new Color(0.05f, 0.05f, 0.06f), 0.95f);
        barrierMaterial = Fallback(barrierMaterial, new Color(0.58f, 0.55f, 0.50f), 0.85f);
    }

    static Material Fallback(Material assigned, Color colour, float roughness)
    {
        // instancing has to be on or RenderMeshInstanced silently draws nothing
        if (assigned != null) { assigned.enableInstancing = true; return assigned; }
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        if (shader == null) { Debug.LogError("[Bootstrap] no usable shader found"); return null; }
        var m = new Material(shader);
        m.SetColor("_BaseColor", colour);
        m.SetFloat("_Smoothness", 1f - roughness);
        m.enableInstancing = true;
        return m;
    }

    /// <summary>
    /// Undoes two quality settings that were quietly halving the whole game.
    ///
    /// globalTextureMipmapLimit was 1 on the level this build runs at, which
    /// DISCARDS the top mip of every texture - so a 970 x 1262 whitepaper was
    /// uploaded at 485 x 631 no matter what the file contained, and every
    /// texture in the world was at half resolution. anisotropicTextures was 0,
    /// which makes a per-texture anisoLevel do nothing at all.
    ///
    /// Both were fought for an afternoon from the other end: the whitepaper
    /// was recompressed, restored to full resolution and given filtering
    /// hints, and none of it could reach the screen.
    ///
    /// Set here rather than in the asset because the quality level is chosen
    /// at runtime by platform, and this has to hold whichever one is picked.
    /// </summary>
    void SharpenTextures()
    {
        QualitySettings.globalTextureMipmapLimit = 0;
        QualitySettings.anisotropicFiltering = AnisotropicFiltering.ForceEnable;
        Debug.Log("[Bootstrap] full-resolution textures, anisotropic filtering forced");
    }

    void BuildLighting()
    {
        var go = new GameObject("Sun");
        var light = go.AddComponent<Light>();
        light.type = LightType.Directional;
        light.color = sunColour;
        light.intensity = sunIntensity;
        light.shadows = LightShadows.Soft;
        light.shadowBias = 0.02f;
        // A low sun throws long shadows, and shadow is most of what tells you a
        // box is a tank. Overhead light flattens everything to its own colour.
        go.transform.rotation = Quaternion.Euler(sunPitch, sunYaw, 0f);

        // Exposure, measured rather than judged by eye: at a sun of 3.6 with
        // +1.05 EV on top, 57% of the pixels at the loading bay were pure
        // white. Concrete has an albedo near 0.7, so in full sun that lands
        // around 2.5 in linear light, doubled by the exposure to 5 - and ACES
        // maps anything past about 1.5 to paper. The bay was not overlit in
        // the model; it was overexposed by the camera.
        //
        // Flat sky ambient fills every crevice and cancels the sun's modelling.
        // A gradient keeps the ground dark and the sky bright, which is both
        // more like daylight and far more legible.
        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
        // Lifted well up. A gradient keeps the modelling that flat sky fill
        // destroys, but set too dark it just makes everything dim - which is
        // the other half of "no contrast".
        RenderSettings.ambientSkyColor = new Color(0.42f, 0.49f, 0.60f);
        RenderSettings.ambientEquatorColor = new Color(0.30f, 0.31f, 0.32f);
        RenderSettings.ambientGroundColor = new Color(0.16f, 0.15f, 0.14f);

        RenderSettings.fog = true;
        RenderSettings.fogMode = FogMode.ExponentialSquared;
        RenderSettings.fogDensity = 0.0022f;
        RenderSettings.fogColor = new Color(0.58f, 0.64f, 0.72f);

        if (postProfile != null)
        {
            var vol = new GameObject("PostProcessing");
            vol.transform.SetParent(transform, false);
            var v = vol.AddComponent<UnityEngine.Rendering.Volume>();
            v.isGlobal = true;
            v.sharedProfile = postProfile;
        }
    }

    MempoolTerrain BuildTerrain()
    {
        var go = new GameObject("MempoolTerrain");
        go.AddComponent<MeshFilter>();
        var mr = go.AddComponent<MeshRenderer>();
        if (groundMaterial != null) mr.sharedMaterial = groundMaterial;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        go.AddComponent<MeshCollider>();
        return go.AddComponent<MempoolTerrain>();
    }

    /// <summary>
    /// All five routes, with their own damage model. Replaces the prototype's
    /// single hand-built ribbon.
    /// </summary>
    void BuildRoads()
    {
        var go = new GameObject("Roads");
        go.transform.SetParent(transform, false);
        // INACTIVE first: AddComponent runs Awake immediately, and RoadNetwork
        // builds all five ribbons there. Assigning the terrain and material
        // afterwards is too late - the roads come out flat at y=0 with no
        // material, buried in the ground.
        go.SetActive(false);
        Roads = go.AddComponent<RoadNetwork>();
        // The road starts where the post office's apron stops. Both are placed
        // from the same number, so the two can never drift apart - and the
        // model behind the network does not exist until the object is active,
        // which is why this is a field on the component and not a property of
        // the model.
        Roads.pavedTo = Arena.Layout.POST_X / 65536f + PostOffice.ApronReach;
        Roads.terrain = _terrain;
        Roads.field = Field;
        Roads.roadMaterial = roadMaterial;
        Roads.lift = RoadLift;
        go.SetActive(true);
    }

    /// <summary>
    /// WITHDRAWN (ruling 4, 2026-09-22). Not called: the map edge is a CLAMP, and the core owes
    /// no wall solids. Kept unreferenced so the reasoning below is not lost - it is why the walls were
    /// tall and sunk, and a future edge rule has to answer it.
    ///
    /// Measured when they went: the core built its own four at +-185 while these stood at +-130, so the
    /// player and every replay walked different walls - which is the divergence, not a detail. With the
    /// clamp the truck reaches the true edge: the vectors' maxZ went 80.24 -> 85.00 and slalom's maxX
    /// 181.31 -> 185.00, and nothing ever leaves the map.
    ///
    /// Walls round the edge of the world.
    ///
    /// The respawn in TruckController is a safety net, not a boundary - being
    /// teleported back to the start because you drove too far is a punishment
    /// for exploring. A wall you can see and bounce off is a map edge.
    ///
    /// They are tall and sunk deep: a truck cresting a fee cliff at speed
    /// arrives at the edge airborne, and a wall it can fly over is not a wall.
    /// </summary>
    void BuildBoundary(MempoolTerrain terrain)
    {
        const float VisibleHeight = 3.2f;   // a kerb you can see, not a fence around the sky
        const float BlockHeight = 26f;      // the part that actually stops a truck
        const float Thickness = 3f;

        var root = new GameObject("Boundary");
        root.transform.SetParent(transform, false);

        // Placed once here, and put back by this whenever the drawn ground
        // moves - a mempool poll, or a crater taking the ground out from under
        // a wall.
        var keeper = root.AddComponent<Arena.SettleOnCoreGround>();
        keeper.terrain = terrain;

        float hw = terrain.width * 0.5f, hd = terrain.depth * 0.5f;
        // footprint only: the visual and the blocker each supply their own height
        var sides = new (string name, Vector3 centre, Vector2 footprint)[]
        {
            ("West",  new Vector3(-hw, 0f, 0f), new Vector2(Thickness, terrain.depth + Thickness * 2f)),
            ("East",  new Vector3( hw, 0f, 0f), new Vector2(Thickness, terrain.depth + Thickness * 2f)),
            ("North", new Vector3(0f, 0f, -hd), new Vector2(terrain.width + Thickness * 2f, Thickness)),
            ("South", new Vector3(0f, 0f,  hd), new Vector2(terrain.width + Thickness * 2f, Thickness)),
        };

        foreach (var (name, centre, footprint) in sides)
        {
            float ground = keeper.Surface(centre.x, centre.z);

            // what you see: a low barrier sitting on the ground
            var visual = GameObject.CreatePrimitive(PrimitiveType.Cube);
            visual.name = $"Barrier_{name}";
            visual.transform.SetParent(root.transform, false);
            visual.transform.position = new Vector3(centre.x, ground + VisibleHeight * 0.5f, centre.z);
            visual.transform.localScale = new Vector3(footprint.x, VisibleHeight, footprint.y);
            Destroy(visual.GetComponent<BoxCollider>());
            if (barrierMaterial != null) visual.GetComponent<MeshRenderer>().sharedMaterial = barrierMaterial;

            // what stops you: tall and invisible, so a truck arriving airborne
            // off a fee cliff still cannot clear the edge of the world
            var blocker = new GameObject($"Wall_{name}");
            blocker.transform.SetParent(root.transform, false);
            blocker.transform.position = new Vector3(centre.x, ground + BlockHeight * 0.5f - 6f, centre.z);
            var bc = blocker.AddComponent<BoxCollider>();
            bc.size = new Vector3(footprint.x, BlockHeight, footprint.y);

            keeper.Hold(visual.transform, centre.x, centre.z, VisibleHeight * 0.5f);
            keeper.Hold(blocker.transform, centre.x, centre.z, BlockHeight * 0.5f - 6f);
        }
    }

    /// <summary>
    /// Replace the truck's body with a model that arrived after the start.
    ///
    /// Only the visual is swapped: the rigidbody, the wheel colliders and the
    /// hull collider stay exactly as they were, so the truck keeps driving
    /// through the change instead of being rebuilt under the player.
    /// </summary>
    public void SwapTruckModel(GameObject prefab)
    {
        if (prefab == null || _truckRoot == null) return;
        truckModel = prefab;

        var old = _truckRoot.Find("Body");
        if (old != null) Destroy(old.gameObject);
        foreach (var w in _modelWheels) if (w != null) Destroy(w.gameObject);
        _modelWheels.Clear();
        _wheelTaken = 0;

        var body = Instantiate(prefab, _truckRoot);
        body.name = "Body";
        body.transform.localPosition = Vector3.zero;
        NormaliseTruckModel(body, _truckRoot);

        // hand the model's own wheels to the colliders that were already there
        if (_truck != null)
            foreach (var axle in _truck.axles)
            {
                if (axle == null) continue;
                if (_wheelTaken < _modelWheels.Count) axle.leftMesh = _modelWheels[_wheelTaken++];
                if (_wheelTaken < _modelWheels.Count) axle.rightMesh = _modelWheels[_wheelTaken++];
            }
        // AND THE GHOSTS DRAW THE SAME TRUCK. The model streams in after the
        // scene is built, so a field made at start holds the proxy; without
        // this every other player stays a box for the whole session.
        var field = _ghosts != null ? _ghosts.GetComponent<Arena.GhostField>() : null;
        if (field != null)
        {
            var was = field.Model;
            field.Model = BuildGhostBody();
            if (was != null) Destroy(was);
        }

        Debug.Log("[Bootstrap] truck model swapped in");
    }

    /// <summary>
    /// The body a ghost is drawn with: this truck, at this size, inert.
    ///
    /// Kept INACTIVE - it is a template, not a truck standing at the origin -
    /// and `GhostField` activates each clone. The streamed model when there is
    /// one, the same proxy box `BuildTruck` falls back to when there is not, so
    /// a page that never finishes streaming still shows where the others are.
    ///
    /// `FitTruckBody` and not `NormaliseTruckModel`: lifting the wheels out
    /// writes `_modelWheels`, and that list belongs to the local truck's axles.
    /// </summary>
    GameObject BuildGhostBody()
    {
        var template = new GameObject("GhostBody");
        template.transform.SetParent(transform, false);
        template.SetActive(false);

        if (truckModel != null)
        {
            var body = Instantiate(truckModel, template.transform);
            body.name = "Body";
            body.transform.localPosition = Vector3.zero;
            FitTruckBody(body, template.transform);
            DressTruckBody(body);
        }
        else
        {
            var box = GameObject.CreatePrimitive(PrimitiveType.Cube);
            box.name = "BodyProxy";
            box.transform.SetParent(template.transform, false);
            box.transform.localScale = new Vector3(2.4f, 2.2f, 6.2f);
            box.transform.localPosition = new Vector3(0f, 1.0f, 0f);
            StripColliders(box);
            if (bodyMaterial != null) box.GetComponent<MeshRenderer>().sharedMaterial = bodyMaterial;
        }
        return template;
    }

    ModelStreamer _streamer;
    GameObject _ghosts;
    Transform _truckRoot;
    TruckController _truck;
    TruckHealth _truckHealth;
    WastedSequence _wasted;
    CargoBay _cargo;
    DeliveryGate _gate;
    PostOffice _post;
    ChainStats _stats;

    /// <summary>Live chain state, shared by both buildings.</summary>
    public ChainStats Stats => _stats;
    RunScore _score;

    /// <summary>The building the run starts from.</summary>
    public PostOffice Post => _post;

    /// <summary>The run score, for tests and for the HUD.</summary>
    public RunScore Score => _score;

    /// <summary>Both armies, fed by the same tape that moves the frontline.</summary>
    void BuildArmies()
    {
        // NO C# ARMY IS BUILT. The core fields one - ninety-six slots, twelve
        // tanks and thirty-six men a side - and since `UploadArmour` was
        // deleted the two could not see each other: the player watched an army
        // that decided nothing while the truck was shot at and blocked by an
        // army nobody drew. `ArmyRenderer` reads the core now.

        var go = new GameObject("Armies");
        go.transform.SetParent(transform, false);
        go.SetActive(false);                    // wire before Awake, as ever
        var renderer = go.AddComponent<ArmyRenderer>();
        renderer.terrain = _terrain;
        renderer.roads = Roads;
        renderer.bullMaterial = bullMaterial;
        renderer.bearMaterial = bearMaterial;
        renderer.soldierPrefab = soldierPrefab;
        renderer.soldierYawOffset = soldierYawOffset;
        renderer.soldierAnimator = soldierAnimator;
        renderer.tankPrefab = tankPrefab;
        renderer.tankYawOffset = tankYawOffset;
        renderer.debrisMaterialForBombs = debrisMaterial;
        renderer.bombPrefab = bombPrefab;
        go.SetActive(true);

        var fxGo = new GameObject("CombatFx");
        fxGo.transform.SetParent(transform, false);
        fxGo.SetActive(false);
        Fx = fxGo.AddComponent<CombatFx>();
        Fx.terrain = _terrain;
        Fx.roads = Roads;
        // The strike's voice is NOT wired here. It cannot be: the theatre is
        // not made until later in the build and `GameAudio` is not made until
        // after this method, so the line that used to sit here was skipped and
        // would have handed over null if it had run. `StrikeTheatre` fetches
        // `GameAudio` itself at the impact.
        Fx.tracerMaterial = tracerMaterial;
        Fx.flashMaterial = flashMaterial;
        Fx.blastMaterial = blastMaterial;
        Fx.bullMaterial = bullMaterial;
        Fx.bearMaterial = bearMaterial;
        Fx.bodyPrefab = soldierPrefab;
        Fx.fireCoreMaterial = fireCoreMaterial;
        Fx.fireMaterial = fireMaterial;
        Fx.smokeMaterial = smokeMaterial;
        Fx.debrisMaterial = debrisMaterial;
        Fx.dustMaterial = dustMaterial;
        Fx.fireParticleMaterial = fireParticleMaterial;
        Fx.smokeParticleMaterial = smokeParticleMaterial;
        Fx.wreckPrefab = tankPrefab;
        fxGo.SetActive(true);
        // Not bound: `CombatFx` lives on the C# army's events and the core
        // raises none. Item 7 owns this, and until then there are no muzzle
        // flashes, tracers or corpses. Said out loud rather than left to be
        // discovered on screen.
    }

    TruckController BuildTruck(MempoolTerrain terrain)
    {
        float startX = Arena.Layout.POST_X / 65536f;      // the core's post office, the same number the building took
        var root = new GameObject("Truck");

        // Parked in a loading bay, not on an empty apron. Bay 1 while nobody
        // else is on the map - which is always, until there is multiplayer.
        // BayFor is arithmetic, not geometry, so it can be asked before the
        // building's Start has run - which it has not, because SetActive only
        // runs Awake immediately and Start waits for the frame. Gating on a
        // flag set in Start left every truck parked at z = 0, 79 m from Bay 1.
        var at = _post != null
            ? _post.BayFor(PostOffice.SoloBay)
            : new Vector3(startX, terrain.SampleWorld(startX, 0f) + 1.4f, 0f);
        root.transform.position = at;
        root.transform.rotation = Quaternion.LookRotation(Vector3.right, Vector3.up);

        // its own layer, so a body it runs over cannot throw it into the air
        root.layer = CombatFx.CourierLayer;
        var rb = root.AddComponent<Rigidbody>();
        rb.mass = 2100f;
        rb.linearDamping = 0.05f;
        rb.angularDamping = 2.5f;
        rb.interpolation = RigidbodyInterpolation.Interpolate;
        rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

        // body: the imported model if there is one, a proxy box otherwise
        GameObject body;
        if (truckModel != null)
        {
            body = Instantiate(truckModel, root.transform);
            body.name = "Body";
            body.transform.localPosition = Vector3.zero;
            NormaliseTruckModel(body, root.transform);
        }
        else
        {
            body = GameObject.CreatePrimitive(PrimitiveType.Cube);
            body.name = "BodyProxy";
            body.transform.SetParent(root.transform, false);
            body.transform.localScale = new Vector3(2.4f, 2.2f, 6.2f);
            body.transform.localPosition = new Vector3(0f, 1.0f, 0f);
            StripColliders(body);
            if (bodyMaterial != null) body.GetComponent<MeshRenderer>().sharedMaterial = bodyMaterial;
        }

        // Collision hull, kept separate from the visual body. It has to clear the
        // wheel contact patch by a good margin: the wheels sit at -0.2 with a
        // 0.55 radius, so anything below about -0.1 leaves the chassis dragging
        // on the ground, the suspension unloaded and the tyres spinning freely.
        var hull = root.AddComponent<BoxCollider>();
        hull.size = new Vector3(2.4f, 2.0f, 6.2f);
        hull.center = new Vector3(0f, 0.95f, 0f);

        var controller = root.AddComponent<TruckController>();
        _truckRoot = root.transform;
        _truck = controller;

        // Condition, destruction and the respawn wait. Fx and the army are
        // hooked up later, once both exist.
        _truckHealth = root.AddComponent<TruckHealth>();
        _truckHealth.truck = controller;
        controller.spawnPosition = root.transform.position;
        controller.spawnRotation = root.transform.rotation;
        controller.axles = new[]
        {
            BuildAxle(root.transform, 2.0f, true, false, false),   // front: steers
            BuildAxle(root.transform, -1.8f, false, true, true),   // rear: driven, handbraked
        };
        return controller;
    }

    /// <summary>
    /// Make an imported truck usable.
    ///
    /// Scaled from its own rendered bounds to the length the physics rig
    /// expects, then shifted so its SOLE meets the wheels' contact patch rather
    /// than the chassis origin. The origin sits 0.75 above that patch - wheels
    /// at -0.2 with a 0.55 radius - so a model dropped straight on the origin
    /// floats, and one positioned from world-space bounds (which is what this
    /// did) lands wherever the truck happened to spawn.
    ///
    /// Its wheels are then pulled OUT of the body and handed to the pool the
    /// WheelColliders drive: left in place they turn with the chassis and never
    /// spin, which is the fault this project already fixed once in three.js.
    /// </summary>
    /// <summary>
    /// The model's box measured along the TRUCK's own axes.
    ///
    /// `Renderer.bounds` is axis-aligned in WORLD space, so a truck standing
    /// at an angle is measured across its diagonal and comes out longer than
    /// it is. Sizing off that made the streamed truck a DIFFERENT SIZE on
    /// every heading: over eight rounds that differed by nothing except which
    /// way the truck was pointing, the same wheel came back resting on 0.503,
    /// 0.488, 0.486, 0.493, 0.507 and 0.518 m. The sole had the same fault -
    /// the world box's floor is below the model's own - so a truck delivered
    /// at an angle was also set down at the wrong height.
    ///
    /// Each renderer's OWN box is carried corner by corner into `space`,
    /// which is exact under any rotation and needs no Read/Write on the
    /// import. Same family as the wheel: a box around a turned thing is not
    /// the thing.
    /// </summary>
    static Bounds Measure(Renderer[] renderers, Transform space)
    {
        bool any = false;
        var box = new Bounds();
        foreach (var r in renderers)
        {
            if (r == null) continue;
            var lb = r.localBounds;
            var l2w = r.transform.localToWorldMatrix;
            for (int c = 0; c < 8; c++)
            {
                var corner = new Vector3((c & 1) == 0 ? lb.min.x : lb.max.x,
                                         (c & 2) == 0 ? lb.min.y : lb.max.y,
                                         (c & 4) == 0 ? lb.min.z : lb.max.z);
                var p = space.InverseTransformPoint(l2w.MultiplyPoint3x4(corner));
                if (!any) { box = new Bounds(p, Vector3.zero); any = true; }
                else box.Encapsulate(p);
            }
        }
        return box;
    }

    /// <summary>
    /// A truck model at the size and height the rig expects, and nothing else.
    ///
    /// Split out of `NormaliseTruckModel` because a GHOST needs exactly this
    /// half and none of the other: the wheels must NOT be lifted out of a
    /// ghost's body, since lifting them writes `_modelWheels`, which is the
    /// list the LOCAL truck's axles are handed. One rule for how big a truck is
    /// and where its sole sits, used by both.
    /// </summary>
    /// <summary>How long a truck is, whatever the model was authored at.</summary>
    const float TruckBodyLength = 6.4f;

    bool FitTruckBody(GameObject body, Transform root)
    {
        var renderers = body.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length == 0)
        {
            Debug.LogWarning("[Bootstrap] truck model has no renderers");
            return false;
        }

        var bounds = Measure(renderers, root);
        // longest horizontal axis is the length, whichever way it was modelled
        float longest = Mathf.Max(bounds.size.x, bounds.size.z);
        if (longest > 0.0001f) body.transform.localScale = Vector3.one * (TruckBodyLength / longest);

        // measure again after scaling
        bounds = Measure(renderers, root);
        float soleLocalY = bounds.min.y;
        const float ContactPatch = -0.75f;      // where the tyres meet the ground
        body.transform.localPosition = new Vector3(0f, ContactPatch - soleLocalY, 0f);
        return true;
    }

    void NormaliseTruckModel(GameObject body, Transform root)
    {
        if (!FitTruckBody(body, root)) return;

        _modelWheels.Clear();
        foreach (var t in body.GetComponentsInChildren<Transform>(true))
        {
            string n = t.name.ToLowerInvariant();
            if (n.Contains("wheel") || n.Contains("tire") || n.Contains("tyre"))
                _modelWheels.Add(t);
        }
        foreach (var w in _modelWheels)
        {
            foreach (var r in w.GetComponentsInChildren<Renderer>(true))
            {
                var mats = new Material[r.sharedMaterials.Length];
                for (int i = 0; i < mats.Length; i++) mats[i] = ToUrp(r.sharedMaterials[i]);
                r.sharedMaterials = mats;
            }
            // Strip their colliders BEFORE detaching. The body is cleaned up
            // below, but by then the wheels have already left it - so any
            // collider they carried survives as a loose solid being teleported
            // to a wheel position every frame, shoving the truck it belongs to.
            foreach (var c in w.GetComponentsInChildren<Collider>(true)) { c.enabled = false; Destroy(c); }
            w.SetParent(null, true);
        }

        int converted = DressTruckBody(body);
        Debug.Log($"[Bootstrap] truck model scaled to {TruckBodyLength}m, " +
                  $"{_modelWheels.Count} wheels lifted out, {converted} materials converted");
    }

    /// <summary>
    /// A truck body with no colliders and materials this pipeline can draw.
    ///
    /// The pack ships Built-in materials. In a URP build that shader is not
    /// there at all, so the body renders NOTHING while still casting a shadow -
    /// which looks exactly like a truck-shaped hole in the world. A ghost needs
    /// this as much as the local truck does, and for the collider strip it
    /// needs it more: `GhostTruck` strips again in Awake, but a body that
    /// arrives clean never has a solid frame at all.
    /// </summary>
    int DressTruckBody(GameObject body)
    {
        foreach (var c in body.GetComponentsInChildren<Collider>(true)) Destroy(c);

        int converted = 0;
        foreach (var r in body.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) { mats[i] = ToUrp(r.sharedMaterials[i]); converted++; }
            r.sharedMaterials = mats;
        }
        return converted;
    }

    /// <summary>
    /// A URP material carrying whatever the source had. Cached, so a model with
    /// repeated materials does not end up with a copy per renderer.
    /// </summary>
    Material ToUrp(Material source)
    {
        if (source == null) return bodyMaterial;
        if (_urpCache.TryGetValue(source, out var hit)) return hit;

        var shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null) return bodyMaterial;

        var m = new Material(shader);
        Texture tex = source.HasProperty("_BaseMap") ? source.GetTexture("_BaseMap")
                    : source.HasProperty("_MainTex") ? source.GetTexture("_MainTex")
                    : null;
        if (tex != null) m.SetTexture("_BaseMap", tex);
        Color c = source.HasProperty("_BaseColor") ? source.GetColor("_BaseColor")
                : source.HasProperty("_Color") ? source.GetColor("_Color")
                : Color.white;
        m.SetColor("_BaseColor", tex != null ? Color.white : c);
        m.SetFloat("_Smoothness", 0.3f);
        _urpCache[source] = m;
        return m;
    }

    readonly System.Collections.Generic.Dictionary<Material, Material> _urpCache =
        new System.Collections.Generic.Dictionary<Material, Material>();

    readonly System.Collections.Generic.List<Transform> _modelWheels =
        new System.Collections.Generic.List<Transform>();
    int _wheelTaken;

    TruckController.Axle BuildAxle(Transform root, float z, bool steering, bool driven, bool handbraked)
    {
        var axle = new TruckController.Axle { steering = steering, driven = driven, handbraked = handbraked };
        axle.left = BuildWheel(root, new Vector3(-1.15f, -0.2f, z), "L", out axle.leftMesh);
        axle.right = BuildWheel(root, new Vector3(1.15f, -0.2f, z), "R", out axle.rightMesh);
        return axle;
    }

    WheelCollider BuildWheel(Transform root, Vector3 local, string tag, out Transform mesh)
    {
        var go = new GameObject($"Wheel{tag}{local.z:0.0}");
        go.transform.SetParent(root, false);
        go.transform.localPosition = local;

        var wheel = go.AddComponent<WheelCollider>();
        wheel.mass = 70f;
        wheel.radius = 0.55f;
        wheel.suspensionDistance = 0.3f;
        wheel.wheelDampingRate = 1.2f;
        var spring = wheel.suspensionSpring;
        spring.spring = 42000f; spring.damper = 4200f; spring.targetPosition = 0.45f;
        wheel.suspensionSpring = spring;
        var fwd = wheel.forwardFriction; fwd.stiffness = 2.0f; wheel.forwardFriction = fwd;
        var side = wheel.sidewaysFriction; side.stiffness = 2.4f; wheel.sidewaysFriction = side;

        // visual, posed each frame from the collider
        if (_wheelTaken < _modelWheels.Count)
        {
            // a wheel lifted out of the imported truck, in the order it was found
            mesh = _modelWheels[_wheelTaken++];
        }
        else if (wheelModel != null)
        {
            mesh = Instantiate(wheelModel).transform;
        }
        else
        {
            var proxy = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            proxy.name = go.name + "Mesh";
            proxy.transform.localScale = new Vector3(1.1f, 0.16f, 1.1f);
            // a Unity cylinder stands on its end; a wheel lies on its side
            proxy.transform.rotation = Quaternion.Euler(0f, 0f, 90f);
            StripColliders(proxy);
            if (wheelMaterial != null) proxy.GetComponent<MeshRenderer>().sharedMaterial = wheelMaterial;
            mesh = proxy.transform;
        }
        return wheel;
    }

    /// <summary>
    /// Primitives arrive with a collider, and which one depends on the shape, so
    /// asking for a specific type silently misses. They also have to be disabled
    /// on the spot: Destroy only takes effect at the end of the frame, and until
    /// then these are solid bodies being teleported around by the wheel poser.
    /// </summary>
    static void StripColliders(GameObject go)
    {
        foreach (var c in go.GetComponentsInChildren<Collider>(true)) { c.enabled = false; Destroy(c); }
    }

    void BuildCamera(TruckController truck)
    {
        var go = new GameObject("ChaseCamera");
        var cam = go.AddComponent<Camera>();
        // The loading panel draws its crates on its own layer with its own
        // camera. The game camera must never see them.
        cam.cullingMask &= ~(1 << PackageYard.YardLayer);
        cam.fieldOfView = 62f;
        cam.farClipPlane = 900f;
        // a Volume in the scene does nothing unless the camera opts in
        var urp = go.AddComponent<UniversalAdditionalCameraData>();
        urp.renderPostProcessing = true;
        urp.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
        go.AddComponent<AudioListener>();
        var chase = go.AddComponent<ChaseCamera>();
        chase.target = truck.transform;
        chase.targetBody = truck.GetComponent<Rigidbody>();
        chase.terrain = _terrain;
    }
}
