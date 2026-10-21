// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using L = Arena.Layout;

/// <summary>
/// WAR_TACTICS.md §4.15: the candles are drawn where the core stands everything on them. The core's words and its
/// candle-layer heights (Tests/Fixtures/candle-words.txt, written by packages/nextblock/tools/candle-fixture.mjs); the mesh
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

    /// <summary>A ground that is not flat, so a slab laid at the apron's height (the 13:42 fault) cannot pass.</summary>
    static float Ground(float x, float z) => 0.4f * Mathf.Sin(x * 0.07f) + 0.3f * Mathf.Cos(z * 0.05f) + 0.2f;

    static List<int> AllTris(CandleTerrain.Parts p)
    {
        var t = new List<int>(p.TopGreen); t.AddRange(p.TopRed); t.AddRange(p.SideGreen); t.AddRange(p.SideRed); t.AddRange(p.FormingTop);
        return t;
    }

    [Test]
    public void TheLayerIsTheCoresCandleHeightAtEveryPointTheCoreMeasured()
    {
        // The renderer's candle layer is the core's rule (candleHeightAt) on the core's words: the ribbon's ramps, the
        // neighbour-covered faces, the field's ends and the scroll (CV_SHIFT), within a centimetre of the core's heights.
        Load();
        foreach (var kv in _views)
        {
            float worst = 0f; int n = 0, plateau = 0, ramp = 0;
            foreach (var (x, z, h) in _heights[kv.Key])
            {
                float mine = CandleTerrain.LayerAt(kv.Value, x, z);
                worst = Mathf.Max(worst, Mathf.Abs(mine - h));
                Assert.AreEqual(h, mine, 0.01f, $"{kv.Key}: layer at {x:0.00},{z:0.00}");
                if (h >= L.CANDLE_H / 65536f - 1e-4f) plateau++; else if (h > 0f) ramp++;
                n++;
            }
            Debug.Log($"[candle-layer] {kv.Key}: shift {kv.Value[L.CV_SHIFT] / 65536f:0.000} m, {n} core heights ({plateau} plateau, {ramp} ramp), worst {worst:0.0000} m");
            Assert.Greater(plateau, 100); Assert.Greater(ramp, 50);
        }
    }

    [Test]
    public void TheDrawnTopIsTheCoresSurfaceWithinATenthOfAMetreOnGroundThatIsNotFlat()
    {
        // ONE SURFACE (§4.15, 13:42): the drawn top is the core's surface - ground plus the candle layer - at every point the
        // core measured (fixture heights), on a ground that rises and falls; nothing is laid at the apron's height.
        Load();
        foreach (var kv in _views)
        {
            var v = kv.Value;
            var p = CandleTerrain.Build(v, Ground);
            var tris = AllTris(p);
            float worst = 0f; int n = 0, inBody = 0;
            foreach (var (x, z, h) in _heights[kv.Key])
            {
                float top = CandleTerrain.TopAt(p.Body, tris, x, z);
                float drawn = float.IsNaN(top) ? Ground(x, z) : top - CandleTerrain.Lift;
                if (!float.IsNaN(top)) inBody++;
                float want = Ground(x, z) + h;
                worst = Mathf.Max(worst, Mathf.Abs(drawn - want));
                Assert.LessOrEqual(Mathf.Abs(drawn - want), 0.1f, $"{kv.Key}: at {x:0.00},{z:0.00} the core stands on {want:0.000} m, drawn {drawn:0.000}");
                n++;
            }
            Debug.Log($"[candle-mesh] {kv.Key}: {n} core heights ({inBody} under a drawn top), worst {worst:0.0000} m, {p.Body.Count} body vertices, {p.RidgeTriangles} wick-ridge triangles");
            Assert.Greater(n, 1000); Assert.Greater(inBody, 500);
        }
    }

    [Test]
    public void ARibbonNoWallsNothingAboveAMetreWicksAreRidgesTheFormingTopHasItsOwnMaterial()
    {
        // 15:20 / 15:30 (§4.15): no glow and no column - nothing but ground. The body and its wick ridges are one height field:
        // every triangle faces up, no steeper than the 25% ramps (per axis; a corner interpolates both, up to sqrt(2) x 25%),
        // nothing more than 1 m over the ground, and the ridges stand beyond the bodies at 0.5 m.
        Load();
        var v = _views["one-sample"];
        var p = CandleTerrain.Build(v, Ground);
        var tris = AllTris(p);
        int tops = (p.TopGreen.Count + p.TopRed.Count + p.FormingTop.Count) / 3, ramps = 0;
        float steepest = 0f, steepestAxis = 0f, highest = 0f;
        for (int t = 0; t < tris.Count; t += 3)
        {
            Vector3 a = p.Body[tris[t]], b = p.Body[tris[t + 1]], c = p.Body[tris[t + 2]];
            var nrm = Vector3.Cross(b - a, c - a).normalized;
            Assert.Greater(nrm.y, 0f, $"a triangle at {a} faces down");
            float grade = Mathf.Sqrt(1f - nrm.y * nrm.y) / nrm.y;
            steepest = Mathf.Max(steepest, grade);
            steepestAxis = Mathf.Max(steepestAxis, Mathf.Max(Mathf.Abs(nrm.x), Mathf.Abs(nrm.z)) / nrm.y);
            if (grade > 0.05f) ramps++;
        }
        foreach (var q in p.Body) highest = Mathf.Max(highest, q.y - CandleTerrain.Lift - Ground(q.x, q.z));
        Debug.Log($"[candle-mesh] top triangles {tops}, ramp triangles {ramps}, wick-ridge triangles {p.RidgeTriangles}, steepest {steepest * 100f:0.0}% ({steepestAxis * 100f:0.0}% along an axis), highest {highest:0.000} m; forming slot {v[L.CV_FORMING]} top triangles {p.FormingTop.Count / 3}, shift {v[L.CV_SHIFT] / 65536f:0.000} m");
        Assert.LessOrEqual(steepestAxis, 0.25f + 0.035f, "steeper than the ribbon's 25% ramp along an axis");
        Assert.LessOrEqual(steepest, 0.25f * Mathf.Sqrt(2f) + 0.035f, "steeper than a corner of 25% ramps");
        Assert.LessOrEqual(highest, L.CANDLE_H / 65536f + 1e-3f, "something stands above 1 m");
        Assert.Greater(tops, 0); Assert.Greater(ramps, 0);
        Assert.Greater(p.RidgeTriangles, 0, "no wick ridge drawn on a staircase tape (the middle sample stands past most bodies)");
        // a ridge top is 0.5 m: some drawn vertex beyond a body stands at it
        int ridgeTop = 0;
        float shift = v[L.CV_SHIFT] / 65536f;
        foreach (var q in p.Body)
        {
            float over = q.y - CandleTerrain.Lift - Ground(q.x, q.z);
            if (Mathf.Abs(over - L.WICK_RIDGE_H / 65536f) > 1e-3f) continue;
            int c = Mathf.Clamp(Mathf.FloorToInt((q.x + shift - L.CANDLE_X0 / 65536f) / (L.CANDLE_SLOT / 65536f)), 0, L.CANDLES - 1);
            int b = L.CV_FIRST + c * L.CV_WORDS;
            if (q.z < v[b + 2] / 65536f || q.z > v[b + 3] / 65536f) ridgeTop++;
        }
        Assert.Greater(ridgeTop, 0, "no 0.5 m ridge top beyond a body");
        // the forming candle (one sample taken: the newest slot) draws its top with the pulsing material
        Assert.AreEqual(L.CANDLES - 1, v[L.CV_FORMING]);
        Assert.Greater(p.FormingTop.Count, 0);
        Assert.AreEqual(CandleTerrain.Green, new Color(0x26 / 255f, 0xa6 / 255f, 0x9a / 255f));
        Assert.AreEqual(CandleTerrain.Red, new Color(0xef / 255f, 0x53 / 255f, 0x50 / 255f));
    }

    [Test]
    public void TheGroundCacheAsksEachCellOnceAndAgainOnlyAfterItsHold()
    {
        int asked = 0;
        var cache = new CandleTerrain.GroundCache((x, z) => { asked++; return Ground(x, z); }) { Hold = 2f, Now = 0f };
        float worst = 0f;
        for (float x = -10f; x < 10f; x += 0.37f)
            for (float z = -10f; z < 10f; z += 0.41f)
                worst = Mathf.Max(worst, Mathf.Abs(cache.Get(x, z) - Ground(x, z)));
        int first = asked;
        for (float x = -10f; x < 10f; x += 0.37f) for (float z = -10f; z < 10f; z += 0.41f) cache.Get(x, z);
        Assert.AreEqual(first, asked, "a held cell was asked again");
        cache.Now = 1.9f;
        for (float x = -10f; x < 10f; x += 0.37f) for (float z = -10f; z < 10f; z += 0.41f) cache.Get(x, z);
        Assert.AreEqual(first, asked, "a cell was asked again inside its hold");
        cache.Now = 4.1f;
        for (float x = -10f; x < 10f; x += 0.37f) for (float z = -10f; z < 10f; z += 0.41f) cache.Get(x, z);
        Debug.Log($"[ground-cache] {first} cells for a 20 m square, worst bilinear error {worst:0.0000} m, {asked - first} asked again after 4.1 s");
        Assert.AreEqual(2 * first, asked, "every cell is asked again within two holds");
        Assert.Less(worst, 0.01f);
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
    // THE GATE OF COMMENT 979: a rebuild is due when a candle word changes, never for the shift alone - the
    // shift is what the slide carries between rebuilds
    [Test]
    public void ARebuildIsDueForACandleWordButNotForTheShift()
    {
        var built = new int[Arena.Layout.CV_TOTAL];
        for (int i = 0; i < built.Length; i++) built[i] = i * 7;
        var now = (int[])built.Clone();
        Assert.IsFalse(CandleTerrain.WordsChanged(now, built), "the same words call for a rebuild");
        now[Arena.Layout.CV_SHIFT] += 123456;
        Assert.IsFalse(CandleTerrain.WordsChanged(now, built), "the shift alone calls for a rebuild");
        now[Arena.Layout.CV_FIRST + 5] += 1;
        Assert.IsTrue(CandleTerrain.WordsChanged(now, built), "a changed candle word does not call for a rebuild");
        now = (int[])built.Clone(); now[Arena.Layout.CV_FORMING] = -1;
        Assert.IsTrue(CandleTerrain.WordsChanged(now, built), "a new forming candle does not call for a rebuild");
    }

    // THE TAIL IS THE SAME RIBBON (comment 980): the last two candles are their own mesh, rebuilt alone when only
    // the forming candle moved - candles [0, n-2) followed by [n-2, n) are vertex for vertex the full build, on every fixture view
    [Test]
    public void TheRestAndTheTailAreTheWholeRibbon()
    {
        Load();
        foreach (var kv in _views)
        {
            var v = kv.Value;
            int n = Mathf.Min(v[L.CV_COUNT], L.CANDLES), k = Mathf.Max(0, n - CandleTerrain.TailCandles);
            var full = CandleTerrain.Build(v, Ground);
            var rest = CandleTerrain.Build(v, Ground, 0, k);
            var tail = CandleTerrain.Build(v, Ground, k, n);
            Assert.AreEqual(full.Body.Count, rest.Body.Count + tail.Body.Count, $"{kv.Key}: vertices");
            for (int i = 0; i < full.Body.Count; i++)
                Assert.AreEqual(full.Body[i], i < rest.Body.Count ? rest.Body[i] : tail.Body[i - rest.Body.Count], $"{kv.Key}: vertex {i}");
            Assert.AreEqual(full.SideGreen.Count + full.SideRed.Count + full.TopGreen.Count + full.TopRed.Count + full.FormingTop.Count,
                rest.SideGreen.Count + rest.SideRed.Count + rest.TopGreen.Count + rest.TopRed.Count + rest.FormingTop.Count
                + tail.SideGreen.Count + tail.SideRed.Count + tail.TopGreen.Count + tail.TopRed.Count + tail.FormingTop.Count, $"{kv.Key}: triangles");
            Assert.AreEqual(full.RidgeTriangles, rest.RidgeTriangles + tail.RidgeTriangles, $"{kv.Key}: ridge triangles");
            Assert.AreEqual(full.FormingTop.Count, rest.FormingTop.Count + tail.FormingTop.Count, $"{kv.Key}: the forming top");
        }
    }

    [Test]
    public void OnlyTheFormingCandleMovingIsATailRebuild()
    {
        int n = L.CANDLES;
        var built = new int[L.CV_TOTAL];
        for (int i = 0; i < built.Length; i++) built[i] = i * 3;
        var now = (int[])built.Clone();
        now[L.CV_FIRST + (n - 1) * L.CV_WORDS + 2] += 77;      // the last candle's z
        now[L.CV_SHIFT] += 5;
        Assert.IsTrue(CandleTerrain.OnlyLastCandleChanged(now, built, n), "the forming candle alone is not a tail rebuild");
        now[L.CV_FIRST + (n - 2) * L.CV_WORDS + 2] += 1;      // and its neighbour
        Assert.IsFalse(CandleTerrain.OnlyLastCandleChanged(now, built, n), "a second candle moving is a tail rebuild");
        now = (int[])built.Clone(); now[L.CV_FORMING] += 1;
        Assert.IsFalse(CandleTerrain.OnlyLastCandleChanged(now, built, n), "a closed candle is a tail rebuild");
    }

}
