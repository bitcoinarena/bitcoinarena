// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

// ONE DRAW, THE SAME PIXELS (comment 988, 2026-10-08): PanelSkin.Gradient drew 24 slices, each 1 unit
// taller than its band; it now draws one texture, a row a screen row, baked from what the slices composited to. This draws
// the old slices row by row in code - each slice's pixel rows by the rasterizer's rule, blended in draw order over black and
// over white - and holds every baked row, quantized to the 8 bits it is stored in, to it within 1/255 a channel.
public class PanelSkinGradientTests
{
    static Color Over(Color c, float a, Color dst) => new Color(c.r * a + (1f - a) * dst.r, c.g * a + (1f - a) * dst.g, c.b * a + (1f - a) * dst.b, 1f);

    [Test]
    public void TheBakedRowsAreTheSlicesWithinOne255th()
    {
        var cases = new (Color top, Color bottom, float y0, float height, float scale)[]
        {
            (new Color(0.1045f, 0.114f, 0.1575f, 0.72f), new Color(0.055f, 0.06f, 0.075f, 0.72f), 18.4f, 162.7f, 1f),     // DriveHud's block box
            (new Color(0.30f, 0.24f, 0.06f, 0.95f), new Color(0.16f, 0.13f, 0.04f, 0.95f), 787.25f, 36f, 1f),             // a lobby button
            (new Color(0.10f, 0.14f, 0.20f, 0.95f), new Color(0.06f, 0.09f, 0.13f, 0.95f), 101.3f, 61.9f, 1.37f),        // under a scaled GUI.matrix
            (new Color(1f, 1f, 1f, 0.94f), new Color(0f, 0f, 0f, 0.94f), 0.5f, 23f, 2.625f),                              // bands under a pixel
        };
        const int slices = 24;
        foreach (var (top, bottom, y0, height, scale) in cases)
        {
            var baked = PanelSkin.Composite(top, bottom, y0, height, scale, slices, out int row0);
            float band = height / slices;
            int touched = 0;
            for (int j = row0 - 5; j < row0 + baked.Length + 5; j++)
            {
                float centre = j + 0.5f;
                var black = new Color(0f, 0f, 0f, 1f); var white = new Color(1f, 1f, 1f, 1f);
                bool any = false;
                for (int i = 0; i < slices; i++)
                {
                    float a = y0 + band * i, b = a + band + scale;      // the slice's quad, in device pixels
                    if (centre < a || centre >= b) continue;
                    any = true;
                    var c = Color.Lerp(top, bottom, i / (float)(slices - 1));
                    black = Over(c, c.a, black); white = Over(c, c.a, white);
                }
                bool inside = j >= row0 && j < row0 + baked.Length;
                Assert.AreEqual(any, inside, $"row {j}: the slices {(any ? "draw" : "do not draw")} it, the bake {(inside ? "has" : "has not")}");
                if (!inside) continue;
                touched++;
                Color32 q = baked[j - row0];                          // stored as RGBA32
                Color s = q;
                var nb = Over(s, s.a, new Color(0f, 0f, 0f, 1f)); var nw = Over(s, s.a, new Color(1f, 1f, 1f, 1f));
                foreach (var (was, now, bg) in new[] { (black, nb, "black"), (white, nw, "white") })
                    for (int ch = 0; ch < 3; ch++)
                        Assert.LessOrEqual(Mathf.Abs(was[ch] - now[ch]), 1f / 255f + 1e-5f,
                            $"y0 {y0} height {height} scale {scale}: row {j} over {bg}, channel {ch}: slices {was[ch]:0.0000}, baked {now[ch]:0.0000}");
            }
            Assert.Greater(touched, 0);
        }
    }
}
