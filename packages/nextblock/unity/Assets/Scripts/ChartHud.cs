// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using L = Arena.Layout;

/// <summary>
/// THE HUD'S CHART (WAR_TACTICS.md §0.3, 2026-09-16 21:50): one TradingView chart with the truck on it.
///
/// A television. Every candle, the seam, the lead, the trend, YOU, the gate, the objectives and the assault are words
/// the core lays out in `src/chart.js` and hands over through `ArenaCore.ChartView`; this file turns those words into
/// rectangles and paints them. It works out no price, no range, no position and no market reading - a painter that
/// did would be a second chart that could disagree with the war.
///
/// ONE chart, ONE range at a time. `Tab` switches the same chart between GROUND (the 32 candles on the terrain, the
/// minimap) and ROUND (every candle since the open, the lead). No overview bar under it, no second chart, no strip
/// (2026-09-16 22:35).
/// </summary>
public class ChartHud : MonoBehaviour
{
    public const string Symbol = "BTCUSD · 10s · ARENA";

    /// <summary>The live range, `L.CHART_GROUND` or `L.CHART_ROUND`. GROUND in the cab.</summary>
    public int Range { get; private set; } = L.CHART_GROUND;

    /// <summary>Charts painted in the last GUI repaint - one, or none while hidden. Never two.</summary>
    public int ChartsPainted { get; private set; }

    /// <summary>The frame painted last, for the measurement tools and the tests.</summary>
    public Frame Last { get; private set; }

    /// <summary>
    /// THE ASSAULT ANNOUNCER (2026-09-20 16:22 / 16:26: "assaults are not perceptible").
    ///
    /// It lives here because this is the one place that already reads `CH_ASSAULT` every frame; a second reader
    /// would mean a second `ChartView` call for two words. `DriveHud` draws what it collects - the banner over
    /// the battlefield, the sound, and the desktop log under the HUD - so the watching and the drawing are not
    /// the same object. Static because the log outlives a HUD that is switched off and on.
    /// </summary>
    public static readonly AssaultWatch Watch = new AssaultWatch();

    public LoadoutPanel loadout;

    readonly int[] _view = new int[L.CH_WORDS];
    readonly int[] _point = new int[L.CH_POINT_WORDS];
    readonly List<Ghost> _ghosts = new List<Ghost>();
    Texture2D _flat;
    GUIStyle _text, _right;
    DriveHud _drive;
    Rect _sim;
    SplashScreen _splash;
    SpectatorCamera _spectator;
    /// <summary>Chart frames painted while the free camera was flying (for the probe).</summary>
    public int SpectateFrames { get; private set; }
    Arena.GhostField _field;
    float _toldAt = -99f;
    int _toldRange = -1;

    static readonly Color Background = Hex(0x131722), Grid = Hex(0x1f2530), Green = Hex(0x26a69a), Red = Hex(0xef5350);
    static readonly Color Truck = new Color(1f, 0.55f, 0.1f), Gold = new Color(1f, 0.78f, 0.2f), Ghosted = new Color(0.62f, 0.64f, 0.68f);
    static readonly Color Axis = new Color(0.60f, 0.63f, 0.69f), Bull = new Color(0.30f, 0.88f, 0.48f), Bear = new Color(1f, 0.42f, 0.42f);

    static Color Hex(int rgb) => new Color(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f);

    public readonly struct Ghost
    {
        public readonly string Name; public readonly int T, P, On;
        public Ghost(string name, int t, int p, int on) { Name = name; T = t; P = p; On = on; }
    }

    public struct Candle { public Rect Body, Wick; public bool Green; }
    public struct Label { public string Text; public Vector2 At; public Color Colour; }

    /// <summary>What one repaint draws: every rectangle and label, placed from the core's words.</summary>
    public class Frame
    {
        public int Range, Candles, First;
        public Rect Panel, Plot;
        public string Header, Price, Lead, Trend;
        public Color LeadColour;
        public int Dots;
        public readonly List<Candle> Bars = new List<Candle>();
        public readonly List<Vector2> Front = new List<Vector2>();
        public float OpenY, LastY;
        public bool LastGreen;
        public Vector2 You; public bool YouOn; public float YouHeading;
        public float GateX; public bool GateOn;
        /// <summary>
        /// The gate past the last candle (§4.15 G1, 2026-09-17: at x 114 it stands 0.97 of a candle past the field):
        /// the core says off the chart and gives its true t; the HUD pins "GATE ›" at the plot's right edge, as YOU is pinned
        /// at the left before the field.
        /// </summary>
        public bool GatePinned;
        public Rect Window; public bool WindowShaded;
        public readonly List<Label> Ghosts = new List<Label>();
        public readonly List<Label> Objectives = new List<Label>();
        /// <summary>Where each objective marker was DRAWN. Empty until the draw runs, which is what O4 reads.</summary>
        public readonly List<Rect> ObjectiveBoxes = new List<Rect>();
        /// <summary>Markers the placer could not fit clear of the chrome - drawn anyway, counted here.</summary>
        public int ObjectivesUnplaced;
        /// <summary>The range's HIGH and LOW candles, from the core's words.</summary>
        public Label High, Low;
        public readonly List<Rect> AssaultColumns = new List<Rect>();
        public readonly List<Color> AssaultColours = new List<Color>();
        public readonly List<string> Banners = new List<string>();
        public readonly List<Color> BannerColours = new List<Color>();
        public Rect BannerBox;
        /// <summary>
        /// Where the header rows and the plot's labels were drawn, as the painter laid them out (text width from the style):
        /// what the OPEN label is measured against.
        /// </summary>
        public Rect SymbolBox, PriceBox, LegendBox, OpenBox, YouBox, HighBox, LowBox, GateBox;
        /// <summary>YOU's dot and heading tick, where the core puts the truck; YouBox is its label.</summary>
        public Rect YouMarkBox;
        /// <summary>The last-price tag on the price axis, and the GATE's gold line across the plot.</summary>
        public Rect LastTagBox, GateLineBox;
        /// <summary>Each other player's dot and id label, in the order they were drawn.</summary>
        public readonly List<Rect> GhostDotBoxes = new List<Rect>(), GhostLabelBoxes = new List<Rect>();
        /// <summary>Other players' id labels that found no free box and stayed right of their dot.</summary>
        public int GhostsUnplaced;
        /// <summary>For each ghost, the rows its label tried and what blocked them (GhostSlotReport).</summary>
        public readonly List<string> GhostSlots = new List<string>();
        /// <summary>False when no place for the YOU label clears every box, and it stayed up and right of the dot.</summary>
        public bool YouPlaced;
        /// <summary>False when no place for the OPEN label clears every box, and it stayed above its line at the left.</summary>
        public bool OpenPlaced;
        /// <summary>False when LOW found no box inside the plot clear of the others: it is not drawn.</summary>
        public bool LowPlaced;
        /// <summary>The price axis' width, and the widest dollar text it holds (the painter's measure; 0 in a bare Build).</summary>
        public float AxisWidth, PriceTextWidth;
        /// <summary>Each time-axis label's box, as drawn.</summary>
        public readonly List<Rect> TimeBoxes = new List<Rect>();
        public readonly List<Label> PriceAxis = new List<Label>();
        public readonly List<Label> TimeAxis = new List<Label>();
    }

    void Awake()
    {
        _flat = new Texture2D(1, 1); _flat.SetPixel(0, 0, Color.white); _flat.Apply();
    }

    /// <summary>`Tab`: the same chart, the other range.</summary>
    public void Toggle() => Range = Range == L.CHART_GROUND ? L.CHART_ROUND : L.CHART_GROUND;

    public static string RangeName(int range) => range == L.CHART_ROUND ? "ROUND" : "GROUND";

    static bool TabPressed()
    {
#if ENABLE_INPUT_SYSTEM
        var k = UnityEngine.InputSystem.Keyboard.current;
        return k != null && k.tabKey.wasPressedThisFrame;
#else
        return Input.GetKeyDown(KeyCode.Tab);
#endif
    }

    void Update()
    {
        if (TabPressed()) Toggle();
    }

    /// <summary>The chart's size before the 2026-09-17 playtest: 30% of the width, 30% of the height at most.</summary>
    public static Vector2 BaseSize(int w, int h)
    {
        float width = Mathf.Max(300f, w * 0.30f);
        return new Vector2(width, Mathf.Max(170f, Mathf.Min(h * 0.30f, width * 0.62f)));
    }

    /// <summary>2026-09-17 08:31 playtest: "make the chart 20% larger - it is unreadable".</summary>
    public const float Scale = 1.2f;

    /// <summary>2026-09-17 16:01 (hud-desktop-1601.jpg): "position is perfect - make it 30% SMALLER on desktop".</summary>
    public const float DesktopScale = 0.7f;

    /// <summary>
    /// UNDER SIM ON/OFF, CLEAR OF THE STEERING ARROWS (2026-09-17 08:31 playtest: "move the HUD chart under SIM
    /// ON/OFF so it does not cover the right steering arrow"). The top edge sits just under the SIM switch
    /// (<paramref name="sim"/>, the rect the HUD draws it in); the left edge is the SIM switch's, or just right of the
    /// right steering arrow where the chart would otherwise reach down onto it; the right edge stops before the throttle
    /// and handbrake pads and the bottom edge above the screen's margin. Scale x the old size where that fits, else what fits.
    /// </summary>
    public static Rect PanelFor(int w, int h, Rect sim)
    {
        float m = TouchPad.Margin(w, h);
        var size = BaseSize(w, h) * Scale;
        var left = TouchPad.RectFor(TouchPad.Pad.Left, w, h);
        var right = TouchPad.RectFor(TouchPad.Pad.Right, w, h);
        var brake = TouchPad.RectFor(TouchPad.Pad.Handbrake, w, h);
        var up = TouchPad.RectFor(TouchPad.Pad.Up, w, h);
        float y = sim.yMax + m * 0.5f;
        float x = sim.x;
        // Directly under SIM the chart would come down onto the steering arrows: start it past the right arrow instead.
        if (y + size.y > Mathf.Min(left.y, right.y) - m * 0.5f) x = Mathf.Max(x, right.xMax + m * 0.5f);
        float maxRight = Mathf.Min(brake.x, up.x) - m * 0.5f;
        float width = Mathf.Min(size.x, maxRight - x);
        float height = Mathf.Min(size.y, h - m - y);
        return new Rect(x, y, Mathf.Max(0f, width), Mathf.Max(0f, height));
    }

    /// <summary>
    /// TOP RIGHT ON THE DESKTOP, ABOVE THE BUTTONS (2026-09-17: "the HUD chart goes top right on the desktop" - T1 -
    /// then "have the HUD above the sound button and the other button on desktop"). Right-aligned at the screen margin, its
    /// top at the margin, the full 1.2x size. The wanted row, the sound and debug buttons, the debug readout and the score
    /// column step down under it in their own order (DriveHud), and the headline gap ends left of it. Touch screens keep
    /// <see cref="PanelFor"/>: under SIM, off the pads.
    /// </summary>
    public static Rect DesktopPanelFor(int w, int h)
    {
        float m = TouchPad.Margin(w, h);
        var size = BaseSize(w, h) * Scale;
        float width = Mathf.Min(size.x, w - 2f * m);
        float height = Mathf.Max(0f, Mathf.Min(size.y, h - 2f * m));
        return new Rect(w - m - width, m, width, height);
    }

    /// <summary>
    /// Lays the core's chart words out in <paramref name="panel"/>. Pure: the tests hand it words, the player hands it
    /// the core's. Scaling a price onto pixels is all it does with them.
    /// </summary>
    public static Frame Build(int[] v, Rect panel, IList<Ghost> ghosts, float priceTextWidth = 0f)
    {
        var f = new Frame { Panel = panel, Range = v[L.CH_RANGE], Candles = v[L.CH_CANDLES], First = v[L.CH_FIRST], PriceTextWidth = priceTextWidth };
        int n = Mathf.Max(1, f.Candles);
        float unit = Mathf.Max(1, v[L.CH_UNIT]);
        // THE PLOT STARTS BELOW THE HEADER'S THREE ROWS, and MarkClearance below that. It started at 22% of the panel, above the
        // rows' own bottom: measured on 0.0.1459 the legend row ("FRONT · SMA 21") reached 19.4 px into the plot, and a truck
        // whose price is near the window's top drew its YOU dot and label on it (dot 34 px², label on the row).
        float headH = HeaderHeight(panel.height), axisW = AxisWidth(panel.width, priceTextWidth), axisH = Mathf.Max(14f, panel.height * 0.09f);
        f.Plot = new Rect(panel.x + 4f, panel.y + headH, panel.width - axisW - 4f, panel.height - headH - axisH);
        f.AxisWidth = axisW;

        f.Header = $"{Symbol} · {RangeName(f.Range)}";
        f.Price = Dollars(v[L.CH_LAST], unit);
        // WHO IS LEADING, not just by how much (2026-09-19 12:55, from the cab: the header read
        // "$81,330 +0.00% SIDEWAYS" and he could not tell who was ahead). §4.14: "BULLS +0.42%" / "BEARS -0.17%"
        // against the round's open; level to the cent is LEVEL, and only the round's end says WIN.
        int bp = v[L.CH_LEAD_BP];
        f.Lead = LeadWord(v[L.CH_LEAD], bp);
        LiveLeading = LeadingWord(v[L.CH_LEAD], bp);          // the run's end screen reads this (§4.14)
        f.LeadColour = v[L.CH_LEAD] > 0 ? Green : v[L.CH_LEAD] < 0 ? Red : Axis;
        f.Dots = v[L.CH_DOTS];
        f.Trend = v[L.CH_TREND] > 0 ? $"UP {v[L.CH_STRENGTH]}" : v[L.CH_TREND] < 0 ? $"DOWN {v[L.CH_STRENGTH]}" : "SIDEWAYS";

        // The drawing's price scale: the range's low and high, a little air either side.
        double lo = v[L.CH_LO], hi = v[L.CH_HI];
        double air = Mathf.Max(1f, (float)(hi - lo) * 0.08f);
        lo -= air; hi += air;
        var plot = f.Plot;
        float Y(double p) => plot.yMax - (float)((p - lo) / (hi - lo)) * plot.height;
        float cw = plot.width / n;
        float X(int tq16) => plot.x + tq16 / 65536f * cw;

        int front = L.CH_CANDLE + 4 * f.Candles;
        for (int i = 0; i < f.Candles; i++)
        {
            int b = L.CH_CANDLE + 4 * i;
            int o = v[b], hiP = v[b + 1], loP = v[b + 2], c = v[b + 3];
            float cx = plot.x + (i + 0.5f) * cw, bodyW = Mathf.Max(1f, cw * 0.7f);
            float top = Y(Mathf.Max(o, c)), bottom = Y(Mathf.Min(o, c));
            f.Bars.Add(new Candle
            {
                Green = c >= o,
                Body = new Rect(cx - bodyW * 0.5f, top, bodyW, Mathf.Max(1f, bottom - top)),
                Wick = new Rect(cx - 0.5f, Y(hiP), 1f, Mathf.Max(1f, Y(loP) - Y(hiP))),
            });
            if (v[front + i] != L.CH_NONE) f.Front.Add(new Vector2(cx, Y(v[front + i])));
        }
        f.OpenY = Mathf.Clamp(Y(v[L.CH_OPEN]), plot.y, plot.yMax);   // GROUND's window can scroll past the open
        f.LastY = Y(v[L.CH_LAST]);
        f.LastGreen = f.Candles == 0 || v[L.CH_CANDLE + 4 * (f.Candles - 1) + 3] >= v[L.CH_CANDLE + 4 * (f.Candles - 1)];

        if (f.Candles > 0)
        {
            f.High = new Label { Text = "HIGH " + Dollars(v[L.CH_HIGH_P], unit), At = new Vector2(X(v[L.CH_HIGH_T]), Y(v[L.CH_HIGH_P])), Colour = Axis };
            f.Low = new Label { Text = "LOW " + Dollars(v[L.CH_LOW_P], unit), At = new Vector2(X(v[L.CH_LOW_T]), Y(v[L.CH_LOW_P])), Colour = Axis };
        }
        f.YouOn = v[L.CH_YOU_ON] != 0;
        f.You = new Vector2(Mathf.Clamp(X(v[L.CH_YOU_T]), plot.x, plot.xMax), Mathf.Clamp(Y(v[L.CH_YOU_P]), plot.y, plot.yMax));
        f.YouHeading = (v[L.CH_YOU_HEADING] & 0xFFFF) * 360f / 65536f;
        f.GateOn = v[L.CH_GATE_ON] != 0;
        f.GatePinned = !f.GateOn && v[L.CH_GATE_T] > v[L.CH_CANDLES] * 65536;
        f.GateX = f.GatePinned ? plot.xMax : X(v[L.CH_GATE_T]);
        f.WindowShaded = f.Range == L.CHART_ROUND;
        f.Window = Rect.MinMaxRect(X(v[L.CH_WINDOW_FROM]), plot.y, X(v[L.CH_WINDOW_TO]), plot.yMax);

        if (ghosts != null)
            foreach (var g in ghosts)
                if (g.On != 0) f.Ghosts.Add(new Label { Text = g.Name, At = new Vector2(X(g.T), Mathf.Clamp(Y(g.P), plot.y, plot.yMax)), Colour = Ghosted });

        // THE CORE'S OBJECTIVES (§4.11): HIGH, LOW and OPEN at their candles' points, as chartView writes them. One
        // the core reports off this range - an absent OPEN included - is not drawn. ONE CANDLE THAT IS BOTH HIGH AND LOW IS ONE
        // MARKER, "HIGH/LOW": the core names the same candle twice, and the chart draws it once.
        var objT = new List<int>();
        for (int o = 0; o < 3; o++)
        {
            int b = L.CH_OBJ + o * L.CH_OBJ_WORDS;
            if (v[b + 4] == 0) continue;
            int same = objT.IndexOf(v[b + 1]);
            if (same >= 0) { var joined = f.Objectives[same]; joined.Text += "/" + ObjectiveName(v[b]); f.Objectives[same] = joined; continue; }
            int holder = v[b + 3];
            objT.Add(v[b + 1]);
            f.Objectives.Add(new Label
            {
                Text = ObjectiveName(v[b]), At = new Vector2(X(v[b + 1]), Mathf.Clamp(Y(v[b + 2]), plot.y, plot.yMax)),
                Colour = holder == L.HOLDER_BULL ? Bull : holder == L.HOLDER_BEAR ? Bear : Axis,
            });
        }
        for (int s = 0; s < 2; s++)
        {
            int b = L.CH_ASSAULT + s * L.CH_ASSAULT_WORDS, phase = v[b];
            if (phase == L.ASSAULT_IDLE) continue;
            // NO OBJECTIVE NAME IN THE BANNER: RIDGE / HOLLOW / GAP are off the HUD (2026-09-17 09:17,
            // "only LOW and HIGH"), and the banner the owner asks for on 2026-09-19 12:55 is who is attacking, not
            // where. The lane is already drawn as the tinted column under the candles.
            string side = s == 0 ? "BULLS" : "BEARS";
            f.Banners.Add($"{side} {(phase == L.ASSAULT_PUSH ? "ASSAULT" : "CONSOLIDATE")}");
            f.BannerColours.Add(s == 0 ? Bull : Bear);
            if (v[b + 3] == 0) continue;
            float x0 = Mathf.Clamp(X(v[b + 4]), plot.x, plot.xMax), x1 = Mathf.Clamp(X(v[b + 5]), plot.x, plot.xMax);
            f.AssaultColumns.Add(Rect.MinMaxRect(x0, plot.y, x1, plot.yMax));
            f.AssaultColours.Add(s == 0 ? Bull : Bear);
        }

        for (int k = 0; k <= 3; k++)
        {
            double p = v[L.CH_LO] + (v[L.CH_HI] - (double)v[L.CH_LO]) * k / 3.0;
            f.PriceAxis.Add(new Label { Text = Dollars((int)p, unit), At = new Vector2(plot.xMax + 4f, Y(p)), Colour = Axis });
        }
        int every = Mathf.Max(1, Mathf.CeilToInt(n / 4f));
        for (int i = 0; i < f.Candles; i += every)
            f.TimeAxis.Add(new Label { Text = Clock((f.First + i) * v[L.CH_CANDLE_SECONDS]), At = new Vector2(plot.x + (i + 0.5f) * cw, plot.yMax + 1f), Colour = Axis });
        return f;
    }

    /// <summary>
    /// THE PRICE AXIS HOLDS ITS WIDEST DOLLAR TEXT (2026-09-17 09:13 playtest, "the $ amount does not fit"). The
    /// labels start 4 px right of the plot and need 4 px before the panel's edge. The screenshot: axis 20% of the panel
    /// (156 of 795 px), "$78,515.00" 183 px wide, 31 px of it past the panel.
    /// </summary>
    public static float AxisWidth(float panelWidth, float priceTextWidth) => Mathf.Max(64f, panelWidth * 0.2f, priceTextWidth + 8f);

    /// <summary>The price texts the axis must hold: the range's low and high, and the last price.</summary>
    public static string[] AxisTexts(int[] v) =>
        new[] { Dollars(v[L.CH_LO], Mathf.Max(1, v[L.CH_UNIT])), Dollars(v[L.CH_HI], Mathf.Max(1, v[L.CH_UNIT])), Dollars(v[L.CH_LAST], Mathf.Max(1, v[L.CH_UNIT])) };

    /// <summary>
    /// LOW OFF THE TIME AXIS (2026-09-17 09:13 playtest: "LOW collides with the time axis"). The lowest candle sits in
    /// the plot's bottom air, so LOW drawn 5 px under its wick landed on the time labels' row (the screenshot: "LOW $77,551.25"
    /// over "-2:30" and "-1:10"). In order: under the wick where that still ends inside the plot, then right of the wick,
    /// then left of it, at the low's level held inside the plot; each must clear <paramref name="avoid"/>. Nowhere: not placed,
    /// and LOW is not drawn.
    /// </summary>
    public static Rect PlaceLow(Rect plot, Vector2 low, float width, float height, Rect[] avoid, out bool placed)
    {
        float side = Mathf.Clamp(low.y - height * 0.5f, plot.y, plot.yMax - height);
        var tries = new[]
        {
            new Rect(Mathf.Clamp(low.x - width * 0.5f, plot.x, plot.xMax - width), low.y + 5f, width, height),
            new Rect(low.x + 4f, side, width, height),
            new Rect(low.x - 4f - width, side, width, height),
        };
        foreach (var r in tries)
        {
            if (r.x < plot.x || r.xMax > plot.xMax || r.y < plot.y || r.yMax > plot.yMax) continue;
            bool clear = true;
            foreach (var a in avoid) if (Shared(r, a) > 0f) { clear = false; break; }
            if (clear) { placed = true; return r; }
        }
        placed = false;
        return new Rect();
    }

    /// <summary>
    /// A time label centred under its candle and held inside the panel: at -14 px the first one began left of the panel
    /// (the screenshot: "-5:10" read "5:10").
    /// </summary>
    public static Rect TimeLabelBox(Rect panel, Rect plot, Vector2 at, float width, float height) =>
        new Rect(Mathf.Clamp(at.x - width * 0.5f, panel.x + 2f, plot.xMax - width), at.y, width, height);

    /// <summary>The gate's label: "GATE" on the chart, "GATE ›" pinned at the right edge past the last candle.</summary>
    /// <summary>
    /// WHO IS LEADING AND BY HOW MUCH (§4.14). The word is the side, the number is the round's open to the last
    /// attested sample. "LEADING" and "WIN" are not the same claim: the round's end says WIN, a live chart says who
    /// is ahead right now, and this is the live one - the run's end screen adds the word LEADING to it.
    /// </summary>
    public static string LeadWord(int lead, int bp)
    {
        string pct = (bp >= 0 ? "+" : "-") + (Mathf.Abs(bp) / 100f).ToString("0.00", CultureInfo.InvariantCulture) + "%";
        return (lead > 0 ? "BULLS " : lead < 0 ? "BEARS " : "LEVEL ") + pct;
    }

    /// <summary>
    /// THE LEAD AS THE RUN'S END SCREEN SAYS IT: "BULLS LEADING +0.42%". §4.14 is exact about the word - a run
    /// ends inside the round, so its screen may say who is *leading* and never who won. Null until a chart is up.
    /// </summary>
    public static string LiveLeading { get; private set; }

    public static string LeadingWord(int lead, int bp)
    {
        string pct = (bp >= 0 ? "+" : "-") + (Mathf.Abs(bp) / 100f).ToString("0.00", CultureInfo.InvariantCulture) + "%";
        return (lead > 0 ? "BULLS LEADING " : lead < 0 ? "BEARS LEADING " : "LEVEL ") + pct;
    }

    /// <summary>The round's verdict, from its open and its close - the only winner there is (§4.14).</summary>
    public static string RoundVerdict(long open, long close) =>
        close > open ? "THE BULLS WIN" : close < open ? "THE BEARS WIN" : "NO MOVE";

    public static string GateWord(Frame f) => f.GatePinned ? "GATE " + PinArrow : "GATE";

    /// <summary>
    /// The arrow on a pinned mark (YOU before the field, GATE past it). ASCII ">": on the 0.0.1474 player "YOU ›" and
    /// "GATE ›" were drawn as "YOU" and "GATE", a pin that looked like a mark on the chart - although the Editor's embedded
    /// font reports U+203A present, so the cause is not proven; the player build is the measurement.
    /// </summary>
    public const string PinArrow = ">";

    /// <summary>
    /// WAR_TACTICS.md §4.11 names the three objectives HIGH, LOW and OPEN - the chart's own high, low and open crossing,
    /// which is what the core picks them from since 68e2b3d6 (before it they were the relief's lanes).
    /// </summary>
    public static string ObjectiveName(int kind) =>
        kind == L.OBJ_HIGH ? "HIGH" : kind == L.OBJ_LOW ? "LOW" : kind == L.OBJ_OPEN ? "OPEN" : "?";

    /// <summary>
    /// Whole dollars on the chart - axis, HIGH, LOW, the last price (2026-09-17 12:40: "decimals still overlap. Remove
    /// decimal places from the chart generally. Integers only").
    /// </summary>
    public static string Dollars(int price, float unit) =>
        "$" + System.Math.Round(price / (double)unit, System.MidpointRounding.AwayFromZero).ToString("N0", CultureInfo.InvariantCulture);

    public static string Clock(int seconds)
    {
        int a = Mathf.Abs(seconds);
        return (seconds < 0 ? "-" : "") + (a / 60) + ":" + (a % 60).ToString("00");
    }

    void OnGUI()
    {
        if (Event.current.type == EventType.Repaint) ChartsPainted = 0;
        if (CleanHud.On) return;
        if (!Arena.ArenaCore.Available) return;
        if (_splash == null) _splash = FindFirstObjectByType<SplashScreen>();
        if (_spectator == null) _spectator = FindFirstObjectByType<SpectatorCamera>();
        if (_splash != null && _splash.Showing) return;
        // ON IN SPECTATE (2026-09-17 16:38: "put the HUD back onto spectate"): the same chart as the drive, in the same
        // panel, over the free camera - the page's core keeps stepping while it flies, so the chart moves there too.
        if (_spectator != null && _spectator.Active) SpectateFrames++;
        if (Arena.ArenaCore.ChartView(Range, _view) == 0) return;

        // ONCE A FRAME, not once a GUI event: IMGUI runs OnGUI for layout and again for the repaint, and the
        // banner's clock would then start on whichever pass came first. The watch ignores an unchanged phase
        // anyway, so this is about the stamp on the line, not about double-counting.
        if (Event.current.type == EventType.Repaint)
        {
            int said = Watch.Revision;
            Watch.Observe(_view, LocalWall.Now, Time.unscaledTime, Arena.ArenaCore.Tick);
            if (Watch.Revision != said) Arena.DailyLobby.AssaultShown(Watch.AsJson());
        }

        // THE WAR DOES NOT PAUSE FOR THE CARGO BAY (2026-09-21, measured). This return used to sit ABOVE the
        // watch, so while the player was choosing freight `Observe` never ran - and the watch only reacts to a
        // TRANSITION, so by the time the bay closed the phase had already moved and the declaration was gone
        // for good: no line, no banner, no chime, ever. Measured on Daily 0.0.1842 over four rounds: 8 of 12
        // declarations were made with the bay open and 0 of those 8 reached the player, while 4 of 4 made on
        // the road did. The chart itself still does not draw here - that is what the return is for - but the
        // war is now recorded while it happens.
        if (loadout != null && loadout.IsOpen) return;

        // THE CHART IS BUILT AND DRAWN ON THE REPAINT PASS ONLY. IMGUI calls OnGUI for its layout pass as
        // well, where a draw paints nothing and the chart reads no input, and this built and painted the whole chart there
        // too: in a named profile of spectate (phone at 4x) ChartHud.OnGUI was 400 ms of every 5 s.
        if (Event.current.type != EventType.Repaint) return;

        if (_field == null) _field = FindFirstObjectByType<Arena.GhostField>();
        _ghosts.Clear();
        if (_field != null)
            foreach (var kv in _field.Pictures)
                if (Arena.ArenaCore.ChartPoint(Range, kv.Value.X, kv.Value.Z, _point))
                    _ghosts.Add(new Ghost(kv.Key.Length > 8 ? kv.Key.Substring(0, 8) : kv.Key, _point[0], _point[1], _point[2]));

        if (_drive == null) _drive = GetComponent<DriveHud>();
        if (_drive == null) _drive = FindFirstObjectByType<DriveHud>();
        _sim = _drive != null ? _drive.SimBox(Screen.width, Screen.height) : new Rect(10f, Screen.height * 0.45f, 300f, 40f);
        var panel = _drive != null ? _drive.HudChartPanel(Screen.width, Screen.height) : PanelFor(Screen.width, Screen.height, _sim);
        Styles(HeaderFont(panel.height));
        float priceW = 0f;
        foreach (var t in AxisTexts(_view)) priceW = Mathf.Max(priceW, _right.CalcSize(new GUIContent(t)).x);
        var f = Build(_view, panel, _ghosts, priceW);
        // IN FRONT OF THE REST OF THE HUD (lower depth is nearer). Measured on the player build: the "Loading models" list drew
        // over the left third of the chart while the models streamed, and YOU was under it.
        GUI.depth = -1;
        Paint(f);
        Last = f;
        if (Event.current.type == EventType.Repaint) { ChartsPainted++; Tell(f); }
    }

    /// <summary>
    /// What the chart reads, to the console, when the range changes and every 2 s: the words it painted from and
    /// where it put them. A number that does not move is looked up here, not guessed at.
    /// </summary>
    void Tell(Frame f)
    {
        if (f.Range == _toldRange && Time.unscaledTime - _toldAt < 2f) return;
        _toldRange = f.Range; _toldAt = Time.unscaledTime;
        var t = Arena.ArenaCore.TruckPosition(0f);
        string a(int s) { int b = L.CH_ASSAULT + s * L.CH_ASSAULT_WORDS; return $"{_view[b]}/{_view[b + 1]}"; }
        Debug.Log("[chart] " + string.Join(" ", new[]
        {
            $"range={RangeName(f.Range)}", $"spectate={(_spectator != null && _spectator.Active ? 1 : 0)}", $"candles={f.Candles}", $"first={f.First}", $"samples={_view[L.CH_SAMPLES]}",
            $"lo={_view[L.CH_LO]}", $"hi={_view[L.CH_HI]}", $"open={_view[L.CH_OPEN]}", $"last={_view[L.CH_LAST]}",
            $"lead={_view[L.CH_LEAD]}", $"leadBp={_view[L.CH_LEAD_BP]}", $"trend={_view[L.CH_TREND]}", $"strength={_view[L.CH_STRENGTH]}",
            $"youT={_view[L.CH_YOU_T]}", $"youP={_view[L.CH_YOU_P]}", $"youOn={_view[L.CH_YOU_ON]}",
            $"youPx={f.You.x:0.0},{f.You.y:0.0}", $"truck={t.x:0.00},{t.z:0.00}",
            $"gateT={_view[L.CH_GATE_T]}", $"gateOn={_view[L.CH_GATE_ON]}", $"gatePinned={f.GatePinned}", $"gatePx={f.GateX:0.0}", $"youShown={(f.YouOn ? "on" : "pinned")}",
            $"ghosts={f.Ghosts.Count}/{_ghosts.Count}", $"ghostAt={Ghosts()}", $"assault={a(0)},{a(1)}", $"columns={f.AssaultColumns.Count}",
            $"banners={string.Join("+", f.Banners).Replace(' ', '_')}", $"candleSum={Sum(L.CH_CANDLE, 4 * f.Candles)}",
            $"frontSum={Sum(L.CH_CANDLE + 4 * f.Candles, f.Candles)}", $"fronts={f.Front.Count}", $"high={_view[L.CH_HIGH_P]}", $"low={_view[L.CH_LOW_P]}",
            $"panel={f.Panel.x:0},{f.Panel.y:0},{f.Panel.width:0},{f.Panel.height:0}", $"simBox={B(_sim)}", $"padLeft={B(TouchPad.RectFor(TouchPad.Pad.Left, Screen.width, Screen.height))}", $"padRight={B(TouchPad.RectFor(TouchPad.Pad.Right, Screen.width, Screen.height))}", $"padBrake={B(TouchPad.RectFor(TouchPad.Pad.Handbrake, Screen.width, Screen.height))}", $"padUp={B(TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height))}", $"padDown={B(TouchPad.RectFor(TouchPad.Pad.Down, Screen.width, Screen.height))}", $"screen={Screen.width}x{Screen.height}",
            $"charts={ChartsPainted}",
            $"symbolBox={B(f.SymbolBox)}", $"priceBox={B(f.PriceBox)}", $"legendBox={B(f.LegendBox)}", $"openBox={B(f.OpenBox)}",
            $"youBox={B(f.YouBox)}", $"youMarkBox={B(f.YouMarkBox)}", $"youPlaced={f.YouPlaced}", $"plotBox={B(f.Plot)}",
            $"youLabelShares={Shares(f.YouBox, f)}", $"youMarkShares={Shares(f.YouMarkBox, f)}",
            $"lastTagBox={B(f.LastTagBox)}", $"gateLineBox={B(f.GateLineBox)}",
            $"ghostLabelBoxes={string.Join("|", f.GhostLabelBoxes.ConvertAll(B))}", $"ghostDotBoxes={string.Join("|", f.GhostDotBoxes.ConvertAll(B))}",
            $"ghostsUnplaced={f.GhostsUnplaced}", $"ghostSlots={string.Join(" || ", f.GhostSlots)}", $"ghostLabelShares={string.Join("|", f.GhostLabelBoxes.ConvertAll(r => GhostShares(r, f)))}", $"highLow={HighLowLine(f).Replace(' ', '_')}", $"gateBox={B(f.GateBox)}",
            $"objBox={string.Join("|", f.ObjectiveBoxes.ConvertAll(B))}", $"objNames={string.Join("+", f.Objectives.ConvertAll(o => o.Text))}",
            $"objUnplaced={f.ObjectivesUnplaced}",
            $"openShares={OpenShares(f)}", $"openPlaced={f.OpenPlaced}",
            $"axisW={f.AxisWidth:0.0}", $"priceTextW={f.PriceTextWidth:0.0}", $"lowPlaced={f.LowPlaced}", $"timeBoxes={string.Join("|", f.TimeBoxes.ConvertAll(B))}",
        }));
    }

    /// <summary>The header's font size for a panel this tall: the painter's and the layout's one number.</summary>
    // The cap scales with the chart (playtest 08:31, unreadable): 18 px was the old chart's ceiling.
    public static int HeaderFont(float panelHeight) => Mathf.RoundToInt(Mathf.Clamp(panelHeight * 0.075f, 11f, 18f * Scale));

    /// <summary>One header row's height: the font and its line spacing.</summary>
    public static float RowHeight(float panelHeight) => HeaderFont(panelHeight) * 1.35f;

    /// <summary>
    /// How far YOU's mark reaches from its centre: the 8 px dot's half (4) and the 10 px heading tick, 2 px wide (11). A dot
    /// pinned to the plot's top edge reaches this far above it, so the plot keeps this clear of the header's rows.
    /// </summary>
    public const float MarkClearance = 12f;

    /// <summary>The header above the plot: 2 px, the symbol, price and legend rows, and MarkClearance.</summary>
    public static float HeaderHeight(float panelHeight) => 2f + 3f * RowHeight(panelHeight) + MarkClearance;

    /// <summary>
    /// Where the YOU label goes, around the dot and never over it: up-right of the dot, then below; along each row, rightwards
    /// then leftwards from the dot in 4 px steps; the first box inside the plot that shares no area with the mark or any of
    /// <paramref name="avoid"/>. Nothing free: up-right of the dot, and <paramref name="placed"/> false. The dot itself is the
    /// core's truck and does not move.
    /// </summary>
    public static Rect PlaceYouLabel(Rect plot, Vector2 dot, Rect mark, float width, float height, Rect[] avoid, out bool placed)
    {
        foreach (float y in new[] { dot.y - height, dot.y + 5f })
        {
            if (y < plot.y || y + height > plot.yMax) continue;
            for (float d = 0f; d <= plot.width; d += 4f)
                foreach (float x in new[] { dot.x + 6f + d, dot.x - 6f - width - d })
                {
                    if (x < plot.x || x + width > plot.xMax) continue;
                    var r = new Rect(x, y, width, height);
                    if (Shared(r, mark) > 0f) continue;
                    bool free = true;
                    foreach (var a in avoid) if (Shared(r, a) > 0f) { free = false; break; }
                    if (free) { placed = true; return r; }
                }
        }
        placed = false;
        return new Rect(dot.x + 6f, dot.y - height, width, height);
    }

    /// <summary>The rows PlaceGhostLabel tries for an id beside <paramref name="dot"/>, in order.</summary>
    public static float[] GhostRows(Vector2 dot, float height, Rect plot)
    {
        // Level, above, below - and then, measured on 2026-09-17 with a truck pinned to the plot's top-left and the one row
        // under it taken end to end (OPEN, YOU, GATE: no free start), further rows below and above the dot, one label and 3 px
        // apart, while inside the plot. The dot does not move; only its label looks further.
        var rows = new List<float> { dot.y - height * 0.5f, dot.y - 3f - height, dot.y + 3f };
        for (int k = 1; ; k++)
        {
            float below = dot.y + 3f + k * (height + 3f), above = dot.y - 3f - height - k * (height + 3f);
            bool b = below + height <= plot.yMax, a = above >= plot.y;
            if (!b && !a) break;
            if (b) rows.Add(below);
            if (a) rows.Add(above);
        }
        return rows.ToArray();
    }

    /// <summary>
    /// WHAT PlaceGhostLabel CONSIDERED, row by row: off the plot, or which boxes block which label starts (x ranges) and the
    /// first free start rightwards and leftwards of the dot, or none. For the log and the tests - it places nothing.
    /// </summary>
    public static string GhostSlotReport(Rect plot, Vector2 dot, float width, float height, Rect[] avoid, string[] names)
    {
        var rows = new List<string>();
        foreach (float y in GhostRows(dot, height, plot))
        {
            if (y < plot.y || y + height > plot.yMax) { rows.Add($"y{y:0.0}:off-plot"); continue; }
            var blocked = new List<string>();
            for (int i = 0; i < avoid.Length; i++)
            {
                var a = avoid[i];
                if (a.width <= 0f || a.height <= 0f || a.yMax <= y || a.y >= y + height) continue;
                float x0 = Mathf.Max(plot.x, a.x - width), x1 = Mathf.Min(plot.xMax - width, a.xMax);
                if (x1 > x0) blocked.Add($"{(i < names.Length ? names[i] : "?")}[{x0:0.0}-{x1:0.0}]");
            }
            string right = "none", left = "none";
            for (float d = 0f; d <= plot.width; d += 4f)
            {
                float xr = dot.x + 4f + d, xl = dot.x - 4f - width - d;
                bool Free(float x) { if (x < plot.x || x + width > plot.xMax) return false; var r = new Rect(x, y, width, height);
                    foreach (var a in avoid) if (Shared(r, a) > 0f) return false; return true; }
                if (right == "none" && Free(xr)) right = $"{xr:0.0}";
                if (left == "none" && Free(xl)) left = $"{xl:0.0}";
            }
            rows.Add($"y{y:0.0}:blocked={(blocked.Count == 0 ? "-" : string.Join("+", blocked))};right={right};left={left}");
        }
        return string.Join(" | ", rows);
    }

    /// <summary>
    /// Where another player's id label goes: level with its dot, then above, then below; along each row rightwards then
    /// leftwards from the dot in 4 px steps; the first box inside the plot (so never on the price axis and its last-price tag)
    /// that shares no area with <paramref name="avoid"/> (GATE's label and line, the header rows, OPEN, YOU, HIGH, LOW, the
    /// ghosts' dots and the labels already placed). Nothing free: right of the dot, and <paramref name="placed"/> false. The dot
    /// is the core's mapping of that truck and does not move.
    /// </summary>
    public static Rect PlaceGhostLabel(Rect plot, Vector2 dot, float width, float height, Rect[] avoid, out bool placed)
    {
        foreach (float y in GhostRows(dot, height, plot))
        {
            if (y < plot.y || y + height > plot.yMax) continue;
            for (float d = 0f; d <= plot.width; d += 4f)
                foreach (float x in new[] { dot.x + 4f + d, dot.x - 4f - width - d })
                {
                    if (x < plot.x || x + width > plot.xMax) continue;
                    var r = new Rect(x, y, width, height);
                    bool free = true;
                    foreach (var a in avoid) if (Shared(r, a) > 0f) { free = false; break; }
                    if (free) { placed = true; return r; }
                }
        }
        placed = false;
        return new Rect(dot.x + 4f, dot.y - height * 0.5f, width, height);
    }

    /// <summary>
    /// Where the OPEN label goes: above its line, then below it, each scanned rightwards from the plot's left edge in 4 px
    /// steps, the first box inside the plot that shares no area with any of <paramref name="avoid"/>. Nothing free: above the
    /// line at the left, and <paramref name="placed"/> false. Layout only - the line itself is the core's open price.
    /// </summary>
    public static Rect PlaceOpen(Rect plot, float openY, float width, float height, Rect[] avoid, out bool placed)
    {
        foreach (float y in new[] { openY - height, openY + 1f })
        {
            for (float x = plot.x + 2f; x + width <= plot.xMax; x += 4f)
            {
                var r = new Rect(x, y, width, height);
                bool free = true;
                foreach (var a in avoid) if (Shared(r, a) > 0f) { free = false; break; }
                if (free) { placed = true; return r; }
            }
        }
        placed = false;
        return new Rect(plot.x + 2f, openY - height, width, height);
    }

    static string B(Rect r) => $"{r.x:0.0},{r.y:0.0},{r.width:0.0},{r.height:0.0}";

    /// <summary>The area, in px, that two boxes share; 0 when they do not touch.</summary>
    public static float Shared(Rect a, Rect b)
    {
        float w = Mathf.Min(a.xMax, b.xMax) - Mathf.Max(a.x, b.x), h = Mathf.Min(a.yMax, b.yMax) - Mathf.Max(a.y, b.y);
        return w > 0f && h > 0f ? w * h : 0f;
    }

    /// <summary>Every chrome box <paramref name="box"/> shares area with (header rows, OPEN, HIGH, LOW, GATE), or "-".</summary>
    public static string Shares(Rect box, Frame f)
    {
        var parts = new List<string>();
        void One(string name, Rect r) { float s = Shared(box, r); if (s > 0f) parts.Add($"{name}:{s:0.0}"); }
        One("symbol", f.SymbolBox); One("price", f.PriceBox); One("legend", f.LegendBox); One("open", f.OpenBox);
        One("high", f.HighBox); One("low", f.LowBox); One("gate", f.GateBox);
        return parts.Count == 0 ? "-" : string.Join("+", parts);
    }

    /// <summary>What an other player's id label shares area with: GATE's label and line, the last-price tag, the header rows, OPEN, YOU, HIGH, LOW.</summary>
    public static string GhostShares(Rect box, Frame f)
    {
        var parts = new List<string>();
        void One(string name, Rect r) { float s = Shared(box, r); if (s > 0f) parts.Add($"{name}:{s:0.0}"); }
        One("gate", f.GateBox); One("gateLine", f.GateLineBox); One("lastTag", f.LastTagBox);
        One("symbol", f.SymbolBox); One("price", f.PriceBox); One("legend", f.LegendBox); One("open", f.OpenBox);
        One("youLabel", f.YouBox); One("youMark", f.YouMarkBox); One("high", f.HighBox); One("low", f.LowBox);
        return parts.Count == 0 ? "-" : string.Join("+", parts);
    }

    /// <summary>Every box the OPEN label shares area with, and how much: "price:120.5+legend:30.0", or "-".</summary>
    public static string OpenShares(Frame f)
    {
        var parts = new List<string>();
        void One(string name, Rect r) { float s = Shared(f.OpenBox, r); if (s > 0f) parts.Add($"{name}:{s:0.0}"); }
        One("symbol", f.SymbolBox); One("price", f.PriceBox); One("legend", f.LegendBox); One("you", f.YouBox); One("youMark", f.YouMarkBox);
        One("high", f.HighBox); One("low", f.LowBox); One("gate", f.GateBox);
        return parts.Count == 0 ? "-" : string.Join("+", parts);
    }

    long Sum(int from, int count)
    {
        long s = 0;
        for (int i = 0; i < count; i++) s += _view[from + i];
        return s;
    }

    string Ghosts()
    {
        var parts = new List<string>();
        for (int i = 0; i < _ghosts.Count && i < 4; i++) parts.Add($"{_ghosts[i].Name}:{_ghosts[i].T}:{_ghosts[i].P}:{_ghosts[i].On}");
        return parts.Count == 0 ? "-" : string.Join(",", parts);
    }

    void Box(Rect r, Color c) { GUI.color = c; GUI.DrawTexture(r, _flat); }

    // A DOTTED LINE IN ONE DRAW: `dash` px on in every `period` from x0, the last dash whole even past x1 - the
    // pixels the old loop of one 1 px box per dash drew, which was one IMGUI draw call per dash (about 150 a frame).
    readonly Dictionary<int, Texture2D> _dashes = new Dictionary<int, Texture2D>();
    void Dashes(float x0, float x1, float y, int dash, int period, Color c)
    {
        int n = Mathf.CeilToInt((x1 - x0) / period);
        if (n <= 0) return;
        int key = dash * 1000 + period;
        if (!_dashes.TryGetValue(key, out var tex))
        {
            tex = new Texture2D(period, 1, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Point };
            for (int i = 0; i < period; i++) tex.SetPixel(i, 0, i < dash ? Color.white : Color.clear);
            tex.Apply();
            _dashes[key] = tex;
        }
        float len = (n - 1) * period + dash;
        GUI.color = c;
        GUI.DrawTextureWithTexCoords(new Rect(x0, y, len, 1f), tex, new Rect(0f, 0f, len / period, 1f));
    }

    void Text(Rect r, string s, Color c, GUIStyle style)
    {
        // WHITE UNDER THE LABEL. IMGUI multiplies a label by GUI.color, and Box leaves it at the last box's colour: measured on
        // the player build, the symbol line that names the live range was drawn in the grid's #1f2530 on #131722 - unreadable.
        GUI.color = Color.white;
        var prev = style.normal.textColor; style.normal.textColor = c; GUI.Label(r, s, style); style.normal.textColor = prev;
    }

    void Styles(int size)
    {
        if (_text == null)
        {
            _text = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperLeft, clipping = TextClipping.Overflow, wordWrap = false };
            _right = new GUIStyle(_text) { alignment = TextAnchor.MiddleLeft };
        }
        _text.fontSize = size; _right.fontSize = size;
    }

    void Paint(Frame f)
    {
        int small = HeaderFont(f.Panel.height);
        Styles(small);
        var old = GUI.color;
        var p = f.Plot;

        Box(f.Panel, Background);
        for (int k = 1; k < 4; k++) Box(new Rect(p.x, p.y + p.height * k / 4f, p.width, 1f), Grid);
        for (int k = 1; k < 6; k++) Box(new Rect(p.x + p.width * k / 6f, p.y, 1f, p.height), Grid);
        if (f.WindowShaded && f.Window.width > 0f) Box(f.Window, new Color(1f, 1f, 1f, 0.05f));

        // header: symbol and range, price, lead, the six trend dots, the trend
        float lh = small * 1.35f, x0 = f.Panel.x + 6f;
        Text(new Rect(x0, f.Panel.y + 2f, f.Panel.width, lh), f.Header, Axis, _text);
        // No "Tab: ROUND" hint beside it (playtest 09:13, the header ran into it: "GROUNDTab: ROUND"). Tab still switches.
        float y2 = f.Panel.y + 2f + lh, w1 = _text.CalcSize(new GUIContent(f.Price)).x;
        Text(new Rect(x0, y2, 200f, lh), f.Price, Color.white, _text);
        float w2 = _text.CalcSize(new GUIContent(f.Lead)).x;
        Text(new Rect(x0 + w1 + 8f, y2, 120f, lh), f.Lead, f.LeadColour, _text);
        float dx = x0 + w1 + w2 + 16f, dot = small * 0.55f;
        for (int c = 5; c >= 0; c--)
        {
            int col = (f.Dots >> (2 * c)) & 3;
            Box(new Rect(dx, y2 + (lh - dot) * 0.5f, dot, dot), col == 1 ? Green : col == 2 ? Red : Axis);
            dx += dot + 3f;
        }
        Text(new Rect(dx + 4f, y2, 120f, lh), f.Trend, Axis, _text);
        Text(new Rect(x0, y2 + lh, 200f, lh), "FRONT · SMA 21", Color.white, _text);
        f.SymbolBox = new Rect(x0, f.Panel.y + 2f, _text.CalcSize(new GUIContent(f.Header)).x, lh);
        f.PriceBox = Rect.MinMaxRect(x0, y2, dx + 4f + _text.CalcSize(new GUIContent(f.Trend)).x, y2 + lh);
        f.LegendBox = new Rect(x0, y2 + lh, _text.CalcSize(new GUIContent("FRONT · SMA 21")).x, lh);

        // assault columns under the candles
        for (int i = 0; i < f.AssaultColumns.Count; i++) { var c = f.AssaultColours[i]; c.a = 0.16f; Box(f.AssaultColumns[i], c); }
        // AND THE BANNERS ABOVE THEM (2026-09-19 12:55: "no BULLS/BEARS assaults" - the list was built every
        // frame and never drawn, so an assault was a faint tint and nothing else). They carry no objective name.
        f.BannerBox = new Rect();
        for (int i = 0; i < f.Banners.Count; i++)
        {
            float bw = _text.CalcSize(new GUIContent(f.Banners[i])).x + 8f;
            var box = new Rect(p.xMax - bw - 2f, p.y + 2f + i * (lh + 2f), bw, lh);
            GUI.color = new Color(0f, 0f, 0f, 0.45f); GUI.DrawTexture(box, _flat); GUI.color = Color.white;
            Text(new Rect(box.x + 4f, box.y, box.width, lh), f.Banners[i], f.BannerColours[i], _text);
            f.BannerBox = f.BannerBox.width <= 0f ? box : Rect.MinMaxRect(Mathf.Min(f.BannerBox.x, box.x), f.BannerBox.y,
                                                                         Mathf.Max(f.BannerBox.xMax, box.xMax), box.yMax);
        }

        foreach (var c in f.Bars) { Box(c.Wick, c.Green ? Green : Red); Box(c.Body, c.Green ? Green : Red); }

        // OPEN, dashed (its label is placed further down, once every box it must keep off is known)
        Dashes(p.x, p.xMax, f.OpenY, 4, 8, Axis);

        // 1. the seam, white 2 px
        for (int i = 1; i < f.Front.Count; i++) Line(f.Front[i - 1], f.Front[i], 2f, Color.white);

        // 2. objectives: not on the chart. Their names (RIDGE, HOLLOW, GAP) sat on the candles and on each other; the chart
        // marks HIGH and LOW only, and the names are nowhere on the HUD (the owner 09:13, 09:17 and after: "only LOW and HIGH").

        // the gate's label box, known before LOW is placed off it
        if (f.GateOn) f.GateBox = new Rect(f.GateX - 34f, p.y, _text.CalcSize(new GUIContent("GATE")).x, lh);
        else if (f.GatePinned) { float gw = _text.CalcSize(new GUIContent(GateWord(f))).x; f.GateBox = new Rect(f.GateX - gw - 2f, p.y, gw, lh); }

        // HIGH and LOW are not written on the chart (2026-09-17 12:55: "HIGH/LOW central on screen not on the chart"):
        // their candles keep a 4 px tick, and since 2026-09-19 13:10 the words are drawn nowhere at all.
        f.LowPlaced = false; f.LowBox = new Rect(); f.HighBox = new Rect();
        if (f.High.Text != null)
        {
            Box(new Rect(f.High.At.x - 0.5f, f.High.At.y - 5f, 1f, 4f), Axis);
            Box(new Rect(f.Low.At.x - 0.5f, f.Low.At.y + 1f, 1f, 4f), Axis);
        }

        // last price: dotted line and the tag on the axis
        var lastColour = f.LastGreen ? Green : Red;
        Dashes(p.x, p.xMax, f.LastY, 2, 4, lastColour);
        float axisText = f.Panel.xMax - (p.xMax + 4f);
        foreach (var a in f.PriceAxis) Text(new Rect(a.At.x, a.At.y - lh * 0.5f, axisText, lh), a.Text, a.Colour, _right);
        Box(new Rect(p.xMax + 2f, f.LastY - lh * 0.5f, f.Panel.xMax - p.xMax - 3f, lh), lastColour);
        f.LastTagBox = new Rect(p.xMax + 2f, f.LastY - lh * 0.5f, f.Panel.xMax - p.xMax - 3f, lh);
        Text(new Rect(p.xMax + 4f, f.LastY - lh * 0.5f, axisText, lh), f.Price, Color.white, _right);
        f.TimeBoxes.Clear();
        foreach (var a in f.TimeAxis)
        {
            var box = TimeLabelBox(f.Panel, p, a.At, _text.CalcSize(new GUIContent(a.Text)).x, lh);
            f.TimeBoxes.Add(box);
            Text(box, a.Text, a.Colour, _text);
        }

        // 6. the gate, gold
        if (f.GateOn) { Box(new Rect(f.GateX - 1f, p.y, 2f, p.height), Gold); f.GateLineBox = new Rect(f.GateX - 1f, p.y, 2f, p.height); Text(new Rect(f.GateX - 34f, p.y, 34f, lh), "GATE", Gold, _text); }
        else if (f.GatePinned) { Box(new Rect(f.GateX - 1f, p.y, 2f, p.height), Gold); f.GateLineBox = new Rect(f.GateX - 1f, p.y, 2f, p.height); Text(new Rect(f.GateBox.x, p.y, f.GateBox.width + 2f, lh), GateWord(f), Gold, _text); }

        // THE OPEN LABEL, off the header and off the labels already on the plot. Measured on 0.0.1459: drawn above its line at
        // the plot's left edge it shared 429 px of box and 246 drawn pixels with the price row ("$78,515.00 +0.00%") and
        // 435 px with the legend row. YOU's box is known before YOU is drawn, so the truck stays on top of it.
        float rad = (90f - f.YouHeading) * Mathf.Deg2Rad;
        var tickEnd = f.You + new Vector2(Mathf.Cos(rad), -Mathf.Sin(rad)) * 10f;
        f.YouMarkBox = Rect.MinMaxRect(Mathf.Min(f.You.x - 4f, tickEnd.x - 1f), Mathf.Min(f.You.y - 4f, tickEnd.y - 1f),
                                       Mathf.Max(f.You.x + 4f, tickEnd.x + 1f), Mathf.Max(f.You.y + 4f, tickEnd.y + 1f));
        string youWord = f.YouOn ? "YOU" : "YOU " + PinArrow;
        f.YouBox = PlaceYouLabel(p, f.You, f.YouMarkBox, _text.CalcSize(new GUIContent(youWord)).x, lh,
                                 new[] { f.SymbolBox, f.PriceBox, f.LegendBox, f.HighBox, f.LowBox, f.GateBox }, out f.YouPlaced);
        float ow = _text.CalcSize(new GUIContent("OPEN")).x;
        f.OpenBox = PlaceOpen(p, f.OpenY, ow, lh, new[] { f.SymbolBox, f.PriceBox, f.LegendBox, f.YouMarkBox, f.YouBox, f.HighBox, f.LowBox, f.GateBox }, out f.OpenPlaced);
        Text(f.OpenBox, "OPEN", Axis, _text);

        // 5. ghosts: the dot where the core maps the other truck, its id label clear of the chrome. Measured before the rule:
        // the id drawn right of its dot ran over GATE's label and line and past the plot onto the last-price tag.
        f.GhostDotBoxes.Clear(); f.GhostLabelBoxes.Clear(); f.GhostSlots.Clear();
        foreach (var g in f.Ghosts) f.GhostDotBoxes.Add(new Rect(g.At.x - 3f, g.At.y - 3f, 6f, 6f));
        var taken = new List<Rect> { f.SymbolBox, f.PriceBox, f.LegendBox, f.OpenBox, f.YouBox, f.YouMarkBox, f.HighBox, f.LowBox,
                                     f.GateBox, f.GateLineBox, f.LastTagBox };
        taken.AddRange(f.GhostDotBoxes);
        for (int i = 0; i < f.Ghosts.Count; i++)
        {
            var g = f.Ghosts[i];
            float gw = _text.CalcSize(new GUIContent(g.Text)).x;
            var label = PlaceGhostLabel(p, g.At, gw, lh, taken.ToArray(), out bool placed);
            var slotNames = new List<string> { "symbol", "price", "legend", "open", "youLabel", "youMark", "high", "low", "gate", "gateLine", "lastTag" };
            for (int j = 0; j < f.GhostDotBoxes.Count; j++) slotNames.Add($"ghostDot{j}");
            for (int j = 0; j < f.GhostLabelBoxes.Count; j++) slotNames.Add($"ghostLabel{j}");
            f.GhostSlots.Add(GhostSlotReport(p, g.At, gw, lh, taken.ToArray(), slotNames.ToArray()));
            f.GhostLabelBoxes.Add(label);
            if (!placed) f.GhostsUnplaced++;
            taken.Add(label);
            Box(f.GhostDotBoxes[i], g.Colour);
            Text(label, g.Text, g.Colour, _text);
        }

        // 6. THE OBJECTIVES (WAR_TACTICS.md §4.11, §0 row O4: "the client draws HIGH, LOW and OPEN at the core's points
        // in the holder's colour"). The list is built above from the core's own words - kind, point, holder - and was
        // consumed by nothing at all: measured on the Daily, the core put three markers on the chart and the HUD drew
        // none of them. This is that draw, and it is the ONLY one: nothing here recomputes a marker.
        //
        // Placed like a ghost's label, out of the chrome it would otherwise sit on, and under the truck, which stays
        // on top of everything.
        f.ObjectiveBoxes.Clear();
        foreach (var o in f.Objectives)
        {
            float ow2 = _text.CalcSize(new GUIContent(o.Text)).x;
            var box = PlaceGhostLabel(p, o.At, ow2, lh, taken.ToArray(), out bool placedObj);
            f.ObjectiveBoxes.Add(box);
            taken.Add(box);
            Box(new Rect(o.At.x - 3f, o.At.y - 3f, 6f, 6f), o.Colour);
            Text(box, o.Text, o.Colour, _text);
            if (!placedObj) f.ObjectivesUnplaced++;
        }

        // 4. the truck, always on top: a faint line down to the time axis, the dot, its heading, YOU
        Box(new Rect(f.You.x, f.You.y, 1f, p.yMax - f.You.y), new Color(Truck.r, Truck.g, Truck.b, 0.35f));
        Line(f.You, tickEnd, 2f, Truck);
        Box(new Rect(f.You.x - 4f, f.You.y - 4f, 8f, 8f), Truck);
        Text(f.YouBox, youWord, Truck, _text);
        GUI.color = old;
    }

    /// <summary>
    /// THE HIGH / LOW PLAQUE IS GONE (2026-09-19 13:10, remove-world-high-low-1310.png: "REMOVE the floating
    /// world overlay HIGH $81,374 . LOW $81,288"). It was put central on 2026-09-17 12:55 to get the words off the
    /// candles; central on a screen with a battlefield on it reads as a plaque floating over the world. The chart
    /// keeps the 4 px ticks on the high and low candles - that is where a high and a low belong - and the words are
    /// drawn nowhere. <see cref="HighLowLine"/> stays because the probe and the log still print what they would say.
    /// </summary>
    public static string HighLowLine(Frame f) => f.High.Text == null ? "" : f.High.Text + "   \u00b7   " + f.Low.Text;

    void Line(Vector2 a, Vector2 b, float width, Color c)
    {
        GUI.color = c;
        var d = b - a;
        float len = d.magnitude;
        if (len < 0.5f) return;
        var m = GUI.matrix;
        GUIUtility.RotateAroundPivot(Mathf.Atan2(d.y, d.x) * Mathf.Rad2Deg, a);
        GUI.DrawTexture(new Rect(a.x, a.y - width * 0.5f, len, width), _flat);
        GUI.matrix = m;
    }
}

/// <summary>
/// THE WALL CLOCK WITHOUT THE TIME-ZONE DATABASE: DateTime.Now made IL2CPP read and parse the time-zone file on
/// its first call - 108 ms inside Unity's start at 4x CPU in a named profile (TimeZoneInfo.GetLocalTimeZoneFromTzFile). In the
/// browser the local time is UTC plus the browser's own offset; elsewhere (the editor, tests) DateTime.Now as before.
/// </summary>
static class LocalWall
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern int ArenaLocalOffsetMinutes();
    public static System.DateTime Now => System.DateTime.SpecifyKind(System.DateTime.UtcNow.AddMinutes(ArenaLocalOffsetMinutes()), System.DateTimeKind.Unspecified);
#else
    public static System.DateTime Now => System.DateTime.Now;
#endif
}

/// <summary>
/// THE LOCAL ZONE WITHOUT THE ZONE DATA (measured 2026-10-08 in a named profile of production 0.0.2857 at 10x CPU as
/// an Android phone: Unity's own GUI static constructor reads DateTime.Now at the first OnGUI, and IL2CPP then builds the local
/// time zone from the zone data - TimeZoneInfo.CreateLocalUnity / GetTimeZoneData, Emscripten mktime and localtime over a year
/// of hours - 294 ms inside the 90 -> 100 % block). In the browser the game's own wall clock reads the browser's offset
/// (LocalWall), so C#'s cached local zone is set to UTC before the first scene and never built. The fields are found by type;
/// if this runtime has none, nothing changes and the log says so.
/// </summary>
static class FastLocalZone
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void UtcAsLocal()
    {
        const System.Reflection.BindingFlags any = System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
        try
        {
            var tz = typeof(System.TimeZoneInfo);
            foreach (var holder in tz.GetFields(any | System.Reflection.BindingFlags.Static))
            {
                var cache = holder.GetValue(null);
                if (cache == null || cache.GetType() == tz || !cache.GetType().Name.Contains("Cached")) continue;
                foreach (var f in cache.GetType().GetFields(any | System.Reflection.BindingFlags.Instance))
                {
                    if (f.FieldType != tz || f.Name.IndexOf("local", System.StringComparison.OrdinalIgnoreCase) < 0) continue;
                    f.SetValue(cache, System.TimeZoneInfo.Utc);
                    Debug.Log($"[time] C#'s local zone is UTC ({holder.Name}.{f.Name}): the zone data is not built; the game's clock reads the browser's offset");
                    return;
                }
            }
            Debug.Log("[time] no cached local zone field found: C# builds the local zone as before");
        }
        catch (System.Exception e) { Debug.Log("[time] the local zone is built as before: " + e.Message); }
    }
#endif
}
