using UnityEngine;

/// <summary>
/// The far end of the run: drive the freight through the gate and it is
/// delivered.
///
/// This closes the loop the loading bay opens. Without it the player picks
/// transactions, drives across a battlefield and then nothing happens, which
/// makes the whole cargo system decoration.
///
/// The gate is built in code, like the rest of the scene, and it is WIDE: the
/// point of the run is surviving the war in the middle, not threading a needle
/// at the end of it.
/// </summary>
public class DeliveryGate : MonoBehaviour
{
    public Transform courier;
    public CargoBay bay;
    public TruckController truck;
    public TruckHealth health;
    public LoadoutPanel loadout;
    public MempoolTerrain terrain;
    public CombatFx fx;
    public GameAudio audio;

    [Tooltip("Where the gate stands. Mirrors the spawn at the other end.")]
    public float gateX = 114f;

    [Tooltip("Half the width of the mouth, along z.")]
    public float halfMouth = 34f;

    [Tooltip("How long the arrival card is left alone before the loading bay " +
             "reopens over it. The card carries the score and its breakdown, " +
             "which is the only moment the player sees how the run was priced.")]
    public float scoreHoldSeconds = 5.6f;

    public Material postMaterial;

    [Tooltip("The miner megastructure. Without it the gate falls back to two " +
             "posts and a beam, so the scene still builds on a fresh clone.")]
    public GameObject minerModel;

    [Tooltip("Height only. The model is 134 m tall as authored, which fills " +
             "the upper half of a phone screen; 0.78 gives the sky back.")]
    public float minerHeightScale = 1f;

    /// <summary>
    /// Height, and ONLY height - and currently 1, which is to say: off.
    ///
    /// Squashing Y alone avoided the map gap that uniform scaling opens, but
    /// it SHEARS every rotated part of the building: a child turned 291
    /// degrees under a (1, 0.45, 1) parent comes out with a lossy scale of
    /// (0.63, 0.82, 1.00), which is why the fan blades sat crooked in their
    /// rings. Non-uniform scale and rotation do not compose.
    ///
    /// So there is no runtime scale that works: uniform opens a way round the
    /// building, non-uniform bends it. The height has to come out of the model
    /// itself, and until it does this stays at 1.
    ///
    /// Scaling the building uniformly was the obvious thing and it opened a
    /// hole in the map: at 0.75 the shell spans 126 m against the map's 170,
    /// leaving 22 m of clear ground down each side to drive around the whole
    /// building through. Width and depth therefore stay at 1, and the fans go
    /// very slightly oval - which at 90 m tall and 200 m away nobody will ever
    /// see, whereas a way round the goal everybody would find.
    /// </summary>
    Vector3 MinerScale => new Vector3(1f, minerHeightScale, 1f);

    /// <summary>
    /// The model faces +X as imported, and the truck drives +X - so it arrives
    /// at the back. glTFast negates X on import: ground_entry_marking is at
    /// glTF -23 and lands at Unity +23, which puts the approach apron behind
    /// the building. Half a turn fixes it, and the collision shell turns with
    /// it so every local offset below stays valid.
    /// </summary>
    static readonly Quaternion FaceThePlayer = Quaternion.Euler(0f, 180f, 0f);

    // Measured off the imported model rather than guessed, at scale 1.
    const float MouthHalfWidth = 40f;    // local z -40 .. +40
    const float MouthHeight = 26f;       // local y  -1.2 .. 26
    const float ShellHalfWidth = 84.4f;  // local z -84.4 .. +84.4
    const float ShellHeight = 133.2f;

    /// <summary>Total fees delivered, in sats. This is the score.</summary>
    public long SatsDelivered { get; private set; }

    /// <summary>Completed runs.</summary>
    public int Runs { get; private set; }

    /// <summary>Sats banked by the last run, for the HUD flash.</summary>
    public long LastRun { get; private set; }

    /// <summary>BTC moved by the last run, for the block tally.</summary>
    public double LastBtc { get; private set; }

    /// <summary>Seconds since the last delivery, or a large number.</summary>
    public float SinceDelivery { get; private set; } = 999f;

    public System.Action<long> Delivered;

    [Tooltip("True when the miner is expected to arrive over Addressables, " +
             "so the fallback posts are not drawn in the meantime.")]
    public bool streamed = true;

    /// <summary>
    /// The megastructure has arrived from the streamer: put it up.
    ///
    /// Streamed for the same reason the tank is - it is 800 KB of building
    /// that nobody needs in the first frame, and the initial download is what
    /// decides whether a phone on 5G ever sees the game at all. The collision
    /// shell does NOT wait for it: the wall is up from Start, so the run can
    /// never be driven through a hole that the model was going to fill.
    /// </summary>
    public void ShowMiner(GameObject model)
    {
        if (model == null || _minerUp) return;
        minerModel = model;
        _minerUp = true;

        foreach (var n in new[] { "GatePostLeft", "GatePostRight", "GateBeam" })
        {
            var old = transform.Find(n);
            if (old != null) Destroy(old.gameObject);
        }

        float ground = terrain != null ? terrain.SampleSurface(gateX, 0f) : 0f;
        BuildMiner(ground);
    }

    bool _minerUp;
    Transform _miner, _shell;
    int _seenGround = -1;

    /// <summary>
    /// Put the building back on the ground after the ground has moved.
    ///
    /// The same watch the post office keeps at the other end: the terrain is
    /// the live fee histogram, so its height under the miner changes with the
    /// mempool, and a megastructure set down once at boot spends the rest of
    /// the session either on stilts or up to its mouth in the ground.
    /// </summary>
    void FollowTheGround()
    {
        if (terrain == null || terrain.Version == _seenGround) return;
        _seenGround = terrain.Version;

        float ground = terrain.SampleSurface(gateX, 0f);
        if (_miner != null) _miner.position = new Vector3(gateX, ground, 0f);
        if (_shell != null) _shell.position = new Vector3(gateX, ground, 0f);
    }

    /// <summary>Unscaled time the last run timed out, for the HUD notice.</summary>
    public float MissedAt { get; private set; } = -99f;

    /// <summary>Runs that ran out of block. Not deliveries, and not wrecks.</summary>
    public int Missed { get; private set; }

    /// <summary>
    /// The block closed with freight still aboard: the run is over and it
    /// scored nothing.
    ///
    /// This is what makes the clock mean something. Arriving late is now a
    /// loss rather than a slightly worse arrival, which is the only thing that
    /// prices out dawdling once exposure stops paying for it.
    /// </summary>
    public void MissTheBlock()
    {
        if (bay == null || !bay.IsLoaded) return;
        if (health != null && health.IsDestroyed) return;

        Missed++;
        MissedAt = Time.unscaledTime;

        bay.Clear();
        if (truck != null) truck.Respawn();
        _reopenAt = Time.unscaledTime + Mathf.Max(0f, scoreHoldSeconds * 0.55f);
    }

    void Start() => Build();

    void Update()
    {
        SinceDelivery += Time.deltaTime;
        FollowTheGround();

        // The bay reopens a beat AFTER the arrival, not with it.
        //
        // Deliver() used to call loadout.Open() directly, so the modal covered
        // the score card in the same frame it appeared - the run was priced and
        // the player never saw the arithmetic. The pause is unscaled because a
        // delivery can land while the world is still in slow motion.
        if (_reopenAt > 0f && Time.unscaledTime >= _reopenAt)
        {
            _reopenAt = 0f;
            if (loadout != null) loadout.Open();
        }

        if (courier == null || bay == null) return;
        if (health != null && health.IsDestroyed) return;
        if (!bay.IsLoaded) return;

        var p = courier.position;
        if (p.x < gateX || Mathf.Abs(p.z) > halfMouth) return;

        Deliver();
    }

    void Deliver()
    {
        LastRun = bay.FeeCarried;
        LastBtc = bay.BtcCarried;
        SatsDelivered += LastRun;
        Runs++;
        SinceDelivery = 0f;

        if (fx != null)
        {
            // arrival is worth a bang, not an explosion
            var at = courier.position + Vector3.up * 1.5f;
            for (int i = 0; i < 12; i++)
                fx.Flash(at + new Vector3(Random.Range(-4f, 4f), Random.Range(0f, 4f),
                                          Random.Range(-4f, 4f)), Random.Range(1f, 2.4f));
        }

        if (audio == null) audio = FindFirstObjectByType<GameAudio>();
        if (audio != null) audio.Delivered();

        Delivered?.Invoke(LastRun);

        // Back to the ramp for the next run - but the bay stays shut until the
        // score card has had its moment. Clearing the bed and respawning are
        // safe to do now: the truck is at the gate, not being driven.
        bay.Clear();
        if (truck != null) truck.Respawn();
        _reopenAt = Time.unscaledTime + Mathf.Max(0f, scoreHoldSeconds);
    }

    float _reopenAt;

    /// <summary>The far end of the run: the miner, or two posts if it is absent.</summary>
    void Build()
    {
        float ground = terrain != null ? terrain.SampleSurface(gateX, 0f) : 0f;

        // The mouth is the goal, so the trigger cannot be wider than the mouth.
        // Scaling the building without this left 34 m of trigger either side of
        // centre against a 30 m half-opening, and the corners of the delivery
        // line sat inside solid wall.
        halfMouth = Mathf.Min(halfMouth, MouthHalfWidth - 3f);

        // The wall goes up whether or not the model does.
        //
        // Collision is what makes the end of the map a building rather than a
        // backdrop, and it must not depend on an asset reference that is null
        // in any scene built at runtime - which is every test that does not
        // load the saved scene. Tying the two together meant the playfield had
        // no far boundary at all in exactly the situation where a test would
        // check for one.
        Wall(ground);

        if (minerModel != null) { _minerUp = true; BuildMiner(ground); return; }

        // Nothing else is drawn while the building streams in.
        //
        // The posts were a stand-in for a missing model, but the collision
        // shell is already up and the miner arrives within seconds - two
        // yellow posts appearing and then vanishing inside a megastructure
        // reads as a bug, not as a placeholder.
        if (streamed) return;

        const float height = 9f;
        Post(new Vector3(gateX, ground + height * 0.5f, -halfMouth),
             new Vector3(2f, height, 2f), "GatePostLeft");
        Post(new Vector3(gateX, ground + height * 0.5f, halfMouth),
             new Vector3(2f, height, 2f), "GatePostRight");
        Post(new Vector3(gateX, ground + height, 0f),
             new Vector3(2.2f, 2.2f, halfMouth * 2f), "GateBeam");
    }

    /// <summary>
    /// The miner, its collision, and its moving parts.
    ///
    /// The model's own origin is placed at gateX, which puts the facade on the
    /// delivery line and leaves the tunnel mouth reaching back towards the
    /// player - so crossing gateX means being inside the tunnel, not merely
    /// near the building.
    /// </summary>
    void BuildMiner(float ground)
    {
        var miner = Instantiate(minerModel, new Vector3(gateX, ground, 0f),
                                FaceThePlayer, transform);
        miner.name = "MinerMegastructure";
        _miner = miner.transform;
        miner.transform.localScale = MinerScale;

        Spin(miner);

        // Batch the static parts WITHOUT touching the hierarchy.
        //
        // The first version lifted the fans, the coin, the bars and the screen
        // out to a sibling object so the combine could not bake their
        // transforms. That reparenting is what skewed them: the miner is
        // scaled (1, 0.45, 1) and turned half round, and a non-uniform scale
        // combined with rotation cannot survive a change of parent - Unity
        // approximates it and the fans came out sheared inside their rings.
        //
        // Combine takes an explicit list, so the moving parts simply stay
        // where they are and are left out of it.
        var statics = new System.Collections.Generic.List<GameObject>();
        foreach (var r in miner.GetComponentsInChildren<Renderer>(true))
        {
            bool live = false;
            for (var t = r.transform; t != null && t != miner.transform; t = t.parent)
                if (IsMoving(t.name)) { live = true; break; }
            if (!live) statics.Add(r.gameObject);
        }
        StaticBatchingUtility.Combine(statics.ToArray(), miner);
    }

    /// <summary>
    /// What must NOT be swallowed by static batching.
    ///
    /// Batching bakes the transform of everything it combines, so anything
    /// that turns, scales or carries child text has to be lifted out first -
    /// the fans and the coin because they spin, the histogram bars because
    /// they are scaled from the live fee profile, and the screen because the
    /// terminal parents its text meshes to it.
    /// </summary>
    static bool IsMoving(string n) =>
        n.StartsWith("Fan_") && !n.EndsWith("_mount")
        || n.StartsWith("bar_")
        || n == "terminal_screen" || n == "Coin" || n == "Beacon_Tip";

    void Spin(GameObject miner)
    {
        var spin = miner.AddComponent<MinerSpin>();
        var fans = new System.Collections.Generic.List<Transform>();
        var bars = new System.Collections.Generic.List<Transform>();
        Transform screen = null;

        foreach (var t in miner.GetComponentsInChildren<Transform>(true))
        {
            if (t.name.StartsWith("Fan_") && !t.name.EndsWith("_mount")) fans.Add(t);
            else if (t.name.StartsWith("bar_")) bars.Add(t);
            else if (t.name == "terminal_screen") screen = t;
            else if (t.name == "Coin") spin.coin = t;
            else if (t.name == "Beacon_Tip")
            {
                spin.beacon = t;
                spin.beaconLamp = t.GetComponentInChildren<Renderer>();
            }
        }
        spin.fans = fans.ToArray();

        // bar_00 .. bar_23 in order, so the histogram is not shuffled
        bars.Sort((a, b) => string.CompareOrdinal(a.name, b.name));

        var term = miner.AddComponent<MinerTerminal>();
        term.screen = screen;
        term.bars = bars.ToArray();
        term.feed = FindFirstObjectByType<MempoolFeed>();
        term.terrain = terrain;
        term.stats = FindFirstObjectByType<ChainStats>();
        term.verticalStretch = 1f / Mathf.Max(0.05f, minerHeightScale);
    }

    /// <summary>
    /// The facade, as collision: solid everywhere except the tunnel mouth.
    ///
    /// This is the whole point of putting a building at the end rather than a
    /// gate - you have to drive INTO it, through the one opening, and the
    /// rest of it is a wall. Three boxes rather than mesh colliders on 880
    /// renderers: the shape that matters is a rectangle with a hole in it, and
    /// hitting the actual greebles would be both expensive and worse, because
    /// a truck should slide along a facade rather than catch on a rivet.
    /// </summary>
    void Wall(float ground)
    {
        var shell = new GameObject("MinerShell");
        shell.transform.SetParent(transform, false);
        shell.transform.position = new Vector3(gateX, ground, 0f);
        _shell = shell.transform;
        shell.transform.rotation = FaceThePlayer;
        shell.transform.localScale = MinerScale;
        var wall = shell.transform;

        float side = (ShellHalfWidth - MouthHalfWidth) * 0.5f;
        float sideZ = MouthHalfWidth + side;

        // Buried 20 m deep, on purpose.
        //
        // The shell is placed at the ground height sampled at z = 0, but the
        // terrain is mempool relief and falls away to either side - so a wall
        // that starts exactly at that one sample leaves a gap underneath it
        // 75 m out, and a truck drives straight through the gap. A building
        // has foundations; these are 20 m of them.
        const float Footing = 20f;
        float wallH = ShellHeight + Footing;
        float wallY = wallH * 0.5f - Footing;

        Slab(wall, "FacadeLeft",
             new Vector3(2f, wallY, -sideZ),
             new Vector3(8f, wallH, side * 2f));
        Slab(wall, "FacadeRight",
             new Vector3(2f, wallY, sideZ),
             new Vector3(8f, wallH, side * 2f));

        // over the mouth, so nothing drives in across the lintel
        Slab(wall, "FacadeLintel",
             new Vector3(2f, MouthHeight + (ShellHeight - MouthHeight) * 0.5f, 0f),
             new Vector3(8f, ShellHeight - MouthHeight, MouthHalfWidth * 2f));

        // and the tunnel's own two sides, so the run-in is a corridor rather
        // than a doorway you can clip past at an angle
        Slab(wall, "TunnelLeft",
             new Vector3(-11f, MouthHeight * 0.5f - Footing * 0.5f,
                         -(MouthHalfWidth + 2f)),
             new Vector3(28f, MouthHeight + Footing, 4f));
        Slab(wall, "TunnelRight",
             new Vector3(-11f, MouthHeight * 0.5f - Footing * 0.5f,
                         MouthHalfWidth + 2f),
             new Vector3(28f, MouthHeight + Footing, 4f));
    }

    void Slab(Transform parent, string name, Vector3 localCentre, Vector3 size)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = localCentre;
        go.AddComponent<BoxCollider>().size = size;
    }

    void Post(Vector3 at, Vector3 size, string name)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name;
        var col = go.GetComponent<Collider>();
        if (col != null) Destroy(col);          // a goal you can crash into is a wall
        go.transform.SetParent(transform, false);
        go.transform.position = at;
        go.transform.localScale = size;
        if (postMaterial != null) go.GetComponent<MeshRenderer>().sharedMaterial = postMaterial;
    }
}
