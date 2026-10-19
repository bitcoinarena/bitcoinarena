// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE PANEL SKIN'S COLOURS (no test named PanelSkin.cs; the owner's ruling (a), comment 538: the colours only).
/// The draw helpers draw through GUI.DrawTexture, which Unity allows only inside OnGUI, so their rectangles are recorded
/// on the card from the code rather than tested here: Glow draws a halo up to `steps` (5) px outside the rectangle,
/// Corners starts 1 px outside it, Gradient's last slice reaches 1 px below it, Scan's trailing lines up to 8 px above.
/// </summary>
public class PanelSkinTests
{
    static void Same(Color want, Color got, string name)
    {
        Assert.AreEqual(want.r, got.r, 1e-6f, name + " r");
        Assert.AreEqual(want.g, got.g, 1e-6f, name + " g");
        Assert.AreEqual(want.b, got.b, 1e-6f, name + " b");
        Assert.AreEqual(1f, got.a, 1e-6f, name + " is opaque");
    }

    [Test]
    public void ThePaletteIsGoldCyanAndSlate()
    {
        Same(new Color(1f, 0.84f, 0.31f), PanelSkin.Gold, "Gold");
        Same(new Color(0.35f, 0.85f, 1f), PanelSkin.Cyan, "Cyan");
        Same(new Color(0.055f, 0.06f, 0.075f), PanelSkin.Slate, "Slate");
    }

    [Test]
    public void GoldAndCyanStandOutOnTheSlateBody()
    {
        // the two accent colours are bright, the body near-black: each accent is at least 8 times the body's luminance
        float L(Color c) => 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b;
        Assert.Greater(L(PanelSkin.Gold), 8f * L(PanelSkin.Slate));
        Assert.Greater(L(PanelSkin.Cyan), 8f * L(PanelSkin.Slate));
        Assert.Less(L(PanelSkin.Slate), 0.1f, "the body is not dark");
    }
}
