// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Mempool Goggles: mempool.space's block-overview graph, on the side of a
/// building.
///
/// Their layout, in the shape it actually takes:
///   - the block is a square grid of slots
///   - a transaction occupies a SQUARE of slots whose side grows with the
///     square root of its weight, so area is proportional to vsize and a
///     transaction ten times heavier is about three times wider
///   - transactions are placed largest first, packed to the bottom left
///   - colour runs by fee rate, from the dark green of a one-sat transaction
///     through olive and yellow to red at the top of the range
///   - and it MOVES: their scene tweens every transaction to its new place
///     over a second, new arrivals flying in from off the edge and departures
///     flying out. See block-scene.ts, animationDuration = 1000.
///
/// The first version of this wall was a still life. It drew forty
/// transactions - the freight list, refetched every twelve seconds - as forty
/// separate quads, and nothing ever moved. Both halves of that are fixed here:
/// the data is the live projected block off mempool.space's socket, a couple
/// of thousand transactions updated every second or two, and the wall is one
/// mesh whose quads are animated towards their targets every frame.
///
/// One mesh, not one GameObject per transaction. Two thousand renderers would
/// cost more per frame than the rest of the game put together; two thousand
/// quads in a single mesh is 8000 vertices, which is nothing.
/// </summary>
public class GogglesWall : MonoBehaviour
{
    public MempoolFeed feed;
    public MempoolBlockStream stream;
    public Transform screen;

    [Tooltip("Slots across the wall. mempool uses a square grid sized to the " +
             "block; 64 gives a readable smallest tile at 16 m and holds a " +
             "couple of thousand transactions.")]
    public int slots = 64;

    [Tooltip("Metres across the panel.")]
    public float size = 16f;

    [Tooltip("How often the arrangement is recomputed. The original animates " +
             "on every delta; this is the floor under that.")]
    public float rebuildSeconds = 0.5f;

    [Tooltip("Seconds a transaction takes to reach its new place - mempool's " +
             "own animationDuration is 1000 ms.")]
    public float travelSeconds = 1f;

    [Tooltip("How much of the grid the tiles should cover.")]
    public float fill = 0.85f;

    /// <summary>A transaction as the wall knows it: where it is, where it is going.</summary>
    class Tile
    {
        public string id;
        public Vector2 at, from, to;     // metres, panel space
        public float sizeNow, sizeFrom, sizeTo;
        public float ramp, rampFrom;      // where it sits on the fee ramp, 0..1
        public float t;                  // 0..1 through its journey
        public bool leaving;
        public bool seen;
    }

    readonly Dictionary<string, Tile> _tiles = new();
    readonly List<Tile> _order = new();
    Mesh _mesh;
    MeshRenderer _renderer;
    float _next;
    int _seenVersion = -1;

    /// <summary>
    /// mempool's fee-rate ramp: deep green at the bottom of the market, olive
    /// and yellow through the middle, red for anything paying to jump.
    /// </summary>
    public static Color Colour(float satPerVb) => Ramp(Along(satPerVb));

    /// <summary>Where a fee rate sits on the ramp, 0..1.</summary>
    public static float Along(float satPerVb)
        => Mathf.Clamp01(Mathf.Log10(1f + Mathf.Max(0f, satPerVb)) / Mathf.Log10(101f));

    /// <summary>The ramp itself, so it can also be baked into a texture.</summary>
    public static Color Ramp(float t)
    {
        if (t < 0.34f) return Color.Lerp(new Color(0.10f, 0.30f, 0.14f),
                                         new Color(0.29f, 0.55f, 0.20f), t / 0.34f);
        if (t < 0.68f) return Color.Lerp(new Color(0.29f, 0.55f, 0.20f),
                                         new Color(0.80f, 0.80f, 0.22f), (t - 0.34f) / 0.34f);
        return Color.Lerp(new Color(0.80f, 0.80f, 0.22f),
                          new Color(0.85f, 0.25f, 0.18f), (t - 0.68f) / 0.32f);
    }

    /// <summary>
    /// Side of a transaction's square, in slots. Area tracks vsize, so the
    /// side tracks its square root - which is the whole reason the graph reads
    /// as a size comparison rather than a list.
    /// </summary>
    public static int SideFor(float vsize, int maxSide, float scale)
        => Mathf.Clamp(Mathf.RoundToInt(Mathf.Sqrt(Mathf.Max(1f, vsize)) * scale), 1, maxSide);

    /// <summary>
    /// The slots-per-sqrt-vB that fills the grid with whatever is in the feed.
    ///
    /// Solving sum((k*sqrt(v))^2) = fill * slots^2 for k. A fixed scale is
    /// right only for a full block: at mempool's own figure, the forty
    /// transactions this used to be given came out as forty half-metre tiles
    /// in the corner of a 16 m wall, which from the road is a blank wall.
    /// </summary>
    public static float ScaleFor(IReadOnlyList<float> vsizes, int slots, float fill)
    {
        double total = 0;
        for (int i = 0; i < vsizes.Count; i++) total += Mathf.Max(1f, vsizes[i]);
        if (total <= 0) return 1f;
        float k = slots * Mathf.Sqrt(Mathf.Clamp01(fill) / (float)total);
        return Mathf.Clamp(k, 1f / Mathf.Sqrt(180f), slots * 0.25f);
    }

    void Start()
    {
        if (screen == null) { enabled = false; return; }
        if (stream == null) stream = FindFirstObjectByType<MempoolBlockStream>();

        var go = new GameObject("GogglesMesh");
        go.transform.SetParent(screen, false);
        // 12 cm in FRONT of the panel and facing out of it: the screen's local
        // +z points at the apron, and a Unity quad's normal is its -z.
        go.transform.localPosition = new Vector3(0f, 0f, 0.12f);
        go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
        go.layer = screen.gameObject.layer;

        _mesh = new Mesh { name = "MempoolGoggles" };
        _mesh.MarkDynamic();
        go.AddComponent<MeshFilter>().sharedMesh = _mesh;
        _renderer = go.AddComponent<MeshRenderer>();
        _renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        _renderer.receiveShadows = false;

        // URP/Lit, black-bodied and emissive: a screen does not take the
        // weather, and URP/Unlit is not referenced by any material in this
        // scene, so a player build strips it and Shader.Find returns null in
        // the browser while working perfectly in the editor.
        var shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null)
        {
            Debug.LogWarning("[GogglesWall] no URP/Lit in this build - the wall stays blank");
            enabled = false;
            return;
        }
        // The fee ramp, baked into a strip of pixels.
        //
        // Vertex colours were the obvious way to give two thousand quads two
        // thousand colours out of one material, and URP's Lit shader ignores
        // them completely - so the whole wall came out white, which is
        // emissive white, which is a light box. A 256-pixel ramp as the
        // emission MAP does what vertex colours were meant to: every tile's
        // four corners carry the same u, and u is its fee rate.
        var ramp = new Texture2D(256, 1, TextureFormat.RGBA32, false)
        {
            wrapMode = TextureWrapMode.Clamp,
            filterMode = FilterMode.Bilinear,
            name = "FeeRamp",
        };
        for (int i = 0; i < 256; i++) ramp.SetPixel(i, 0, Ramp(i / 255f));
        ramp.Apply();

        var mat = new Material(shader);
        mat.SetColor("_BaseColor", Color.black);
        mat.SetFloat("_Smoothness", 0f);
        mat.EnableKeyword("_EMISSION");
        mat.SetTexture("_EmissionMap", ramp);
        mat.SetColor("_EmissionColor", Color.white);
        _renderer.sharedMaterial = mat;
    }

    void Update()
    {
        if (_mesh == null) return;

        if (Time.unscaledTime >= _next)
        {
            _next = Time.unscaledTime + Mathf.Max(0.1f, rebuildSeconds);
            Relayout();
        }

        // Only rebuild the mesh while something is actually moving. A settled
        // wall of five thousand quads is 20,000 vertices that do not need
        // writing sixty times a second, and this runs on a phone.
        if (Advance(Time.unscaledDeltaTime) || _dirty) { Draw(); _dirty = false; }
    }

    /// <summary>The transactions to show, live block first, freight list second.</summary>
    void Gather(List<string> ids, List<float> vsizes, List<float> rates)
    {
        if (stream != null && stream.Live && stream.Transactions.Count > 0)
        {
            foreach (var tx in stream.Transactions)
            {
                ids.Add(tx.txid); vsizes.Add(tx.vsize); rates.Add(tx.rate);
            }
            return;
        }
        // Fallback: the freight list, so the wall is never blank while the
        // socket is refused or still connecting.
        var offers = feed != null ? feed.Offers : null;
        if (offers == null) return;
        foreach (var tx in offers)
        {
            ids.Add(tx.txid ?? ids.Count.ToString());
            vsizes.Add(tx.vsize);
            rates.Add(tx.FeeRate);
        }
    }

    static readonly List<string> _ids = new();
    static readonly List<float> _vsizes = new();
    static readonly List<float> _rates = new();
    static readonly List<int> _placeOrder = new();
    // each id's Scatter hash, taken once per repack: the sort used to hash both txids in every comparison
    static readonly List<uint> _scatterOf = new();

    /// <summary>
    /// A stable scattering key for a transaction.
    ///
    /// FNV-1a over the txid: cheap, well spread, and the same every time - a
    /// tile must not move because the wall was repacked.
    /// </summary>
    static uint Scatter(string txid)
    {
        uint h = 2166136261u;
        if (txid != null)
            for (int i = 0; i < txid.Length; i++) { h ^= txid[i]; h *= 16777619u; }
        return h;
    }

    /// <summary>
    /// Repack the wall and give every tile a new destination.
    ///
    /// Nothing jumps: a tile that is already on the wall keeps its current
    /// position and is sent to the new one, a tile that has just arrived
    /// starts off the left edge - mempool's animationOffset - and one whose
    /// transaction has been mined or replaced is sent off the right edge and
    /// removed when it gets there.
    /// </summary>
    void Relayout()
    {
        if (stream != null && stream.Version == _seenVersion && _tiles.Count > 0) return;
        if (stream != null) _seenVersion = stream.Version;

        _ids.Clear(); _vsizes.Clear(); _rates.Clear();
        Gather(_ids, _vsizes, _rates);
        if (_ids.Count == 0) return;
        _dirty = true;

        float cell = size / slots;
        float scale = ScaleFor(_vsizes, slots, fill);
        var skyline = new int[slots];
        foreach (var t in _tiles.Values) t.seen = false;

        // Placed in a SCATTERED order, not the order the socket sent them.
        //
        // The feed arrives sorted by fee rate, and fee rate correlates with
        // size, so a skyline packer laid it down in bands: a solid field of
        // identical small tiles above, the big ones stacked along the bottom.
        // The real thing mixes them - a large transaction sits wherever it
        // happens to fit, with small ones packed around it - and that mixing
        // is most of what makes it read as a mempool rather than a chart.
        //
        // Ordered by a hash of the txid rather than shuffled: it has to be the
        // same order on the next repack, or every tile would swap places with
        // a stranger each time the wall refreshes.
        _placeOrder.Clear();
        // ONE HASH PER TILE, NOT TWO PER COMPARISON (measured 2026-10-08: this sort's comparator was 1.0 s of
        // 30 s of spectate in a named profile at 4x CPU, one spike per feed update). The keys are the same numbers the
        // comparator computed, so the comparisons - and the order - are unchanged.
        _scatterOf.Clear();
        for (int i = 0; i < _ids.Count; i++) { _placeOrder.Add(i); _scatterOf.Add(Scatter(_ids[i])); }
        _placeOrder.Sort((a, b) => _scatterOf[a].CompareTo(_scatterOf[b]));

        foreach (int i in _placeOrder)
        {
            int side = SideFor(_vsizes[i], Mathf.Max(1, slots / 3), scale);
            if (!Place(skyline, side, out int px, out int py)) continue;

            var to = new Vector2((px + side * 0.5f) * cell - size * 0.5f,
                                 (py + side * 0.5f) * cell - size * 0.5f);
            float wide = side * cell * 0.86f;      // a hairline between tiles
            float ramp = Along(_rates[i]);

            if (!_tiles.TryGetValue(_ids[i], out var tile))
            {
                tile = new Tile
                {
                    id = _ids[i],
                    // in from the left, a wall's width out, as theirs does
                    at = new Vector2(-size * 1.4f, to.y),
                    sizeNow = wide,
                    ramp = ramp,
                };
                _tiles[_ids[i]] = tile;
            }

            tile.seen = true;
            tile.leaving = false;
            tile.from = tile.at;
            tile.to = to;
            tile.sizeFrom = tile.sizeNow;
            tile.sizeTo = wide;
            tile.rampFrom = tile.ramp;
            tile.ramp = ramp;
            tile.t = 0f;
        }

        // Anything the block no longer holds has been mined or replaced.
        foreach (var t in _tiles.Values)
        {
            if (t.seen || t.leaving) continue;
            t.leaving = true;
            t.from = t.at;
            t.to = new Vector2(size * 1.4f, t.at.y);
            t.sizeFrom = t.sizeNow;
            t.sizeTo = t.sizeNow;
            t.t = 0f;
        }
    }

    bool _dirty;

    /// <summary>Moves every tile along, and says whether any of them moved.</summary>
    bool Advance(float dt)
    {
        float step = dt / Mathf.Max(0.05f, travelSeconds);
        _order.Clear();
        var gone = new List<string>();
        bool moving = false;

        foreach (var t in _tiles.Values)
        {
            if (t.t < 1f) moving = true;
            t.t = Mathf.Min(1f, t.t + step);
            // ease out, so a transaction arrives rather than stops
            float e = 1f - (1f - t.t) * (1f - t.t) * (1f - t.t);
            t.at = Vector2.LerpUnclamped(t.from, t.to, e);
            t.sizeNow = Mathf.LerpUnclamped(t.sizeFrom, t.sizeTo, e);

            if (t.leaving && t.t >= 1f) { gone.Add(t.id); continue; }
            _order.Add(t);
        }
        foreach (var id in gone) _tiles.Remove(id);
        return moving || gone.Count > 0;
    }

    static readonly List<Vector3> _verts = new();
    static readonly List<Vector2> _uvs = new();
    static readonly List<int> _tris = new();

    void Draw()
    {
        _verts.Clear(); _uvs.Clear(); _tris.Clear();
        float half = size * 0.5f;

        foreach (var t in _order)
        {
            // clipped to the panel: a tile flying in from off the edge must
            // not be drawn across the building next to it
            if (t.at.x + t.sizeNow * 0.5f < -half || t.at.x - t.sizeNow * 0.5f > half) continue;

            float s = t.sizeNow * 0.5f;
            int v = _verts.Count;
            _verts.Add(new Vector3(t.at.x - s, t.at.y - s, 0f));
            _verts.Add(new Vector3(t.at.x + s, t.at.y - s, 0f));
            _verts.Add(new Vector3(t.at.x + s, t.at.y + s, 0f));
            _verts.Add(new Vector3(t.at.x - s, t.at.y + s, 0f));

            // the colour eases too, so a re-priced transaction slides along
            // the ramp rather than blinking
            float e = Mathf.Clamp01(t.t);
            float u = Mathf.Lerp(t.rampFrom, t.ramp, e);
            for (int i = 0; i < 4; i++) _uvs.Add(new Vector2(u, 0.5f));

            _tris.Add(v); _tris.Add(v + 2); _tris.Add(v + 1);
            _tris.Add(v); _tris.Add(v + 3); _tris.Add(v + 2);
        }

        _mesh.Clear();
        if (_verts.Count == 0) return;
        _mesh.SetVertices(_verts);
        _mesh.SetUVs(0, _uvs);
        _mesh.SetTriangles(_tris, 0);
        _mesh.RecalculateBounds();
    }

    /// <summary>
    /// Skyline packing: the lowest place this square fits, leftmost first.
    ///
    /// The scan-every-cell version this replaces was fine for forty tiles and
    /// hopeless for two thousand - it is O(transactions x grid), which at 64 x
    /// 64 is fourteen million tests every relayout. The skyline is one height
    /// per column and finds the same bottom-left arrangement in a single pass
    /// across the columns.
    /// </summary>
    static bool Place(int[] skyline, int side, out int px, out int py)
    {
        int n = skyline.Length;
        px = py = 0;
        int bestY = int.MaxValue, bestX = -1;

        for (int x = 0; x + side <= n; x++)
        {
            int y = 0;
            for (int i = 0; i < side; i++) y = Mathf.Max(y, skyline[x + i]);
            if (y + side > n) continue;
            if (y < bestY) { bestY = y; bestX = x; }
        }
        if (bestX < 0) return false;

        for (int i = 0; i < side; i++) skyline[bestX + i] = bestY + side;
        px = bestX; py = bestY;
        return true;
    }
}
