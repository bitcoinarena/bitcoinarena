// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using L = Arena.Layout;

/// <summary>
/// THE CHART DRAWS THE CORE'S OBJECTIVES, AND ONLY THEM (WAR_TACTICS.md §4.11 and its §0 client row): HIGH, LOW and
/// OPEN at the points the core writes - its candle's centre and the seam over it - in the core's own words, read from
/// packages/nextblock/test/fixtures/chart-objectives.json (chartView's GROUND view on the core this tree builds, written by
/// packages/nextblock/tools/chart-objectives-fixture.mjs, never typed here). An absent OPEN draws nothing; one candle that is both
/// HIGH and LOW is one marker, "HIGH/LOW". Objectives are read by index (0 HIGH, 1 LOW, 2 OPEN), the core's own order.
/// </summary>
public class ChartHudObjectivesTests
{
    [System.Serializable] class Word { public int lane, candle; }
    [System.Serializable] class Case { public int[] view; public Word[] objectives; }
    [System.Serializable] class Cases { public Case threeCandles, openAbsent, highLowOneCandle; }
    [System.Serializable] class Fixture { public string core; public int CH_WORDS; public Cases cases; }

    static readonly string[] Names = { "HIGH", "LOW", "OPEN" };
    static readonly Rect Panel = new Rect(0f, 0f, 420f, 300f);

    static Fixture Load()
    {
        string path = System.IO.Path.Combine(Application.dataPath, "../../packages/nextblock/test/fixtures/chart-objectives.json");
        return JsonUtility.FromJson<Fixture>(System.IO.File.ReadAllText(path));
    }

    /// <summary>Where the core's point (t, price) lands on this frame's plot - the chart's own scale, recomputed from the words.</summary>
    static Vector2 PointOf(int[] v, ChartHud.Frame f, int o)
    {
        int b = L.CH_OBJ + o * L.CH_OBJ_WORDS;
        double lo = v[L.CH_LO], hi = v[L.CH_HI], air = Mathf.Max(1f, (float)(hi - lo) * 0.08f);
        lo -= air; hi += air;
        float cw = f.Plot.width / Mathf.Max(1, v[L.CH_CANDLES]);
        float y = f.Plot.yMax - (float)((v[b + 2] - lo) / (hi - lo)) * f.Plot.height;
        return new Vector2(f.Plot.x + v[b + 1] / 65536f * cw, Mathf.Clamp(y, f.Plot.y, f.Plot.yMax));
    }

    static ChartHud.Frame Draw(Case c)
    {
        Assert.AreEqual(L.CH_WORDS, c.view.Length, "the fixture's view is not this layout's chart");
        return ChartHud.Build(c.view, Panel, null);
    }

    static string Names_(ChartHud.Frame f) => string.Join(" + ", f.Objectives.Select(o => o.Text));

    [Test]
    public void HighLowAndOpenAreDrawnAtTheCoresPoints()
    {
        var c = Load().cases.threeCandles;
        var f = Draw(c);
        Assert.AreEqual(3, f.Objectives.Count, $"drew {Names_(f)}");
        for (int o = 0; o < 3; o++)
        {
            var label = f.Objectives.SingleOrDefault(x => x.Text == Names[o]);
            Assert.IsNotNull(label, $"no {Names[o]} marker: drew {Names_(f)}");
            var want = PointOf(c.view, f, o);
            Assert.That(Vector2.Distance(label.At, want), Is.LessThan(0.01f), $"{Names[o]} at {label.At}, the core's point is {want}");
        }
    }

    [Test]
    public void AnAbsentOpenDrawsNothing()
    {
        var c = Load().cases.openAbsent;
        Assert.AreEqual(255, c.objectives[2].lane, "the fixture's OPEN is not absent");
        var f = Draw(c);
        Assert.IsFalse(f.Objectives.Any(x => x.Text.Contains("OPEN")), $"an absent OPEN was drawn: {Names_(f)}");
        Assert.AreEqual(2, f.Objectives.Count, $"drew {Names_(f)}");
    }

    [Test]
    public void OneCandleThatIsBothHighAndLowIsOneMarker()
    {
        var c = Load().cases.highLowOneCandle;
        Assert.AreEqual(c.objectives[0].candle, c.objectives[1].candle, "the fixture's HIGH and LOW are not one candle");
        var f = Draw(c);
        var both = f.Objectives.Where(x => x.Text.Contains("HIGH") || x.Text.Contains("LOW")).ToList();
        Assert.AreEqual(1, both.Count, $"one candle drew {both.Count} markers: {Names_(f)}");
        Assert.AreEqual("HIGH/LOW", both[0].Text);
        Assert.That(Vector2.Distance(both[0].At, PointOf(c.view, f, 0)), Is.LessThan(0.01f), "HIGH/LOW is not at the candle's point");
    }
}
