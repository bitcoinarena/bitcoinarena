// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// WHERE THE PAGE'S CONSOLE BUTTON GOES (2026-10-04): DriveHud.ConsoleSlot tells the page, in Unity's pixels, the
/// bottom of the top-right corner's furniture, its right edge and the throttle pad. Measured live: at 1280x720 the button
/// first sat on the chart's header, then at 844x390 on the WANTED caption. The slot's top must be below all of it - and on
/// a phone held upright (the chart over the pads, ChartTopRight false) it falls back to the settings icons' corner.
/// </summary>
public class ConsoleSlotTests
{
    [System.Serializable] class Slot { public float w, h, top, right, padX, padY, padW, m, floor, pads; }

    static Slot SlotOf(DriveHud hud, int w, int h) => JsonUtility.FromJson<Slot>(hud.ConsoleSlot(w, h));

    [TearDown] public void Reset() { DriveHud.MobileOverride = null; DriveHud.PadsOverride = null; }

    [TestCase(1280, 720)]
    [TestCase(844, 390)]
    public void TheSlotTopIsBelowTheChartTheButtonsThePipsAndTheWantedCaption(int w, int h)
    {
        DriveHud.MobileOverride = false; DriveHud.PadsOverride = true;
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            Assert.IsTrue(hud.ChartTopRight(w, h), "this screen takes the chart top right");
            var s = SlotOf(hud, w, h);
            float caption = hud.WantedBox(w, h).yMax + DriveHud.SmallFont(w, h) * 1.6f;
            Assert.Greater(s.top, hud.ChartPanel(w, h).yMax, "the chart");
            Assert.Greater(s.top, hud.SettingsRect(TouchPad.Pad.Sound, w, h).yMax, "the sound button");
            Assert.Greater(s.top, hud.SettingsRect(TouchPad.Pad.Debug, w, h).yMax, "the menu button");
            Assert.Greater(s.top, hud.WantedBox(w, h).yMax, "the WANTED pips");
            Assert.GreaterOrEqual(s.top, caption, "the WANTED caption (844x390 on 0.0.2515 covered it)");
            Assert.LessOrEqual(s.right, w, "inside the screen");
            var up = TouchPad.RectFor(TouchPad.Pad.Up, w, h);
            Assert.AreEqual(up.x, s.padX, 0.06f); Assert.AreEqual(up.y, s.padY, 0.06f); Assert.AreEqual(up.width, s.padW, 0.06f);
            Assert.AreEqual(w, s.w); Assert.AreEqual(h, s.h);
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    [Test]
    public void APhoneHeldUprightFallsBackToTheSettingsIconsCorner()
    {
        const int w = 390, h = 844;
        DriveHud.MobileOverride = true; DriveHud.PadsOverride = true;
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            Assert.IsFalse(hud.ChartTopRight(w, h), "upright, the chart stands over the pads");
            var s = SlotOf(hud, w, h);
            Assert.Greater(s.top, hud.SettingsRect(TouchPad.Pad.Debug, w, h).yMax, "below the settings icons");
            Assert.AreEqual(hud.ChartCorner(w, h) + TouchPad.Margin(w, h) * 0.25f, s.top, 0.06f, "the corner is the icons', not the chart's");
            Assert.Less(s.top, hud.HudChartPanel(w, h).y, "above the chart, which is down over the pads");
        }
        finally { Object.DestroyImmediate(hud.gameObject); }
    }

    /// <summary>WHETHER THE PADS ARE DRAWN: the page stands the open console one margin above the throttle pad
    /// only where there is one, else at the screen's bottom margin - the slot says DriveHud.PadsShown.</summary>
    [Test]
    public void TheSlotSaysWhetherThePadsAreDrawn()
    {
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        try
        {
            DriveHud.PadsOverride = true;
            Assert.AreEqual(1f, SlotOf(hud, 430, 932).pads, "pads drawn");
            DriveHud.PadsOverride = false;
            Assert.AreEqual(0f, SlotOf(hud, 1280, 720).pads, "no pads");
        }
        finally { DriveHud.PadsOverride = null; Object.DestroyImmediate(hud.gameObject); }
    }

    /// <summary>THE FLOOR (measured 844x390 on 0.0.2519, paid round: the open panel covered HUNTED, LOAD and ROLL OUT): the
    /// cargo bay's top while the bay is open, the screen's bottom once it is closed.</summary>
    [TestCase(1280, 720)]
    [TestCase(844, 390)]
    public void TheFloorIsTheCargoBaysTopWhileItIsOpen(int w, int h)
    {
        DriveHud.MobileOverride = true; DriveHud.PadsOverride = true;
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        var bay = new GameObject("loadout").AddComponent<LoadoutPanel>();
        try
        {
            hud.loadout = bay;
            Assert.AreEqual(h, SlotOf(hud, w, h).floor, 0.06f, "closed: the screen's bottom");
            bay.Open();
            Assert.IsTrue(bay.IsOpen);
            Assert.AreEqual(bay.BottomBarRect(w, h).y, SlotOf(hud, w, h).floor, 0.06f, "open: the bay's top");
            Assert.Less(SlotOf(hud, w, h).floor, h);
            bay.Dismiss();
            Assert.AreEqual(h, SlotOf(hud, w, h).floor, 0.06f, "closed again");
        }
        finally { Object.DestroyImmediate(hud.gameObject); Object.DestroyImmediate(bay.gameObject); }
    }

    /// <summary>AND UNDER THE CARGO CHOOSER while the bay is open (measured 1280x720 on 0.0.2521: the button at y 313 and the
    /// panel lay on the chooser's bottom row of crates): the slot's top is in the band between the chooser and the bay.</summary>
    [TestCase(1280, 720)]
    [TestCase(844, 390)]
    public void WithTheBayOpenTheSlotTopIsUnderTheChooser(int w, int h)
    {
        DriveHud.MobileOverride = false; DriveHud.PadsOverride = true;
        var hud = new GameObject("hud").AddComponent<DriveHud>();
        var bay = new GameObject("loadout").AddComponent<LoadoutPanel>();
        var yard = new GameObject("yard").AddComponent<PackageYard>();
        try
        {
            hud.loadout = bay; bay.yard = yard;
            float before = SlotOf(hud, w, h).top;
            bay.Open();
            var s = SlotOf(hud, w, h);
            Assert.GreaterOrEqual(s.top, yard.PanelRect(w, h).yMax, "under the chooser's crates");
            Assert.GreaterOrEqual(s.top, before, "never higher than the HUD corner");
            Assert.Less(s.top, s.floor, "above the bay's top");
            bay.Dismiss();
            Assert.AreEqual(before, SlotOf(hud, w, h).top, 0.06f, "closed: the HUD corner again");
        }
        finally { Object.DestroyImmediate(hud.gameObject); Object.DestroyImmediate(bay.gameObject); Object.DestroyImmediate(yard.gameObject); }
    }
}
