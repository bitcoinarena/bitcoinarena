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
    public float sunIntensity = 3.6f;

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

    void Start()
    {
        EnsureMaterials();
        BuildLighting();
        _terrain = BuildTerrain();

        // live tape first: the frontline is the price chart, so everything
        // downstream wants it already ticking
        Market = gameObject.AddComponent<MarketFeed>();
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
        BuildBoundary(_terrain);
        var truck = BuildTruck(_terrain);
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

        // The war gets a voice. Hung off the same events the effects use, so a
        // shot that is drawn is a shot that is heard.
        var army = Field.Army;
        army.Fired += (from, at) => audio.Cannon(new Vector2(from.x, from.z));
        army.Shot += (from, at) => audio.Rifle(new Vector2(from.x, from.z));
        army.Destroyed += u => audio.Destroyed(new Vector2(u.x, u.z));
        army.Killed += (u, at) => audio.Hit(new Vector2(u.x, u.z));
        army.Bombed += at => audio.Destroyed(at);
        army.CourierHit += _ => audio.Hit(new Vector2(truck.transform.position.x,
                                                      truck.transform.position.z));
        // the chase camera is built further down, so both of these find it
        // themselves in Start rather than being handed a null here
        Field.Army.CourierHit += _truckHealth.Damage;

        var wasted = gameObject.AddComponent<WastedSequence>();
        wasted.health = _truckHealth;
        _wasted = wasted;

        // The loading bay. The truck is held here until freight is aboard, and
        // the bay reopens on every respawn.
        var feed = gameObject.AddComponent<MempoolFeed>();
        var bay = truck.gameObject.AddComponent<CargoBay>();
        bay.crateMaterial = crateMaterial;
        bay.boxPrefab = boxPrefab;

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
        gate.terrain = _terrain;
        gate.fx = Fx;
        gate.gateX = _terrain.width * 0.44f;
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
        hud.field = Field;
        hud.streamer = _streamer;
        hud.health = _truckHealth;
        hud.wasted = _wasted;
        hud.gate = _gate;
        hud.runScore = _score;
        hud.loadout = Object.FindFirstObjectByType<LoadoutPanel>();

        // The block is the round: it puts a price on time, without which the
        // safest possible load was also the best one.
        var clock = gameObject.AddComponent<BlockClock>();
        clock.gate = _gate;
        clock.audioSource = Audio;
        // The clock running out has to DO something, or it teaches the player
        // that time is free - and time is the only cost left on dawdling.
        clock.BlockClosed += _gate.MissTheBlock;
        clock.BlockClosed += () => { if (_score != null) _score.Reset(); };
        hud.block = clock;
        Clock = clock;

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

        // Flat sky ambient fills every crevice and cancels the sun's modelling.
        // A gradient keeps the ground dark and the sky bright, which is both
        // more like daylight and far more legible.
        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
        // Lifted well up. A gradient keeps the modelling that flat sky fill
        // destroys, but set too dark it just makes everything dim - which is
        // the other half of "no contrast".
        RenderSettings.ambientSkyColor = new Color(0.62f, 0.72f, 0.86f);
        RenderSettings.ambientEquatorColor = new Color(0.44f, 0.45f, 0.46f);
        RenderSettings.ambientGroundColor = new Color(0.20f, 0.19f, 0.17f);

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
        Roads.terrain = _terrain;
        Roads.field = Field;
        Roads.roadMaterial = roadMaterial;
        Roads.lift = RoadLift;
        go.SetActive(true);
    }

    /// <summary>
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
            float ground = terrain.SampleWorld(centre.x, centre.z);

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
        Debug.Log("[Bootstrap] truck model swapped in");
    }

    ModelStreamer _streamer;
    Transform _truckRoot;
    TruckController _truck;
    TruckHealth _truckHealth;
    WastedSequence _wasted;
    CargoBay _cargo;
    DeliveryGate _gate;
    RunScore _score;

    /// <summary>The run score, for tests and for the HUD.</summary>
    public RunScore Score => _score;

    /// <summary>Both armies, fed by the same tape that moves the frontline.</summary>
    void BuildArmies()
    {
        Field.Army = new Army(System.Environment.TickCount)
        {
            FrontlineAt = Field.FrontlineZ,
            // gunships hold a height over the ground, not over sea level
            GroundAt = (x, z) => _terrain.SampleSurface(x, z),
        };
        Field.Army.Populate(armourPerSide, infantryPerSide);

        var go = new GameObject("Armies");
        go.transform.SetParent(transform, false);
        go.SetActive(false);                    // wire before Awake, as ever
        var renderer = go.AddComponent<ArmyRenderer>();
        renderer.army = Field.Army;
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
        Fx.army = Field.Army;
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
        Fx.Bind(Field.Army);
    }

    TruckController BuildTruck(MempoolTerrain terrain)
    {
        float startX = -terrain.width * 0.44f;
        var root = new GameObject("Truck");
        root.transform.position = new Vector3(startX, terrain.SampleWorld(startX, 0f) + 1.4f, 0f);
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
    void NormaliseTruckModel(GameObject body, Transform root)
    {
        var renderers = body.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length == 0)
        {
            Debug.LogWarning("[Bootstrap] truck model has no renderers");
            return;
        }

        Bounds World()
        {
            var b = renderers[0].bounds;
            foreach (var r in renderers) b.Encapsulate(r.bounds);
            return b;
        }

        var bounds = World();
        // longest horizontal axis is the length, whichever way it was modelled
        float longest = Mathf.Max(bounds.size.x, bounds.size.z);
        const float WantedLength = 6.4f;
        if (longest > 0.0001f) body.transform.localScale = Vector3.one * (WantedLength / longest);

        // measure again after scaling, in the TRUCK's space, not the world's
        bounds = World();
        float soleLocalY = root.InverseTransformPoint(
            new Vector3(bounds.center.x, bounds.min.y, bounds.center.z)).y;
        const float ContactPatch = -0.75f;      // where the tyres meet the ground
        body.transform.localPosition = new Vector3(0f, ContactPatch - soleLocalY, 0f);

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

        foreach (var c in body.GetComponentsInChildren<Collider>(true)) Destroy(c);

        // The pack ships Built-in materials. In a URP build that shader is not
        // there at all, so the body renders NOTHING while still casting a
        // shadow - which looks exactly like a truck-shaped hole in the world.
        int converted = 0;
        foreach (var r in body.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) { mats[i] = ToUrp(r.sharedMaterials[i]); converted++; }
            r.sharedMaterials = mats;
        }
        Debug.Log($"[Bootstrap] truck model scaled to {WantedLength}m, " +
                  $"{_modelWheels.Count} wheels lifted out, {converted} materials converted");
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
