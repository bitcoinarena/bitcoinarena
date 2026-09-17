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

    [Test]
    public void AWickIsDrawnOnlyWhereItStandsPastTheBody()
    {
        // Today's tape has no wick past a body (two samples a candle); the core's words carry one as a candle with more
        // samples would: candle 5 given a low 6 m under its body and a high 10 m over it.
        Load();
        var v = (int[])_views["open"].Clone();
        int b = L.CV_FIRST + 5 * L.CV_WORDS;
        for (int c = 0; c < L.CANDLES; c++)
        {
            int k = L.CV_FIRST + c * L.CV_WORDS;
            Assert.AreEqual(v[k + 2], v[k + 6], $"candle {c}: the core sent a low wick past the body on a two-sample tape");
            Assert.AreEqual(v[k + 3], v[k + 7], $"candle {c}: the core sent a high wick past the body on a two-sample tape");
        }
        v[b + 6] = v[b + 2] - 6 * 65536;
        v[b + 7] = v[b + 3] + 10 * 65536;
        var verts = new List<Vector3>(); var green = new List<int>(); var red = new List<int>();
        CandleTerrain.Build(v, verts, green, red);
        var all = new List<int>(green); all.AddRange(red);
        float apron = v[L.CV_APRON] / 65536f, top = apron + L.WICK_HEIGHT / 65536f, cx = (v[b] + v[b + 1]) * 0.5f / 65536f;
        float z0 = v[b + 2] / 65536f, z1 = v[b + 3] / 65536f, low = v[b + 6] / 65536f, high = v[b + 7] / 65536f;
        int tall = 0;
        foreach (var p in verts)
        {
            if (Mathf.Abs(p.y - top) > 1e-3f) continue;
            tall++;
            Assert.LessOrEqual(Mathf.Abs(p.x - cx), 0.5f + 1e-3f, $"wick vertex {p} off the centre line {cx}");
            bool lowSeg = p.z >= low - 1e-3f && p.z <= z0 + 1e-3f, highSeg = p.z >= z1 - 1e-3f && p.z <= high + 1e-3f;
            Assert.IsTrue(lowSeg || highSeg, $"wick vertex {p} stands over the body {z0:0.00}..{z1:0.00}");
        }
        float atLow = DrawnTop(verts, all, cx, (low + z0) * 0.5f), atHigh = DrawnTop(verts, all, cx, (z1 + high) * 0.5f);
        float onBody = DrawnTop(verts, all, cx + 0.2f, (z0 + z1) * 0.5f);
        Debug.Log($"[candle-mesh] wick: {tall} vertices at {top - apron:0.00} m; drawn top over the low wick {atLow - apron:0.00} m, over the high wick {atHigh - apron:0.00} m, over the body {onBody - apron:0.00} m");
        Assert.AreEqual(24, tall, "two pillars: a lid (4 vertices) and four sides (2 each at the top) - 12 a pillar");
        Assert.AreEqual(L.WICK_HEIGHT / 65536f, atLow - apron, 1e-3f);
        Assert.AreEqual(L.WICK_HEIGHT / 65536f, atHigh - apron, 1e-3f);
        Assert.LessOrEqual(onBody - apron, L.CANDLE_H / 65536f + 1e-3f, "a wick drawn through the body");
        // pillar sides face out: the mesh's own normals on the wick's tall quads
        var mesh = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
        mesh.SetVertices(verts); mesh.subMeshCount = 2; mesh.SetTriangles(green, 0); mesh.SetTriangles(red, 1); mesh.RecalculateNormals();
        var n = mesh.normals;
        for (int i = 0; i < verts.Count; i += 4)
        {
            var a = verts[i]; var c2 = verts[i + 2];
            if (Mathf.Abs(a.y - top) > 1e-3f && Mathf.Abs(c2.y - top) > 1e-3f) continue;
            var mid = (a + c2) * 0.5f;
            var outward = new Vector3(mid.x - cx, 0f, 0f);
            if (Mathf.Abs(a.y - c2.y) < 1e-3f) Assert.Greater(n[i].y, 0.5f, $"a wick lid faces down at {mid}");
            else if (Mathf.Abs(a.x - c2.x) < 1e-3f) Assert.Greater(n[i].x * outward.x, 0f, $"a wick side faces in at {mid}");
            else Assert.Greater(Mathf.Abs(n[i].z), 0.9f, $"a wick end is not an end at {mid}");
        }
    }

    [Test]
    public void AHullClimbsACandleFaceInAThirdOfASecondAndFollowsASlopeWithoutLag()
    {
        // §4.15: the core steps a tank 2 m onto a plateau in one tick; the renderer eases the hull over 0.3 s.
        const float dt = 1f / 60f, H = L.CANDLE_H / 65536f;
        float drawn = 0f; int frames = 0;
        float first = ArmyRenderer.EaseRest(0f, H, dt);
        while (drawn < H - 1e-4f && frames < 100) { drawn = ArmyRenderer.EaseRest(drawn, H, dt); frames++; }
        Debug.Log($"[hull-ease] 2 m face at 60 fps: first frame {first:0.000} m, reached in {frames} frames ({frames * dt:0.000} s)");
        Assert.Less(first, 0.2f, $"the hull popped {first:0.000} m in one frame");
        Assert.AreEqual(ArmyRenderer.FaceSeconds, frames * dt, dt + 1e-4f);
        // down a face the same way
        Assert.AreEqual(H - H / ArmyRenderer.FaceSeconds * dt, ArmyRenderer.EaseRest(H, 0f, dt), 1e-4f);
        // a relief slope at 5 m/s over 55% (2.75 m/s) is followed exactly, frame by frame
        float ground = 0f; drawn = 0f; float worst = 0f;
        for (int i = 0; i < 120; i++) { ground += 2.75f * dt; drawn = ArmyRenderer.EaseRest(drawn, ground, dt); worst = Mathf.Max(worst, Mathf.Abs(drawn - ground)); }
        Assert.Less(worst, 1e-4f, $"the hull lagged a slope by {worst:0.0000} m");
    }
}
