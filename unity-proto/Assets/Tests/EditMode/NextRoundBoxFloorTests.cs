// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE NEXT ROUND'S BOX COVERS NO RESULT (MF 19 - measured unattended on 0.0.2523: "joining next round · exit
/// game" stood over the result summary's lines, "1 still driving" and "YOU PENDING").
///
/// The box is the page's (index.html #arena-next), drawn from the run's end until the next start; the card, its fold
/// control and a wreck's summary are Unity's. So the box is modelled here as the page's CSS draws it - at the bottom edge
/// in landscape, between the touch pads on a touch screen, above them upright - and the page hands Unity its top
/// (nextBoxTop), which is what these tests hand DriveHud.CardFloor. Each screen is in canvas pixels at its device pixel
/// ratio, as Unity sees it. And before: the box at 18% up and the card let down to 98% of the screen, as on 0.0.2523.
/// </summary>
public class NextRoundBoxFloorTests
{
    struct Screen { public string name; public int w, h; public float dpr; public bool touch; }

    static readonly Screen[] Screens =
    {
        new Screen { name = "test host Chrome 1280x800", w = 1280, h = 800, dpr = 1f },
        new Screen { name = "desktop 1920x1080", w = 1920, h = 1080, dpr = 1f },
        new Screen { name = "laptop 1366x768", w = 1366, h = 768, dpr = 1f },
        new Screen { name = "test host 1440x900 @2", w = 2880, h = 1800, dpr = 2f },
        new Screen { name = "phone landscape 844x390 @3", w = 2532, h = 1170, dpr = 3f, touch = true },
        new Screen { name = "small phone landscape 667x375 @2", w = 1334, h = 750, dpr = 2f, touch = true },
        new Screen { name = "phone upright 390x844 @3", w = 1170, h = 2532, dpr = 3f, touch = true },
        new Screen { name = "small phone upright 375x667 @2", w = 750, h = 1334, dpr = 2f, touch = true },
    };

    /// <summary>The box as the page draws it now, in canvas pixels (CSS of index.html, the widest words it says).</summary>
    static Rect Box(Screen s)
    {
        float cw = s.w / s.dpr, ch = s.h / s.dpr;
        bool landscape = s.w > s.h;
        float width, height, bottom;
        if (landscape)
        {
            bool short_ = ch <= 460f;
            width = Mathf.Min(440f, cw - 32f);
            if (s.touch) width = Mathf.Min(width, cw - 0.92f * ch);
            height = short_ ? 51f : 68f;                     // the words wrapped to two lines, the worst case
            bottom = 10f;
        }
        else
        {
            width = cw <= 520f ? cw - 32f : Mathf.Min(440f, cw - 32f);
            height = 67f;
            bottom = s.touch ? Mathf.Max(0.18f * ch, 0.4525f * cw + 10f) : 0.18f * ch;
        }
        return new Rect((cw - width) * 0.5f * s.dpr, (ch - bottom - height) * s.dpr, width * s.dpr, height * s.dpr);
    }

    /// <summary>The box as 0.0.2523 drew it: 18% up whatever the screen.</summary>
    static Rect OldBox(Screen s)
    {
        float cw = s.w / s.dpr, ch = s.h / s.dpr;
        float width = cw <= 520f ? cw - 32f : Mathf.Min(440f, cw - 32f);
        float height = cw <= 520f ? 67f : 68f;
        return new Rect((cw - width) * 0.5f * s.dpr, (ch - 0.18f * ch - height) * s.dpr, width * s.dpr, height * s.dpr);
    }

    static DriveHud Hud() => new GameObject("hud-under-test").AddComponent<DriveHud>();

    [Test]
    public void TheCardAndItsFoldControlEndAboveTheBox()
    {
        var hud = Hud();
        foreach (var s in Screens)
            foreach (int lines in new[] { 3, 6 })
            {
                var box = Box(s);
                float head = DriveHud.CardHead(s.w, s.h, true);
                float reserve = DriveHud.FoldReserve(head);
                float floor = DriveHud.CardFloor(s.h, true, box.y / s.h, reserve);
                var card = hud.ArrivalBox(s.w, s.h, 0f, false, true, floor, lines);
                var before = hud.ArrivalBox(s.w, s.h, 0f, false, true, DriveHud.CardFloor(s.h, false, 0f), lines);
                var old = OldBox(s);
                TestContext.WriteLine($"{s.name}, {lines} summary lines: card y {card.y:0}..{card.yMax:0} + fold {reserve:0} | box top {box.y:0} (now) | "
                    + $"before: card ..{before.yMax:0}, box top {old.y:0}, {Mathf.Max(0f, before.yMax + reserve - old.y):0} px under the box");
                Assert.LessOrEqual(card.yMax + reserve, box.y + 0.5f,
                    $"{s.name}, {lines} lines: the card and its fold control end at {card.yMax + reserve:0}, the box starts at {box.y:0}");
            }
        Object.DestroyImmediate(hud.gameObject);
    }

    [Test]
    public void AWrecksSummaryEndsAboveTheBox()
    {
        foreach (var s in Screens)
            foreach (int lines in new[] { 3, 6 })
            {
                var box = Box(s);
                var panel = DriveHud.WreckSummaryPanel(s.w, s.h, lines, DriveHud.CardFloor(s.h, true, box.y / s.h), out int font);
                var before = DriveHud.WreckSummaryPanel(s.w, s.h, lines, s.h - 4f, out int fontBefore);
                var old = OldBox(s);
                TestContext.WriteLine($"{s.name}, {lines} lines: wreck summary y {panel.y:0}..{panel.yMax:0} font {font} | box top {box.y:0} | "
                    + $"before: ..{before.yMax:0} font {fontBefore}, box top {old.y:0}, {Mathf.Max(0f, before.yMax - old.y):0} px under the box");
                Assert.LessOrEqual(panel.yMax, box.y + 0.5f, $"{s.name}, {lines} lines: the wreck's summary ends at {panel.yMax:0}, the box starts at {box.y:0}");
                Assert.GreaterOrEqual(font, 9);
            }
    }

    [Test]
    public void TheBoxStaysOffTheTouchPads()
    {
        var pads = new[] { TouchPad.Pad.Left, TouchPad.Pad.Right, TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake };
        foreach (var s in Screens)
        {
            if (!s.touch) continue;
            var box = Box(s);
            foreach (var p in pads)
            {
                var r = TouchPad.RectFor(p, s.w, s.h);
                Assert.IsFalse(box.Overlaps(r), $"{s.name}: the box {box} lies on the {p} pad {r}");
            }
        }
    }

    [Test]
    public void NotContinuingTheFloorIsTheScreensAsBefore()
    {
        foreach (var s in Screens)
            foreach (float top in new[] { 0f, 0.5f, 0.82f })
                Assert.AreEqual(s.h - Mathf.Max(8f, s.h * 0.02f), DriveHud.CardFloor(s.h, false, top), 0.001f, s.name);
        // and before the page has said where its box is, a floor at NextBoxTopDefault
        Assert.AreEqual(800 * DriveHud.NextBoxTopDefault - 8f, DriveHud.CardFloor(800, true, 0f), 0.001f);
    }
}
