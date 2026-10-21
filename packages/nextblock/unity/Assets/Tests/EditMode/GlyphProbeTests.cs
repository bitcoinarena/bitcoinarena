// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// WHAT THE FONT ACTUALLY HAS.
///
/// In the 22:17 photo the word WANTED is on screen and the stars above it are
/// not. Two candidates: the row is positioned off the top, or the glyph does
/// not exist in the font the player's browser handed Unity. This asks the font
/// rather than reading the picture.
/// </summary>
public class GlyphProbeTests
{
    [Test]
    [Explicit("Measurement, not an assertion. Read the [glyph] lines.")]
    public void MeasureWhetherTheFontHasTheStars()
    {
        // NOT `GUI.skin` - that is only legal inside OnGUI. The two fonts a
        // build can end up using are asked directly: the one Unity embeds and
        // ships (which is what a browser gets, because WebGL has no OS fonts
        // to fall back to) and an OS font, which only exists in the editor.
        var builtin = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf")
                   ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
        var os = Font.CreateDynamicFontFromOSFont("Arial", 32);

        foreach (var pair in new[] { ("embedded", builtin), ("os", os) })
        {
            var font = pair.Item2;
            Debug.Log($"[glyph] {pair.Item1}: '{(font != null ? font.name : "none")}' "
                      + $"dynamic={(font != null && font.dynamic)}");
            if (font == null) continue;
            foreach (char c in new[] { '★', '☆', 'W', '·', '×' })
                Debug.Log($"[glyph] {pair.Item1} U+{(int)c:X4} '{c}' present="
                          + $"{font.HasCharacter(c)}");
        }

        // Widths would need a GUIStyle, which is also OnGUI-only. Presence is
        // the question anyway: a glyph the font does not have is drawn as
        // nothing or as a box, and neither is a star.
    }
}
