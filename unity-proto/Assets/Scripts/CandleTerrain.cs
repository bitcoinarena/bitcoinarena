using System;
using System.Collections.Generic;
using UnityEngine;
using L = Blwp.Layout;

/// <summary>
/// THE CANDLES AS TERRAIN (WAR_TACTICS.md §4.15), a RAISED RIBBON on ONE SURFACE (492f128 PLAYTEST FIX, the owner 2026-09-17
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
/// The look (§4.15 client rows): matte TradingView green #26a69a / red #ef5350, the plateau 20% lighter than its ramps; a
/// glow volume from the plateau to 6 m with no edges; the wick a 1 m column of light, 9 m tall, from the candle's low to its
/// high; the forming candle's glow pulsing at 1 Hz; the seam a 0.5 m white line on the ground. Wick and glow are light only
/// - the core has no collider for them.
///
/// BLENDED, NOT ADDED (live 0.0.1496, 2026-09-17): the glow washed the truck's view WHITE. The source was Bootstrap's
/// opaque Lit fire material, whose alpha is 1, so every face ADDED its full colour, and a low sight line along the field
/// crosses two faces per slot, 31 slots. Now the shipped transparent particle material (FireFlipbook, alpha-blended, its
/// variant in the build), vertex colours white (a missing colour attribute reads black on WebGL): any stack of faces tends
/// to the candle's own colour and never past it; 10% a face (wick 35%).
/// </summary>
public class CandleTerrain : MonoBehaviour
{
    public static readonly Color Green = new Color(0x26 / 255f, 0xa6 / 255f, 0x9a / 255f), Red = new Color(0xef / 255f, 0x53 / 255f, 0x50 / 255f);
    /// <summary>The plateau, 20% lighter than the ramps.</summary>
    public static Color Top(Color c) => Color.Lerp(c, Color.white, 0.2f);
    public const float Station = 0.5f, XStation = 1f, Lift = 0.03f, GlowTo = 6f, WickHeight = 9f, WickHalf = 0.5f, SeamHalf = 0.25f;
    public const float GlowAlpha = 0.10f, WickAlpha = 0.35f, RebuildSeconds = 0.1f, GroundSeconds = 2f;

    /// <summary>A transparent source material shipped in the build (Bootstrap's fire flipbook): the glow is a clone of it.</summary>
    public Material glowSource;

    const float ONE = 65536f;
    readonly int[] _words = new int[L.CV_TOTAL];
    Mesh _body, _glow, _forming, _wick, _seam;
    Material _formingMat;
    float _builtShift, _builtAt = -1f;
    int _builtSurface = int.MinValue;
    public int Rebuilds { get; private set; }

    /// <summary>The geometry of one view, as lists per part. Pure, for the tests: the ground is asked, not computed.</summary>
    public class Parts
    {
        public readonly List<Vector3> Body = new List<Vector3>();
        public readonly List<int> SideGreen = new List<int>(), SideRed = new List<int>(), TopGreen = new List<int>(), TopRed = new List<int>();
        public readonly List<Vector3> Glow = new List<Vector3>();
        public readonly List<int> GlowGreen = new List<int>(), GlowRed = new List<int>();
        public readonly List<Vector3> Forming = new List<Vector3>();
        public readonly List<int> FormingTris = new List<int>();
        public bool FormingGreen;
        public readonly List<Vector3> Wick = new List<Vector3>();
        public readonly List<int> WickGreen = new List<int>(), WickRed = new List<int>();
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
        if (z <= z0 || z >= z1) return 0f;
        float d = Mathf.Min(Mathf.Min(z - z0, z1 - z), Mathf.Min(x - west, east - x));
        float left = dx - c * S, right = S - left;
        if (left < R) d = Mathf.Min(d, FaceDistance(v, n, c - 1, z0, z1, z, left));
        if (right < R) d = Mathf.Min(d, FaceDistance(v, n, c + 1, z0, z1, z, right));
        return d >= R ? H : H * d / R;
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
    /// The ribbon, glows and wicks for a view, in world space at the view's shift. <paramref name="ground"/> is the core's
    /// ground under the candle layer, in metres, asked at world x, z.
    /// </summary>
    public static Parts Build(int[] v, Func<float, float, float> ground)
    {
        var p = new Parts();
        int n = Mathf.Min(v[L.CV_COUNT], L.CANDLES), forming = v[L.CV_FORMING];
        float shift = v[L.CV_SHIFT] / ONE, west = L.CANDLE_WEST / ONE, east = L.CANDLE_EAST / ONE, R = L.CANDLE_RAMP / ONE;
        var xs = new List<float>(); var zs = new List<float>();
        for (int c = 0; c < n; c++)
        {
            float sx0 = W(v, c, 0) - shift, sx1 = W(v, c, 1) - shift, z0 = W(v, c, 2), z1 = W(v, c, 3), H = W(v, c, 4);
            float xa = Mathf.Max(west, sx0), xb = Mathf.Min(east, sx1);
            bool green = W(v, c, 5) != 0f;
            if (c == forming) p.FormingGreen = green;
            if (xb - xa < 0.01f) continue;
            if (z1 - z0 > 0.01f)
            {
                // the height field over the slot, with a station at every kink of the ramps: R in from each end and face,
                // and the neighbours' z-ends where a face turns from covered to free
                float nb0 = c > 0 ? W(v, c - 1, 2) : z0, nb1 = c > 0 ? W(v, c - 1, 3) : z1;
                float na0 = c + 1 < n ? W(v, c + 1, 2) : z0, na1 = c + 1 < n ? W(v, c + 1, 3) : z1;
                Stations(xa, xb, XStation, xs, sx0 + R, sx1 - R, west + R, east - R);
                Stations(z0, z1, Station, zs, z0 + R, z1 - R, nb0, nb1, na0, na1, nb0 + R, nb1 - R, na0 + R, na1 - R);
                int cols = xs.Count, first = p.Body.Count;
                var layer = new float[cols * zs.Count];
                for (int j = 0; j < zs.Count; j++)
                    for (int i = 0; i < cols; i++)
                    {
                        float h = LayerAt(v, xs[i], zs[j]);
                        layer[j * cols + i] = h;
                        p.Body.Add(new Vector3(xs[i], ground(xs[i], zs[j]) + h + Lift, zs[j]));
                    }
                var side = green ? p.SideGreen : p.SideRed;
                var top = green ? p.TopGreen : p.TopRed;
                for (int j = 0; j + 1 < zs.Count; j++)
                    for (int i = 0; i + 1 < cols; i++)
                    {
                        int a = j * cols + i, b = a + cols;
                        bool plateau = layer[a] >= H - 1e-3f && layer[a + 1] >= H - 1e-3f && layer[b] >= H - 1e-3f && layer[b + 1] >= H - 1e-3f;
                        var t = plateau ? top : side;
                        // clockwise from above (Unity's front face): a, b, b+1 and a, b+1, a+1
                        t.Add(first + a); t.Add(first + b); t.Add(first + b + 1);
                        t.Add(first + a); t.Add(first + b + 1); t.Add(first + a + 1);
                    }

                // the glow over the plateau: from its top to 6 m, the two x sides and a lid, no edge lines
                var glow = c == forming ? p.Forming : p.Glow;
                var gt = c == forming ? p.FormingTris : (green ? p.GlowGreen : p.GlowRed);
                for (int j = 0; j + 1 < zs.Count; j++)
                {
                    float za = zs[j], zb = zs[j + 1];
                    float ga0 = ground(xa, za) + H, gb0 = ground(xa, zb) + H, ga1 = ground(xb, za) + H, gb1 = ground(xb, zb) + H;
                    float up = GlowTo - H;
                    Quad(glow, gt, new Vector3(xa, ga0 + up, za), new Vector3(xa, gb0 + up, zb), new Vector3(xb, gb1 + up, zb), new Vector3(xb, ga1 + up, za));
                    Quad(glow, gt, new Vector3(xb, ga1, za), new Vector3(xb, ga1 + up, za), new Vector3(xb, gb1 + up, zb), new Vector3(xb, gb1, zb));
                    Quad(glow, gt, new Vector3(xa, gb0, zb), new Vector3(xa, gb0 + up, zb), new Vector3(xa, ga0 + up, za), new Vector3(xa, ga0, za));
                }
            }
            // the wick: a 1 m column of light from the low to the high, 9 m tall from the ground, where its slot stands
            float cx = (sx0 + sx1) * 0.5f, low = W(v, c, 6), high = W(v, c, 7);
            var wt = green ? p.WickGreen : p.WickRed;
            if (high - low > 1e-3f && cx - WickHalf > west && cx + WickHalf < east)
                for (float z = low; z < high - 1e-4f; z += Station)
                {
                    float zb = Mathf.Min(high, z + Station);
                    float ga = ground(cx, z), gb = ground(cx, zb);
                    Quad(p.Wick, wt, new Vector3(cx + WickHalf, ga, z), new Vector3(cx + WickHalf, ga + WickHeight, z), new Vector3(cx + WickHalf, gb + WickHeight, zb), new Vector3(cx + WickHalf, gb, zb));
                    Quad(p.Wick, wt, new Vector3(cx - WickHalf, gb, zb), new Vector3(cx - WickHalf, gb + WickHeight, zb), new Vector3(cx - WickHalf, ga + WickHeight, z), new Vector3(cx - WickHalf, ga, z));
                }
        }
        return p;
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
        mr.shadowCastingMode = name == "CandleBodies" ? UnityEngine.Rendering.ShadowCastingMode.On : UnityEngine.Rendering.ShadowCastingMode.Off;
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

    /// <summary>A translucent light from the shipped transparent particle material: no texture, the colour's alpha, blended.</summary>
    Material Light(Color c, float alpha)
    {
        Material m = glowSource != null ? new Material(glowSource) : Matte(c);
        if (m.HasProperty("_BaseMap")) m.SetTexture("_BaseMap", null);
        if (m.HasProperty("_MainTex")) m.SetTexture("_MainTex", null);
        m.DisableKeyword("_FLIPBOOKBLENDING_ON");
        var col = new Color(c.r, c.g, c.b, alpha);
        if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", col);
        m.color = col;
        if (m.HasProperty("_Surface")) m.SetFloat("_Surface", 1f);
        m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
        if (m.HasProperty("_SrcBlend")) m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
        if (m.HasProperty("_SrcBlendAlpha")) m.SetFloat("_SrcBlendAlpha", (float)UnityEngine.Rendering.BlendMode.One);
        if (m.HasProperty("_DstBlendAlpha")) m.SetFloat("_DstBlendAlpha", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
        if (m.HasProperty("_DstBlend")) m.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
        if (m.HasProperty("_Blend")) m.SetFloat("_Blend", 0f);                         // URP particles: 0 = Alpha, 2 = Additive
        m.DisableKeyword("_ALPHAPREMULTIPLY_ON"); m.DisableKeyword("_ALPHAMODULATE_ON");
        if (m.HasProperty("_ZWrite")) m.SetFloat("_ZWrite", 0f);
        if (m.HasProperty("_Cull")) m.SetFloat("_Cull", 0f);
        m.renderQueue = 3000;
        return m;
    }

    void EnsureMeshes()
    {
        if (_body != null) return;
        _body = Child("CandleBodies", new[] { Matte(Green), Matte(Red), Matte(Top(Green)), Matte(Top(Red)) });
        _glow = Child("CandleGlow", new[] { Light(Green, GlowAlpha), Light(Red, GlowAlpha) });
        _formingMat = Light(Green, GlowAlpha);
        _forming = Child("CandleGlowForming", new[] { _formingMat });
        _wick = Child("CandleWicks", new[] { Light(Green, WickAlpha), Light(Red, WickAlpha) });
        _seam = Child("Seam", new[] { Matte(Color.white) });
    }

    readonly List<Vector3> _seamVerts = new List<Vector3>();
    readonly List<int> _seamTris = new List<int>();
    bool _formingGreen;
    GroundCache _ground;

    void LateUpdate()
    {
        if (!Blwp.BlwpCore.Available || Blwp.BlwpCore.CandleView(_words) == 0) return;
        EnsureMeshes();
        float now = Time.unscaledTime, shift = _words[L.CV_SHIFT] / ONE;
        // the forming candle's glow pulses at 1 Hz
        if (_formingMat != null)
        {
            float a = GlowAlpha * (0.6f + 0.4f * Mathf.Sin(now * Mathf.PI * 2f));
            var c = _formingGreen ? Green : Red;
            _formingMat.SetColor("_BaseColor", new Color(c.r, c.g, c.b, a));
        }
        int surfaceSig = Blwp.BlwpCore.ReliefEpoch * 1000003 + Blwp.BlwpCore.StrikeCount * 1009 + Blwp.BlwpCore.CraterCount;
        if (_ground == null) _ground = new GroundCache(Blwp.BlwpCore.TerrainAt) { Hold = GroundSeconds };
        _ground.Now = now;
        bool surfaceChanged = surfaceSig != _builtSurface;
        if (surfaceChanged) _ground.Clear();

        if (surfaceChanged || _builtAt < 0f || now - _builtAt >= RebuildSeconds)
        {
            _builtAt = now; _builtSurface = surfaceSig; _builtShift = shift;
            var p = Build(_words, _ground.Get);
            Set(_body, p.Body, p.SideGreen, p.SideRed, p.TopGreen, p.TopRed);
            Lit(_glow, p.Glow, p.GlowGreen, p.GlowRed);
            Lit(_forming, p.Forming, p.FormingTris);
            _formingGreen = p.FormingGreen;
            Lit(_wick, p.Wick, p.WickGreen, p.WickRed);
            BuildSeam(L.CANDLE_WEST / ONE, L.CANDLE_EAST / ONE, Blwp.BlwpCore.FrontlineZ, Surface, _seamVerts, _seamTris);
            Set(_seam, _seamVerts, _seamTris);
            Rebuilds++;
            if (Rebuilds <= 3 || Rebuilds % 600 == 0)
            {
                int f = L.CV_FIRST;
                Debug.Log($"[candles] rebuild={Rebuilds} count={_words[L.CV_COUNT]} shift={shift:0.000} forming={_words[L.CV_FORMING]} first={_words[f]},{_words[f + 1]},{_words[f + 2]},{_words[f + 3]},{_words[f + 4]},{_words[f + 5]} bodyVerts={p.Body.Count} wickQuads={p.Wick.Count / 4} glowVerts={p.Glow.Count + p.Forming.Count} groundAsked={_ground.Asked} {SurfaceCheck()}");
            }
        }
        // between rebuilds the ribbon slides with the core's shift, so it glides at 0.576 m/s rather than stepping; the
        // seam line reads the core's front at world x and stays
        var slide = new Vector3(_builtShift - shift, 0f, 0f);
        foreach (Transform child in transform) if (child.name != "Seam") child.localPosition = slide;
    }

    float Surface(float x, float z) => _ground.Get(x, z) + LayerAt(_words, x, z);

    readonly List<Color> _white = new List<Color>();

    void Lit(Mesh mesh, List<Vector3> verts, params List<int>[] subs)
    {
        while (_white.Count < verts.Count) _white.Add(Color.white);
        Set(mesh, verts, subs);
        mesh.SetColors(_white, 0, verts.Count);
    }

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
        var verts = new List<Vector3>(); _body.GetVertices(verts);
        var tris = new List<int>();
        for (int s = 0; s < _body.subMeshCount; s++) tris.AddRange(_body.GetTriangles(s));
        for (float x = -70f; x <= 100f; x += 14.3f)
            for (float z = -44f; z <= 44f; z += 7.3f)
            {
                float core = Blwp.BlwpCore.SurfaceAt(x, z);
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
