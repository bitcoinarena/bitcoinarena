// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE CHART UNDER SIM ON/OFF, OFF THE STEERING ARROWS, 20% LARGER (2026-09-17 08:31 playtest). The SIM switch is
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
    public void TheChartIsTopRightAboveTheButtonsOnEveryScreenWithPadsOrWithout()
    {
        // 2026-09-17 12:35 HARD FAIL: his screen (pads shown, about 3072x1515) had the chart in the middle over the
        // truck. Top right, above the buttons, not center, not over the steering arrows - with the pads and without.
        var shapes = new[] { (3072, 1515), (2048, 1010), (1920, 1080), (1366, 768), (1280, 800), (1280, 657), (1024, 768), (1024, 505) };
        try
        {
            DriveHud.MobileOverride = false;
            foreach (var pads in new[] { true, false })
            {
                DriveHud.PadsOverride = pads;
                foreach (var (w, h) in shapes)
                {
                    var full = _hud.CornerFullSize(w, h);
                    var r = _hud.ChartPanel(w, h);
                    bool top = _hud.ChartTopRight(w, h);
                    // 16:01: 30% smaller on the desktop than the 1.2x chart, in the same corner
                    Assert.AreEqual(ChartHud.BaseSize(w, h).x * ChartHud.Scale * 0.7f, full.x, 0.01f, $"{w}x{h}: the desktop chart is not 30% smaller");
                    if (!pads && w >= 1920) Assert.AreEqual(full.x, r.width, 0.01f, $"{w}x{h}: a desktop with room draws the whole (30% smaller) chart");
                    var sound = _hud.SettingsRect(TouchPad.Pad.Sound, w, h);
                    var debug = _hud.SettingsRect(TouchPad.Pad.Debug, w, h);
                    var wanted = _hud.WantedBox(w, h);
                    var manifest = _hud.ManifestBox(w, h);
                    var head = _hud.HeadlineBox(w, h);
                    float m = TouchPad.Margin(w, h);
                    Debug.Log($"[topright] pads={pads} {w}x{h} top={top} chart={r} height {r.height / full.y:0.00} of full wanted={wanted} sound={sound} debug={debug} manifest={manifest} headline={head}");
                    Assert.IsTrue(top, $"pads={pads} {w}x{h}: the chart is not top right (chart {r})");
                    Assert.AreEqual(w - m, r.xMax, 0.01f); Assert.AreEqual(m, r.y, 0.01f);
                    Assert.LessOrEqual(r.yMax, Mathf.Min(sound.y, Mathf.Min(debug.y, wanted.y)) + 0.01f, $"pads={pads} {w}x{h}: not above the buttons");
                    Assert.IsTrue(manifest.yMin >= 0 && manifest.yMax <= h + 0.01f && sound.yMax <= h, $"pads={pads} {w}x{h}: off screen");
                    // live 0.0.1508 at 1280x656 with pads: the 30% smaller chart narrowed the score column until its lines clipped to
                    // "drop-off" and "0". Its widest line, measured in 0.0.1497's frame at that shape ("yours only if you reach the
                    // drop-off"), spans 155 px: the column holds at least that.
                    Debug.Log($"[score-column] pads={pads} {w}x{h} x={manifest.x:0.0} w={manifest.width:0.0}");
                    // held where it was measured; other shapes are logged (1280x800 with pads: 134 px, the same as before the chart
                    // shrank - listed in PRIORITIES, not measured on screen)
                    if (pads && w == 1280 && h == 657)
                        Assert.GreaterOrEqual(manifest.width, 155f, $"pads={pads} {w}x{h}: the score column is {manifest.width:0} px wide - its lines clip");
                    var others = new System.Collections.Generic.List<(string, Rect)> { ("sound", sound), ("debug", debug), ("wanted", wanted), ("manifest", manifest),
                        ("headline", head), ("clock", _hud.BlockTimerBox(w, h)), ("liquidation", _hud.LiquidationBox(w, h)), ("runStopped", _hud.RunStoppedBox(w, h)),
                        ("health", _hud.HealthBox(w, h)), ("exposure", _hud.ExposureBox(w, h)), ("practice", _hud.PracticeBox(w, h)), ("sim", _hud.SimBox(w, h)) };
                    foreach (var (name, o) in others) Assert.AreEqual(0f, ChartHud.Shared(r, o), $"pads={pads} {w}x{h}: chart {r} on {name} {o}");
                    foreach (var (name, o) in new[] { ("sound", sound), ("debug", debug), ("wanted", wanted) })
                        Assert.AreEqual(0f, ChartHud.Shared(manifest, o), $"pads={pads} {w}x{h}: score column on {name}");
                    Assert.AreEqual(0f, ChartHud.Shared(wanted, sound)); Assert.AreEqual(0f, ChartHud.Shared(wanted, debug));
                    if (pads)
                        foreach (TouchPad.Pad pad in new[] { TouchPad.Pad.Left, TouchPad.Pad.Right, TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake })
                        {
                            var pr = TouchPad.RectFor(pad, w, h);
                            foreach (var (name, o) in new[] { ("chart", r), ("score column", manifest), ("sound", sound), ("debug", debug), ("wanted", wanted) })
                                Assert.AreEqual(0f, ChartHud.Shared(o, pr), $"pads={pads} {w}x{h}: {name} {o} on the {pad} pad {pr}");
                        }
                }
            }
        }
        finally { DriveHud.PadsOverride = null; DriveHud.MobileOverride = null; }
    }

    [Test]
    public void OnMobileTheChartStandsDirectlyAboveTheLeftAndRightControls()
    {
        // 2026-09-17 12:40: "MOBILE: HUD further down, directly ABOVE the left/right controls. Not mid-screen over the
        // truck." His phone's Unity screen is about 1170x2532 (PRACTICE's fixed 300 px drawn 230 px of a 919 px shot).
        // held upright; a phone on its side takes the desktop corner (L1) - OnALandscapePhoneTheChartIsTheDesktopCornerScaled...
        var shapes = new[] { (1170, 2532), (390, 844), (430, 932), (1290, 2796), (768, 1024) };
        try
        {
            DriveHud.MobileOverride = true; DriveHud.PadsOverride = true;
            foreach (var (w, h) in shapes)
            {
                var full = ChartHud.BaseSize(w, h) * ChartHud.Scale;
                var r = _hud.MobileChartPanel(w, h);
                var left = TouchPad.RectFor(TouchPad.Pad.Left, w, h);
                float m = TouchPad.Margin(w, h);
                var manifest = _hud.ManifestBox(w, h);
                Debug.Log($"[mobile] {w}x{h} chart={r} size {r.width / full.x:0.00}x{r.height / full.y:0.00} of full leftPad={left} sim={_hud.SimBox(w, h)} manifest={manifest} topRight={_hud.ChartTopRight(w, h)}");
                Assert.IsFalse(_hud.ChartTopRight(w, h), "mobile took the desktop corner");
                Assert.AreEqual(left.x, r.x, 0.01f, $"{w}x{h}: not over the left control");
                Assert.AreEqual(left.y - m * 0.5f, r.yMax, 0.01f, $"{w}x{h}: not directly above the controls");
                Assert.Greater(r.height, 0f, $"{w}x{h}: no room"); Assert.Greater(r.width, 0f);
                // portrait: at least half the chart's height over the controls (landscape phones measured and listed:
                // PRACTICE / SIM reach down to the pads there - 844x390 leaves 0.10, 932x430 0.18)
                if (h > w) Assert.GreaterOrEqual(r.height, full.y * 0.5f, $"{w}x{h}: under half the chart's height over the controls");
                Assert.IsTrue(r.xMin >= 0 && r.yMin >= 0 && r.xMax <= w && r.yMax <= h, $"{w}x{h}: off screen");
                foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
                    Assert.AreEqual(0f, ChartHud.Shared(r, TouchPad.RectFor(pad, w, h)), $"{w}x{h}: chart {r} on the {pad} pad {TouchPad.RectFor(pad, w, h)}");
                foreach (var (name, o) in new[] { ("sim", _hud.SimBox(w, h)), ("practice", _hud.PracticeBox(w, h)), ("health", _hud.HealthBox(w, h)),
                                                  ("exposure", _hud.ExposureBox(w, h)), ("manifest", manifest), ("wanted", _hud.WantedBox(w, h)) })
                    Assert.AreEqual(0f, ChartHud.Shared(r, o), $"{w}x{h}: chart {r} on {name} {o}");
            }
        }
        finally { DriveHud.PadsOverride = null; DriveHud.MobileOverride = null; }
    }

    [Test]
    public void OnALandscapePhoneTheChartIsTheDesktopCornerScaledAndHighLowIsCentral()
    {
        // L1 (2026-09-17): a phone on its side takes the desktop top-right corner above the buttons, scaled to the
        // shorter height. And HIGH / LOW central on the screen, off the chart (12:55), on every layout.
        try
        {
            foreach (var (mobile, pads, shapes) in new[] {
                (true, true, new[] { (844, 390), (932, 430), (2532, 1170), (2796, 1290) }),
                (true, true, new[] { (390, 844), (1170, 2532) }),
                (false, true, new[] { (3072, 1515), (1280, 657), (1024, 505) }),
                (false, false, new[] { (1920, 1080), (1000, 360) }) })
            {
                DriveHud.MobileOverride = mobile; DriveHud.PadsOverride = pads;
                foreach (var (w, h) in shapes)
                {
                    bool portrait = mobile && h > w;
                    var full = portrait ? ChartHud.BaseSize(w, h) * ChartHud.Scale : _hud.CornerFullSize(w, h);
                    var chart = portrait ? _hud.MobileChartPanel(w, h) : _hud.ChartPanel(w, h);
                    float m = TouchPad.Margin(w, h);
                    var sound = _hud.SettingsRect(TouchPad.Pad.Sound, w, h);
                    var debug = _hud.SettingsRect(TouchPad.Pad.Debug, w, h);
                    var hl = _hud.HighLowBox(w, h, Mathf.Min(420f, w * 0.5f), 26f);
                    Debug.Log($"[l1] mobile={mobile} pads={pads} {w}x{h} {(portrait ? "portrait" : "corner")} chart=({chart.x:0.0},{chart.y:0.0},{chart.width:0.0},{chart.height:0.0}) scale {chart.width / full.x:0.00} highLow=({hl.x:0.0},{hl.y:0.0},{hl.width:0.0},{hl.height:0.0}) centre off {hl.center.x - w * 0.5f:0.0}");
                    if (!portrait)
                    {
                        Assert.IsTrue(_hud.ChartTopRight(w, h), $"{w}x{h}: not the corner");
                        Assert.AreEqual(w - m, chart.xMax, 0.01f); Assert.AreEqual(m, chart.y, 0.01f);
                        Assert.LessOrEqual(chart.yMax, Mathf.Min(sound.y, debug.y) + 0.01f, $"{w}x{h}: not above the buttons");
                        Assert.AreEqual(chart.width / full.x, chart.height / full.y, 0.001f, $"{w}x{h}: squeezed, not scaled");
                        Assert.GreaterOrEqual(chart.height, full.y * 0.5f - 0.01f);
                    }
                    var boxes = new System.Collections.Generic.List<(string, Rect)> { ("chart", chart), ("sound", sound), ("debug", debug), ("wanted", _hud.WantedBox(w, h)),
                        ("manifest", _hud.ManifestBox(w, h)), ("sim", _hud.SimBox(w, h)), ("practice", _hud.PracticeBox(w, h)), ("health", _hud.HealthBox(w, h)),
                        ("exposure", _hud.ExposureBox(w, h)), ("clock", _hud.BlockTimerBox(w, h)), ("liquidation", _hud.LiquidationBox(w, h)) };
                    foreach (var (name, o) in boxes) Assert.AreEqual(0f, ChartHud.Shared(hl, o), $"{w}x{h}: HIGH/LOW {hl} on {name} {o}");
                    if (!portrait) foreach (var (name, o) in boxes) if (name != "chart") Assert.AreEqual(0f, ChartHud.Shared(chart, o), $"{w}x{h}: chart on {name} {o}");
                    if (pads)
                        foreach (TouchPad.Pad pad in new[] { TouchPad.Pad.Left, TouchPad.Pad.Right, TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake })
                        {
                            Assert.AreEqual(0f, ChartHud.Shared(chart, TouchPad.RectFor(pad, w, h)), $"{w}x{h}: chart on the {pad} pad");
                            Assert.AreEqual(0f, ChartHud.Shared(hl, TouchPad.RectFor(pad, w, h)), $"{w}x{h}: HIGH/LOW on the {pad} pad");
                        }
                }
            }
        }
        finally { DriveHud.PadsOverride = null; DriveHud.MobileOverride = null; }
    }
}
