// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// ONE LINE, WHOLE, OR NOT AT ALL (2026-09-29 21:18, CLIP-2118). On his phone the centre gap is a strip:
/// "-0.15% 24h" wrapped and its "24h" was cut in half by the row under the percent, and "UNDER FIRE" was clipped from both
/// sides to a lone red R. Every label in the gap now goes through `DriveHud.FitLine`: no wrapping, the font shrinks to the
/// width, and a label that still does not fit is not drawn at all.
/// </summary>
public class FitLineTests
{
    static GUIStyle Style(int size) => new GUIStyle { fontSize = size, font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") };

    [Test]
    public void AShortLabelShrinksToTheStripAndIsWholeOnOneLine()
    {
        var s = Style(40);
        float wide = s.CalcSize(new GUIContent("UNDER FIRE")).x;
        Assert.Greater(wide, 60f, "the font measures nothing here, so nothing below would be measured");
        Assert.IsTrue(DriveHud.FitLine(s, "UNDER FIRE", wide * 0.6f, 10), "a label that fits smaller is drawn smaller");
        Assert.LessOrEqual(s.CalcSize(new GUIContent("UNDER FIRE")).x, wide * 0.6f + 0.5f);
        Assert.IsFalse(s.wordWrap, "wrapped, its second line is what the row cut off");
    }

    [Test]
    public void ALabelThatCannotFitIsNotDrawnAtAll()
    {
        var s = Style(24);
        Assert.IsFalse(DriveHud.FitLine(s, "the block is the round · arrive before it closes", 40f, 10),
            "at its floor the line is still wider than the strip: nothing is drawn, not a clipped piece of it");
        Assert.IsFalse(DriveHud.FitLine(Style(24), "", 400f, 10), "no text, nothing to draw");
    }
}
