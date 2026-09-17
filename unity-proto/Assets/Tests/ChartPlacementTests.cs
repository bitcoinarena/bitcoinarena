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
    public void OnTheDesktopTheChartIsTopRightAboveTheButtonsAndCoversNoHudBox()
    {
        // the owner 2026-09-17: top right on the desktop (T1), "must not cover the sound button and the other one", then "have
        // the HUD above the sound button and the other button on desktop". The editor has no touch screen, so the HUD lays
        // out as a desktop here - the branch a desktop browser takes.
        Assert.IsFalse(TouchControls.TouchScreen, "the editor reports a touch screen: this is not the desktop layout");
        foreach (var (w, h) in new[] { (1024, 768), (844, 390), (800, 600) })
            Debug.Log($"[topright] {w}x{h} top right: {_hud.ChartTopRight(w, h)}");
        foreach (var (w, h) in new[] { (1280, 657), (1280, 800), (1366, 768), (1440, 900), (1536, 864), (1920, 1080) })
        {
            Assert.IsTrue(_hud.ChartTopRight(w, h), $"{w}x{h}: a desktop window with room did not put the chart top right");
            var r = ChartHud.DesktopPanelFor(w, h);
            var base1 = ChartHud.BaseSize(w, h) * ChartHud.Scale;
            var sound = _hud.SettingsRect(TouchPad.Pad.Sound, w, h);
            var debug = _hud.SettingsRect(TouchPad.Pad.Debug, w, h);
            var wanted = _hud.WantedBox(w, h);
            var manifest = _hud.ManifestBox(w, h);
            var head = _hud.HeadlineBox(w, h);
            float m = TouchPad.Margin(w, h);
            Debug.Log($"[topright] {w}x{h} chart={r} wanted={wanted} sound={sound} debug={debug} manifest={manifest} headline={head} clock={_hud.BlockTimerBox(w, h)}");
            Assert.IsTrue(r.xMin >= 0 && r.yMin >= 0 && r.xMax <= w && r.yMax <= h, $"{w}x{h}: chart {r} off screen");
            Assert.AreEqual(w - m, r.xMax, 0.01f, $"{w}x{h}: not at the right margin");
            Assert.AreEqual(m, r.y, 0.01f, $"{w}x{h}: not at the top margin");
            Assert.LessOrEqual(r.yMax, Mathf.Min(sound.y, debug.y), $"{w}x{h}: the chart is not above the buttons");
            Assert.AreEqual(base1.x, r.width, 0.01f); Assert.AreEqual(base1.y, r.height, 0.01f);
            Assert.IsTrue(manifest.yMax <= h && sound.yMax <= h, $"{w}x{h}: the stack under the chart runs off the screen");
            var others = new (string, Rect)[] { ("sound", sound), ("debug", debug), ("wanted", wanted), ("manifest", manifest),
                ("headline", head), ("clock", _hud.BlockTimerBox(w, h)), ("liquidation", _hud.LiquidationBox(w, h)), ("runStopped", _hud.RunStoppedBox(w, h)),
                ("health", _hud.HealthBox(w, h)), ("exposure", _hud.ExposureBox(w, h)), ("practice", _hud.PracticeBox(w, h)), ("sim", _hud.SimBox(w, h)) };
            foreach (var (name, o) in others) Assert.AreEqual(0f, ChartHud.Shared(r, o), $"{w}x{h}: chart {r} on {name} {o}");
            Assert.AreEqual(0f, ChartHud.Shared(manifest, sound)); Assert.AreEqual(0f, ChartHud.Shared(manifest, debug));
            Assert.AreEqual(0f, ChartHud.Shared(wanted, sound)); Assert.AreEqual(0f, ChartHud.Shared(wanted, debug));
        }
    }
}
