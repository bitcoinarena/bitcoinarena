using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using L = Blwp.Layout;

/// <summary>
/// WAR_TACTICS.md §4.15: the candles are drawn where the core stands everything on them. The core's words and its
/// candle-layer heights (Tests/Fixtures/candle-words.txt, written by packages/core/tools/candle-fixture.mjs); the mesh
/// built from the words must meet every height within 0.1 m ("the client's drawn height differs from candleHeight by
/// more than 0.1 m" fails), face up on the top and out on the x sides.
/// </summary>
public class CandleTerrainTests
{
    static Dictionary<string, int[]> _views;
    static Dictionary<string, List<(float x, float z, float h)>> _heights;

    static void Load()
    {
        if (_views != null) return;
        _views = new Dictionary<string, int[]>();
        _heights = new Dictionary<string, List<(float, float, float)>>();
        foreach (var line in File.ReadAllLines(Path.Combine(Application.dataPath, "Tests", "Fixtures", "candle-words.txt")))
        {
            var p = line.Split(' ');
            if (p[0] == "view")
            {
                var v = new int[L.CV_TOTAL];
                for (int i = 2; i < p.Length; i++) v[i - 2] = int.Parse(p[i]);
                _views[p[1]] = v;
            }
            else
            {
                if (!_heights.TryGetValue(p[1], out var list)) _heights[p[1]] = list = new List<(float, float, float)>();
                list.Add((int.Parse(p[2]) / 65536f, int.Parse(p[3]) / 65536f, int.Parse(p[4]) / 65536f));
            }
        }
    }

    /// <summary>The highest drawn point straight above (x, z), NaN where nothing is drawn: the mesh's top as a player sees it.</summary>
    static float DrawnTop(List<Vector3> verts, List<int> tris, float x, float z)
    {
        float best = float.NaN;
        for (int t = 0; t < tris.Count; t += 3)
        {
            Vector3 a = verts[tris[t]], b = verts[tris[t + 1]], c = verts[tris[t + 2]];
            float d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
            if (Mathf.Abs(d) < 1e-9f) continue;                      // a face seen edge-on from above
            float wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
            float wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
            float wc = 1f - wa - wb;
            const float e = -1e-4f;
            if (wa < e || wb < e || wc < e) continue;
            float y = wa * a.y + wb * b.y + wc * c.y;
            if (float.IsNaN(best) || y > best) best = y;
        }
        return best;
    }

    [Test]
    public void TheDrawnCandlesMeetTheCoresHeightsWithinATenthOfAMetre()
    {
        Load();
        foreach (var kv in _views)
        {
            var verts = new List<Vector3>(); var green = new List<int>(); var red = new List<int>();
            CandleTerrain.Build(kv.Value, verts, green, red);
            var all = new List<int>(green); all.AddRange(red);
            float apron = kv.Value[L.CV_APRON] / 65536f, worst = 0f;
            int n = 0;
            foreach (var (x, z, h) in _heights[kv.Key])
            {
                float top = DrawnTop(verts, all, x, z);
                float drawn = float.IsNaN(top) ? 0f : top - apron;       // nothing drawn = the ground under it
                worst = Mathf.Max(worst, Mathf.Abs(drawn - h));
                Assert.LessOrEqual(Mathf.Abs(drawn - h), 0.1f, $"{kv.Key}: at {x:0.00},{z:0.00} the core stands on {h:0.000} m, drawn {drawn:0.000}");
                n++;
            }
            Debug.Log($"[candle-mesh] {kv.Key}: {n} core heights, worst drawn difference {worst:0.0000} m, {verts.Count} vertices");
            Assert.Greater(n, 1000);
        }
    }

    [Test]
    public void TopsFaceUpFacesFaceOutAndColoursFollowTheCore()
    {
        Load();
        var v = _views["open"];
        var verts = new List<Vector3>(); var green = new List<int>(); var red = new List<int>();
        CandleTerrain.Build(v, verts, green, red);
        var mesh = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
        mesh.SetVertices(verts); mesh.subMeshCount = 2; mesh.SetTriangles(green, 0); mesh.SetTriangles(red, 1);
        mesh.RecalculateNormals();
        var normals = mesh.normals;
        int up = 0, outward = 0, wrong = 0;
        for (int i = 0; i < verts.Count; i += 4)
        {
            var nrm = normals[i];
            var p = verts[i]; var q = verts[i + 2];
            if (Mathf.Abs(p.x - q.x) > 0.01f) { if (nrm.y > 0.5f) up++; else wrong++; }        // a top quad spans x
            else
            {
                // a face: its x is one of the body's two; outward is away from the body's centre
                int c = Mathf.Clamp(Mathf.FloorToInt((p.x - L.CANDLE_X0 / 65536f) / (L.CANDLE_SLOT / 65536f)), 0, L.CANDLES - 1);
                float cx = (v[L.CV_FIRST + c * L.CV_WORDS] + v[L.CV_FIRST + c * L.CV_WORDS + 1]) * 0.5f / 65536f;
                if (Mathf.Sign(nrm.x) == Mathf.Sign(p.x - cx) && Mathf.Abs(nrm.x) > 0.9f) outward++; else wrong++;
            }
        }
        Debug.Log($"[candle-mesh] tops up {up}, faces out {outward}, wrong {wrong}");
        Assert.AreEqual(0, wrong);
        Assert.Greater(up, 0); Assert.Greater(outward, 0);
        int greens = 0;
        for (int c = 0; c < L.CANDLES; c++) greens += v[L.CV_FIRST + c * L.CV_WORDS + 5];
        Assert.AreEqual(greens > 0, green.Count > 0);
        Assert.AreEqual(greens < L.CANDLES, red.Count > 0);
    }
}
