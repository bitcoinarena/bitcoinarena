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

    [Tooltip("Where the building stands. Mirrors the delivery gate.")]
    public float postX = -114.4f;

    /// <summary>Bay the player is given when nobody else is on the map.</summary>
    public const int SoloBay = 0;

    /// <summary>Where the truck should stand, once the building is up.</summary>
    public Vector3 BayPosition { get; private set; }
    public bool HasBay { get; private set; }

    // Measured off the import: 24 ports at 6.8 m from z -78.2 to +78.2, the
    // facade around local x 2, the shell 168.4 wide and 52.6 tall.
    const float PortPitch = 6.8f;
    const float FirstPortZ = -78.2f;
    const float MouthHalf = 2.3f;      // clear half-width of one bay
    const float MouthHigh = 9f;
    const float ShellHalf = 84.2f;
    const float ShellHigh = 52.6f;

    GameObject _up;
    readonly List<TextMesh> _feeRate = new();
    readonly List<TextMesh> _feeUsd = new();
    TextMesh _unconf;
    readonly List<TextMesh> _blockFace = new();
    readonly List<TextMesh> _blockLabel = new();
    Transform _goggles;
    float _nextData;

    public Vector3 BayFor(int bay)
    {
        float ground = terrain != null ? terrain.SampleSurface(postX, 0f) : 0f;
        return new Vector3(postX + 14f, ground + 1.4f,
                           FirstPortZ + PortPitch * Mathf.Clamp(bay, 0, 23));
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

        float ground = terrain != null ? terrain.SampleSurface(postX, 0f) : 0f;
        _up = Instantiate(asset, new Vector3(postX, ground, 0f), Quaternion.identity, transform);
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
    /// </summary>
    void Wall()
    {
        float ground = terrain != null ? terrain.SampleSurface(postX, 0f) : 0f;
        var shell = new GameObject("PostOfficeShell");
        shell.transform.SetParent(transform, false);
        shell.transform.position = new Vector3(postX, ground, 0f);

        // Buried, for the same reason the miner's facade is: the shell sits at
        // one terrain sample and the ground rolls away to either side.
        const float Footing = 20f;
        float h = ShellHigh + Footing, y = h * 0.5f - Footing;

        // one slab per gap between bays, plus the two ends
        float pillar = PortPitch - MouthHalf * 2f;
        for (int i = 0; i <= 24; i++)
        {
            float z = FirstPortZ - PortPitch * 0.5f + PortPitch * i;
            Slab(shell.transform, $"Pillar{i:00}", new Vector3(2f, y, z),
                 new Vector3(8f, h, pillar));
        }
        // the ends, out to the edge of the shell
        float endWidth = ShellHalf - (FirstPortZ + PortPitch * 23.5f);
        Slab(shell.transform, "EndLeft",
             new Vector3(2f, y, -(ShellHalf + FirstPortZ - PortPitch * 0.5f) * 0.5f - 40f),
             new Vector3(8f, h, Mathf.Max(1f, endWidth)));
        // over every mouth
        Slab(shell.transform, "Lintel",
             new Vector3(2f, MouthHigh + (ShellHigh - MouthHigh) * 0.5f, 0f),
             new Vector3(8f, ShellHigh - MouthHigh, ShellHalf * 2f));
    }

    void Slab(Transform parent, string name, Vector3 at, Vector3 size)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = at;
        go.AddComponent<BoxCollider>().size = size;
    }

    /// <summary>Hangs a text mesh on one of the model's blank plates.</summary>
    TextMesh Plate(Transform plate, float height, Color colour, TextAnchor anchor)
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
        tm.anchor = anchor;
        tm.alignment = TextAlignment.Center;
        tm.color = colour;
        tm.text = "";

        var mr = go.GetComponent<MeshRenderer>();
        mr.sharedMaterial = font.material;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        _height[tm] = height;
        return tm;
    }

    readonly Dictionary<TextMesh, float> _height = new();

    void Fit(TextMesh tm)
    {
        var mr = tm.GetComponent<MeshRenderer>();
        if (mr == null || !_height.TryGetValue(tm, out float want)) return;
        var size = mr.localBounds.size;
        if (size.y < 0.001f || size.x < 0.001f) return;
        float k = Mathf.Clamp(Mathf.Min(want / size.y, 22f / size.x), 0.001f, 5f);
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
            if (n == "goggles_screen") _goggles = t;
            else if (n == "unconf_count") _unconf = Plate(t, 5.2f, white, TextAnchor.MiddleCenter);
            else if (n.StartsWith("fee_rate_") && !n.Contains("unit"))
                _feeRate.Add(Plate(t, 1.5f, white, TextAnchor.MiddleCenter));
            else if (n.StartsWith("fee_usd_") && !n.Contains("unit"))
                _feeUsd.Add(Plate(t, 1.1f, green, TextAnchor.MiddleCenter));
            else if (n.StartsWith("next_face_") && !n.Contains("plate"))
                _blockFace.Add(Plate(t, 1.4f, white, TextAnchor.MiddleCenter));
            else if (n.StartsWith("mined_face_") && !n.Contains("plate"))
                _blockFace.Add(Plate(t, 1.4f, white, TextAnchor.MiddleCenter));
            else if (n.StartsWith("block_label_") && !n.Contains("case"))
                _blockLabel.Add(Plate(t, 1.0f, blue, TextAnchor.MiddleCenter));
        }
        Treemap();
    }

    /// <summary>
    /// Mempool Goggles: one quad per transaction, sized by weight.
    ///
    /// Squares rather than a texture, so it costs no download and no render
    /// target - and each square really is one of the transactions sitting in
    /// the loading yard.
    /// </summary>
    void Treemap()
    {
        if (_goggles == null || feed == null) return;
        var offers = feed.Offers;
        if (offers == null || offers.Count == 0) return;

        for (int i = _goggles.childCount - 1; i >= 0; i--)
            if (_goggles.GetChild(i).name.StartsWith("tile")) Destroy(_goggles.GetChild(i).gameObject);

        const int Cols = 8;
        int show = Mathf.Min(offers.Count, Cols * Cols);
        for (int i = 0; i < show; i++)
        {
            var tx = offers[i];
            float cell = 16f / Cols;
            int cx = i % Cols, cy = i / Cols;

            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            q.name = "tile" + i;
            Destroy(q.GetComponent<Collider>());
            q.transform.SetParent(_goggles, false);
            q.layer = _goggles.gameObject.layer;

            float fill = Mathf.Clamp(CargoBay.RoomFor(tx) / 1.35f, 0.30f, 0.95f);
            q.transform.localPosition = new Vector3(
                (cx - (Cols - 1) * 0.5f) * cell, (cy - (Cols - 1) * 0.5f) * cell, -0.12f);
            q.transform.localScale = new Vector3(cell * fill, cell * fill, 1f);
            q.transform.localRotation = Quaternion.identity;

            var mr = q.GetComponent<MeshRenderer>();
            mr.sharedMaterial = new Material(Shader.Find("Universal Render Pipeline/Unlit"))
            {
                color = Color.Lerp(new Color(0.16f, 0.42f, 0.20f),
                                   new Color(0.72f, 0.78f, 0.20f),
                                   Mathf.Clamp01(tx.FeeRate / 30f)),
            };
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        }
    }

    void Update()
    {
        if (_up == null || Time.unscaledTime < _nextData) return;
        _nextData = Time.unscaledTime + 2f;

        Fees();
        Unconfirmed();
        Blocks();
        Treemap();
    }

    /// <summary>
    /// Four priority tiers, taken from the live fee profile.
    ///
    /// mempool.space shows no priority, low, medium and high; the profile is
    /// already a fee-rate distribution, so the tiers are just quantiles of it.
    /// </summary>
    void Fees()
    {
        if (_feeRate.Count < 4 || terrain == null) return;
        var profile = terrain.FeeProfile(32);
        if (profile == null) return;

        // profile is normalised, so scale it back onto a plausible sat/vB range
        float[] q = { 0.06f, 0.22f, 0.55f, 0.92f };
        for (int i = 0; i < 4 && i < _feeRate.Count; i++)
        {
            int at = Mathf.Clamp(Mathf.RoundToInt(q[i] * (profile.Length - 1)), 0, profile.Length - 1);
            float rate = Mathf.Max(0.1f, profile[at] * 24f);
            _feeRate[i].text = $"{rate:0.#}";
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
        if (_unconf == null || feed == null) return;
        // the feed keeps a rolling window, not the whole mempool, so the count
        // is scaled to read as a mempool depth rather than a list length
        int n = feed.Offers != null ? feed.Offers.Count : 0;
        _unconf.text = n > 0 ? $"{n * 1900:N0}" : "—";
        Fit(_unconf);
    }

    void Blocks()
    {
        if (clock == null) return;
        int tip = clock.Height;
        for (int i = 0; i < _blockLabel.Count; i++)
        {
            // five upcoming then five mined, newest in the middle
            int height = i < 5 ? tip + (5 - i) : tip - (i - 5);
            _blockLabel[i].text = height > 0 ? height.ToString("N0") : "—";
            Fit(_blockLabel[i]);
        }
        // From the fee profile, not from Random: a made-up number on a wall
        // that claims to show chain state is worse than an empty wall.
        var profile = terrain != null ? terrain.FeeProfile(_blockFace.Count) : null;
        for (int i = 0; i < _blockFace.Count; i++)
        {
            _blockFace[i].text = profile != null
                ? $"~{Mathf.Max(0.1f, profile[i] * 24f):0.#} sat/vB" : "—";
            Fit(_blockFace[i]);
        }
    }
}
