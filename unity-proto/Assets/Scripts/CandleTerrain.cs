using System.Collections.Generic;
using UnityEngine;
using L = Blwp.Layout;

/// <summary>
/// THE CANDLES AS TERRAIN (WAR_TACTICS.md §4.15), drawn. The core stands the truck, the tanks and the men on 32 candle
/// bodies - 2 m plateaus with a 5 m ramp inside each z-end and a vertical face on each x side - and sends their spans in
/// `candleView`'s words. This meshes those words and computes no geometry of its own: the x span, the z span, the plateau
/// height and the apron come from the core, and the ramp is the core's `h = H x clamp(d / R, 0, 1)` drawn at its four
/// break points, which is exact because the ramp is straight. The terrain mesh under it is the core's surface without
/// the candle layer (BlwpCore.TerrainAt), so the candles are drawn once.
///
/// The wick (ruling w1): a 1 m x 1 m, 9 m pillar at the centre x, only over the segments the core says stand past the body
/// (the view's low-wick-from and high-wick-to words), the same pillar the core resolves the truck against.
/// Not here yet (the slice): the scroll, the rescale lerp, the glow.
/// </summary>
public class CandleTerrain : MonoBehaviour
{
    static readonly Color Green = new Color(0x26 / 255f, 0xa6 / 255f, 0x9a / 255f), Red = new Color(0xef / 255f, 0x53 / 255f, 0x50 / 255f);

    readonly int[] _words = new int[L.CV_TOTAL];
    int[] _drawn;
    Mesh _mesh;
    /// <summary>Rebuilds so far, for the log and the probe.</summary>
    public int Rebuilds { get; private set; }

    const float ONE = 65536f;

    /// <summary>
    /// The mesh for a candle view: vertices, and the triangles of green bodies and red bodies. Pure, for the tests. Each
    /// body: its top along z at four stations (foot, ramp top, ramp top, foot) and its two x-faces down to the apron.
    /// </summary>
    public static void Build(int[] v, List<Vector3> verts, List<int> green, List<int> red)
    {
        verts.Clear(); green.Clear(); red.Clear();
        float apron = v[L.CV_APRON] / ONE, ramp = L.CANDLE_RAMP / ONE;
        int n = Mathf.Min(v[L.CV_COUNT], L.CANDLES);
        var zs = new float[4]; var hs = new float[4];
        for (int c = 0; c < n; c++)
        {
            int b = L.CV_FIRST + c * L.CV_WORDS;
            float x0 = v[b] / ONE, x1 = v[b + 1] / ONE, z0 = v[b + 2] / ONE, z1 = v[b + 3] / ONE, H = v[b + 4] / ONE;
            var tris = v[b + 5] != 0 ? green : red;
            float cx = (x0 + x1) * 0.5f, half = L.WICK_HALF / ONE, top = apron + L.WICK_HEIGHT / ONE;
            if (v[b + 6] < v[b + 2]) Pillar(verts, tris, cx, half, v[b + 6] / ONE, z0, apron, top);
            if (v[b + 7] > v[b + 3]) Pillar(verts, tris, cx, half, z1, v[b + 7] / ONE, apron, top);
            float r = Mathf.Min(ramp, (z1 - z0) * 0.5f), peak = H * r / ramp;
            zs[0] = z0; zs[1] = z0 + r; zs[2] = z1 - r; zs[3] = z1;
            hs[0] = apron; hs[1] = apron + peak; hs[2] = apron + peak; hs[3] = apron;
            for (int s = 0; s < 3; s++)
            {
                if (zs[s + 1] - zs[s] <= 0f) continue;
                // top, seen from above: clockwise is (x0,za) (x0,zb) (x1,zb)
                Quad(verts, tris, new Vector3(x0, hs[s], zs[s]), new Vector3(x0, hs[s + 1], zs[s + 1]),
                                  new Vector3(x1, hs[s + 1], zs[s + 1]), new Vector3(x1, hs[s], zs[s]));
                if (hs[s] <= apron && hs[s + 1] <= apron) continue;
                // the +x face, seen from +x (z to the right): (za,apron) (za,top) (zb,top) (zb,apron)
                Quad(verts, tris, new Vector3(x1, apron, zs[s]), new Vector3(x1, hs[s], zs[s]),
                                  new Vector3(x1, hs[s + 1], zs[s + 1]), new Vector3(x1, apron, zs[s + 1]));
                // the -x face, seen from -x (z to the left)
                Quad(verts, tris, new Vector3(x0, apron, zs[s + 1]), new Vector3(x0, hs[s + 1], zs[s + 1]),
                                  new Vector3(x0, hs[s], zs[s]), new Vector3(x0, apron, zs[s]));
            }
        }
    }

    /// <summary>A wick pillar over z from..to at x centre +- half, from the apron to its top: four sides and a lid.</summary>
    static void Pillar(List<Vector3> verts, List<int> tris, float cx, float half, float za, float zb, float bottom, float top)
    {
        float xa = cx - half, xb = cx + half;
        Quad(verts, tris, new Vector3(xa, top, za), new Vector3(xa, top, zb), new Vector3(xb, top, zb), new Vector3(xb, top, za));
        Quad(verts, tris, new Vector3(xb, bottom, za), new Vector3(xb, top, za), new Vector3(xb, top, zb), new Vector3(xb, bottom, zb));
        Quad(verts, tris, new Vector3(xa, bottom, zb), new Vector3(xa, top, zb), new Vector3(xa, top, za), new Vector3(xa, bottom, za));
        Quad(verts, tris, new Vector3(xa, bottom, za), new Vector3(xa, top, za), new Vector3(xb, top, za), new Vector3(xb, bottom, za));
        Quad(verts, tris, new Vector3(xb, bottom, zb), new Vector3(xb, top, zb), new Vector3(xa, top, zb), new Vector3(xa, bottom, zb));
    }

    /// <summary>A quad a b c d, clockwise from its front: two triangles on four vertices of its own (flat shading).</summary>
    static void Quad(List<Vector3> verts, List<int> tris, Vector3 a, Vector3 b, Vector3 c, Vector3 d)
    {
        int i = verts.Count;
        verts.Add(a); verts.Add(b); verts.Add(c); verts.Add(d);
        tris.Add(i); tris.Add(i + 1); tris.Add(i + 2);
        tris.Add(i); tris.Add(i + 2); tris.Add(i + 3);
    }

    void Awake()
    {
        _mesh = new Mesh { name = "CandleTerrain", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
        _mesh.MarkDynamic();
        gameObject.AddComponent<MeshFilter>().sharedMesh = _mesh;
        var mr = gameObject.AddComponent<MeshRenderer>();
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        mr.sharedMaterials = new[] { Material(Green), Material(Red) };
    }

    static Material Material(Color c)
    {
        var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
        var m = new Material(shader);
        if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
        m.color = c;
        if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", 0.2f);
        return m;
    }

    readonly List<Vector3> _verts = new List<Vector3>();
    readonly List<int> _green = new List<int>(), _red = new List<int>();

    void LateUpdate()
    {
        if (!Blwp.BlwpCore.Available || Blwp.BlwpCore.CandleView(_words) == 0) return;
        if (_drawn != null && System.Linq.Enumerable.SequenceEqual(_drawn, _words)) return;
        _drawn = (int[])_words.Clone();
        Build(_words, _verts, _green, _red);
        _mesh.Clear();
        _mesh.SetVertices(_verts);
        _mesh.subMeshCount = 2;
        _mesh.SetTriangles(_green, 0);
        _mesh.SetTriangles(_red, 1);
        _mesh.RecalculateNormals();
        _mesh.RecalculateBounds();
        Rebuilds++;
        int f = L.CV_FIRST;
        Debug.Log($"[candles] rebuild={Rebuilds} count={_words[L.CV_COUNT]} apron={_words[L.CV_APRON]} first={_words[f]},{_words[f + 1]},{_words[f + 2]},{_words[f + 3]},{_words[f + 4]},{_words[f + 5]} verts={_verts.Count} green={_green.Count / 6} red={_red.Count / 6}");
    }
}
