// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using L = Arena.Layout;

/// <summary>
/// WAR_TACTICS.md §0.3: the HUD's one chart, painted from the CORE'S chart words (Tests/Fixtures/chart-words.txt,
/// written by packages/nextblock/tools/chart-fixture.mjs). One chart, nothing under it, Tab switches its range, YOU goes
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

    static readonly Rect Panel = ChartHud.PanelFor(1024, 768, new Rect(19.2f, 330f, 300f, 42f));

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
        // §4.15 G1: the chart is the candle field. Parked in its bay the truck stands before the field (core YOU off, t < 0):
        // YOU is pinned at the plot's left edge. Driven onto the field it is the core's truck through the mapping.
        var parked = ChartHud.Build(Words("ground-open"), Panel, null);
        var driven = ChartHud.Build(Words("ground-driven"), Panel, null);
        Assert.AreEqual(0, Words("ground-open")[L.CH_YOU_ON]);
        Assert.Less(Words("ground-open")[L.CH_YOU_T], 0, "the parked truck is before the field");
        Assert.IsFalse(parked.YouOn);
        Assert.AreEqual(parked.Plot.x, parked.You.x, 0.01f, "before the field YOU is pinned at the left edge");
        Assert.AreEqual(1, Words("ground-driven")[L.CH_YOU_ON]);
        Assert.IsTrue(driven.YouOn);
        float cw = parked.Plot.width / 32f;
        Assert.AreEqual(driven.Plot.x + Words("ground-driven")[L.CH_YOU_T] / 65536f * cw, driven.You.x, 0.01f);
        Assert.Greater(driven.You.x - parked.You.x, 10f, "driven +x, YOU moved right on the chart");
        // The gate at x 114 is past the last candle: the core says off, t 4.632 of a candle past 32 plus the scroll -
        // at the open the chart has slid one sample, half a candle (§4.15 movement) - so 5.132; the HUD pins GATE ›.
        // It was 0.97 / 1.47 while the field ran to x 108.4; ruling B is refitted to the miner's measured door, so
        // the field ends at 90.0 m and a candle is 5.181 m instead of 5.756. The gate did not move, the chart did.
        var w = Words("ground-open");
        Assert.AreEqual(0, w[L.CH_GATE_ON]);
        Assert.AreEqual(5.1321f, (w[L.CH_GATE_T] - 32 * 65536) / 65536f, 0.0001f, "the gate stands 5.13 of a candle past the last");
        Assert.IsFalse(parked.GateOn);
        Assert.IsTrue(parked.GatePinned);
        Assert.AreEqual(parked.Plot.xMax, parked.GateX, 0.01f, "GATE › is pinned at the plot's right edge");
        Assert.AreEqual("GATE " + ChartHud.PinArrow, ChartHud.GateWord(parked));
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
        // THE BANNER CARRIES NO OBJECTIVE NAME (2026-09-17 09:17, "only LOW and HIGH" - RIDGE / HOLLOW / GAP are
        // off the HUD; and 2026-09-19 12:55, which asked for the banner itself). It says who is attacking, and the
        // lane is already drawn as the tinted column under the candles, which the next line still counts.
        StringAssert.IsMatch("^(BULLS|BEARS) (ASSAULT|CONSOLIDATE)$", loud.Banners[0]);
        foreach (var b in loud.Banners)
            foreach (var name in new[] { "RIDGE", "HOLLOW", "GAP" })
                StringAssert.DoesNotContain(name, b, "an objective name is back on the HUD");
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
    public void TheHeaderRowsEndAboveThePlotAndYouKeepsOffThem()
    {
        // Measured on 0.0.1459 (panel 587,437,384,197): the legend row ended at 499.7 and the plot began at 480.3, 19.4 px
        // inside it, and a truck near the window's top put its YOU dot (34 px²) and label on "FRONT · SMA 21".
        foreach (var name in new[] { "ground-open", "round-90", "ground-assault" })
        {
            var f = ChartHud.Build(Words(name), Panel, null);
            float lh = ChartHud.RowHeight(Panel.height);
            float rowsEnd = Panel.y + 2f + 3f * lh;
            Assert.GreaterOrEqual(f.Plot.y - rowsEnd, ChartHud.MarkClearance - 0.01f, $"{name}: plot top {f.Plot.y} vs rows end {rowsEnd}");
            var legend = new Rect(Panel.x + 6f, Panel.y + 2f + 2f * lh, 117.2f, lh);
            Assert.AreEqual(0f, ChartHud.Shared(legend, f.Plot), $"{name}: the legend row reaches into the plot");
        }
        var g = ChartHud.Build(Words("ground-open"), Panel, null);
        float h = ChartHud.RowHeight(Panel.height);
        var rows = new[]
        {
            new Rect(Panel.x + 6f, Panel.y + 2f, 180f, h), new Rect(Panel.x + 6f, Panel.y + 2f + h, 291.4f, h),
            new Rect(Panel.x + 6f, Panel.y + 2f + 2f * h, 117.2f, h),
        };
        // the truck at the window's top: the dot pinned to the plot's top edge, heading +x (the tick to the right)
        foreach (var dot in new[] { new Vector2(g.Plot.x + 36f, g.Plot.y), new Vector2(g.Plot.x + 36f, g.Plot.y + 9f), new Vector2(g.Plot.xMax - 3f, g.Plot.y) })
        {
            var mark = Rect.MinMaxRect(dot.x - 4f, dot.y - 4f, dot.x + 11f, dot.y + 4f);
            foreach (var r in rows) Assert.AreEqual(0f, ChartHud.Shared(mark, r), $"dot {dot}: mark {mark} on header row {r}");
            var label = ChartHud.PlaceYouLabel(g.Plot, dot, mark, 42.5f, h, rows, out bool placed);
            Assert.IsTrue(placed, $"dot {dot}: no place for YOU");
            Assert.AreEqual(0f, ChartHud.Shared(label, mark), $"dot {dot}: label on the mark");
            foreach (var r in rows) Assert.AreEqual(0f, ChartHud.Shared(label, r), $"dot {dot}: label {label} on header row {r}");
            Assert.IsTrue(label.x >= g.Plot.x && label.xMax <= g.Plot.xMax && label.y >= g.Plot.y && label.yMax <= g.Plot.yMax, $"dot {dot}: label {label} off the plot {g.Plot}");
        }
    }

    [Test]
    public void TheOtherPlayersIdKeepsOffGateAndTheLastPriceTag()
    {
        // The frame build 0.0.1461 logged with the other truck at the gate and above the window's top (x 103.1 m, z 80.4 m):
        // its id drawn right of the dot at 865,501.5 shared 145.4 px² with GATE's label, 20.2 with GATE's line, 396.9 with the
        // last-price tag and 362.6 with HIGH.
        var plot = new Rect(591.2f, 511.7f, 303.2f, 104.6f);
        var dot = new Vector2(861f, 511.65f);
        float w = 61.7f, h = 20.3f;
        var gate = new Rect(839.7f, 511.7f, 39.7f, h);
        var gateLine = new Rect(872.7f, 511.7f, 2f, 104.6f);
        var lastTag = new Rect(896.4f, 508.7f, 73.8f, h);
        var high = new Rect(777.7f, 493.6f, 116.7f, h);
        var avoid = new[]
        {
            new Rect(593.2f, 439.2f, 180f, h), new Rect(593.2f, 459.2f, 291.4f, h), new Rect(593.2f, 479.4f, 117.2f, h),
            new Rect(713.2f, 498.6f, 42.5f, h), new Rect(641.6f, 566.3f, 32.5f, h), new Rect(623.6f, 582.5f, 15f, 8f),
            high, new Rect(), gate, gateLine, lastTag, new Rect(dot.x - 3f, dot.y - 3f, 6f, 6f),
        };
        var old = new Rect(dot.x + 4f, dot.y - h * 0.5f, w, h);
        Assert.Greater(ChartHud.Shared(old, gate) + ChartHud.Shared(old, lastTag), 0f, "the old place is on GATE and the tag");
        var r = ChartHud.PlaceGhostLabel(plot, dot, w, h, avoid, out bool placed);
        Assert.IsTrue(placed, "no place for the id");
        foreach (var a in avoid) Assert.AreEqual(0f, ChartHud.Shared(r, a), $"id {r} shares area with {a}");
        Assert.IsTrue(r.x >= plot.x && r.xMax <= plot.xMax && r.y >= plot.y && r.yMax <= plot.yMax, $"id {r} off the plot {plot}");
        Assert.LessOrEqual(r.xMax, lastTag.x, "never on the price axis");
        var none = ChartHud.PlaceGhostLabel(plot, dot, w, h, new[] { new Rect(0f, 0f, 2000f, 2000f) }, out bool nowhere);
        Assert.IsFalse(nowhere);
        Assert.AreEqual(old, none, "nothing free: it stays right of its dot");
    }

    [Test]
    public void TheIdOfATruckPinnedTopLeftWithTheRowUnderItTaken()
    {
        // B's screen on build 0.0.1461+placement: A's truck pinned to the plot's top edge at the left, B at the gate. Logged
        // boxes; the GATE line from the logged gate pixel 873.7; the symbol row above the plot. A's id stayed right of its dot
        // (657.7,501.5) and lay on OPEN 122.1 px² / 68 drawn pixels.
        var plot = new Rect(591.2f, 511.7f, 303.2f, 104.6f);
        var dot = new Vector2(653.7f, 511.65f);
        float w = 62.6f, h = 20.3f;
        var names = new[] { "symbol", "price", "legend", "open", "youLabel", "youMark", "high", "gate", "gateLine", "lastTag", "ghostDot" };
        var avoid = new[]
        {
            new Rect(593.2f, 439.2f, 180f, h), new Rect(593.2f, 459.2f, 291.4f, h), new Rect(593.2f, 479.4f, 117.2f, h),
            new Rect(713.2f, 498.6f, 42.5f, h), new Rect(805.2f, 516.7f, 32.5f, h), new Rect(859.7f, 507.7f, 13.4f, 10.5f),
            new Rect(777.7f, 493.6f, 116.7f, h), new Rect(839.7f, 511.7f, 39.7f, h), new Rect(872.7f, 511.7f, 2f, 104.6f),
            new Rect(896.4f, 508.7f, 73.8f, h), new Rect(dot.x - 3f, dot.y - 3f, 6f, 6f),
        };
        string report = ChartHud.GhostSlotReport(plot, dot, w, h, avoid, names);
        TestContext.Out.WriteLine("[slots] " + report);
        var r = ChartHud.PlaceGhostLabel(plot, dot, w, h, avoid, out bool placed);
        TestContext.Out.WriteLine($"[slots] placed={placed} box={r.x:0.0},{r.y:0.0},{r.width:0.0},{r.height:0.0} open={ChartHud.Shared(r, avoid[3]):0.0}");
        // Before the further rows: level and above were off the plot, below blocked end to end, and the id stayed right of its
        // dot on OPEN (123.5 px² of box). With them it must find a box inside the plot on none of the chrome.
        Assert.IsTrue(placed, "no free box even with the further rows");
        foreach (var a in avoid) Assert.AreEqual(0f, ChartHud.Shared(r, a), $"id {r} shares area with {a}");
        Assert.IsTrue(r.x >= plot.x && r.xMax <= plot.xMax && r.y >= plot.y && r.yMax <= plot.yMax, $"id {r} off the plot {plot}");
    }

    [Test]
    public void OpenKeepsOffThePriceRowTheLegendAndTheLabels()
    {
        // The boxes as build 0.0.1459 logged them on a 1280x657 player (panel 587,437,384,197): OPEN's old place above its
        // line shared 429 px of box with the price row and 435 px with the legend row.
        var plot = new Rect(591f, 480.3f, 303.2f, 139f);
        float openY = 489.7f, w = 42.5f, h = 20.3f;
        var symbol = new Rect(593.2f, 439.2f, 180f, h);
        var price = new Rect(593.2f, 459.2f, 291.4f, h);
        var legend = new Rect(593.2f, 479.4f, 117.2f, h);
        var you = new Rect(623.6f, 518.2f, 42.5f, 24.3f);
        var high = new Rect(777.7f, 464.4f, 116.7f, h);
        var gate = new Rect(839.7f, 480.3f, 39.7f, h);
        var old = new Rect(593.2f, 469.4f, w, h);
        Assert.Greater(ChartHud.Shared(old, price), 0f, "the old place is on the price row");
        var avoid = new[] { symbol, price, legend, you, high, new Rect(), gate };
        var r = ChartHud.PlaceOpen(plot, openY, w, h, avoid, out bool placed);
        Assert.IsTrue(placed);
        foreach (var a in avoid) Assert.AreEqual(0f, ChartHud.Shared(r, a), $"OPEN {r} shares area with {a}");
        Assert.GreaterOrEqual(r.x, plot.x); Assert.LessOrEqual(r.xMax, plot.xMax);
        Assert.AreEqual(openY + 1f, r.y, 0.01f, "below its line: above it the price row runs the plot's width");
        // nowhere free: stays where it was, and says so
        var all = ChartHud.PlaceOpen(plot, openY, w, h, new[] { new Rect(0f, 0f, 2000f, 2000f) }, out bool none);
        Assert.IsFalse(none);
        Assert.AreEqual(new Rect(plot.x + 2f, openY - h, w, h), all);
    }

    [Test]
    public void TheChartSitsUnderAGivenSimBoxAndClearsEveryPad()
    {
        // Playtest 2026-09-17 08:31: under SIM ON/OFF, off the right steering arrow, 20% larger. The real SIM boxes are the
        // PlayMode ChartPlacementTests'; here the rule is held against a SIM switch high and low in the left column.
        foreach (var (w, h) in new[] { (1024, 768), (1280, 657), (1280, 800), (1920, 1080), (844, 390) })
            foreach (float at in new[] { 0.35f, 0.55f })
            {
                var sim = new Rect(Mathf.Max(10f, h * 0.025f), h * at, Mathf.Min(w * 0.52f, 300f), 40f);
                var r = ChartHud.PanelFor(w, h, sim);
                Assert.GreaterOrEqual(r.y, sim.yMax, $"{w}x{h}: chart {r} not under SIM {sim}");
                Assert.IsTrue(r.xMin >= 0 && r.yMin >= 0 && r.xMax <= w && r.yMax <= h, $"{w}x{h}: {r} off screen");
                foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
                    Assert.IsFalse(r.Overlaps(TouchPad.RectFor(pad, w, h)), $"{w}x{h}: chart {r} over the {pad} pad {TouchPad.RectFor(pad, w, h)}");
            }
    }

    [Test]
    public void TheDollarFitsInsideThePanel()
    {
        // the owner's screenshots, in their own pixels. 09:13: panel 795 px wide, "$78,515.00" 183 px wide; the axis was 20% of
        // the panel (159 px) and the tag ran 31 px past the panel. 09:17: panel 434 px, the text 100 px, axis 86.8 px.
        foreach (var (pw, tw) in new[] { (795f, 183f), (434f, 100f) })
        {
            var panel = new Rect(50f, 300f, pw, pw * 0.62f);
            float oldPlotRight = panel.xMax - Mathf.Max(64f, pw * 0.2f);
            Assert.Greater(oldPlotRight + 4f + tw, panel.xMax, $"{pw}: the old axis clipped the dollar");
            foreach (var name in new[] { "ground-open", "round-90", "ground-assault" })
            {
                var f = ChartHud.Build(Words(name), panel, null, tw);
                Assert.LessOrEqual(f.Plot.xMax + 4f + tw, panel.xMax - 4f, $"{pw} {name}: dollar {tw} px past the panel");
                Assert.AreEqual(ChartHud.AxisWidth(pw, tw), f.AxisWidth, 0.01f);
            }
        }
        // no measure (a bare Build): the old axis, so every other layout test keeps its numbers
        Assert.AreEqual(Mathf.Max(64f, Panel.width * 0.2f), ChartHud.Build(Words("ground-open"), Panel, null).AxisWidth, 0.01f);
    }

    [Test]
    public void LowKeepsOffTheTimeAxis()
    {
        // 09:13 screenshot, its pixels: plot 67..700 x 880..1172, the lowest wick's tip at (455, 1158), "LOW $77,551.25" 274 x 40,
        // HIGH's box over the top; the time labels -5:10 -3:50 -2:30 -1:10 on the row under the plot.
        var plot = Rect.MinMaxRect(67f, 880f, 700f, 1172f);
        var low = new Vector2(455f, 1158f);
        float lw = 274f, lh = 40f;
        var high = new Rect(415f, 865f, 285f, 40f);
        float cw = plot.width / 32f;
        var times = new List<Rect>();
        var panel = Rect.MinMaxRect(63f, 725f, 858f, 1217f);
        for (int i = 0; i < 32; i += 8) times.Add(ChartHud.TimeLabelBox(panel, plot, new Vector2(plot.x + (i + 0.5f) * cw, plot.yMax + 1f), 80f, lh));
        var old = new Rect(Mathf.Clamp(low.x - lw * 0.5f, plot.x, plot.xMax - lw), low.y + 5f, lw, lh);
        Assert.Greater(times.Sum(t => ChartHud.Shared(old, t)), 0f, "the old LOW sat on the time labels");
        var r = ChartHud.PlaceLow(plot, low, lw, lh, new[] { high }, out bool placed);
        Assert.IsTrue(placed);
        foreach (var t in times) Assert.AreEqual(0f, ChartHud.Shared(r, t), $"LOW {r} on time label {t}");
        Assert.AreEqual(0f, ChartHud.Shared(r, high));
        Assert.IsTrue(r.x >= plot.x && r.xMax <= plot.xMax && r.y >= plot.y && r.yMax <= plot.yMax, $"LOW {r} off the plot {plot}");
        foreach (var t in times) Assert.GreaterOrEqual(t.x, panel.x, $"time label {t} begins left of the panel");

        // 09:17 screenshot: plot 53..397 x 300..450, tip (235, 445), LOW 152 x 22: right of the wick fits
        var plot2 = Rect.MinMaxRect(53f, 300f, 397f, 450f);
        var r2 = ChartHud.PlaceLow(plot2, new Vector2(235f, 445f), 152f, 22f, new Rect[0], out bool placed2);
        Assert.IsTrue(placed2);
        Assert.LessOrEqual(r2.yMax, plot2.yMax);

        // no room anywhere: not placed, not drawn
        var none = ChartHud.PlaceLow(plot2, new Vector2(235f, 445f), 152f, 22f, new[] { plot2 }, out bool placed3);
        Assert.IsFalse(placed3);
        Assert.AreEqual(new Rect(), none);
    }

    [Test]
    public void ThePinArrowIsAGlyphTheShippedFontHas()
    {
        // The font a WebGL player draws IMGUI with is the one Unity embeds (no OS fonts in a browser). Measured on 0.0.1474:
        // the pinned "GATE ›" and "YOU ›" were drawn without their arrow.
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        Assert.IsNotNull(font, "no embedded font");
        foreach (char c in new[] { '\u203A', '\u00BB', '\u25B6', '\u2192', '>' })
            Debug.Log($"[glyph] {font.name} U+{(int)c:X4} '{c}' present={font.HasCharacter(c)}");
        foreach (var word in new[] { "YOU " + ChartHud.PinArrow, "GATE " + ChartHud.PinArrow })
            foreach (char c in word)
                Assert.IsTrue(c == ' ' || font.HasCharacter(c), $"'{c}' (U+{(int)c:X4}) of \"{word}\" is not in the shipped font");
    }
}
