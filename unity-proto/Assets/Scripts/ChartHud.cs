using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using L = Blwp.Layout;

/// <summary>
/// THE HUD'S CHART (WAR_TACTICS.md §0.3, the owner 2026-09-16 21:50): one TradingView chart with the truck on it.
///
/// A television. Every candle, the seam, the lead, the trend, YOU, the gate, the objectives and the assault are words
/// the core lays out in `src/chart.js` and hands over through `BlwpCore.ChartView`; this file turns those words into
/// rectangles and paints them. It works out no price, no range, no position and no market reading - a painter that
/// did would be a second chart that could disagree with the war.
///
/// ONE chart, ONE range at a time. `Tab` switches the same chart between GROUND (the 32 candles on the terrain, the
/// minimap) and ROUND (every candle since the open, the lead). No overview bar under it, no second chart, no strip
/// (the owner 2026-09-16 22:35).
/// </summary>
public class ChartHud : MonoBehaviour
{
    public const string Symbol = "BTCUSD · 10s · BLWP";

    /// <summary>The live range, `L.CHART_GROUND` or `L.CHART_ROUND`. GROUND in the cab.</summary>
    public int Range { get; private set; } = L.CHART_GROUND;

    /// <summary>Charts painted in the last GUI repaint - one, or none while hidden. Never two.</summary>
    public int ChartsPainted { get; private set; }

    /// <summary>The frame painted last, for the measurement tools and the tests.</summary>
    public Frame Last { get; private set; }

    public LoadoutPanel loadout;

    readonly int[] _view = new int[L.CH_WORDS];
    readonly int[] _point = new int[L.CH_POINT_WORDS];
    readonly List<Ghost> _ghosts = new List<Ghost>();
    Texture2D _flat;
    GUIStyle _text, _right;
    Blwp.NetSession _session;
    DriveHud _drive;
    Rect _sim;
    SplashScreen _splash;
    SpectatorCamera _spectator;
    Blwp.GhostField _field;
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
        /// The gate past the last candle (§4.15 G1, the owner 2026-09-17: at x 114 it stands 0.97 of a candle past the field):
        /// the core says off the chart and gives its true t; the HUD pins "GATE ›" at the plot's right edge, as YOU is pinned
        /// at the left before the field.
        /// </summary>
        public bool GatePinned;
        public Rect Window; public bool WindowShaded;
        public readonly List<Label> Ghosts = new List<Label>();
        public readonly List<Label> Objectives = new List<Label>();
        /// <summary>The range's HIGH and LOW candles, from the core's words.</summary>
        public Label High, Low;
        public readonly List<Rect> AssaultColumns = new List<Rect>();
        public readonly List<Color> AssaultColours = new List<Color>();
        public readonly List<string> Banners = new List<string>();
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

    /// <summary>the owner 2026-09-17 08:31 playtest: "make the chart 20% larger - it is unreadable".</summary>
    public const float Scale = 1.2f;

    /// <summary>
    /// UNDER SIM ON/OFF, CLEAR OF THE STEERING ARROWS (the owner 2026-09-17 08:31 playtest: "move the HUD chart under SIM
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
    /// TOP RIGHT ON THE DESKTOP, ABOVE THE BUTTONS (the owner 2026-09-17: "the HUD chart goes top right on the desktop" - T1 -
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
        int bp = v[L.CH_LEAD_BP];
        f.Lead = (bp >= 0 ? "+" : "-") + (Mathf.Abs(bp) / 100f).ToString("0.00", CultureInfo.InvariantCulture) + "%";
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

        for (int o = 0; o < 3; o++)
        {
            int b = L.CH_OBJ + o * L.CH_OBJ_WORDS;
            if (v[b + 4] == 0) continue;
            int holder = v[b + 3];
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
            string side = s == 0 ? "BULLS" : "BEARS";
            f.Banners.Add($"{side} {(phase == L.ASSAULT_PUSH ? "ASSAULT" : "CONSOLIDATE")} {ObjectiveName(v[b + 1])}");
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
    /// THE PRICE AXIS HOLDS ITS WIDEST DOLLAR TEXT (the owner 2026-09-17 09:13 playtest, "the $ amount does not fit"). The
    /// labels start 4 px right of the plot and need 4 px before the panel's edge. The screenshot: axis 20% of the panel
    /// (156 of 795 px), "$78,515.00" 183 px wide, 31 px of it past the panel.
    /// </summary>
    public static float AxisWidth(float panelWidth, float priceTextWidth) => Mathf.Max(64f, panelWidth * 0.2f, priceTextWidth + 8f);

    /// <summary>The price texts the axis must hold: the range's low and high, and the last price.</summary>
    public static string[] AxisTexts(int[] v) =>
        new[] { Dollars(v[L.CH_LO], Mathf.Max(1, v[L.CH_UNIT])), Dollars(v[L.CH_HI], Mathf.Max(1, v[L.CH_UNIT])), Dollars(v[L.CH_LAST], Mathf.Max(1, v[L.CH_UNIT])) };

    /// <summary>
    /// LOW OFF THE TIME AXIS (the owner 2026-09-17 09:13 playtest: "LOW collides with the time axis"). The lowest candle sits in
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
    public static string GateWord(Frame f) => f.GatePinned ? "GATE " + PinArrow : "GATE";

    /// <summary>
    /// The arrow on a pinned mark (YOU before the field, GATE past it). ASCII ">": on the 0.0.1474 player "YOU ›" and
    /// "GATE ›" were drawn as "YOU" and "GATE", a pin that looked like a mark on the chart - although the Editor's embedded
    /// font reports U+203A present, so the cause is not proven; the player build is the measurement.
    /// </summary>
    public const string PinArrow = ">";

    public static string ObjectiveName(int kind) =>
        kind == L.OBJ_RIDGE ? "RIDGE" : kind == L.OBJ_HOLLOW ? "HOLLOW" : kind == L.OBJ_GAP ? "GAP" : "?";

    public static string Dollars(int price, float unit) =>
        "$" + (price / (double)unit).ToString("N2", CultureInfo.InvariantCulture);

    public static string Clock(int seconds)
    {
        int a = Mathf.Abs(seconds);
        return (seconds < 0 ? "-" : "") + (a / 60) + ":" + (a % 60).ToString("00");
    }

    void OnGUI()
    {
        if (Event.current.type == EventType.Repaint) ChartsPainted = 0;
        if (!Blwp.BlwpCore.Available) return;
        if (_splash == null) _splash = FindFirstObjectByType<SplashScreen>();
        if (_spectator == null) _spectator = FindFirstObjectByType<SpectatorCamera>();
        if (_splash != null && _splash.Showing) return;
        if (_spectator != null && _spectator.Active) return;
        if (loadout != null && loadout.IsOpen) return;
        if (Blwp.BlwpCore.ChartView(Range, _view) == 0) return;

        if (_field == null) _field = FindFirstObjectByType<Blwp.GhostField>();
        _ghosts.Clear();
        if (_field != null)
            foreach (var kv in _field.Pictures)
                if (Blwp.BlwpCore.ChartPoint(Range, kv.Value.X, kv.Value.Z, _point))
                    _ghosts.Add(new Ghost(kv.Key.Length > 8 ? kv.Key.Substring(0, 8) : kv.Key, _point[0], _point[1], _point[2]));

        if (_drive == null) _drive = GetComponent<DriveHud>();
        if (_drive == null) _drive = FindFirstObjectByType<DriveHud>();
        _sim = _drive != null ? _drive.SimBox(Screen.width, Screen.height) : new Rect(10f, Screen.height * 0.45f, 300f, 40f);
        var panel = _drive != null && _drive.ChartTopRight(Screen.width, Screen.height)
            ? DesktopPanelFor(Screen.width, Screen.height)
            : PanelFor(Screen.width, Screen.height, _sim);
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
        var t = Blwp.BlwpCore.TruckPosition(0f);
        string a(int s) { int b = L.CH_ASSAULT + s * L.CH_ASSAULT_WORDS; return $"{_view[b]}/{_view[b + 1]}"; }
        Debug.Log("[chart] " + string.Join(" ", new[]
        {
            $"range={RangeName(f.Range)}", $"candles={f.Candles}", $"first={f.First}", $"samples={_view[L.CH_SAMPLES]}",
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
            $"ghostsUnplaced={f.GhostsUnplaced}", $"ghostSlots={string.Join(" || ", f.GhostSlots)}", $"ghostLabelShares={string.Join("|", f.GhostLabelBoxes.ConvertAll(r => GhostShares(r, f)))}", $"highBox={B(f.HighBox)}", $"lowBox={B(f.LowBox)}", $"gateBox={B(f.GateBox)}",
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
        // No assault banners: they name RIDGE / HOLLOW / GAP, and those names are off the HUD (the owner 2026-09-17, after 09:17:
        // "RIDGE HOLLOW GAP must go, only LOW and HIGH").

        foreach (var c in f.Bars) { Box(c.Wick, c.Green ? Green : Red); Box(c.Body, c.Green ? Green : Red); }

        // OPEN, dashed (its label is placed further down, once every box it must keep off is known)
        for (float x = p.x; x < p.xMax; x += 8f) Box(new Rect(x, f.OpenY, 4f, 1f), Axis);

        // 1. the seam, white 2 px
        for (int i = 1; i < f.Front.Count; i++) Line(f.Front[i - 1], f.Front[i], 2f, Color.white);

        // 2. objectives: not on the chart. Their names (RIDGE, HOLLOW, GAP) sat on the candles and on each other; the chart
        // marks HIGH and LOW only, and the names are nowhere on the HUD (the owner 09:13, 09:17 and after: "only LOW and HIGH").

        // the gate's label box, known before LOW is placed off it
        if (f.GateOn) f.GateBox = new Rect(f.GateX - 34f, p.y, _text.CalcSize(new GUIContent("GATE")).x, lh);
        else if (f.GatePinned) { float gw = _text.CalcSize(new GUIContent(GateWord(f))).x; f.GateBox = new Rect(f.GateX - gw - 2f, p.y, gw, lh); }

        // HIGH above its candle, LOW by its candle inside the plot (PlaceLow), TradingView's marks
        f.LowPlaced = false; f.LowBox = new Rect();
        if (f.High.Text != null)
        {
            float hw = _text.CalcSize(new GUIContent(f.High.Text)).x, lw = _text.CalcSize(new GUIContent(f.Low.Text)).x;
            Box(new Rect(f.High.At.x - 0.5f, f.High.At.y - 5f, 1f, 4f), Axis);
            Text(new Rect(Mathf.Clamp(f.High.At.x - hw * 0.5f, p.x, p.xMax - hw), f.High.At.y - 5f - lh, hw + 2f, lh), f.High.Text, Axis, _text);
            f.HighBox = new Rect(Mathf.Clamp(f.High.At.x - hw * 0.5f, p.x, p.xMax - hw), f.High.At.y - 5f - lh, hw, lh);
            f.LowBox = PlaceLow(p, f.Low.At, lw, lh, new[] { f.SymbolBox, f.PriceBox, f.LegendBox, f.HighBox, f.GateBox }, out f.LowPlaced);
            Box(new Rect(f.Low.At.x - 0.5f, f.Low.At.y + 1f, 1f, 4f), Axis);
            if (f.LowPlaced) Text(new Rect(f.LowBox.x, f.LowBox.y, lw + 2f, lh), f.Low.Text, Axis, _text);
        }

        // last price: dotted line and the tag on the axis
        var lastColour = f.LastGreen ? Green : Red;
        for (float x = p.x; x < p.xMax; x += 4f) Box(new Rect(x, f.LastY, 2f, 1f), lastColour);
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

        // 4. the truck, always on top: a faint line down to the time axis, the dot, its heading, YOU
        Box(new Rect(f.You.x, f.You.y, 1f, p.yMax - f.You.y), new Color(Truck.r, Truck.g, Truck.b, 0.35f));
        Line(f.You, tickEnd, 2f, Truck);
        Box(new Rect(f.You.x - 4f, f.You.y - 4f, 8f, 8f), Truck);
        Text(f.YouBox, youWord, Truck, _text);
        GUI.color = old;
    }

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
