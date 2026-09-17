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
}
