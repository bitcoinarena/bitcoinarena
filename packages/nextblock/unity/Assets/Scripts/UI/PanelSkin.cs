// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// The chrome both windows are dressed in: gradients, bracket corners, hazard
/// tape, a drifting scan line and faked glow.
///
/// All of it is drawn from a single white pixel with GUI.color. IMGUI has no
/// gradients, no rounded corners and no shadows, so each one is built out of
/// stacked fills - a gradient is twenty slices, a glow is four lines of
/// falling alpha, and a diagonal is a rotated group. That is cheap enough to
/// run every frame and costs nothing in the build, which matters more here
/// than it would elsewhere: this game streams its models and every byte in
/// the payload was fought for.
///
/// Shared so the loading bay and the title screen cannot drift apart.
/// </summary>
public static class PanelSkin
{
    public static readonly Color Gold = new Color(1f, 0.84f, 0.31f);
    public static readonly Color Cyan = new Color(0.35f, 0.85f, 1f);
    public static readonly Color Slate = new Color(0.055f, 0.06f, 0.075f);

    static Texture2D _px;

    static Texture2D Pixel
    {
        get
        {
            if (_px == null)
            {
                _px = new Texture2D(1, 1);
                _px.SetPixel(0, 0, Color.white);
                _px.Apply();
            }
            return _px;
        }
    }

    static void Fill(Rect r, Color c)
    {
        GUI.color = c;
        GUI.DrawTexture(r, Pixel);
        GUI.color = Color.white;
    }

    /// <summary>A vertical gradient, as slices. IMGUI has no such thing.</summary>
    public static void Gradient(Rect r, Color top, Color bottom, int slices = 24)
    {
        // ONE DRAW, THE SAME PIXELS (comment 988, 2026-10-08): the slices were one GUI.DrawTexture each -
        // 24 a panel. They are baked into a texture one pixel wide and one texel per screen row, each row what the
        // overlapping slices composited to on it (the 1 px seams included), and drawn once at whole rows. A rotated
        // GUI.matrix keeps the slices.
        var m = GUI.matrix;
        if (Mathf.Abs(m.m01) > 1e-6f || Mathf.Abs(m.m10) > 1e-6f || m.m11 <= 0f || slices < 2) { Slices(r, top, bottom, slices); return; }
        float sy = m.m11, ty = m.m13;
        var tex = Baked(top, bottom, sy * r.y + ty, sy * r.height, sy, slices, out int row0, out int rows);
        if (tex == null) return;
        GUI.color = Color.white;
        GUI.DrawTexture(new Rect(r.x, (row0 - ty) / sy, r.width, rows / sy), tex);
    }

    /// <summary>The gradient as it was drawn before: one Fill a slice, each 1 unit taller than its band.</summary>
    public static void Slices(Rect r, Color top, Color bottom, int slices = 24)
    {
        float h = r.height / slices;
        for (int i = 0; i < slices; i++)
            Fill(new Rect(r.x, r.y + h * i, r.width, h + 1f),
                 Color.Lerp(top, bottom, i / (float)(slices - 1)));
    }

    /// <summary>
    /// What the slices composite to, one entry a screen row: a slice of device height `band` from pixel `y0` covers the rows
    /// whose centre lies in [top, top + band + scale), the rasterizer's rule; where two slices cover a row the later is drawn
    /// over the earlier (c2 over c1 is alpha 1 - (1 - a2)(1 - a1), colour (a2 c2 + (1 - a2) a1 c1) / that alpha). Gamma space,
    /// as the project blends. Rows with no slice are clear.
    /// </summary>
    public static Color[] Composite(Color top, Color bottom, float y0, float height, float scale, int slices, out int row0)
    {
        float band = height / slices;
        float yEnd = y0 + band * (slices - 1) + band + scale;
        row0 = Mathf.CeilToInt(y0 - 0.5f);
        int rowEnd = Mathf.CeilToInt(yEnd - 0.5f);            // first row whose centre is past the last slice
        int rows = Mathf.Max(0, rowEnd - row0);
        var outRows = new Color[rows];
        for (int j = 0; j < rows; j++)
        {
            float centre = row0 + j + 0.5f;
            float pr = 0f, pg = 0f, pb = 0f, pa = 0f;            // premultiplied
            for (int i = 0; i < slices; i++)
            {
                float a = y0 + band * i, b = a + band + scale;
                if (centre < a || centre >= b) continue;
                var c = Color.Lerp(top, bottom, i / (float)(slices - 1));
                pr = c.r * c.a + (1f - c.a) * pr; pg = c.g * c.a + (1f - c.a) * pg; pb = c.b * c.a + (1f - c.a) * pb;
                pa = c.a + (1f - c.a) * pa;
            }
            outRows[j] = pa > 0f ? new Color(pr / pa, pg / pa, pb / pa, pa) : new Color(0f, 0f, 0f, 0f);
        }
        return outRows;
    }

    static readonly System.Collections.Generic.Dictionary<(Color, Color, int, int, int, int), Texture2D> _baked =
        new System.Collections.Generic.Dictionary<(Color, Color, int, int, int, int), Texture2D>();

    static Texture2D Baked(Color top, Color bottom, float y0, float height, float scale, int slices, out int row0, out int rows)
    {
        // the rows depend on the colours, the device height, where the first row starts inside a pixel, and the scale
        var key = (top, bottom, Mathf.RoundToInt(height * 64f), Mathf.RoundToInt((y0 - Mathf.Floor(y0)) * 64f), Mathf.RoundToInt(scale * 64f), slices);
        row0 = Mathf.CeilToInt(y0 - 0.5f);
        rows = Mathf.Max(0, Mathf.CeilToInt(y0 + height + scale - 0.5f) - row0);   // as Composite counts them
        if (rows == 0) return null;
        if (_baked.TryGetValue(key, out var tex) && tex != null && tex.height == rows) return tex;
        var colours = Composite(top, bottom, y0, height, scale, slices, out row0);
        rows = colours.Length;
        if (rows == 0) return null;
        if (_baked.Count > 256) { foreach (var t in _baked.Values) if (t != null) Object.Destroy(t); _baked.Clear(); }
        tex = new Texture2D(1, rows, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
        // a texture's row 0 is its bottom, and GUI.DrawTexture draws it at the rect's bottom
        var flipped = new Color[rows];
        for (int j = 0; j < rows; j++) flipped[j] = colours[rows - 1 - j];
        tex.SetPixels(flipped);
        tex.Apply(false, true);
        _baked[key] = tex;
        return tex;
    }

    /// <summary>
    /// The body of a window: a dark slate that lifts towards the top, with a
    /// faint horizon line where the light would fall.
    /// </summary>
    public static void Body(Rect r, float alpha = 0.94f)
    {
        var top = new Color(Slate.r * 1.9f, Slate.g * 1.9f, Slate.b * 2.1f, alpha);
        var bottom = new Color(Slate.r, Slate.g, Slate.b, alpha);
        Gradient(r, top, bottom);
        Fill(new Rect(r.x, r.y + r.height * 0.34f, r.width, 1f),
             new Color(1f, 1f, 1f, 0.05f));
    }

    /// <summary>
    /// A glow, faked: lines of falling alpha stepping away from the edge.
    /// A single hard border reads as a dialog box from 1998.
    /// </summary>
    public static void Glow(Rect r, Color c, int steps = 5, float strength = 0.30f)
    {
        for (int i = steps; i >= 1; i--)
        {
            float k = strength * (1f - i / (float)(steps + 1));
            var g = new Rect(r.x - i, r.y - i, r.width + i * 2f, r.height + i * 2f);
            var col = new Color(c.r, c.g, c.b, k);
            Fill(new Rect(g.x, g.y, g.width, 1f), col);
            Fill(new Rect(g.x, g.yMax - 1f, g.width, 1f), col);
            Fill(new Rect(g.x, g.y, 1f, g.height), col);
            Fill(new Rect(g.xMax - 1f, g.y, 1f, g.height), col);
        }
    }

    /// <summary>A double rule: a bright hairline inside a heavier one.</summary>
    public static void Border(Rect r, Color c)
    {
        Fill(new Rect(r.x, r.y, r.width, 2f), c);
        Fill(new Rect(r.x, r.yMax - 2f, r.width, 2f), c);
        Fill(new Rect(r.x, r.y, 2f, r.height), c);
        Fill(new Rect(r.xMax - 2f, r.y, 2f, r.height), c);

        var inner = new Rect(r.x + 5f, r.y + 5f, r.width - 10f, r.height - 10f);
        var faint = new Color(c.r, c.g, c.b, 0.22f);
        Fill(new Rect(inner.x, inner.y, inner.width, 1f), faint);
        Fill(new Rect(inner.x, inner.yMax - 1f, inner.width, 1f), faint);
        Fill(new Rect(inner.x, inner.y, 1f, inner.height), faint);
        Fill(new Rect(inner.xMax - 1f, inner.y, 1f, inner.height), faint);
    }

    /// <summary>
    /// Bracket corners, the way a targeting reticle is drawn. They say
    /// "instrument" where a full box says "form".
    /// </summary>
    public static void Corners(Rect r, Color c, float thickness = 3f)
    {
        float len = Mathf.Min(r.width, r.height) * 0.07f;
        len = Mathf.Clamp(len, 14f, 54f);

        Fill(new Rect(r.x - 1f, r.y - 1f, len, thickness), c);
        Fill(new Rect(r.x - 1f, r.y - 1f, thickness, len), c);
        Fill(new Rect(r.xMax - len + 1f, r.y - 1f, len, thickness), c);
        Fill(new Rect(r.xMax - thickness + 1f, r.y - 1f, thickness, len), c);
        Fill(new Rect(r.x - 1f, r.yMax - thickness + 1f, len, thickness), c);
        Fill(new Rect(r.x - 1f, r.yMax - len + 1f, thickness, len), c);
        Fill(new Rect(r.xMax - len + 1f, r.yMax - thickness + 1f, len, thickness), c);
        Fill(new Rect(r.xMax - thickness + 1f, r.yMax - len + 1f, thickness, len), c);
    }

    /// <summary>
    /// Loading-dock hazard tape, drifting slowly. This is a haulage game and
    /// the panel is a loading ramp; the stripes say so without a word.
    /// </summary>
    public static void Hazard(Rect r, Color c, float speed = 14f)
    {
        GUI.BeginGroup(r);
        var local = new Rect(0f, 0f, r.width, r.height);
        Fill(local, new Color(0f, 0f, 0f, 0.55f));

        var pivot = new Vector2(r.width * 0.5f, r.height * 0.5f);
        var saved = GUI.matrix;
        GUIUtility.RotateAroundPivot(-32f, pivot);

        float band = r.height * 1.7f;
        float drift = Mathf.Repeat(Time.unscaledTime * speed, band * 2f);
        for (float x = -r.width - band * 2f; x < r.width + band * 2f; x += band * 2f)
            Fill(new Rect(x + drift, -r.height, band, r.height * 3f),
                 new Color(c.r, c.g, c.b, 0.55f));

        GUI.matrix = saved;
        GUI.EndGroup();
    }

    /// <summary>
    /// A line of light travelling down the window, with a soft tail. Slow
    /// enough to read as a sweep rather than as a flicker.
    /// </summary>
    public static void Scan(Rect r, Color c, float seconds = 4.5f)
    {
        float t = Mathf.Repeat(Time.unscaledTime / seconds, 1f);
        float y = r.y + r.height * t;
        for (int i = 0; i < 5; i++)
            Fill(new Rect(r.x + 2f, y - i * 2f, r.width - 4f, 1f),
                 new Color(c.r, c.g, c.b, 0.16f * (1f - i / 5f)));
    }

    /// <summary>A short accent rule, for under a heading.</summary>
    public static void Rule(Rect r, Color c)
    {
        Gradient(r, new Color(c.r, c.g, c.b, 0f), new Color(c.r, c.g, c.b, 0.9f), 2);
        Fill(r, new Color(c.r, c.g, c.b, 0.85f));
    }

    /// <summary>A pill with a label in it, for tags like LIVE or BLOCK.</summary>
    public static void Tag(Rect r, string text, Color c, GUIStyle style)
    {
        Fill(r, new Color(c.r * 0.25f, c.g * 0.25f, c.b * 0.25f, 0.9f));
        Fill(new Rect(r.x, r.y, 3f, r.height), c);
        var prev = style.normal.textColor;
        style.normal.textColor = c;
        GUI.Label(new Rect(r.x + 8f, r.y, r.width - 10f, r.height), text, style);
        style.normal.textColor = prev;
    }
}
