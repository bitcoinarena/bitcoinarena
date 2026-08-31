using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The Mempool Post Office: where the run starts.
///
/// Counterpart to the miner at the other end. The truck rolls out of a loading
/// bay rather than appearing on an empty apron, and the building's displays
/// carry the same live chain state the rest of the map is built from - the fee
/// estimate, the unconfirmed count, the blocks, and a treemap of what is
/// actually waiting.
///
/// Everything on it is data at runtime and nothing is baked, for the same
/// reason as the miner's terminal: a number in a texture is wrong within the
/// minute and can only be corrected by re-exporting a building.
/// </summary>
public class PostOffice : MonoBehaviour
{
    public GameObject model;
    public MempoolTerrain terrain;
    public MempoolFeed feed;
    public MarketFeed market;
    public BlockClock clock;
    public ChainStats stats;

    [Tooltip("Where the building stands. Mirrors the delivery gate.")]
    public float postX = -114.4f;

    /// <summary>Bay the player is given when nobody else is on the map.</summary>
    public const int SoloBay = 0;

    /// <summary>Where the truck should stand, once the building is up.</summary>
    public Vector3 BayPosition { get; private set; }
    public bool HasBay { get; private set; }

    // Measured off the import, in the model's own local space AFTER glTFast
    // has mirrored x - which it does to get from glTF's right-handed frame to
    // Unity's, so every x below is the negative of what a glTF viewer shows.
    //
    //   facade front face   x =  0        (the rivets stand 0.3 proud of it)
    //   bay mouths          x = -8.9 .. -0.5, y 1.1 .. 9.1, 5.0 wide in z
    //   the hall behind     x = -42.8
    //   the apron in front  x = +5 .. +31, the full 168 m of z
    //   24 ports            z = -78.2 .. +78.2 on a 6.8 pitch
    //   shell               z = +-84.15, 51.95 tall
    const float PortPitch = 6.8f;
    const float FirstPortZ = -78.2f;
    const float MouthHalf = 2.5f;      // clear half-width of one bay
    const float MouthHigh = 9.2f;
    const float ShellHalf = 84.15f;
    const float ShellHigh = 52f;
    const float FacadeX = 0f;
    const float WallDepth = 8f;        // the barrier runs back INTO the hall

    [Tooltip("How far out on the apron the truck is parked, in metres from " +
             "the facade. The apron slab reaches 31 m, so this has to stay " +
             "inside it or the truck starts on bare ground.")]
    public float bayStandoff = 14f;

    /// <summary>
    /// Clearance between the model's apron slab and the ground it is laid on.
    ///
    /// The slab is 5 cm thick and centred on the model's own zero, so setting
    /// the building down at exactly the sampled height buries half of it and
    /// leaves 26 x 168 m of coplanar geometry fighting the terrain for depth.
    /// A hand's width of lift costs nothing and settles it.
    /// </summary>
    const float ApronLift = 0.06f;

    GameObject _up;
    Transform _shell;
    int _seenGround = -1;
    readonly List<TextMesh> _feeRate = new();
    readonly List<TextMesh> _feeUsd = new();
    TextMesh _unconf;
    readonly List<TextMesh> _blockFace = new();
    readonly List<TextMesh> _blockLabel = new();
    Transform _goggles;
    float _nextData, _nextCount;

    /// <summary>
    /// The height the building stands at: the LOWEST ground under its apron.
    ///
    /// One building, one height - it is a concrete slab, not a blanket. The
    /// terrain is levelled dead flat at this end of the map precisely so that
    /// this is exact, and the lowest of several samples is taken rather than
    /// one at the centre so that any relief that does survive leaves the
    /// building slightly proud of the ground instead of hovering over it with
    /// the road running underneath - which is what happened, and what put the
    /// truck under its own loading dock.
    /// </summary>
    float Ground()
    {
        if (terrain == null) return 0f;
        float low = float.MaxValue;
        for (int i = 0; i <= 8; i++)
        {
            float z = Mathf.Lerp(-ShellHalf, ShellHalf, i / 8f);
            low = Mathf.Min(low, terrain.SampleSurface(postX, z));
            low = Mathf.Min(low, terrain.SampleSurface(postX + bayStandoff, z));
            low = Mathf.Min(low, terrain.SampleSurface(postX + 31f, z));
        }
        return low;
    }

    public Vector3 BayFor(int bay)
    {
        float z = FirstPortZ + PortPitch * Mathf.Clamp(bay, 0, 23);
        float x = postX + bayStandoff;
        // the ground the truck will actually rest on, not the ground at the
        // building's centre 78 m away
        float ground = terrain != null ? terrain.SampleSurface(x, z) : 0f;
        return new Vector3(x, ground + 1.4f, z);
    }

    void Start()
    {
        // The bay is known from arithmetic, not from the model, so the truck
        // can be parked in it before the building has finished streaming.
        BayPosition = BayFor(SoloBay);
        HasBay = true;

        Wall();
        if (model != null) Show(model);
    }

    /// <summary>The building has arrived from the streamer.</summary>
    public void Show(GameObject asset)
    {
        if (asset == null || _up != null) return;

        _up = Instantiate(asset, new Vector3(postX, Ground() + ApronLift, 0f),
                          Quaternion.identity, transform);
        _up.name = "MempoolPostOffice";

        Wire(_up);

        // Same treatment as the miner: batch the static parts in place rather
        // than reparenting, which shears anything rotated.
        var statics = new List<GameObject>();
        foreach (var r in _up.GetComponentsInChildren<Renderer>(true))
        {
            bool live = false;
            for (var t = r.transform; t != null && t != _up.transform; t = t.parent)
                if (IsLive(t.name)) { live = true; break; }
            if (!live) statics.Add(r.gameObject);
        }
        StaticBatchingUtility.Combine(statics.ToArray(), _up);
    }

    static bool IsLive(string n) =>
        n == "goggles_screen" || n == "unconf_count"
        || n.StartsWith("fee_rate_") && !n.Contains("unit")
        || n.StartsWith("fee_usd_") && !n.Contains("unit")
        || n.StartsWith("next_face_") && !n.Contains("plate")
        || n.StartsWith("mined_face_") && !n.Contains("plate")
        || n.StartsWith("block_label_") && !n.Contains("case");

    /// <summary>
    /// The facade, as collision: solid except the 24 bay mouths.
    ///
    /// The building spans the map, so without this the start of the map has no
    /// boundary at all - and with it, the only way onto the road is out of a
    /// bay, which is the point of a loading dock.
    ///
    /// The slabs run from the facade BACKWARDS into the hall. They used to run
    /// forwards, 6 m out onto the apron, which put an invisible wall in front
    /// of the doors the truck is parked at.
    /// </summary>
    void Wall()
    {
        var shell = new GameObject("PostOfficeShell");
        shell.transform.SetParent(transform, false);
        shell.transform.position = new Vector3(postX, Ground(), 0f);
        _shell = shell.transform;

        // Buried, for the same reason the miner's facade is: the shell sits at
        // one terrain sample and the ground rolls away to either side.
        const float Footing = 20f;
        float h = ShellHigh + Footing, y = h * 0.5f - Footing;
        float x = FacadeX - WallDepth * 0.5f;

        // one slab per gap between bays, plus the two ends
        float pillar = PortPitch - MouthHalf * 2f;
        for (int i = 0; i <= 24; i++)
        {
            float z = FirstPortZ - PortPitch * 0.5f + PortPitch * i;
            Slab(shell.transform, $"Pillar{i:00}", new Vector3(x, y, z),
                 new Vector3(WallDepth, h, pillar));
        }

        // The two ends, from the outermost pillar out to the edge of the
        // shell. There used to be one of these and it was parked at z = -41,
        // in the middle of the doors, while both actual ends stood open - a
        // 2.5 m gap at each corner that a 2.4 m truck fits through.
        float lastEdge = FirstPortZ + PortPitch * 23.5f;   // 81.6
        float endWidth = Mathf.Max(0.5f, ShellHalf - lastEdge);
        foreach (int side in new[] { -1, 1 })
            Slab(shell.transform, side < 0 ? "EndLeft" : "EndRight",
                 new Vector3(x, y, side * (lastEdge + endWidth * 0.5f)),
                 new Vector3(WallDepth, h, endWidth));

        // over every mouth
        Slab(shell.transform, "Lintel",
             new Vector3(x, MouthHigh + (ShellHigh - MouthHigh) * 0.5f, 0f),
             new Vector3(WallDepth, ShellHigh - MouthHigh, ShellHalf * 2f));
    }

    void Slab(Transform parent, string name, Vector3 at, Vector3 size)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = at;
        go.AddComponent<BoxCollider>().size = size;
    }

    /// <summary>Hangs a text mesh on one of the model's blank plates.</summary>
    TextMesh Plate(Transform plate, Color colour, float fill = 0.88f)
    {
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        var go = new GameObject(plate.name + "_text");
        go.transform.SetParent(plate, false);
        go.transform.localPosition = new Vector3(0f, 0f, -0.15f);
        go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
        go.layer = plate.gameObject.layer;

        var tm = go.AddComponent<TextMesh>();
        tm.font = font;
        tm.fontSize = 80;
        tm.characterSize = 1f;
        tm.anchor = TextAnchor.MiddleCenter;
        tm.alignment = TextAlignment.Center;
        tm.color = colour;
        tm.text = "";

        var mr = go.GetComponent<MeshRenderer>();
        mr.sharedMaterial = font.material;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        _room[tm] = Room(plate) * fill;
        return tm;
    }

    /// <summary>
    /// How much room a plate actually offers, in its own local units.
    ///
    /// The model ships every display as a blank quad of a known size - 8.2 m
    /// square on a block face, 24 x 6.4 on the unconfirmed counter - so the
    /// space available is a fact that can be read off the mesh rather than a
    /// number to be guessed. It was guessed, at 1.4 m for three lines of text
    /// on an 8.2 m face, and from the road the block band read as blank.
    /// </summary>
    static Vector2 Room(Transform plate)
    {
        var mf = plate.GetComponent<MeshFilter>();
        var size = mf != null && mf.sharedMesh != null ? mf.sharedMesh.bounds.size
                                                       : new Vector3(4f, 1f, 0f);
        return new Vector2(Mathf.Max(0.2f, size.x), Mathf.Max(0.2f, size.y));
    }

    readonly Dictionary<TextMesh, Vector2> _room = new();

    /// <summary>
    /// Scales a plate's text to fill it - both ways, and no further.
    ///
    /// Renderer.localBounds, not the mesh: TextMesh builds its mesh
    /// internally and leaves sharedMesh null, which is the trap the miner's
    /// terminal fell into first.
    /// </summary>
    void Fit(TextMesh tm)
    {
        var mr = tm.GetComponent<MeshRenderer>();
        if (mr == null || !_room.TryGetValue(tm, out var room)) return;
        var size = mr.localBounds.size;
        if (size.y < 0.001f || size.x < 0.001f) return;
        float k = Mathf.Clamp(Mathf.Min(room.y / size.y, room.x / size.x), 0.001f, 20f);
        tm.transform.localScale = Vector3.one * k;
    }

    void Wire(GameObject root)
    {
        var white = Color.white;
        var green = new Color(0.35f, 0.95f, 0.45f);
        var blue = new Color(0.45f, 0.65f, 1f);

        foreach (var t in root.GetComponentsInChildren<Transform>(true))
        {
            string n = t.name;
            if (n == "goggles_screen")
            {
                _goggles = t;
                var wall = gameObject.AddComponent<GogglesWall>();
                wall.feed = feed;
                wall.screen = t;
            }
            else if (n == "unconf_count") _unconf = Plate(t, white);
            else if (n.StartsWith("fee_rate_") && !n.Contains("unit"))
                _feeRate.Add(Plate(t, white));
            else if (n.StartsWith("fee_usd_") && !n.Contains("unit"))
                _feeUsd.Add(Plate(t, green));
            else if (n.StartsWith("next_face_") && !n.Contains("plate"))
                _blockFace.Add(Plate(t, white, 0.82f));
            else if (n.StartsWith("mined_face_") && !n.Contains("plate"))
                _blockFace.Add(Plate(t, white, 0.82f));
            else if (n.StartsWith("block_label_") && !n.Contains("case"))
                _blockLabel.Add(Plate(t, blue, 0.92f));
        }
    }

    /// <summary>
    /// Put the building back on the ground after the ground has moved.
    ///
    /// It moves regularly: the terrain IS the fee histogram, and every poll
    /// that finds a different mempool rebuilds it at a different height. A
    /// building set down once at boot is correct for about twenty seconds and
    /// hanging in the air, or buried to the windows, for the rest of the
    /// session. MempoolTerrain.Version exists to be watched for exactly this.
    /// </summary>
    void Settle()
    {
        float ground = Ground();
        if (_up != null)
            _up.transform.position = new Vector3(postX, ground + ApronLift, 0f);
        if (_shell != null)
            _shell.position = new Vector3(postX, ground, 0f);
        BayPosition = BayFor(SoloBay);
    }

    void Update()
    {
        if (terrain != null && terrain.Version != _seenGround)
        {
            _seenGround = terrain.Version;
            Settle();
        }

        if (_up == null) return;

        // The counter runs on its own clock. It is the one number on the
        // building that moves between one look and the next, and a mempool
        // counter that updates every other second reads as a photograph.
        if (Time.unscaledTime >= _nextCount)
        {
            _nextCount = Time.unscaledTime + 0.5f;
            Unconfirmed();
        }

        if (Time.unscaledTime < _nextData) return;
        _nextData = Time.unscaledTime + 2f;

        Fees();
        Blocks();
    }

    /// <summary>
    /// Four priority tiers, taken from the live fee profile.
    ///
    /// mempool.space shows no priority, low, medium and high; the profile is
    /// already a fee-rate distribution, so the tiers are just quantiles of it.
    /// </summary>
    void Fees()
    {
        if (_feeRate.Count < 4 || stats == null || !stats.HasFees) return;

        // Straight from the node. These were derived from the terrain's
        // normalised fee profile times a constant - numbers not so much wrong
        // as unrelated to anything, and it showed.
        int[] tier = { stats.FeeNone, stats.FeeLow, stats.FeeMedium, stats.FeeHigh };
        for (int i = 0; i < 4 && i < _feeRate.Count; i++)
        {
            float rate = tier[i];
            _feeRate[i].text = $"{tier[i]}";
            Fit(_feeRate[i]);

            if (i < _feeUsd.Count)
            {
                // a plain transaction is about 140 vB
                double usd = market != null && market.Price > 0
                    ? rate * 140.0 / 1e8 * market.Price : 0.0;
                _feeUsd[i].text = usd > 0 ? $"{usd:0.00} $" : "—";
                Fit(_feeUsd[i]);
            }
        }
    }

    void Unconfirmed()
    {
        if (_unconf == null) return;
        // The REAL count. It used to be the length of the freight list times
        // 1900 - a made-up number wearing a real one's clothes.
        int n = stats != null ? stats.Unconfirmed : 0;
        string was = _unconf.text;
        _unconf.text = n > 0 ? $"{n:N0}" : "—";
        if (_unconf.text != was) Fit(_unconf);
    }

    /// <summary>How long ago a block was found, the way an explorer says it.</summary>
    static string Ago(int minutes)
    {
        if (minutes < 1) return "just now";
        if (minutes == 1) return "1 minute ago";
        if (minutes < 60) return $"{minutes} minutes ago";
        int h = minutes / 60, m = minutes % 60;
        return m == 0 ? (h == 1 ? "1 hour ago" : $"{h} hours ago")
                      : $"{h}h {m}m ago";
    }

    /// <summary>
    /// The block row, as mempool.space arranges it.
    ///
    /// Left of the divider are PROJECTED blocks - what the mempool would pay
    /// if it were mined now: fees in BTC, how many transactions, roughly when.
    /// Right are blocks that exist: their height, transaction count, and how
    /// long ago. Two different things drawn as the same cube, which is exactly
    /// why each needs its own words - in English, like the explorer they are
    /// copied from, rather than half of one language and half of the other.
    /// </summary>
    void Blocks()
    {
        if (stats == null) return;

        int tip = stats.Recent.Count > 0 ? stats.Recent[0].height
                : (clock != null ? clock.Height : 0);

        for (int i = 0; i < _blockFace.Count; i++)
        {
            if (i < 5)
            {
                var up = i < stats.Upcoming.Count ? stats.Upcoming[i] : null;
                _blockFace[i].text = up == null ? "—"
                    : $"{up.totalFeeSats / 1e8:0.000} BTC\n{up.nTx:N0} tx\nin ~{up.inMinutes} min";
            }
            else
            {
                int at = i - 5;
                var m = at < stats.Recent.Count ? stats.Recent[at] : null;
                // The height goes ON the block. It was on the strip above it
                // and nowhere else, which is a caption rather than a label -
                // and a mined block without its number is not identifiable as
                // anything.
                _blockFace[i].text = m == null ? "—"
                    : $"{m.height:N0}\n{m.nTx:N0} tx\n{Ago(m.AgeMinutes)}";
            }
            Fit(_blockFace[i]);
        }

        for (int i = 0; i < _blockLabel.Count; i++)
        {
            if (i < 5)
            {
                // The nearest projected block to the divider is the NEXT one,
                // tip + 1 - it is the one its own face says arrives in nine
                // minutes. The row used to be numbered backwards, so the block
                // captioned tip + 5 was the one being mined next.
                _blockLabel[i].text = tip > 0 ? $"{tip + 1 + i:N0}" : "—";
            }
            else
            {
                int at = i - 5;
                _blockLabel[i].text = at < stats.Recent.Count
                    ? $"{stats.Recent[at].height:N0}" : "—";
            }
            Fit(_blockLabel[i]);
        }
    }
}
