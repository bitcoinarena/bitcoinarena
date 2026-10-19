// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// THE GAME'S NAME AND MARK IN UNITY (2026-10-06: "Tick Tock, Next Block"). The lobby's title bar and
/// the result card draw them; the page carries the same mark (packages/nextblock/brand). The icon is the 192 px render
/// of nextblock-icon.svg, loaded once from Resources.
/// </summary>
public static class NextBlockMark
{
    public const string Name = "TICK TOCK, NEXT BLOCK";
    static Texture2D _icon;
    static bool _asked;

    /// <summary>The square icon, or null when the build carries none.</summary>
    public static Texture2D Icon
    {
        get
        {
            if (!_asked) { _asked = true; _icon = Resources.Load<Texture2D>("nextblock-icon"); }
            return _icon;
        }
    }

    /// <summary>Draws the icon in <paramref name="r"/> (kept square, centred), tinted by the current GUI alpha.</summary>
    public static void DrawIcon(Rect r, float alpha = 1f)
    {
        var icon = Icon;
        if (icon == null || r.width <= 0f || r.height <= 0f) return;
        float s = Mathf.Min(r.width, r.height);
        var was = GUI.color;
        GUI.color = new Color(1f, 1f, 1f, alpha);
        GUI.DrawTexture(new Rect(r.x + (r.width - s) * 0.5f, r.y + (r.height - s) * 0.5f, s, s), icon, ScaleMode.ScaleToFit, true);
        GUI.color = was;
    }
}
