using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// A SHADOWED LABEL IS BUILT ONCE, NOT EVERY FRAME (kanban #266, comment 990, the owner 2026-10-08). IMGUI builds a label's text
/// geometry anew on every Repaint, and DriveHud's Shadowed draws two (shadow, then text): 161-178 ms of the 7 s after 100 %
/// at 10x CPU as an Android phone. Here a label's glyph coverage is rendered once - in white over opaque black, at its own
/// screen position, so each pixel holds exactly the coverage the GPU blends with - and the shadow is the same glyphs moved by
/// whole pixels. Text over shadow is composited from those into one texture (one alpha, one colour, stored straight so a plain
/// GUI.DrawTexture blends it as the two labels were blended) and drawn at the same whole-pixel position from then on.
/// Only a label seen two frames running is baked: one that moves or changes every frame is drawn as before. So is anything
/// under a GUI.matrix, a tinted GUI.color or contentColor, a disabled GUI, or a style with a background.
/// </summary>
public static class ShadowLabelCache
{
    public static readonly Vector2Int ShadowOffset = new Vector2Int(2, 3);
    public static readonly Color ShadowColour = new Color(0f, 0f, 0f, 0.55f);
    public static bool Enabled = true;
    public static int Bakes, Hits;

    struct Entry { public Texture Tex; public RectInt Area; public int UsedAt; }

    // THE KEY IS A STRUCT (comment 991: the string key cost 60-68 ms of the window): everything that decides the label's pixels
    readonly struct Key : System.IEquatable<Key>
    {
        readonly string _text; readonly int _font, _size, _flags, _pad, _w, _h, _fx, _fy, _screen, _hash; readonly Color32 _colour; readonly Vector2 _offset;
        public Key(Rect r, string text, GUIStyle style, Color colour)
        {
            _text = text; _font = style.font != null ? style.font.GetInstanceID() : 0; _size = style.fontSize;
            _flags = (int)style.fontStyle | ((int)style.alignment << 4) | ((int)style.clipping << 9) | (style.wordWrap ? 1 << 11 : 0) | (style.richText ? 1 << 12 : 0);
            var p = style.padding; _pad = p.left | (p.right << 8) | (p.top << 16) | (p.bottom << 24); _offset = style.contentOffset;
            _w = Mathf.RoundToInt(r.width * 1000f); _h = Mathf.RoundToInt(r.height * 1000f);
            _fx = Mathf.RoundToInt((r.x - Mathf.Floor(r.x)) * 1000f); _fy = Mathf.RoundToInt((r.y - Mathf.Floor(r.y)) * 1000f);
            _screen = Screen.width * 65536 + Screen.height; _colour = colour;
            _hash = System.HashCode.Combine(text.GetHashCode(), _font, _size, _flags, _pad, System.HashCode.Combine(_w, _h, _fx, _fy, _screen, _colour.r | (_colour.g << 8) | (_colour.b << 16) | (_colour.a << 24), _offset));
        }
        public bool Equals(Key o) => _hash == o._hash && _font == o._font && _size == o._size && _flags == o._flags && _pad == o._pad && _w == o._w && _h == o._h
            && _fx == o._fx && _fy == o._fy && _screen == o._screen && _colour.r == o._colour.r && _colour.g == o._colour.g && _colour.b == o._colour.b
            && _colour.a == o._colour.a && _offset == o._offset && string.Equals(_text, o._text);
        public override bool Equals(object o) => o is Key k && Equals(k);
        public override int GetHashCode() => _hash;
    }

    static readonly Dictionary<Key, Entry> _cache = new Dictionary<Key, Entry>();
    static readonly Dictionary<Key, int> _seen = new Dictionary<Key, int>();
    // AT MOST TWO BAKES A FRAME, so the labels that all appear in the first seconds are spread out rather than piled into one
    public const int BakesPerFrame = 2;
    static int _bakeFrame = -1, _bakesThisFrame;
    static Material _compose;
    static RenderTexture _rt;
    static Texture2D _read;
    const int MaxEntries = 160;
    static bool? _half;
    public static bool Half => _half ??= SystemInfo.SupportsRenderTextureFormat(RenderTextureFormat.ARGBHalf) && SystemInfo.SupportsTextureFormat(TextureFormat.RGBAHalf);

    /// <summary>The label as it was always drawn: the shadow 2,3 px down-right, then the text.</summary>
    public static void DrawOld(Rect r, string text, GUIStyle style, Color colour)
    {
        var prev = style.normal.textColor;
        style.normal.textColor = ShadowColour;
        GUI.Label(new Rect(r.x + ShadowOffset.x, r.y + ShadowOffset.y, r.width, r.height), text, style);
        style.normal.textColor = colour;
        GUI.Label(r, text, style);
        style.normal.textColor = prev;
    }

    static bool Cacheable(GUIStyle style) =>
        Enabled && Event.current != null && Event.current.type == EventType.Repaint && GUI.enabled
        && GUI.matrix == Matrix4x4.identity && GUI.color == Color.white && GUI.contentColor == Color.white
        && style.normal.background == null && SystemInfo.supportsRenderTextures;


    /// <summary>Draws the label from the cache and answers true; false when the caller must draw it as before.</summary>
    public static bool TryDraw(Rect r, string text, GUIStyle style, Color colour)
    {
        if (string.IsNullOrEmpty(text) || !Cacheable(style)) return false;
        var key = new Key(r, text, style, colour);
        int frame = Time.frameCount;
        if (!_cache.TryGetValue(key, out var e))
        {
            // BAKED ONLY WHEN IT STAYS: seen in the frame before this one
            bool stays = _seen.TryGetValue(key, out int at) && at == frame - 1;
            _seen[key] = frame;
            if (_seen.Count > 2048) _seen.Clear();
            if (!stays) return false;
            if (_bakeFrame != frame) { _bakeFrame = frame; _bakesThisFrame = 0; }
            if (_bakesThisFrame >= BakesPerFrame) { _seen[key] = frame; return false; }   // asked again next frame
            _bakesThisFrame++;
            if (!Bake(r, text, style, colour, out e)) return false;
            if (_cache.Count >= MaxEntries) Evict();
            _cache[key] = e;
            Bakes++;
        }
        else Hits++;
        e.UsedAt = frame; _cache[key] = e;
        Draw(r, e);
        return true;
    }

    static void Draw(Rect r, Entry e)
    {
        GUI.DrawTexture(new Rect(Mathf.Floor(r.x) + e.Area.x, Mathf.Floor(r.y) + e.Area.y, e.Area.width, e.Area.height), e.Tex);
    }

    static void Evict()
    {
        Key oldest = default; int at = int.MaxValue; bool any = false;
        foreach (var kv in _cache) if (kv.Value.UsedAt < at) { at = kv.Value.UsedAt; oldest = kv.Key; any = true; }
        if (!any) return;
        Release(_cache[oldest].Tex);
        _cache.Remove(oldest);
    }

    /// <summary>The pixel rows and columns a label can touch, its shadow included, relative to floor(r.x), floor(r.y).</summary>
    static RectInt AreaOf(Rect r, GUIStyle style)
    {
        int pad = Mathf.CeilToInt(Mathf.Max(4f, (style.fontSize > 0 ? style.fontSize : 14) * 0.6f));
        int x0 = -pad, y0 = -pad;
        int x1 = Mathf.CeilToInt(r.width) + pad + ShadowOffset.x + 1, y1 = Mathf.CeilToInt(r.height) + pad + ShadowOffset.y + 1;
        return new RectInt(x0, y0, x1 - x0, y1 - y0);
    }

    static void EnsureTargets()
    {
        if (_rt == null || _rt.width != Screen.width || _rt.height != Screen.height)
        {
            if (_rt != null) _rt.Release();
            // HALF FLOAT WHERE THE GPU HAS IT: an 8-bit target rounds the coverage, and that rounding plus the 8-bit texel put the
            // first pixel test 2/255 off (comment 990 gate); the old draw rounds only in the framebuffer
            _rt = new RenderTexture(Screen.width, Screen.height, 0, Half ? RenderTextureFormat.ARGBHalf : RenderTextureFormat.ARGB32) { name = "ShadowLabelMask", filterMode = FilterMode.Point };
            _rt.Create();
        }
        if (_read == null) _read = new Texture2D(4, 4, Half ? TextureFormat.RGBAHalf : TextureFormat.RGBA32, false);
    }

    /// <summary>Renders what is drawn by `draw` at screen pixels `area` over an opaque `bg`, and reads those pixels back, top row first.</summary>
    public static Color[] Capture(RectInt area, Color bg, System.Action draw)
    {
        EnsureTargets();
        var prev = RenderTexture.active;
        RenderTexture.active = _rt;
        GL.Clear(false, true, bg);
        draw();
        // the screen area clamped to the target; outside it nothing is drawn
        int sx = Mathf.Clamp(area.x, 0, _rt.width), sy = Mathf.Clamp(area.y, 0, _rt.height);
        int ex = Mathf.Clamp(area.xMax, 0, _rt.width), ey = Mathf.Clamp(area.yMax, 0, _rt.height);
        var outPx = new Color[area.width * area.height];
        for (int i = 0; i < outPx.Length; i++) outPx[i] = bg;
        if (ex > sx && ey > sy)
        {
            int w = ex - sx, h = ey - sy;
            if (_read.width != w || _read.height != h) _read.Reinitialize(w, h);
            // a render target's row 0 is its bottom; GUI rows count down from the top
            _read.ReadPixels(new Rect(sx, _rt.height - ey, w, h), 0, 0, false);
            var got = _read.GetPixels();
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    outPx[(sy - area.y + y) * area.width + (sx - area.x + x)] = got[(h - 1 - y) * w + x];
        }
        RenderTexture.active = prev;
        return outPx;
    }

    static void Release(Texture t)
    {
        if (t is RenderTexture rt) rt.Release();
        if (t != null) Object.Destroy(t);
    }

    /// <summary>
    /// THE BAKE, ON THE GPU (comment 991: the read-back bake cost 97-125 ms of the window): the label's coverage is rendered
    /// into the mask target at its screen position, then one blit through Hidden/ShadowLabelCompose writes text over shadow
    /// into the label's own render texture. Nothing comes back to the CPU.
    /// </summary>
    static bool Bake(Rect r, string text, GUIStyle style, Color colour, out Entry e)
    {
        e = default;
        if (_compose == null)
        {
            var sh = Shader.Find("Hidden/ShadowLabelCompose");
            if (sh == null || !sh.isSupported) { Enabled = false; return false; }
            _compose = new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
        }
        EnsureTargets();
        var rel = AreaOf(r, style);
        var area = new RectInt(Mathf.FloorToInt(r.x) + rel.x, Mathf.FloorToInt(r.y) + rel.y, rel.width, rel.height);
        var prev = RenderTexture.active;
        RenderTexture.active = _rt;
        GL.Clear(false, true, Color.black);
        var was = style.normal.textColor;
        style.normal.textColor = Color.white;
        GUI.Label(r, text, style);
        style.normal.textColor = was;
        var dest = new RenderTexture(rel.width, rel.height, 0, Half ? RenderTextureFormat.ARGBHalf : RenderTextureFormat.ARGB32)
            { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp, name = "ShadowLabel" };
        dest.Create();
        // the area in the mask's UV: a target's rows count up from its bottom, the GUI's down from its top
        _compose.SetVector("_Area", new Vector4(area.x / (float)_rt.width, (_rt.height - area.yMax) / (float)_rt.height,
                                                area.width / (float)_rt.width, area.height / (float)_rt.height));
        _compose.SetVector("_Text", colour);
        _compose.SetVector("_Shadow", ShadowColour);
        _compose.SetVector("_Offset", new Vector4(ShadowOffset.x, ShadowOffset.y, 0f, 0f));
        GL.PushMatrix();
        Graphics.Blit(_rt, dest, _compose);
        GL.PopMatrix();
        RenderTexture.active = prev;
        e = new Entry { Tex = dest, Area = rel };
        return true;
    }

    /// <summary>
    /// Text over shadow from one coverage mask (top row first, the red channel): the shadow's coverage is the mask moved by
    /// `offset`; c_t over c_s is alpha a_t + (1 - a_t) a_s and colour (c_t a_t + (1 - a_t) c_s a_s) / that alpha, stored straight.
    /// </summary>
    public static Color[] Compose(Color[] mask, int w, int h, Color text, Color shadow, Vector2Int offset)
    {
        var outPx = new Color[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                float ct = mask[y * w + x].r;
                int sx = x - offset.x, sy = y - offset.y;
                float cs = sx >= 0 && sy >= 0 ? mask[sy * w + sx].r : 0f;
                float at = ct * text.a, asd = cs * shadow.a;
                float a = at + (1f - at) * asd;
                if (a <= 0f) { outPx[y * w + x] = new Color(0f, 0f, 0f, 0f); continue; }
                outPx[y * w + x] = new Color((text.r * at + (1f - at) * shadow.r * asd) / a, (text.g * at + (1f - at) * shadow.g * asd) / a,
                                             (text.b * at + (1f - at) * shadow.b * asd) / a, a);
            }
        return outPx;
    }

    /// <summary>
    /// THE PIXEL GATE (comment 990): each sample drawn the old way and from a fresh bake, over opaque black and over opaque white,
    /// read back pixel for pixel. Answers the worst channel difference in 1/255 over each, and the samples tried. Repaint only.
    /// </summary>
    public static string PixelTest(IList<(Rect r, string text, GUIStyle style, Color colour)> samples, out bool pass)
    {
        int worstB = 0, worstW = 0, n = 0, px = 0;
        foreach (var s in samples)
        {
            if (!Cacheable(s.style)) continue;
            if (!Bake(s.r, s.text, s.style, s.colour, out var e)) continue;
            var area = new RectInt(Mathf.FloorToInt(s.r.x) + e.Area.x, Mathf.FloorToInt(s.r.y) + e.Area.y, e.Area.width, e.Area.height);
            foreach (var bg in new[] { Color.black, Color.white })
            {
                var old = Capture(area, bg, () => DrawOld(s.r, s.text, s.style, s.colour));
                var now = Capture(area, bg, () => Draw(s.r, e));
                int worst = 0;
                for (int i = 0; i < old.Length; i++)
                {
                    Color32 a = old[i], b = now[i];
                    worst = Mathf.Max(worst, Mathf.Abs(a.r - b.r), Mathf.Abs(a.g - b.g), Mathf.Abs(a.b - b.b));
                }
                if (bg == Color.black) worstB = Mathf.Max(worstB, worst); else worstW = Mathf.Max(worstW, worst);
                px += old.Length;
            }
            Release(e.Tex);
            n++;
        }
        pass = n > 0 && worstB <= 1 && worstW <= 1;
        return $"samples={n} pixels={px} worst over black={worstB}/255 over white={worstW}/255 half={(Half ? "yes" : "no")} -> {(pass ? "PASS" : "FAIL")}";
    }
}
