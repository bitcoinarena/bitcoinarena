// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using UnityEngine;
using L = Arena.Layout;

/// <summary>
/// THE CANDLES AS TERRAIN (WAR_TACTICS.md §4.15), a RAISED RIBBON on ONE SURFACE (492f128 PLAYTEST FIX, 2026-09-17
/// 13:51: "he can drive onto candles without getting stuck"). Every body is its whole slot, bodies touch, the plateau is
/// 1 m over the ground and every free edge is a 4 m ramp at 25%; nothing is a wall. The chart MOVES (13:49): the core
/// slides the slots toward the post office by `CV_SHIFT`, half a slot per sample, and a new candle grows out of the ground.
///
/// ONE SURFACE: the drawn height at a vertex is the core's ground under the candle layer (`TerrainAt`, the same ground
/// the terrain mesh draws) plus the candle layer's height from the core's words (`LayerAt`, the core's `candleHeightAt`
/// read in floats and tested against the core's own heights). The ground is asked of the core once per 0.5 m cell and
/// held two to four seconds, staggered, so a rebuild asks the bridge for few cells; the mesh is rebuilt ten times a second and slid by the shift
/// in between, so it glides at the core's 0.576 m/s.
///
/// The look (§4.15 client rows, 2026-09-17 15:20 and 15:30): matte TradingView green #26a69a / red #ef5350, the
/// plateau 20% lighter than its ramps; NO GLOW ("I do not want to see through the candles") and no column: the WICK IS
/// GROUND, a 0.5 m ridge with a 1 m top beyond the body's ends, ramped at 25%, in the core's layer like the body and drawn
/// the same way; the forming candle's top face pulses at 1 Hz; the seam a 0.5 m white line on the ground. Nothing about a
/// candle is transparent, nothing stands above 1 m, nothing is passed through.
/// </summary>
public class CandleTerrain : MonoBehaviour
{
    public static readonly Color Green = new Color(0x26 / 255f, 0xa6 / 255f, 0x9a / 255f), Red = new Color(0xef / 255f, 0x53 / 255f, 0x50 / 255f);
    /// <summary>The plateau, 20% lighter than the ramps.</summary>
    public static Color Top(Color c) => Color.Lerp(c, Color.white, 0.2f);
    public const float Station = 0.5f, XStation = 1f, Lift = 0.03f, SeamHalf = 0.25f;
    public const float RebuildSeconds = 0.1f, GroundSeconds = 2f;
    /// <summary>
    /// THE RIBBON IS REBUILT WHEN SOMETHING ON IT CHANGED (2026-10-08, comment 979): every RebuildSeconds it
    /// was rebuilt whatever changed - in a named profile of the 7 s after 100 % (Pixel 7a profile, 10x CPU) LateUpdate was
    /// 522-623 ms, ~70 rebuilds. Now a rebuild needs the core's candle words to change (all but the shift), the surface
    /// signature to change, or the ribbon to have slid SlideMetres since it was built; between, it slides as it always did.
    /// </summary>
    public const float SlideMetres = 0.25f;


    const float ONE = 65536f;
    readonly int[] _words = new int[L.CV_TOTAL];
    Mesh _body, _tail, _seam;
    /// <summary>The last TailCandles candles are their own mesh: the forming candle's words move with the price every tick (kanban
    ///, comment 980), and its neighbour reads its z, so a change in the forming candle alone rebuilds these two.</summary>
    public const int TailCandles = 2;
    float _tailShift;
    Material _formingTop;
    float _builtShift, _builtAt = -1f;
    int _builtSurface = int.MinValue;
    readonly int[] _builtWords = new int[L.CV_TOTAL];
    // `?candlegate=0` on the page's address: the old rule (every RebuildSeconds), in the same build - the A/B of comment 979
    static bool? _gate;
    static bool Gate => _gate ??= !(Application.absoluteURL ?? "").Contains("candlegate=0");
    int _countedRebuilds; float _countedAt = -1f;
    int _bySurface, _byWords, _bySlide, _byTail, _wordAt = -1;
    public int Rebuilds { get; private set; }
    /// <summary>The core's candle words this frame, for what lies on the ribbon (the roads); null before the first view.</summary>
    public static int[] LiveWords { get; private set; }

    /// <summary>The geometry of one view, as lists per part. Pure, for the tests: the ground is asked, not computed.</summary>
    public class Parts
    {
        public readonly List<Vector3> Body = new List<Vector3>();
        public readonly List<int> SideGreen = new List<int>(), SideRed = new List<int>(), TopGreen = new List<int>(), TopRed = new List<int>();
        /// <summary>The forming candle's top faces, drawn with the pulsing material.</summary>
        public readonly List<int> FormingTop = new List<int>();
        public bool FormingGreen;
        /// <summary>Triangles of the wick ridges beyond the bodies (counted for the tests; they are in the lists above).</summary>
        public int RidgeTriangles;
    }

    static float W(int[] v, int c, int k) => v[L.CV_FIRST + c * L.CV_WORDS + k] / ONE;

    /// <summary>
    /// The candle layer's height at a world point, metres: the core's `candleHeightAt` (rules/candles.js) on the view's
    /// words. Inside a body the plateau, less the ramp within R of the ribbon's boundary - the body's z-ends, the parts of its
    /// x-faces its neighbour does not cover, and the field's fixed ends; 0 off the ribbon.
    /// </summary>
    public static float LayerAt(int[] v, float x, float z)
    {
        float west = L.CANDLE_WEST / ONE, east = L.CANDLE_EAST / ONE;
        if (x <= west || x >= east) return 0f;
        float S = L.CANDLE_SLOT / ONE, R = L.CANDLE_RAMP / ONE, xs = x + v[L.CV_SHIFT] / ONE, dx = xs - L.CANDLE_X0 / ONE;
        int n = Mathf.Min(v[L.CV_COUNT], L.CANDLES);
        if (dx < 0f || dx >= n * S) return 0f;
        int c = Mathf.Clamp(Mathf.FloorToInt(dx / S), 0, n - 1);
        float z0 = W(v, c, 2), z1 = W(v, c, 3), H = W(v, c, 4);
        float clip = Mathf.Min(x - west, east - x);
        float ridge = RidgeAt(v, c, dx - (c + 0.5f) * S, z, clip);
        if (z <= z0 || z >= z1) return ridge;
        float d = Mathf.Min(Mathf.Min(z - z0, z1 - z), clip);
        float left = dx - c * S, right = S - left;
        if (left < R) d = Mathf.Min(d, FaceDistance(v, n, c - 1, z0, z1, z, left));
        if (right < R) d = Mathf.Min(d, FaceDistance(v, n, c + 1, z0, z1, z, right));
        return Mathf.Max(d >= R ? H : H * d / R, ridge);
    }

    /// <summary>The wick ridge (core `wickRidge`): 0.5 m on a 1 m top along the slot's centre, 25% down its sides and ends.</summary>
    static float RidgeAt(int[] v, int c, float across, float z, float clip)
    {
        float RH = L.WICK_RIDGE_H / ONE, top = L.WICK_RIDGE_TOP_HALF / ONE, RR = L.WICK_RIDGE_RAMP / ONE, R = L.CANDLE_RAMP / ONE;
        float side = top + RR - Mathf.Abs(across);
        if (side <= 0f) return 0f;
        float z0 = W(v, c, 2), z1 = W(v, c, 3), lo = W(v, c, 6), hi = W(v, c, 7);
        float along = -1f;
        if (lo < z0 && z > lo && z < z0 + R) along = Mathf.Min(z - lo, z0 + R - z);
        if (hi > z1 && z < hi && z > z1 - R) along = Mathf.Max(along, Mathf.Min(hi - z, z - (z1 - R)));
        if (along <= 0f) return 0f;
        float d = Mathf.Min(Mathf.Min(side, along), clip);
        return d >= RR ? RH : RH * d / RR;
    }

    static float FaceDistance(int[] v, int n, int nb, float z0, float z1, float z, float across)
    {
        if (nb < 0 || nb >= n) return across;
        float n0 = W(v, nb, 2), n1 = W(v, nb, 3);
        if (z <= n0 || z >= n1) return across;
        float best = float.MaxValue;
        if (n0 > z0) best = Mathf.Min(best, Mathf.Sqrt(across * across + (z - n0) * (z - n0)));
        if (n1 < z1) best = Mathf.Min(best, Mathf.Sqrt(across * across + (n1 - z) * (n1 - z)));
        return best;
    }

    /// <summary>Sorted stations from a to b every `step`, with the given breakpoints inside, no two closer than 1 cm.</summary>
    static List<float> Stations(float a, float b, float step, List<float> into, params float[] breaks)
    {
        into.Clear();
        for (float s = a; s < b; s += step) into.Add(s);
        into.Add(b);
        foreach (var k in breaks) if (k > a && k < b) into.Add(k);
        into.Sort();
        for (int i = into.Count - 1; i > 0; i--) if (into[i] - into[i - 1] < 0.01f) into.RemoveAt(into[i] >= b - 1e-4f ? i - 1 : i);
        return into;
    }

    /// <summary>
    /// The ribbon and its wick ridges for a view, in world space at the view's shift. <paramref name="ground"/> is the core's
    /// ground under the candle layer, in metres, asked at world x, z.
    /// </summary>
    public static Parts Build(int[] v, Func<float, float, float> ground) => Build(v, ground, 0, int.MaxValue);

    /// <summary>
    /// Candles [from, to) only (comment 980): each candle's geometry reads the words and the ground and nothing
    /// built before it, so the parts of [0, k) followed by those of [k, n) are the parts of [0, n).
    /// </summary>
    public static Parts Build(int[] v, Func<float, float, float> ground, int from, int to)
    {
        var p = new Parts();
        int n = Mathf.Min(v[L.CV_COUNT], L.CANDLES), forming = v[L.CV_FORMING];
        float shift = v[L.CV_SHIFT] / ONE, west = L.CANDLE_WEST / ONE, east = L.CANDLE_EAST / ONE, R = L.CANDLE_RAMP / ONE;
        var xs = new List<float>(); var zs = new List<float>();
        for (int c = Mathf.Max(0, from); c < Mathf.Min(n, to); c++)
        {
            float sx0 = W(v, c, 0) - shift, sx1 = W(v, c, 1) - shift, z0 = W(v, c, 2), z1 = W(v, c, 3), H = W(v, c, 4);
            float xa = Mathf.Max(west, sx0), xb = Mathf.Min(east, sx1);
            bool green = W(v, c, 5) != 0f;
            if (c == forming) p.FormingGreen = green;
            if (xb - xa < 0.01f) continue;
            float cx = (sx0 + sx1) * 0.5f, low = W(v, c, 6), high = W(v, c, 7);
            float rtop = L.WICK_RIDGE_TOP_HALF / ONE, rout = rtop + L.WICK_RIDGE_RAMP / ONE, rr = L.WICK_RIDGE_RAMP / ONE;
            // the forming candle pulses whole (a half-grown body has no flat top yet): its faces go to the pulsing material
            var side = c == forming ? p.FormingTop : (green ? p.SideGreen : p.SideRed);
            var top = c == forming ? p.FormingTop : (green ? p.TopGreen : p.TopRed);
            if (z1 - z0 > 0.01f)
            {
                // the height field over the slot, with a station at every kink of the ramps: R in from each end and face,
                // the neighbours' z-ends where a face turns from covered to free, and the wick ridge's edges
                float nb0 = c > 0 ? W(v, c - 1, 2) : z0, nb1 = c > 0 ? W(v, c - 1, 3) : z1;
                float na0 = c + 1 < n ? W(v, c + 1, 2) : z0, na1 = c + 1 < n ? W(v, c + 1, 3) : z1;
                // ...AND THE SLOT'S OWN CENTRE. With ruling B refitted to the miner's door a slot is 5.181 m and the
                // 4 m ramps from its two ends CROSS: the body has no flat top in x any more, it has a peak at cx, and
                // a 1 m station grid cut that peak off - measured against the core, 0.193 m out at -70.04,-14.60
                // where the tolerance is 0.100. The kink is a station now, as every other kink already was.
                Stations(xa, xb, XStation, xs, sx0 + R, sx1 - R, west + R, east - R, cx - rtop, cx + rtop, cx - rout, cx + rout, cx);
                Stations(z0, z1, Station, zs, z0 + R, z1 - R, nb0, nb1, na0, na1, nb0 + R, nb1 - R, na0 + R, na1 - R, z0 + R - rr, z1 - R + rr);
                Grid(p, v, ground, xs, zs, side, top, false);
            }
            // THE WICK RIDGES beyond the body's ends (15:30): ground, drawn like the body, only as wide as the ridge
            float ra = Mathf.Max(xa, cx - rout), rb = Mathf.Min(xb, cx + rout);
            if (rb - ra > 0.01f)
            {
                // A ridge runs R into its body (core wickRidge); a body shorter than R - a doji - leaves it poking out past
                // the body's OTHER end, so that stretch is drawn too (measured: a doji's high ridge down to z1 - R, 3 m below it).
                void Ridge(float from, float to, float kink)
                {
                    if (to - from < 0.01f) return;
                    Stations(ra, rb, Station, xs, cx - rtop, cx + rtop);
                    Stations(from, to, Station, zs, kink);
                    p.RidgeTriangles += Grid(p, v, ground, xs, zs, side, green ? p.TopGreen : p.TopRed, true);
                }
                if (low < z0 - 0.01f) { Ridge(low, z0, low + rr); Ridge(z1, z0 + R, z0 + R - rr); }
                if (high > z1 + 0.01f) { Ridge(z1, high, high - rr); Ridge(z1 - R, z0, z1 - R + rr); }
            }
        }
        return p;
    }

    /// <summary>
    /// One height field of the candle layer over the stations: vertices at the core's ground plus LayerAt, a quad flat at a
    /// height above the ground (a plateau or a ridge top) into <paramref name="top"/>, the rest (ramps) into <paramref name="side"/>.
    /// Returns the triangles added.
    /// </summary>
    static int Grid(Parts p, int[] v, Func<float, float, float> ground, List<float> xs, List<float> zs, List<int> side, List<int> top, bool ridgeOnly)
    {
        int cols = xs.Count, first = p.Body.Count, added = 0;
        var layer = new float[cols * zs.Count];
        for (int j = 0; j < zs.Count; j++)
            for (int i = 0; i < cols; i++)
            {
                float h = LayerAt(v, xs[i], zs[j]);
                layer[j * cols + i] = h;
                p.Body.Add(new Vector3(xs[i], ground(xs[i], zs[j]) + h + Lift, zs[j]));
            }
        for (int j = 0; j + 1 < zs.Count; j++)
            for (int i = 0; i + 1 < cols; i++)
            {
                int a = j * cols + i, b = a + cols;
                float h0 = layer[a];
                if (ridgeOnly && h0 <= 0f && layer[a + 1] <= 0f && layer[b] <= 0f && layer[b + 1] <= 0f) continue;   // bare ground beside a ridge
                bool flat = h0 > 1e-3f && Mathf.Abs(layer[a + 1] - h0) < 1e-3f && Mathf.Abs(layer[b] - h0) < 1e-3f && Mathf.Abs(layer[b + 1] - h0) < 1e-3f;
                var t = flat ? top : side;
                // clockwise from above (Unity's front face): a, b, b+1 and a, b+1, a+1
                t.Add(first + a); t.Add(first + b); t.Add(first + b + 1);
                t.Add(first + a); t.Add(first + b + 1); t.Add(first + a + 1);
                added += 2;
            }
        return added;
    }

    /// <summary>The seam as a 0.5 m white strip on the core's surface, across the candle field, from the core's front line.</summary>
    public static void BuildSeam(float x0, float x1, Func<float, float> seamZ, Func<float, float, float> surface, List<Vector3> verts, List<int> tris)
    {
        verts.Clear(); tris.Clear();
        const float step = 1f;
        float zPrev = seamZ(x0);
        for (float x = x0; x < x1; x += step)
        {
            float xb = Mathf.Min(x1, x + step), za = zPrev, zb = seamZ(xb);
            zPrev = zb;
            Quad(verts, tris, new Vector3(x, surface(x, za - SeamHalf) + 0.05f, za - SeamHalf), new Vector3(x, surface(x, za + SeamHalf) + 0.05f, za + SeamHalf),
                              new Vector3(xb, surface(xb, zb + SeamHalf) + 0.05f, zb + SeamHalf), new Vector3(xb, surface(xb, zb - SeamHalf) + 0.05f, zb - SeamHalf));
        }
    }

    /// <summary>A quad a b c d, clockwise from its front: two triangles on four vertices of its own.</summary>
    static void Quad(List<Vector3> verts, List<int> tris, Vector3 a, Vector3 b, Vector3 c, Vector3 d)
    {
        int i = verts.Count;
        verts.Add(a); verts.Add(b); verts.Add(c); verts.Add(d);
        tris.Add(i); tris.Add(i + 1); tris.Add(i + 2);
        tris.Add(i); tris.Add(i + 2); tris.Add(i + 3);
    }

    /// <summary>
    /// The core's ground under the candle layer on a 0.5 m grid, each cell asked when first read and again once it is older
    /// than `hold` seconds - the berms glide with the seam - staggered per cell over one to two holds so the re-asks spread
    /// over frames instead of landing on one; everything is asked again when the relief, a strike or a crater changes it.
    /// Bilinear between cells.
    /// </summary>
    public class GroundCache
    {
        const float Cell = 0.5f, X0 = -80f, Z0 = -90f;
        const int Cols = 400, Rows = 360;
        readonly float[] _h = new float[Cols * Rows], _until = new float[Cols * Rows];
        readonly Func<float, float, float> _ask;
        public float Now, Hold = float.PositiveInfinity;
        public int Asked { get; private set; }
        public GroundCache(Func<float, float, float> ask) { _ask = ask; Clear(); }
        public void Clear() { for (int i = 0; i < _h.Length; i++) _h[i] = float.NaN; }

        float At(int i, int j)
        {
            i = Mathf.Clamp(i, 0, Cols - 1); j = Mathf.Clamp(j, 0, Rows - 1);
            int k = j * Cols + i;
            if (float.IsNaN(_h[k]) || Now >= _until[k])
            {
                _h[k] = _ask(X0 + i * Cell, Z0 + j * Cell); Asked++;
                _until[k] = Now + Hold * (1f + (unchecked((uint)k * 2654435761u) >> 22) / 1024f);
            }
            return _h[k];
        }

        public float Get(float x, float z)
        {
            float fx = (x - X0) / Cell, fz = (z - Z0) / Cell;
            int i = Mathf.FloorToInt(fx), j = Mathf.FloorToInt(fz);
            float tx = fx - i, tz = fz - j;
            float a = At(i, j), b = At(i + 1, j), c = At(i, j + 1), d = At(i + 1, j + 1);
            return Mathf.Lerp(Mathf.Lerp(a, b, tx), Mathf.Lerp(c, d, tx), tz);
        }
    }

    Mesh Child(string name, Material[] mats)
    {
        var go = new GameObject(name);
        go.transform.SetParent(transform, false);
        var mesh = new Mesh { name = name, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
        mesh.MarkDynamic();
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        mr.sharedMaterials = mats;
        mr.shadowCastingMode = name.StartsWith("CandleBodies") ? UnityEngine.Rendering.ShadowCastingMode.On : UnityEngine.Rendering.ShadowCastingMode.Off;
        return mesh;
    }

    static Material Matte(Color c)
    {
        var m = new Material(Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard"));
        if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
        m.color = c;
        if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", 0f);
        if (m.HasProperty("_Metallic")) m.SetFloat("_Metallic", 0f);
        if (m.HasProperty("_SpecularHighlights")) m.SetFloat("_SpecularHighlights", 0f);
        m.EnableKeyword("_SPECULARHIGHLIGHTS_OFF");
        return m;
    }

    void EnsureMeshes()
    {
        if (_body != null) return;
        _formingTop = Matte(Top(Green));
        var mats = new[] { Matte(Green), Matte(Red), Matte(Top(Green)), Matte(Top(Red)), _formingTop };
        _body = Child("CandleBodies", mats);
        _tail = Child("CandleBodiesTail", mats);
        _seam = Child("Seam", new[] { Matte(Color.white) });
    }

    readonly List<Vector3> _seamVerts = new List<Vector3>();
    readonly List<int> _seamTris = new List<int>();
    bool _formingGreen;
    GroundCache _ground;

    void LateUpdate()
    {
        if (!Arena.ArenaCore.Available || Arena.ArenaCore.CandleView(_words) == 0) return;
        LiveWords = _words;
        EnsureMeshes();
        float now = Time.unscaledTime, shift = _words[L.CV_SHIFT] / ONE;
        if (_formingTop != null)
        {
            // the forming candle's top face pulses at 1 Hz: its top colour, 15% toward white and back
            var c = Color.Lerp(Top(_formingGreen ? Green : Red), Color.white, 0.15f * (0.5f + 0.5f * Mathf.Sin(now * Mathf.PI * 2f)));
            if (_formingTop.HasProperty("_BaseColor")) _formingTop.SetColor("_BaseColor", c);
            _formingTop.color = c;
        }
        int surfaceSig = Arena.ArenaCore.ReliefEpoch * 1000003 + Arena.ArenaCore.StrikeCount * 1009 + Arena.ArenaCore.CraterCount;
        if (_ground == null) _ground = new GroundCache(Arena.ArenaCore.TerrainAt) { Hold = GroundSeconds };
        _ground.Now = now;
        bool surfaceChanged = surfaceSig != _builtSurface;
        if (surfaceChanged) _ground.Clear();

        int n = Mathf.Min(_words[L.CV_COUNT], L.CANDLES), tailFrom = Mathf.Max(0, n - TailCandles);
        bool wordsChanged = WordsChanged(_words, _builtWords), slid = Mathf.Abs(shift - _builtShift) >= SlideMetres;
        bool full = Gate ? surfaceChanged || _builtAt < 0f || slid || (wordsChanged && !OnlyLastCandleChanged(_words, _builtWords, n))
                         : surfaceChanged || _builtAt < 0f || now - _builtAt >= RebuildSeconds;
        bool tailOnly = !full && Gate && wordsChanged;
        if (full || tailOnly)
        {
            // WHY (the 5 s count says it): the surface, the words (and the first word that moved), the slide; the forming candle alone
            if (surfaceChanged) _bySurface++; else if (tailOnly) _byTail++; else if (wordsChanged) { _byWords++; _wordAt = FirstChanged(_words, _builtWords); } else if (slid) _bySlide++;
            System.Array.Copy(_words, _builtWords, _words.Length);
            var tail = Build(_words, _ground.Get, tailFrom, n);
            Set(_tail, tail.Body, tail.SideGreen, tail.SideRed, tail.TopGreen, tail.TopRed, tail.FormingTop);
            _tailShift = shift;
            var p = tail;
            if (full)
            {
                _builtAt = now; _builtSurface = surfaceSig; _builtShift = shift;
                p = Build(_words, _ground.Get, 0, tailFrom);
                Set(_body, p.Body, p.SideGreen, p.SideRed, p.TopGreen, p.TopRed, p.FormingTop);
            }
            _formingGreen = tail.FormingGreen || p.FormingGreen;
            BuildSeam(L.CANDLE_WEST / ONE, L.CANDLE_EAST / ONE, Arena.ArenaCore.FrontlineZ, Surface, _seamVerts, _seamTris);
            Set(_seam, _seamVerts, _seamTris);
            Rebuilds++;
            // THE SURFACE CHECK NOT AT START (measured 2026-10-08 in a named profile at 10x CPU as an Android phone:
            // SurfaceCheck - ~170 points, each against every body triangle - was 226 ms inside Unity's start, from the first
            // rebuilds' lines). The first three lines say so; the check is logged at rebuild 30 and every 600th, as the probe reads it.
            if (Rebuilds <= 3 || Rebuilds == 30 || Rebuilds % 600 == 0)
            {
                int f = L.CV_FIRST;
                Debug.Log($"[candles] rebuild={Rebuilds} count={_words[L.CV_COUNT]} shift={shift:0.000} forming={_words[L.CV_FORMING]} first={_words[f]},{_words[f + 1]},{_words[f + 2]},{_words[f + 3]},{_words[f + 4]},{_words[f + 5]} bodyVerts={_body.vertexCount + _tail.vertexCount} ridgeTriangles={tail.RidgeTriangles + (p != tail ? p.RidgeTriangles : 0)} formingTop={(tail.FormingTop.Count + (p != tail ? p.FormingTop.Count : 0)) / 3} groundAsked={_ground.Asked} {(Rebuilds <= 3 ? "surfaceCheck=after-start" : SurfaceCheck())}");
            }
        }
        // between rebuilds the ribbon slides with the core's shift, so it glides at 0.576 m/s rather than stepping; the
        // seam line reads the core's front at world x and stays
        // (each body mesh from the shift it was built at)
        var slide = new Vector3(_builtShift - shift, 0f, 0f);
        foreach (Transform child in transform)
            if (child.name == "CandleBodiesTail") child.localPosition = new Vector3(_tailShift - shift, 0f, 0f);
            else if (child.name != "Seam") child.localPosition = slide;

        // HOW OFTEN IT REBUILDS, said every 5 s for the first minute (the probe of comment 979 reads it)
        if (_countedAt < 0f) { _countedAt = now; _countedRebuilds = Rebuilds; }
        else if (now - _countedAt >= 5f && now < 65f)
        {
            Debug.Log($"[candles] rebuilds={Rebuilds - _countedRebuilds} in {now - _countedAt:0.0} s gate={(Gate ? "on" : "off")} total={Rebuilds} " +
                      $"surface={_bySurface} words={_byWords} (last word {_wordAt}) slide={_bySlide} formingOnly={_byTail}");
            _bySurface = _byWords = _bySlide = _byTail = 0;
            _countedAt = now; _countedRebuilds = Rebuilds;
        }
    }

    /// <summary>Only the last candle's words changed (all but the shift): the forming candle moving with the price.</summary>
    public static bool OnlyLastCandleChanged(int[] now, int[] built, int n)
    {
        int last = L.CV_FIRST + (n - 1) * L.CV_WORDS;
        for (int i = 0; i < last && i < now.Length; i++)
            if (i != L.CV_SHIFT && now[i] != built[i]) return false;
        return n > 0;
    }

    static int FirstChanged(int[] now, int[] built)
    {
        for (int i = 0; i < now.Length; i++) if (i != L.CV_SHIFT && now[i] != built[i]) return i;
        return -1;
    }

    /// <summary>Did the core's candle words change since the build - every word but the shift, which the slide carries.</summary>
    public static bool WordsChanged(int[] now, int[] built)
    {
        for (int i = 0; i < now.Length; i++)
            if (i != L.CV_SHIFT && now[i] != built[i]) return true;
        return false;
    }

    float Surface(float x, float z) => _ground.Get(x, z) + LayerAt(_words, x, z);

    static void Set(Mesh mesh, List<Vector3> verts, params List<int>[] subs)
    {
        mesh.Clear();
        mesh.SetVertices(verts);
        mesh.subMeshCount = subs.Length;
        for (int i = 0; i < subs.Length; i++) mesh.SetTriangles(subs[i], i);
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();
    }

    /// <summary>
    /// ONE SURFACE, measured in the player: at points across the candle field, the drawn top - the higher of the terrain
    /// mesh and the ribbon - against the core's `SurfaceAt`. Logged with the first rebuilds and every minute for the probe.
    /// </summary>
    string SurfaceCheck()
    {
        var terrain = FindFirstObjectByType<MempoolTerrain>();
        if (terrain == null) return "surfaceCheck=no-terrain";
        float worst = 0f, worstX = 0f, worstZ = 0f; int n = 0, inBody = 0;
        var verts = new List<Vector3>(); var tris = new List<int>();
        foreach (var mesh in new[] { _body, _tail })
        {
            var mv = new List<Vector3>(); mesh.GetVertices(mv);
            int at = verts.Count; verts.AddRange(mv);
            for (int s = 0; s < mesh.subMeshCount; s++) foreach (int i in mesh.GetTriangles(s)) tris.Add(at + i);
        }
        for (float x = -70f; x <= 100f; x += 14.3f)
            for (float z = -44f; z <= 44f; z += 7.3f)
            {
                float core = Arena.ArenaCore.SurfaceAt(x, z);
                float drawn = terrain.DrawnHeightAt(x, z);
                float top = TopAt(verts, tris, x, z);
                if (!float.IsNaN(top)) { top -= Lift; inBody++; drawn = float.IsNaN(drawn) ? top : Mathf.Max(drawn, top); }
                if (float.IsNaN(drawn)) continue;
                float d = Mathf.Abs(drawn - core);
                if (d > worst) { worst = d; worstX = x; worstZ = z; }
                n++;
            }
        return $"surfaceCheck points={n} inBody={inBody} worst={worst:0.000} at={worstX:0.0},{worstZ:0.0}";
    }

    /// <summary>The highest body triangle straight above (x, z), NaN where no body is drawn.</summary>
    public static float TopAt(List<Vector3> verts, List<int> tris, float x, float z)
    {
        float best = float.NaN;
        for (int t = 0; t < tris.Count; t += 3)
        {
            Vector3 a = verts[tris[t]], b = verts[tris[t + 1]], c = verts[tris[t + 2]];
            if (x < Mathf.Min(a.x, Mathf.Min(b.x, c.x)) - 1e-3f || x > Mathf.Max(a.x, Mathf.Max(b.x, c.x)) + 1e-3f) continue;
            if (z < Mathf.Min(a.z, Mathf.Min(b.z, c.z)) - 1e-3f || z > Mathf.Max(a.z, Mathf.Max(b.z, c.z)) + 1e-3f) continue;
            float d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
            if (Mathf.Abs(d) < 1e-9f) continue;
            float wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
            float wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
            float wc = 1f - wa - wb;
            if (wa < -1e-4f || wb < -1e-4f || wc < -1e-4f) continue;
            float y = wa * a.y + wb * b.y + wc * c.y;
            if (float.IsNaN(best) || y > best) best = y;
        }
        return best;
    }
}
