using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using L = Blwp.Layout;

/// <summary>
/// WAR_TACTICS.md §0.3: the HUD's one chart, painted from the CORE'S chart words (Tests/Fixtures/chart-words.txt,
/// written by packages/core/tools/chart-fixture.mjs). One chart, nothing under it, Tab switches its range, YOU goes
/// where the core's truck is, the assault column is there exactly while the core's assault word says so.
/// </summary>
public class ChartHudTests
{
    static Dictionary<string, int[]> _words;

    static int[] Words(string name)
    {
        if (_words == null)
        {
            _words = new Dictionary<string, int[]>();
            var path = Path.Combine(Application.dataPath, "Tests", "Fixtures", "chart-words.txt");
            foreach (var line in File.ReadAllLines(path))
            {
                var parts = line.Split(' ');
                var v = new int[L.CH_WORDS];
                for (int i = 1; i < parts.Length; i++) v[i - 1] = int.Parse(parts[i]);
                _words[parts[0]] = v;
            }
        }
        return _words[name];
    }

    static readonly Rect Panel = ChartHud.PanelFor(1024, 768);

    static IEnumerable<Rect> Everything(ChartHud.Frame f) =>
        f.Bars.SelectMany(b => new[] { b.Body, b.Wick })
         .Concat(f.AssaultColumns)
         .Concat(new[] { f.Plot })
         .Concat(f.Front.Select(p => new Rect(p, Vector2.one)))
         .Concat(f.Objectives.Concat(f.Ghosts).Select(l => new Rect(l.At, Vector2.one)))
         .Concat(new[] { new Rect(f.You, Vector2.one), new Rect(f.High.At, Vector2.one), new Rect(f.Low.At, Vector2.one) });

    [Test]
    public void OneChartAndNothingUnderIt()
    {
        foreach (var name in new[] { "ground-open", "round-open", "ground-90", "round-90", "ground-assault" })
        {
            var f = ChartHud.Build(Words(name), Panel, null);
            foreach (var r in Everything(f))
            {
                Assert.GreaterOrEqual(r.yMin, Panel.yMin - 0.01f, $"{name}: {r} above the chart");
                Assert.LessOrEqual(r.yMin, Panel.yMax + 0.01f, $"{name}: {r} under the chart - a bar under it");
                Assert.GreaterOrEqual(r.xMin, Panel.xMin - 0.01f, $"{name}: {r} left of the chart");
                Assert.LessOrEqual(r.xMin, Panel.xMax + 0.01f, $"{name}: {r} right of the chart");
            }
            Assert.AreEqual(Words(name)[L.CH_CANDLES], f.Bars.Count, $"{name}: one candle per core candle");
            StringAssert.StartsWith("HIGH $", f.High.Text, $"{name}: HIGH is drawn");
            StringAssert.StartsWith("LOW $", f.Low.Text, $"{name}: LOW is drawn");
            Assert.LessOrEqual(f.High.At.y, f.Low.At.y, $"{name}: HIGH above LOW");
        }
    }

    [Test]
    public void TabSwitchesTheRangeOfTheSameChart()
    {
        var go = new GameObject("chart");
        try
        {
            var hud = go.AddComponent<ChartHud>();
            Assert.AreEqual(L.CHART_GROUND, hud.Range, "GROUND in the cab");
            hud.Toggle();
            Assert.AreEqual(L.CHART_ROUND, hud.Range);
            hud.Toggle();
            Assert.AreEqual(L.CHART_GROUND, hud.Range);
        }
        finally { Object.DestroyImmediate(go); }

        var ground = ChartHud.Build(Words("ground-90"), Panel, null);
        var round = ChartHud.Build(Words("round-90"), Panel, null);
        StringAssert.EndsWith("· GROUND", ground.Header, "the header says which range is live");
        StringAssert.EndsWith("· ROUND", round.Header);
        Assert.AreEqual(ground.Plot, round.Plot, "the same chart in the same place, not a second one");
        Assert.AreEqual(32, ground.Bars.Count);
        Assert.AreEqual(46, round.Bars.Count, "ROUND is every candle since the open");
        Assert.AreNotEqual(ground.Bars[0].Body.width, round.Bars[0].Body.width, "the drawn window changed, not a label");
        Assert.AreEqual(ground.Price, round.Price, "the same series: the same last price");
        Assert.AreEqual(ground.Lead, round.Lead, "the same lead");
        Assert.IsTrue(round.WindowShaded && !ground.WindowShaded, "ROUND shades the ground window on itself");
        // The window ROUND shades is GROUND's 32 candles: 32/46 of the plot, flush with the right edge.
        Assert.AreEqual(round.Plot.width * 31.5f / 46f, round.Window.width, 0.6f);
    }

    [Test]
    public void YouGoesWhereTheCoresTruckIs()
    {
        var parked = ChartHud.Build(Words("ground-open"), Panel, null);
        var driven = ChartHud.Build(Words("ground-driven"), Panel, null);
        Assert.IsTrue(parked.YouOn && driven.YouOn);
        float cw = parked.Plot.width / 32f;
        Assert.AreEqual(parked.Plot.x + Words("ground-open")[L.CH_YOU_T] / 65536f * cw, parked.You.x, 0.01f);
        Assert.AreEqual(driven.Plot.x + Words("ground-driven")[L.CH_YOU_T] / 65536f * cw, driven.You.x, 0.01f);
        Assert.Greater(driven.You.x - parked.You.x, 10f, "driven +x, YOU moved right on the chart");
        Assert.AreEqual(Words("ground-open")[L.CH_GATE_ON], 1);
        Assert.IsTrue(parked.GateOn);
        Assert.Greater(parked.GateX, driven.You.x, "the gate is ahead of the truck");
    }

    [Test]
    public void TheAssaultColumnIsThereWhileTheCoreSaysSo()
    {
        var quiet = ChartHud.Build(Words("ground-open"), Panel, null);
        Assert.AreEqual(0, quiet.AssaultColumns.Count);
        Assert.AreEqual(0, quiet.Banners.Count);
        var w = Words("ground-assault");
        var loud = ChartHud.Build(w, Panel, null);
        int running = 0;
        for (int s = 0; s < 2; s++) if (w[L.CH_ASSAULT + s * L.CH_ASSAULT_WORDS] != L.ASSAULT_IDLE) running++;
        Assert.Greater(running, 0, "the fixture holds a running assault");
        Assert.AreEqual(running, loud.Banners.Count);
        StringAssert.Contains("ASSAULT " + ChartHud.ObjectiveName(w[L.CH_ASSAULT + 1]), loud.Banners[0]);
        Assert.AreEqual(running, loud.AssaultColumns.Count);
    }

    [Test]
    public void GhostsSitOnTheSameMapping()
    {
        var ghosts = new List<ChartHud.Ghost> { new ChartHud.Ghost("abcdef01", 16 * 65536, Words("ground-open")[L.CH_YOU_P], 1),
                                                new ChartHud.Ghost("offrange", -65536, 0, 0) };
        var f = ChartHud.Build(Words("ground-open"), Panel, ghosts);
        Assert.AreEqual(1, f.Ghosts.Count, "a ghost off the range is not drawn inside it");
        Assert.AreEqual(f.Plot.x + f.Plot.width * 16f / 32f, f.Ghosts[0].At.x, 0.01f);
        Assert.AreEqual(f.You.y, f.Ghosts[0].At.y, 0.01f, "the same price, the same height as YOU");
    }

    [Test]
    public void TheChartClearsTheThrottlePadsAtTheFloor()
    {
        foreach (var (w, h) in new[] { (1024, 768), (1280, 800), (1920, 1080) })
        {
            var r = ChartHud.PanelFor(w, h);
            Assert.IsTrue(r.xMin >= 0 && r.yMin >= 0 && r.xMax <= w && r.yMax <= h, $"{w}x{h}: {r} off screen");
            foreach (var pad in new[] { TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake, TouchPad.Pad.Left, TouchPad.Pad.Right })
                Assert.IsFalse(r.Overlaps(TouchPad.RectFor(pad, w, h)), $"{w}x{h}: chart over the {pad} pad");
        }
    }
}
