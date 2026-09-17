using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE CHART UNDER SIM ON/OFF, OFF THE STEERING ARROWS, 20% LARGER (the owner 2026-09-17 08:31 playtest). The SIM switch is
/// the rect the HUD draws it in (DriveHud.SimBox), the pads are TouchPad's; nothing here recomputes either.
/// </summary>
public class ChartPlacementTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    DriveHud _hud;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return null;
        yield return new WaitForSeconds(0.5f);
        _hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(_hud, "no HUD in the scene");
    }

    [Test]
    public void TheChartIsUnderSimClearOfEveryPadAndTwentyPercentLarger()
    {
        foreach (var (w, h, desktop) in new[] { (1280, 657, true), (1280, 800, true), (1366, 768, true), (1920, 1080, true),
                                                (1024, 768, true), (844, 390, false), (800, 600, false) })
        {
            var sim = _hud.SimBox(w, h);
            var r = ChartHud.PanelFor(w, h, sim);
            var old = ChartHud.BaseSize(w, h);
            var steer = TouchPad.RectFor(TouchPad.Pad.Right, w, h);
            Debug.Log($"[place] {w}x{h} sim={sim} chart={r} rightArrow={steer} scale w={r.width / old.x:0.000} h={r.height / old.y:0.000}");
            Assert.GreaterOrEqual(r.y, sim.yMax, $"{w}x{h}: chart {r} not under SIM {sim}");
            Assert.IsTrue(r.xMin >= 0 && r.yMin >= 0 && r.xMax <= w && r.yMax <= h, $"{w}x{h}: chart {r} off screen");
            foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
                Assert.IsFalse(r.Overlaps(TouchPad.RectFor(pad, w, h)), $"{w}x{h}: chart {r} over the {pad} pad {TouchPad.RectFor(pad, w, h)}");
            // 20% larger where the screen has the room; where it does not, exactly the room between the pads (measured at
            // 1024x768: 302.08 px from the right steering arrow to the handbrake, the old chart was 307.2). At 1280 wide and up
            // the room is there, and the full 20% is required.
            float m = TouchPad.Margin(w, h);
            float roomW = Mathf.Min(TouchPad.RectFor(TouchPad.Pad.Handbrake, w, h).x, TouchPad.RectFor(TouchPad.Pad.Up, w, h).x) - m * 0.5f - r.x;
            float roomH = h - m - r.y;
            Assert.AreEqual(Mathf.Min(old.x * ChartHud.Scale, roomW), r.width, 0.01f, $"{w}x{h}: width is neither 20% larger nor the room");
            Assert.AreEqual(Mathf.Min(old.y * ChartHud.Scale, roomH), r.height, 0.01f, $"{w}x{h}: height is neither 20% larger nor the room");
            if (desktop && w >= 1280)
            {
                Assert.AreEqual(ChartHud.Scale, r.width / old.x, 0.001f, $"{w}x{h}: chart width not 20% larger ({r.width} vs {old.x})");
                Assert.AreEqual(ChartHud.Scale, r.height / old.y, 0.001f, $"{w}x{h}: chart height not 20% larger ({r.height} vs {old.y})");
            }
        }
    }

    [Test]
    public void TheObjectivesStripIsInTheMiddleOffTheChartAndEveryHudBox()
    {
        // the owner 09:17: RIDGE / HOLLOW / GAP and the assault banners off the chart, central on the screen. Held at its widest
        // (the whole room) with both lines, against the boxes the HUD draws in. The run-stopped row is its room; that line
        // and the strip are never drawn together.
        foreach (var (w, h) in new[] { (1280, 657), (1280, 800), (1366, 768), (1920, 1080), (1024, 768), (844, 390), (800, 600) })
        {
            var head = _hud.HeadlineBox(w, h);
            var chart = ChartHud.PanelFor(w, h, _hud.SimBox(w, h));
            var row = _hud.RunStoppedBox(w, h);
            var room = ChartHud.ObjectivesRoom(head, row, chart);
            int font = ChartHud.ObjectivesFont(room.height, 2, ChartHud.HeaderFont(chart.height));
            float lh = font * 1.35f;
            var box = ChartHud.ObjectivesBox(room, w * 0.5f, room.width - 16f, lh, 2);
            var typical = ChartHud.ObjectivesBox(room, w * 0.5f, 300f, lh, 2);
            Debug.Log($"[objectives] {w}x{h} room={room} font={font} box={box} typical={typical} offCentre={typical.center.x - w * 0.5f:0.0} chart={chart} row={row}");
            Assert.GreaterOrEqual(font, 9, $"{w}x{h}: strip font {font} unreadable");
            Assert.GreaterOrEqual(box.height, lh * 2f, $"{w}x{h}: two lines do not fit {box}");
            Assert.AreEqual(Mathf.Clamp(w * 0.5f, room.x + typical.width * 0.5f, room.xMax - typical.width * 0.5f), typical.center.x, 0.01f, $"{w}x{h}: not at the centre the room allows");
            Assert.IsTrue(box.xMin >= 0 && box.yMin >= 0 && box.xMax <= w && box.yMax <= h, $"{w}x{h}: strip {box} off screen");
            var others = new (string, Rect)[] { ("chart", chart), ("sim", _hud.SimBox(w, h)), ("practice", _hud.PracticeBox(w, h)),
                ("health", _hud.HealthBox(w, h)), ("exposure", _hud.ExposureBox(w, h)), ("wanted", _hud.WantedBox(w, h)),
                ("blockTimer", _hud.BlockTimerBox(w, h)), ("liquidation", _hud.LiquidationBox(w, h)) };
            foreach (var (name, r) in others) Assert.AreEqual(0f, ChartHud.Shared(box, r), $"{w}x{h}: strip {box} on {name} {r}");
            foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
                Assert.AreEqual(0f, ChartHud.Shared(box, TouchPad.RectFor(pad, w, h)), $"{w}x{h}: strip {box} on the {pad} pad");
        }
    }
}
