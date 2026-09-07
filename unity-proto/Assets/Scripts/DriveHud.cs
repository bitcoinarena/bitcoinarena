using UnityEngine;

/// <summary>
/// Heads-up display.
///
/// The BTC price is the headline: it is the thing the whole battlefield is
/// made of, so it sits centred at the top at a size you can read from arm's
/// length on a phone. Everything else is diagnostic and deliberately smaller.
/// </summary>
public class DriveHud : MonoBehaviour
{
    public TruckController truck;
    public MarketFeed market;
    public Battlefield field;
    [Tooltip("Developer readout, top left. OFF by default: it sits exactly " +
             "where the block clock goes and is drawn after it, so it was " +
             "hiding it. F1 toggles it.")]
    public bool showDiagnostics = false;
    public ModelStreamer streamer;
    public TruckHealth health;
    public WastedSequence wasted;
    public DeliveryGate gate;
    public CargoBay bay;
    public LoadoutPanel loadout;
    public BlockClock block;
    public Blwp.StrikeTheatre strike;
    int _saidStrike = -1, _strikeSeen = -1;
    float _strikeAt = -99f;
    public RunScore runScore;

    GUIStyle _price, _sub, _small;
    Texture2D _flat;

    static readonly Color Up = new Color(0.30f, 0.88f, 0.48f);
    static readonly Color Down = new Color(1f, 0.42f, 0.42f);

    void Awake()
    {
        _flat = new Texture2D(1, 1); _flat.SetPixel(0, 0, Color.white); _flat.Apply();
    }

    /// <summary>
    /// The small font size, as arithmetic rather than as a GUIStyle.
    ///
    /// The panel geometry is derived from it, and GUI.skin only exists inside
    /// OnGUI - so anything that computes a layout by reading _small.fontSize
    /// throws the moment it is called from outside a GUI pass, a test
    /// included.
    /// </summary>
    static int SmallFont(int w, int h) =>
        Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.032f, 13f, 20f));

    void Styles()
    {
        int min = Mathf.Min(Screen.width, Screen.height);
        if (_price == null)
        {
            _price = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold };
            _sub = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter };
            _small = new GUIStyle(GUI.skin.label);
        }
        _price.fontSize = Mathf.RoundToInt(min * 0.13f);
        _sub.fontSize = Mathf.RoundToInt(min * 0.045f);
        _small.fontSize = SmallFont(Screen.width, Screen.height);
        _small.normal.textColor = Color.white;
    }

    /// <summary>
    /// Where the diagnostics panel sits. Shared with the health bar, which is
    /// parked directly under it - computing the same box twice would drift
    /// apart the first time a line is added to the panel.
    /// </summary>
    public Rect DiagnosticsBox(int w, int h)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        float lh = SmallFont(w, h) * 1.45f;
        int lines = 9 + (market != null ? 2 : 0);
        return new Rect(pad, pad, Mathf.Min(320f, w * 0.34f), lh * lines + pad);
    }

    /// <summary>Drawn twice with an offset: the sky and the dirt are both bright.</summary>
    void Shadowed(Rect r, string text, GUIStyle style, Color colour)
    {
        var prev = style.normal.textColor;
        style.normal.textColor = new Color(0f, 0f, 0f, 0.55f);
        GUI.Label(new Rect(r.x + 2, r.y + 3, r.width, r.height), text, style);
        style.normal.textColor = colour;
        GUI.Label(r, text, style);
        style.normal.textColor = prev;
    }

    /// <summary>
    /// What is aboard and what has been banked, plus the flash on arrival.
    /// </summary>
    void DrawManifest(int w, int h)
    {
        if (gate == null || bay == null) return;

        // Bottom right and large. This is the score: it is the one number the
        // player is playing for, and it was a small grey line in a corner.
        float pad = Mathf.Max(10f, h * 0.025f);
        int min = Mathf.Min(w, h);

        var score = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.LowerRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.075f, 30f, 74f)),
        };
        var under = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.LowerRight,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.030f, 15f, 26f)),
        };

        // The full width, not 60% of it.
        //
        // These are right-aligned labels, so a box narrower than the text
        // clips it on the LEFT - which is why a narrow window showed "CORE ·
        // best 370" with the S cut off. Anchoring to the screen edge lets a
        // long line run leftwards as far as it needs.
        var manifest = ManifestBox(w, h);
        float width = manifest.width;
        float x = manifest.x;

        // ABOVE the driving pads, measured off the pads themselves rather than
        // guessed at: throttle and brake are stacked in the bottom right corner
        // and the score was sitting across them.
        float bottom = manifest.yMax;

        // Banked is deliberately its own size: bigger than the small print,
        // smaller than the pending figure. It is the number that survives.
        var banked = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.LowerRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.042f, 20f, 40f)),
        };

        // AND IN PRACTICE TOO, for the reason the danger meter carries: the
        // truck is invulnerable in practice, `RunScore.Running` is false while
        // it is, and the score line then showed the LAST run's number - zero
        // on a first drive. Photographed on the daily at 1024x768: the core's
        // own readout said tick 824 and DANGER read x1.00 while SCORE read 0,
        // and the core's `runScore` on the same drive returns 432 at ten
        // seconds and 642 by the time the truck is at the far end.
        bool live = runScore != null && (runScore.Running || Blwp.PracticeMode.On);
        int pending = runScore == null ? 0 : (live ? runScore.Projected : runScore.LastScore);

        // Stacked bottom-up so adding a row never silently overlaps the one
        // below it - the earlier version positioned every row off `bottom`
        // with hand-tuned multiples and drifted apart the moment one changed.
        float y = bottom;
        Rect Row(float lineHeight)
        {
            y -= lineHeight;
            return new Rect(x, y, width, lineHeight);
        }

        // AND THE TYPE SHRINKS TO THE BOX, because the box can no longer be
        // the whole screen. These lines are right-aligned, so anything wider
        // than the box is cut off on the LEFT - photographed at 733x293 as
        // "586 sat" where "CARGO 5 parcels - 2,795 sat" was meant. Measured at
        // the shapes this is checked at, the free strip beside the left column
        // is 143 to 279 px and the longest line wants more at full size.
        //
        // The same trick the price already uses on its own gap, applied to the
        // group so the five rows keep their relative sizes. Floors at 10 px:
        // below that it is not a number anybody reads, and the right answer
        // would be to say less rather than to say it smaller.
        {
            string longest = bay != null && bay.IsLoaded
                ? $"CARGO  {bay.Count} parcels  ·  {bay.FeeCarried:N0} sat" : "CARGO  empty";
            string tailNow = runScore == null
                ? $"{gate.Runs} runs delivered"
                : $"best {runScore.Best:N0}  ·  {gate.Runs} runs  ·  {gate.SatsDelivered:N0} sat";
            float widest = Mathf.Max(under.CalcSize(new GUIContent(longest)).x,
                                     under.CalcSize(new GUIContent(tailNow)).x);
            widest = Mathf.Max(widest, banked.CalcSize(new GUIContent("BANKED  000,000")).x);
            widest = Mathf.Max(widest, score.CalcSize(new GUIContent("SCORE  000,000")).x);
            if (widest > width && widest > 1f)
            {
                float k = width / widest;
                score.fontSize = Mathf.Max(10, Mathf.FloorToInt(score.fontSize * k));
                under.fontSize = Mathf.Max(10, Mathf.FloorToInt(under.fontSize * k));
                banked.fontSize = Mathf.Max(10, Mathf.FloorToInt(banked.fontSize * k));
            }
        }

        string tail = runScore == null
            ? $"{gate.Runs} runs delivered"
            : $"best {runScore.Best:N0}  ·  {gate.Runs} runs  ·  {gate.SatsDelivered:N0} sat";
        Shadowed(Row(under.fontSize * 1.5f), tail, under, new Color(1f, 1f, 1f, 0.7f));

        // The condition, in small type, directly under the two figures it
        // explains. Above them it read as a heading for the whole block; the
        // sentence is about the top number only.
        string caption = runScore == null ? ""
            : live ? "yours only if you reach the drop-off" : "last run";
        Shadowed(Row(under.fontSize * 1.5f), caption, under,
                 live ? new Color(1f, 0.82f, 0.30f, 0.8f) : new Color(1f, 1f, 1f, 0.5f));

        // BANKED: what is actually yours. Green, and it never goes down.
        if (runScore != null)
            Shadowed(Row(banked.fontSize * 1.3f), $"BANKED  {runScore.Total:N0}", banked, Up);

        // SCORE: what the current run would add. Amber, because a wreck takes
        // all of it - the colour is the warning, the line beneath says why.
        var tint = live ? new Color(1f, 0.82f, 0.30f) : new Color(1f, 1f, 1f, 0.45f);
        if (live && runScore.Projected <= 0) tint = new Color(1f, 0.45f, 0.40f);
        Shadowed(Row(score.fontSize * 1.25f), $"SCORE  {pending:N0}", score, tint);

        Shadowed(Row(under.fontSize * 1.5f), bay.IsLoaded
                     ? $"CARGO  {bay.Count} parcels  ·  {bay.FeeCarried:N0} sat"
                     : "CARGO  empty",
                 under, bay.IsLoaded ? Color.white : new Color(1f, 1f, 1f, 0.6f));

        DrawArrivalCard(w, h);
        DrawSendOff(w, h);
        DrawPractice(w, h);
        DrawSettings(w, h);
        DrawDebug(w, h);
    }

    /// <summary>
    /// The practice switch, and the state it is in.
    ///
    /// It is drawn rather than hidden behind a key because a run that took no
    /// damage has to LOOK different from one that survived - otherwise the two
    /// are indistinguishable on a screenshot, and the first thing anyone does
    /// with a build is send a screenshot.
    ///
    /// On by default in this build: it exists to be driven and judged, not
    /// survived.
    /// </summary>
    void DrawPractice(int w, int h)
    {
        float pad = Mathf.Max(10f, h * 0.025f);
        int min = Mathf.Min(w, h);
        // Wide enough for the subtitle to sit on ONE line. At 30% of a phone's
        // width the longer of the two captions wrapped and the second line was
        // clipped off by the box, so the switch read "nothing can hit you · tap"
        // with no idea what to tap.
        float bw = Mathf.Min(w * 0.52f, 300f);
        float bh = Mathf.Max(42f, min * 0.070f);

        // Under the block clock, on the left, clear of the driving pads and of
        // the score column on the right.
        var box = PracticeBox(w, h);

        bool on = Blwp.PracticeMode.On;
        var tint = on ? new Color(0.45f, 0.75f, 1f) : new Color(1f, 0.55f, 0.30f);

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.72f);
        GUI.DrawTexture(box, _flat);
        GUI.color = new Color(tint.r, tint.g, tint.b, 0.75f);
        GUI.DrawTexture(new Rect(box.x, box.y, 3f, box.height), _flat);
        GUI.color = Color.white;

        var label = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleLeft,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.030f, 13f, 22f)),
        };
        var sub = new GUIStyle(_small) { alignment = TextAnchor.MiddleLeft };

        var text = new Rect(box.x + 12f, box.y + 2f, box.width - 16f, box.height * 0.52f);
        Shadowed(text, on ? "PRACTICE  ·  ON" : "PRACTICE  ·  OFF", label, tint);
        Shadowed(new Rect(box.x + 12f, box.y + box.height * 0.48f, box.width - 16f, box.height * 0.46f),
                 on ? "no damage  ·  tap to arm" : "live fire  ·  tap for practice",
                 sub, new Color(1f, 1f, 1f, 0.7f));

        if (GUI.Button(box, GUIContent.none, GUIStyle.none)) Blwp.PracticeMode.Toggle();

        // THE SIM SWITCH, under PRACTICE and only while PRACTICE is on. It is
        // a rehearsal control: a player who wants to see what a liquidation
        // does should not have to wait ninety seconds for the books to go
        // quiet, and should not be able to reach for it in live fire.
        //
        // It fires the CORE's liquidation - `Bootstrap.FireSimulated`, the one
        // the silent-market clock already calls - so the crater, the mushroom,
        // the fallout and the hull wipe are the core's, not a picture built
        // here. There is no second strike and no Unity crater.
        if (!on) return;

        var simBox = SimBox(w, h);
        bool sim = Bootstrap.SimForced;
        var simTint = sim ? new Color(1f, 0.72f, 0.25f) : new Color(0.65f, 0.70f, 0.78f);

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.72f);
        GUI.DrawTexture(simBox, _flat);
        GUI.color = new Color(simTint.r, simTint.g, simTint.b, 0.75f);
        GUI.DrawTexture(new Rect(simBox.x, simBox.y, 3f, simBox.height), _flat);
        GUI.color = Color.white;

        Shadowed(new Rect(simBox.x + 12f, simBox.y + 1f, simBox.width - 16f, simBox.height * 0.55f),
                 sim ? "SIM  ·  ON" : "SIM  ·  OFF", label, simTint);
        Shadowed(new Rect(simBox.x + 12f, simBox.y + simBox.height * 0.50f,
                          simBox.width - 16f, simBox.height * 0.46f),
                 sim ? "firing liquidations  ·  tap to stop"
                     : "tap to fire liquidations",
                 sub, new Color(1f, 1f, 1f, 0.7f));

        if (GUI.Button(simBox, GUIContent.none, GUIStyle.none)) Bootstrap.ToggleSim();
    }

    /// <summary>
    /// Sound and debug, top right.
    ///
    /// Small and out of the way: neither is reached for mid-run, and the
    /// corner they sit in is the only one not already carrying the block
    /// clock, the score or a driving pad.
    /// </summary>
    void DrawSettings(int w, int h)
    {
        IconButton(TouchPad.RectFor(TouchPad.Pad.Sound, w, h), Icon.Speaker,
                   GameSettings.Sound, GameSettings.ToggleSound);
        IconButton(TouchPad.RectFor(TouchPad.Pad.Debug, w, h), Icon.Bars,
                   GameSettings.Debug, GameSettings.ToggleDebug);
    }

    enum Icon { Speaker, Bars }

    /// <summary>
    /// A settings control as a drawn glyph rather than a word.
    ///
    /// DRAWN, not typed: an emoji or a box-drawing character depends on
    /// whatever font the player's browser hands Unity, and a missing glyph is
    /// a blank square where a control used to be. These are rectangles from
    /// the same white texture everything else in this file uses, so they look
    /// the same in every build.
    ///
    /// The state is in the colour and in the slash, not in a caption: lit blue
    /// is on, grey is off, and a muted speaker carries a bar across it.
    /// </summary>
    void IconButton(Rect r, Icon icon, bool on, System.Action onClick)
    {
        GUI.color = new Color(0.02f, 0.03f, 0.05f, on ? 0.78f : 0.55f);
        GUI.DrawTexture(r, _flat);

        var tint = on ? new Color(0.62f, 0.85f, 1f, 0.95f) : new Color(1f, 1f, 1f, 0.45f);
        GUI.color = tint;

        float u = r.height * 0.12f;                       // the glyph's unit
        float cx = r.x + r.width * 0.5f, cy = r.y + r.height * 0.5f;

        if (icon == Icon.Speaker)
        {
            // A box and a cone, built out of three rectangles: the body, and
            // two steps that widen away from it.
            GUI.DrawTexture(new Rect(cx - u * 2.2f, cy - u, u * 1.2f, u * 2f), _flat);
            GUI.DrawTexture(new Rect(cx - u * 1.0f, cy - u * 1.6f, u * 0.9f, u * 3.2f), _flat);
            GUI.DrawTexture(new Rect(cx - u * 0.1f, cy - u * 2.2f, u * 0.9f, u * 4.4f), _flat);
            // and the bar that says it is off
            if (!on)
                GUI.DrawTexture(new Rect(cx - u * 2.6f, cy - u * 0.25f, u * 5.2f, u * 0.5f), _flat);
        }
        else
        {
            // Three bars: a readout, which is what the debug panel is.
            for (int i = -1; i <= 1; i++)
                GUI.DrawTexture(new Rect(cx - u * 2.2f, cy + i * u * 1.4f - u * 0.3f,
                                         u * (i == 1 ? 2.8f : 4.4f), u * 0.6f), _flat);
        }

        GUI.color = Color.white;
        if (GUI.Button(r, GUIContent.none, GUIStyle.none)) onClick();
    }

    void Button(Rect r, string label, bool on, System.Action onClick)
    {
        GUI.color = new Color(0.02f, 0.03f, 0.05f, on ? 0.78f : 0.55f);
        GUI.DrawTexture(r, _flat);
        GUI.color = on ? new Color(0.45f, 0.75f, 1f, 0.85f) : new Color(1f, 1f, 1f, 0.35f);
        GUI.DrawTexture(new Rect(r.x, r.y, r.width, 2f), _flat);
        GUI.color = Color.white;

        var st = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(r.height * 0.42f, 10f, 18f)),
        };
        Shadowed(r, label, st, on ? new Color(0.75f, 0.9f, 1f) : new Color(1f, 1f, 1f, 0.6f));
        if (GUI.Button(r, GUIContent.none, GUIStyle.none)) onClick();
    }

    /// <summary>
    /// What the core actually thinks is happening.
    ///
    /// Every fault in this build so far was invisible until it had a number
    /// on it: a truck riding half a metre high, wheels sunk into the road by
    /// the depth of the tarmac, a steering model out by a factor of four. The
    /// person best placed to catch the next one is whoever is driving, so the
    /// numbers go where they can see them.
    /// </summary>
    void DrawDebug(int w, int h)
    {
        if (!GameSettings.Debug) return;

        var core = Object.FindFirstObjectByType<Blwp.CoreDrivenTruck>();
        _fps = Mathf.Lerp(_fps, 1f / Mathf.Max(0.0001f, Time.unscaledDeltaTime), 0.06f);

        var lines = new System.Collections.Generic.List<string>
        {
            $"fps {_fps:0}",
            core != null && core.Driving ? "core DRIVING" : "PhysX driving",
        };

        if (core != null && core.Driving)
        {
            float ONE = Blwp.BlwpCore.ONE;
            var st = Blwp.BlwpCore.State;
            lines.Add($"tick {Blwp.BlwpCore.Tick}");
            lines.Add($"speed {Blwp.BlwpCore.TruckSpeed:0.0} m/s   {Blwp.BlwpCore.TruckSpeed * 3.6f:0} km/h");
            lines.Add($"pos {st[Blwp.Layout.O_TRUCK + Blwp.Layout.T_X] / ONE:0.0}, " +
                      $"{st[Blwp.Layout.O_TRUCK + Blwp.Layout.T_Z] / ONE:0.0}");
            lines.Add($"heading {Blwp.BlwpCore.TruckHeading:0}   wheel {Blwp.BlwpCore.TruckSteerDegrees:0.0}");
            lines.Add($"surface {core.LastSurface:0.00} m   grade {core.LastGrade:0.000} " +
                      $"({Mathf.Atan(core.LastGrade) * Mathf.Rad2Deg:0.0} deg)");
            lines.Add($"practice {(Blwp.PracticeMode.On ? "on" : "off")} ({Blwp.PracticeMode.Source})");
        }

        var style = new GUIStyle(_small) { alignment = TextAnchor.MiddleLeft };
        float lh = Mathf.Max(14f, h * 0.020f);
        var box = DebugPanelBox(w, h, lines.Count);
        if (box.height <= 0f) return;      // no room for it and the score both

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.72f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;
        for (int i = 0; i < lines.Count; i++)
            Shadowed(new Rect(box.x + 10f, box.y + lh * 0.3f + i * lh, box.width - 14f, lh),
                     lines[i], style, new Color(0.7f, 0.95f, 0.8f));
    }

    float _fps = 60f;

    /// <summary>How tall the condition bar is. Shared, so nothing lands on it.</summary>
    float HealthBoxHeight(int w, int h) => HealthBox(w, h).height;

    /// <summary>
    /// Time left in the block, directly under the price.
    ///
    /// The clock was a line in the top-left panel among five others, and it
    /// counted down for two minutes and then did nothing - so it read as
    /// decoration, which it now is not: the block closing ends the run. A
    /// deadline that costs you the load has to be somewhere you cannot avoid
    /// seeing, and it goes red and pulses in the last thirty seconds.
    /// </summary>
    /// <summary>
    /// Which exchanges the liquidations come off, and whether each is talking.
    ///
    /// Named always, not only when broken. A feed that is silent for a whole
    /// session looks exactly like a quiet market from the driving seat, and
    /// that is what happened: Binance futures accepted the connection and never
    /// sent a frame while the price ticked and the HUD said "live".
    /// </summary>
    string Venues()
    {
        if (market == null || market.Sources.Count == 0) return "no liq feed";
        var sb = new System.Text.StringBuilder("liq ");
        for (int i = 0; i < market.Sources.Count; i++)
        {
            var v = market.Sources[i];
            if (i > 0) sb.Append(' ');
            sb.Append(v.Name).Append(v.Status == "live" ? "" : "!");
            // Forced orders anywhere, then BTC ones. A venue that is clearing
            // out other books is alive even while BTC is quiet.
            if (v.Forced > 0) sb.Append('/').Append(v.Forced);
            if (v.Accepted > 0) sb.Append('×').Append(v.Accepted);
        }
        return sb.ToString();
    }

    /// <summary>
    /// What was just liquidated, SUMMARISED.
    ///
    /// Twenty forced orders can land in one tick and a list of twenty lines is
    /// unreadable from a moving truck. One line: the total, and which exchanges
    /// it came off. Picture only - the core is handed each size on its own and
    /// decides the crater from the largest, which this does not touch.
    /// </summary>
    void DrawLiquidations(int w, int h, float y)
    {
        // GATED ON THE CORE'S STRIKE, not on the feed's list, and both halves
        // of that were wrong in the first cut of this.
        //
        // A SIMULATED strike never enters `market.Liquidations` at all - the
        // clock hands its size straight to `BlwpCore.Liquidation` - so gating
        // on that list left the HUD silent about a crater the core had just
        // dug. And the list holds an order for ninety seconds, so the line
        // also stopped fading: it stood for as long as anything was in the
        // window, naming a strike a minute gone.
        // ONLY WHILE THE CLOUD IS UP. the owner, 17:50: the line should appear
        // with the mushroom, not before it. It ran on a timer of its own -
        // eight seconds from the strike serial - so it could be on screen
        // while there was nothing to see, and gone while the cloud still
        // stood. The theatre publishes the cap's position for exactly as long
        // as a cloud is standing, so that is the same clock the player's eye
        // is on.
        if (!Blwp.BlwpCore.Available) return;
        if (Blwp.BlwpCore.StrikeCount <= 0) return;
        if (!Blwp.StrikeTheatre.CapCentre.HasValue) return;

        // WHAT THE FEED SAW, which is not what ran. Kept only to say so in the
        // log: this summed every forced order of the last eight seconds and
        // listed every exchange among them, while the core keeps ONE - the
        // largest still pending - and digs one crater from it. The line named
        // orders the core had already thrown away, and named their exchanges
        // beside the one that actually landed.
        double usd = 0; int n = 0;
        var seen = new System.Collections.Generic.List<string>();
        if (market != null)
            foreach (var l in market.Liquidations)
            {
                if (l.Age > 8f) continue;
                usd += l.UsdValue; n++;
                string v = l.Venue ?? "?";
                if (!seen.Contains(v)) seen.Add(v);
            }

        // WHAT THE CORE TOOK. The size is the core's own `K_LOAD`, in millions,
        // read back out of the state it dug the crater from; the exchange is
        // the one carried by the liquidation the latch was holding when the
        // strike serial moved, and that latch follows the core's rule - largest
        // wins, first of a tie, compared in the core's units.
        float load = Blwp.BlwpCore.Available ? Blwp.BlwpCore.StrikeLoad : 0f;
        string venue = strike != null ? strike.ArmedVenue : null;
        if (load <= 0f) return;

        // A REAL FORCED ORDER IS OFTEN SMALL. Most of what the live books
        // throw off is hundreds of dollars, and the first cut of this printed
        // every one of them as "$0k" because it only knew millions and
        // thousands. Measured on the running feed: two strikes in a row read
        // "$0k" and "$1k".
        double dollars = load * 1e6;
        string money = dollars >= 1e6 ? $"${dollars / 1e6:0.0}M"
                     : dollars >= 1e3 ? $"${dollars / 1e3:0.0}k"
                                      : $"${dollars:0}";
        string line = $"LIQUIDATED  {money}  ·  {venue ?? "simulated"}";

        if (Blwp.BlwpCore.StrikeCount != _saidStrike)
        {
            _saidStrike = Blwp.BlwpCore.StrikeCount;
            string was = usd >= 1e6 ? $"${usd / 1e6:0.0}M"
                       : usd >= 1e3 ? $"${usd / 1e3:0.0}k" : $"${usd:0}";
            Debug.Log($"[hud] strike {_saidStrike}: the feed's summary said "
                      + $"\"{was} · {n} order(s) · {string.Join(" ", seen)}\"; "
                      + $"the core says \"{line}\"");
        }
        Shadowed(LiquidationBox(w, h), line, _sub, new Color(1f, 0.72f, 0.25f));
    }

    void DrawBlockTimer(int w, int h, float y)
    {
        if (block == null || block.Remaining <= 0f) return;

        int left = Mathf.CeilToInt(block.Remaining);
        bool late = left <= 30;

        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 22f, 46f)),
        };

        var colour = late
            ? Color.Lerp(new Color(1f, 0.45f, 0.35f), new Color(1f, 0.2f, 0.15f),
                         0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 6f))
            : new Color(1f, 0.86f, 0.35f);

        // In the gap between the columns, like the price above it: full width
        // and centred put "BLOCK 965,829 · 2:06" straight across the practice
        // switch on a phone.
        var head = HeadlineBox(w, h);
        Shadowed(new Rect(head.x, y, head.width, style.fontSize * 1.35f),
                 $"BLOCK {block.Height:N0}   ·   {left / 60}:{left % 60:00}", style, colour);

        var sub = new GUIStyle(_small) { alignment = TextAnchor.UpperCenter };
        Shadowed(new Rect(head.x, y + style.fontSize * 1.2f, head.width, _small.fontSize * 1.6f),
                 late ? "DELIVER BEFORE THE BLOCK IS MINED — OR LOSE THE LOAD"
                      : "the block is the round · arrive before it closes",
                 sub, new Color(1f, 1f, 1f, late ? 0.95f : 0.6f));
    }

    /// <summary>
    /// The send-off, on rolling out of the bay.
    ///
    /// The arrival card tells the player what a run was worth; without a
    /// counterpart at the start, the run simply begins with the panel
    /// vanishing. This names the freight in the same words the arrival uses -
    /// sats, to the miners - so the two ends of a run are visibly the same
    /// errand rather than two unrelated screens.
    /// </summary>
    /// <summary>How long the send-off card stands after roll-out.</summary>
    public const float SendOffHold = 3.4f;

    /// <summary>Is the send-off card on screen this frame?</summary>
    public bool SendOffShowing
    {
        get
        {
            if (loadout == null) return false;
            float since = Time.unscaledTime - loadout.ConfirmedAt;
            return since >= 0f && since < SendOffHold;
        }
    }

    /// <summary>Is the arrival card on screen this frame?</summary>
    public bool ArrivalShowing
    {
        get
        {
            if (gate == null || ArrivalIsHiddenBy(SendOffShowing)) return false;
            const float Hold = 5f;
            bool missed = Time.unscaledTime - gate.MissedAt < Hold;
            return missed || gate.SinceDelivery < Hold;
        }
    }

    /// <summary>
    /// THE ARRIVAL CARD YIELDS TO THE SEND-OFF.
    ///
    /// The two cards run on independent clocks - 3.4 s from roll-out, 5 s from
    /// a delivery or a miss - so nothing stopped both from being up: deliver,
    /// then confirm the next load inside five seconds, and both are drawn. They
    /// sit at 18% and 20% down the screen and are taller than that gap, so they
    /// would be laid on each other.
    ///
    /// Gated rather than moved, because two cards side by side on a phone are
    /// two cards nobody can read - and of the pair, the one about the run that
    /// has ENDED is the one to drop when a new run is starting.
    ///
    /// Static so the rule can be asserted without a scene and without waiting
    /// five seconds for a clock.
    /// </summary>
    public static bool ArrivalIsHiddenBy(bool sendOffShowing) => sendOffShowing;

    void DrawSendOff(int w, int h)
    {
        if (loadout == null) return;
        const float Hold = SendOffHold;
        float since = Time.unscaledTime - loadout.ConfirmedAt;
        if (since < 0f || since >= Hold) return;

        float k = Mathf.Clamp01((Hold - since) / (Hold * 0.3f));
        int min = Mathf.Min(w, h);

        int head = Mathf.RoundToInt(CardHead(w, h, false));
        var big = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold, fontSize = head,
        };
        var sub = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(head * 0.78f),
        };

        float padY = head * 0.5f;
        var card = SendOffBox(w, h);

        // AND THE WORDS FIT THE CARD. The card stands in the gap now, which is
        // 371 px on a phone in landscape and not the 92% of the screen it used
        // to take, so a headline sized for the old width would be cut off at
        // both ends by the centring. Same shrink the price and the score
        // column use, floored at 11 px.
        FitInto(big, $"DELIVERING  {loadout.ConfirmedSats:N0} sat  TO THE MINERS",
                card.width - 16f, 11);
        FitInto(sub, "GOOD LUCK!", card.width - 16f, 10);

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.8f * k);
        GUI.DrawTexture(card, _flat);
        GUI.color = new Color(1f, 0.86f, 0.35f, 0.5f * k);
        GUI.DrawTexture(new Rect(card.x, card.y, card.width, 2f), _flat);
        GUI.DrawTexture(new Rect(card.x, card.yMax - 2f, card.width, 2f), _flat);
        GUI.color = Color.white;

        big.normal.textColor = new Color(1f, 0.86f, 0.35f, k);
        GUI.Label(new Rect(card.x, card.y + padY, card.width, head * 1.4f),
                  $"DELIVERING  {loadout.ConfirmedSats:N0} sat  TO THE MINERS", big);

        sub.normal.textColor = new Color(Up.r, Up.g, Up.b, k);
        GUI.Label(new Rect(card.x, card.y + padY + head * 1.3f, card.width, sub.fontSize * 1.4f),
                  "GOOD LUCK!", sub);
    }

    /// <summary>
    /// What just happened, on arrival: the freight delivered, the score earned,
    /// and the arithmetic that produced it.
    ///
    /// The two are DIFFERENT things and the card used to conflate them - it
    /// said "DELIVERED 412", which claims a score was hauled to the gate. What
    /// was hauled is satoshis, to the miner; the score is what the run was
    /// worth for doing it. So the headline names the freight and the score sits
    /// underneath with its working.
    ///
    /// It is also on screen for five seconds rather than under three. The
    /// breakdown is three factors and a product, which nobody reads in a
    /// second and a half, and the loading bay used to arrive on top of it.
    /// </summary>
    void DrawArrivalCard(int w, int h)
    {
        if (ArrivalIsHiddenBy(SendOffShowing)) return;

        const float Hold = 5f;
        bool missed = Time.unscaledTime - gate.MissedAt < Hold;
        float since = missed ? Time.unscaledTime - gate.MissedAt : gate.SinceDelivery;
        if (!missed && gate.SinceDelivery >= Hold) return;

        // Full strength for most of it, then fade. A linear fade from the first
        // frame spends the whole time getting harder to read.
        float k = Mathf.Clamp01((Hold - since) / (Hold * 0.28f));
        int min = Mathf.Min(w, h);

        // Sized off the WIDTH, not the smaller dimension.
        //
        // On a wide window min is the height, so the headline was scaled for a
        // square and ran off both sides - "…to the miner" with the s missing.
        // It is also drawn on a dark plate: the card lands over sky and
        // explosions, and pale text on a fireball is unreadable however large.
        int head = Mathf.RoundToInt(CardHead(w, h, true));
        var big = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold, fontSize = head,
        };
        var mid = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(head * 0.82f),
        };
        var line = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter,
            fontSize = Mathf.RoundToInt(head * 0.48f),
        };

        float padY = head * 0.55f;
        var card = ArrivalBox(w, h);

        // The same fit as the send-off, on the longest line each style draws.
        FitInto(big, "BLOCK MINED WITHOUT YOU", card.width - 16f, 11);
        FitInto(mid, "SCORE  +000,000", card.width - 16f, 10);
        FitInto(line, "those fees go to the miners — the score is what the run pays you",
                card.width - 16f, 9);

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.82f * k);
        GUI.DrawTexture(card, _flat);
        GUI.color = new Color(1f, 0.86f, 0.35f, 0.5f * k);
        GUI.DrawTexture(new Rect(card.x, card.y, card.width, 2f), _flat);
        GUI.DrawTexture(new Rect(card.x, card.yMax - 2f, card.width, 2f), _flat);
        GUI.color = Color.white;

        float y = card.y + padY;

        big.normal.textColor = missed ? new Color(1f, 0.42f, 0.36f, k)
                                      : new Color(Up.r, Up.g, Up.b, k);
        GUI.Label(new Rect(card.x, y, card.width, head * 1.5f),
                  missed ? "BLOCK MINED WITHOUT YOU"
                         : $"DELIVERED  {gate.LastRun:N0} sat to the miners", big);
        y += head * 1.35f;

        if (runScore == null) return;

        mid.normal.textColor = new Color(1f, 0.86f, 0.35f, k);
        GUI.Label(new Rect(card.x, y, card.width, mid.fontSize * 1.4f),
                  missed ? "SCORE  0" : $"SCORE  +{runScore.LastScore:N0}", mid);
        y += mid.fontSize * 1.3f;

        // The working, which is the whole point of showing a score at all: it
        // is where the player reads WHY a careful full run scored 40 and a
        // reckless half-empty one scored 700.
        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.92f);
        GUI.Label(new Rect(card.x, y, card.width, line.fontSize * 1.7f),
                  missed ? "the freight never reached the block"
                         : $"load {runScore.LastCargo:0.00}   ×   danger {runScore.LastExposure:0.00}" +
                           $"   ×   speed {runScore.LastTime:0.00}   ×  1000", line);
        y += line.fontSize * 1.7f;

        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.62f);
        GUI.Label(new Rect(card.x, y, card.width, line.fontSize * 1.7f),
                  // NOT "your stake came back". There is no stake in this
                  // game: nobody deposits anything, so nothing returns. That
                  // was multiplayer vocabulary imported into a build that has
                  // no multiplayer, and it described a mechanic the player had
                  // never taken part in. The sats are the FEES of the
                  // transactions being hauled - they belong to the miner, which
                  // is why the headline says delivered to the miners.
                  missed ? "the fees never reached the block — beat the clock next time"
                         : "those fees go to the miners — the score is what the run pays you",
                  line);
    }

    /// <summary>
    /// The block being mined, its clock, and the best blocks so far.
    ///
    /// The clock is what stops a risk-free trickle from being the best play:
    /// a block spent hauling 52 sat is a block that cannot be spent hauling
    /// four thousand, and the board compares blocks rather than lifetimes.
    /// </summary>
    void DrawBlock(int w, int h)
    {
        if (block == null) return;

        float pad = Mathf.Max(10f, h * 0.022f);
        float bw = Mathf.Min(300f, w * 0.24f);
        float lh = SmallFont(w, h) * 1.55f;

        var head = new GUIStyle(_small) { fontStyle = FontStyle.Bold, alignment = TextAnchor.UpperLeft };
        var line = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft };

        // Height depends on whether there is a board yet, so it is measured
        // before anything is drawn.
        int rows = Mathf.Min(5, block.Board.Count);
        float boxH = BlockBoxHeight(w, h);
        var box = new Rect(pad, pad, bw + pad, boxH);

        PanelSkin.Body(box, 0.72f);
        PanelSkin.Border(box, new Color(1f, 0.86f, 0.35f, 0.55f));
        PanelSkin.Corners(box, new Color(1f, 0.86f, 0.35f, 0.8f), 2f);

        float y = pad + lh * BlockRows[0];
        Shadowed(new Rect(pad * 1.5f, y, bw, lh), $"BLOCK #{block.Height}", head,
                 new Color(1f, 0.86f, 0.35f));
        y += lh * BlockRows[1];

        // the clock, running out
        var track = new Rect(pad * 1.5f, y, bw, lh * 0.42f);
        GUI.color = new Color(1f, 1f, 1f, 0.16f);
        GUI.DrawTexture(track, _flat);
        GUI.color = block.Fraction < 0.2f
            ? new Color(1f, 0.35f, 0.28f) : new Color(0.42f, 0.86f, 1f);
        GUI.DrawTexture(new Rect(track.x + 1f, track.y + 1f,
                                 Mathf.Max(0f, (track.width - 2f) * block.Fraction),
                                 track.height - 2f), _flat);
        GUI.color = Color.white;
        y += lh * BlockRows[2];

        int secs = Mathf.CeilToInt(block.Remaining);
        Shadowed(new Rect(pad * 1.5f, y, bw, lh), $"{secs / 60}:{secs % 60:00} left", line,
                 new Color(1f, 1f, 1f, 0.85f));
        y += lh * BlockRows[3];
        Shadowed(new Rect(pad * 1.5f, y, bw, lh),
                 $"in this block: {block.PendingSats:N0} sat  ·  {block.PendingBtc:0.###} BTC",
                 line, Up);
        // `BlockRows[4]` is the pending line's own height - it is counted in
        // the content total but it is not an advance, because the gap to the
        // board is measured from that line's top.
        y += lh * BlockBoardGap;

        if (block.Board.Count == 0) return;

        Shadowed(new Rect(pad * 1.5f, y, bw, lh), "BEST BLOCKS", head, new Color(1f, 1f, 1f, 0.8f));
        y += lh * BlockBoardHead;
        for (int i = 0; i < block.Board.Count && i < 5; i++)
        {
            var b = block.Board[i];
            Shadowed(new Rect(pad * 1.5f, y, bw, lh),
                     $"{i + 1}.  #{b.height}   {b.sats:N0} sat   {b.btc:0.##} BTC",
                     line, i == 0 ? Up : new Color(1f, 1f, 1f, 0.7f));
            y += lh * BlockBoardRow;
        }
    }

    /// <summary>
    /// <summary>
    /// Stars for a heat, 0 to 5. Public and static so the rule can be pinned
    /// without a scene: it decides both how many stars are drawn and whether
    /// the word reads HUNTED, and those two must not be able to disagree.
    /// </summary>
    public static int StarsFor(float heat) =>
        Mathf.Clamp(Mathf.CeilToInt(heat * 5f), 0, 5);

    /// <summary>The word under the stars. Four of five is being hunted.</summary>
    public static string WantedWord(int stars) => stars >= 4 ? "HUNTED" : "WANTED";

    /// <summary>
    /// The wanted level, top right, as stars.
    ///
    /// The risk was set at the loading ramp and then never mentioned again, so
    /// the consequence of a greedy load was invisible the moment it mattered.
    /// Filled stars for the heat, and they pulse while it is high.
    /// </summary>
    void DrawWanted(int w, int h)
    {
        // THE CORE'S WORD, and only the core's.
        //
        // This used to read `bay.Heat` - Unity's own copy of the rule - while
        // the shooting read the core's `S_HEAT`. The two agreed, because the
        // formula is written twice and identically, which is exactly the
        // arrangement that stops being true the first time one side changes.
        // The yard still CHOOSES the number and hands it over at roll-out;
        // from then on the picture reports the word the war is hunting with.
        //
        // The `bay.IsLoaded` gate went with it: an empty bed is heat zero and
        // draws no stars by the same test that hides them at zero, so keeping
        // the bed as a second opinion about whether to show anything bought
        // nothing.
        // AND ONLY WHILE THE RUN IS LIVE. The word survives the round in the
        // core - it is cleared by the next roll-out, not by arriving - and the
        // old `bay.IsLoaded` gate used to hide the stars when the bed emptied
        // on delivery. Without a gate they would hang over the score card of a
        // run that is already settled. Still one source: this is the core's
        // own run state, not a second opinion about the load.
        if (Blwp.BlwpCore.RunState != 0) return;

        float heat = Blwp.BlwpCore.Heat;
        int stars = StarsFor(heat);
        if (stars <= 0) return;

        float pad = Mathf.Max(10f, h * 0.025f);
        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 24f, 46f)),
        };

        // a slow pulse at high heat, so a five star run never settles down
        float pulse = heat > 0.55f
            ? 0.75f + 0.25f * Mathf.Sin(Time.unscaledTime * 5.5f) : 1f;
        var colour = Color.Lerp(new Color(1f, 0.86f, 0.35f), new Color(1f, 0.32f, 0.25f), heat);
        colour.a = pulse;

        // PIPS, DRAWN, not '★' and '☆'.
        //
        // In the 22:17 photo the word WANTED is on screen and the row above it
        // is empty. Asked directly, both fonts a build can end up using report
        // U+2605 present - but `HasCharacter` in the editor answers for the
        // editor's font stack, and a browser has no OS fonts at all and falls
        // back to what Unity embedded. That question cannot be settled from
        // here, so it is removed instead of argued: five squares, filled for
        // earned and outlined for not, from the same white texture the rest of
        // this file draws with. The same reasoning as the settings icons.
        var box = WantedBox(w, h);
        float pip = box.height * 0.62f, step = pip * 1.35f;
        for (int i = 0; i < 5; i++)
        {
            var r = new Rect(box.x + i * step, box.y + (box.height - pip) * 0.5f, pip, pip);
            GUI.color = i < stars ? colour : new Color(colour.r, colour.g, colour.b, colour.a * 0.30f);
            if (i < stars) GUI.DrawTexture(r, _flat);
            else
            {
                float t = Mathf.Max(1f, pip * 0.14f);
                GUI.DrawTexture(new Rect(r.x, r.y, r.width, t), _flat);
                GUI.DrawTexture(new Rect(r.x, r.yMax - t, r.width, t), _flat);
                GUI.DrawTexture(new Rect(r.x, r.y, t, r.height), _flat);
                GUI.DrawTexture(new Rect(r.xMax - t, r.y, t, r.height), _flat);
            }
        }
        GUI.color = Color.white;

        var sub = new GUIStyle(_small) { alignment = TextAnchor.UpperRight };
        Shadowed(new Rect(box.x, box.yMax, box.width, _small.fontSize * 1.6f),
                 WantedWord(stars), sub, colour);
    }

    /// <summary>
    /// Where the exposure meter sits: under the wanted stars, on the right,
    /// at a FIXED offset whether or not the stars are showing.
    ///
    /// The stars come and go with the load. If the meter were stacked on the
    /// stars it would jump half a centimetre every time the heat crossed a
    /// star boundary, which is exactly when the player is looking at it.
    /// Public so a test can assert it never lands on the block board.
    /// </summary>
    /// <summary>
    /// THE TRANSIENT CARDS AND BANNERS, given rects someone can ask for.
    ///
    /// They are the ones the overlap test could not see, and several are the
    /// same shape the price and the wanted row turned out to be: a box the
    /// width of the screen with the text centred in it. A card that is 92% of
    /// the width by construction cannot avoid the left column on a phone, so
    /// it has to be checked rather than assumed - and where it does overlap,
    /// that is a fact about a card that is deliberately in front of the game
    /// for three seconds, not a layout accident. Which of those it is, is a
    /// decision; measuring it is not.
    ///
    /// `DrawFallout` and `DrawWaypoint` are NOT here. They are markers
    /// projected from a world position through the camera - where they land
    /// depends on where the truck is looking, so they have no layout box and a
    /// static rect for them would be a fiction.
    /// </summary>
    public Rect SendOffBox(int w, int h)
    {
        float head = CardHead(w, h, false);
        float sub = Mathf.RoundToInt(head * 0.78f);
        float padY = head * 0.5f;
        return CardIn(w, h, padY * 2f + head * 1.3f + sub * 1.4f);
    }

    /// <summary>
    /// How tall each card's rows actually are, from the same head size the
    /// drawing uses. The box and the drawing had three different formulas for
    /// that number and nothing compared them.
    /// </summary>
    public float CardContentHeight(int w, int h, bool arrival)
    {
        float head = CardHead(w, h, arrival);
        if (arrival)
        {
            float mid = Mathf.RoundToInt(head * 0.52f), line = Mathf.RoundToInt(head * 0.40f);
            return head * 0.55f * 2f + head * 1.35f + mid * 1.3f + line * 3.4f;
        }
        float sub = Mathf.RoundToInt(head * 0.78f);
        return head * 0.5f * 2f + head * 1.3f + sub * 1.4f;
    }

    /// <summary>
    /// Shrinks a style until the given line fits the given width.
    ///
    /// Three places in this file were doing this by hand - the price into its
    /// gap, the score column into its strip, the exposure warning into the
    /// column - and each got it slightly differently. One floor, one loop, one
    /// margin, and a style that cannot go below `floor` because below that the
    /// answer is fewer words rather than smaller ones.
    /// </summary>
    static void FitInto(GUIStyle style, string line, float width, int floor)
    {
        if (width <= 1f || string.IsNullOrEmpty(line)) return;
        for (int pass = 0; pass < 4; pass++)
        {
            float need = style.CalcSize(new GUIContent(line)).x;
            if (need <= width || need <= 1f || style.fontSize <= floor) return;
            style.fontSize = Mathf.Max(floor,
                Mathf.Min(style.fontSize - 1, Mathf.FloorToInt(style.fontSize * width / need)));
        }
    }

    /// <summary>
    /// The headline size on each card, asked in ONE place.
    ///
    /// The box used `clamp(min(w, h) * 0.055, 20, 46)` and the drawing used
    /// `round(min(w * 0.034, min * 0.060))` for the send-off and `0.040 /
    /// 0.070` for the arrival - three formulas for the same number. At
    /// 844x390 the box sized itself for 21.45 and the send-off drew at 23, so
    /// the content was taller than the frame that was meant to hold it. The
    /// block board's fault a fifth time, and the only reason it was not
    /// visible is that the card is up for three seconds.
    /// </summary>
    public static float CardHead(int w, int h, bool arrival)
    {
        int min = Mathf.Min(w, h);
        return Mathf.RoundToInt(arrival ? Mathf.Min(w * 0.040f, min * 0.070f)
                                        : Mathf.Min(w * 0.034f, min * 0.060f));
    }

    /// <summary>
    /// Where a card stands: in the gap between the columns, under the block
    /// clock.
    ///
    /// Both cards were 92% of the screen wide and centred on it, so they
    /// covered the left column by construction - measured at 1024x768, the
    /// send-off ran from x=41 across a condition bar at x=15. A card is a
    /// takeover of the middle of the screen and that is what it is for, but
    /// the middle of the screen is where the driver's numbers are, and a card
    /// that hides the condition bar hides whether he is still alive.
    ///
    /// So it takes the gap, which is the one column with nothing permanent in
    /// it, and stands below the block clock. It is narrower than it was; the
    /// alternative is wider and on top of the numbers.
    /// </summary>
    Rect CardIn(int w, int h, float height)
    {
        float pad = Mathf.Max(10f, h * 0.022f);
        var head = HeadlineBox(w, h);
        if (head.width <= 0f)
        {
            float wide = Mathf.Min(w * 0.92f, 900f);
            return new Rect((w - wide) * 0.5f, h * 0.20f, wide, height);
        }
        return new Rect(head.x, BlockTimerBox(w, h).yMax + pad, head.width, height);
    }

    /// <summary>The arrival card, in the same place and a little taller.</summary>
    public Rect ArrivalBox(int w, int h)
    {
        float head = CardHead(w, h, true);
        float mid = Mathf.RoundToInt(head * 0.52f), line = Mathf.RoundToInt(head * 0.40f);
        float padY = head * 0.55f;
        return CardIn(w, h, padY * 2f + head * 1.35f + mid * 1.3f + line * 3.4f);
    }

    /// <summary>The streaming list, right-hand side, one row per model.</summary>
    public Rect StreamingBox(int w, int h, int items)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        float lh = SmallFont(w, h) * 1.5f;
        float height = lh * (items + 1) + pad;

        // IN THE GAP, UNDER THE BLOCK CLOCK.
        //
        // It used to sit at `w - width - pad, h * 0.30f` - the right-hand side,
        // a third of the way down - which is where the score column and the
        // block clock also are. Photographed: the list was drawn straight
        // across "BLOCK 965 ..." and over SCORE, BANKED and CARGO. The rect
        // test could not see it because the list was only ever checked against
        // the left column and the wanted row.
        //
        // The gap between the columns is the one place on this screen with
        // nothing permanent in it, and a list that retires four seconds after
        // the last model lands is exactly what belongs in a temporary space.
        // Where there is no gap at all - a phone held upright - it keeps its
        // old corner, because there is nowhere better and the alternative is
        // not drawing it.
        var head = HeadlineBox(w, h);
        if (head.width <= 0f)
        {
            float narrow = Mathf.Min(290f, w * 0.34f);
            return new Rect(w - narrow - pad, h * 0.30f, narrow, height);
        }

        float width = Mathf.Min(290f, head.width);
        float top = BlockTimerBox(w, h).yMax + pad;
        return new Rect(head.x, top, width,
                        StreamingLineHeight(w, h, items) * (items + 1) + pad);
    }

    /// <summary>
    /// The pitch of one row in the streaming list.
    ///
    /// TIGHTENED TO THE ROOM RATHER THAN RUNNING OFF THE BOTTOM. Eleven models
    /// at a comfortable pitch is 244 px, and a phone in landscape has 233 px
    /// under the block clock - so the last row was a pixel off the screen at
    /// 844x390 and twenty-one off at 1000x360. Shrinking the pitch keeps every
    /// row visible; dropping rows would hide the model that failed, which is
    /// the one worth seeing.
    ///
    /// It never goes below the font's own size, so rows cannot be drawn into
    /// each other - measured, the tightest of the shapes checked is 17.8 px
    /// against a 13 px font.
    /// </summary>
    public float StreamingLineHeight(int w, int h, int items)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        float roomy = SmallFont(w, h) * 1.5f;
        var head = HeadlineBox(w, h);
        if (head.width <= 0f) return roomy;

        float top = BlockTimerBox(w, h).yMax + pad;
        float room = h - top - pad * 2f;
        if (room <= 0f) return roomy;
        return Mathf.Clamp(room / (items + 1), SmallFont(w, h), roomy);
    }

    /// <summary>
    /// How tall the rows inside a panel actually are. Both panels lay their
    /// lines out at `lh` apart from an inset, and both boxes are built from a
    /// line count - so the two can drift the way the block board's did, where
    /// the border claimed 3.20 lines and the drawing laid out 3.77.
    /// </summary>
    public float DebugPanelContentHeight(int w, int h, int lines)
    {
        float lh = Mathf.Max(14f, h * 0.020f);
        return lh * 0.3f + lines * lh;
    }

    /// <summary>The same for the F1 diagnostics panel, top left.</summary>
    public float DiagnosticsContentHeight(int w, int h, int lines)
    {
        float lh = SmallFont(w, h) * 1.45f;
        return lh * lines;
    }

    /// <summary>
    /// The debug readout, top right, under the debug icon.
    ///
    /// A second panel and not the F1 diagnostics box - that one is top LEFT
    /// and the condition bar already stacks under it. This one is gated on the
    /// debug icon and lands in the corner the score column was pushed into,
    /// so the two have to be measured against each other rather than assumed
    /// apart.
    ///
    /// `lines` is what `DrawDebug` builds: two when the core is not driving,
    /// eight when it is.
    /// </summary>
    public Rect DebugPanelBox(int w, int h, int lines)
    {
        float lh = Mathf.Max(14f, h * 0.020f);
        float bw = Mathf.Min(w * 0.42f, 260f);
        float pad = Mathf.Max(10f, h * 0.025f);
        var box = new Rect(w - bw - pad,
                           TouchPad.RectFor(TouchPad.Pad.Debug, w, h).yMax + lh * 0.6f,
                           bw, lh * lines + lh * 0.6f);

        // AND IT IS NOT DRAWN AT ALL WHERE IT WOULD PUSH THE SCORE OFF THE
        // SCREEN. The score column steps under this panel, and on a 360-tall
        // window there is not room for both: measured, the column ended at
        // y=365 of 360. Of the two, one is eight lines of developer numbers
        // behind a toggle and the other is what the player is playing for, so
        // where they do not both fit the readout goes.
        if (box.yMax + pad * 0.5f + ManifestContentHeight(w, h) > h) return new Rect();
        return box;
    }

    /// <summary>
    /// THE WARNING UNDER THE DANGER METER - "NO SCORE OUT HERE - GET CLOSER TO
    /// THE FIGHTING" - and the row it stands in.
    ///
    /// It was drawn at `box.xMax - min(w * 0.75f, 560f)`: 560 px reaching LEFT
    /// from the meter's right edge, into what used to be empty screen when the
    /// meter lived in the top-right corner. Moving the meter into the left
    /// column left the sentence running backwards across the practice switch
    /// and off the edge - photographed at 733x293, drawn over PRACTICE - ON.
    ///
    /// It is a row of the column now, in the column's own width, and the row
    /// is RESERVED whether or not the warning is showing. The alternative is a
    /// switch that jumps half a centimetre down the screen the moment the
    /// player drives out of the corridor, which is exactly when he is looking
    /// at it. The same reasoning the meter itself carries about the stars.
    /// </summary>
    public Rect ExposureWarningBox(int w, int h)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        var meter = ExposureBox(w, h);
        return new Rect(meter.x, meter.yMax + pad * 0.25f,
                        meter.width, SmallFont(w, h) * 1.5f);
    }

    /// <summary>
    /// The price line drawn in the corner while the loading panel is open.
    ///
    /// It is the ONE piece of the driving HUD that survives into the loadout
    /// screen - everything else returns early - and it is there because the
    /// price is not what the player is reading while choosing freight, but it
    /// should not vanish either. Measured against the panel's own frame rather
    /// than assumed to be clear of it.
    /// </summary>
    public Rect LoadingPriceBox(int w, int h) =>
        new Rect(w * 0.02f, h * 0.012f, w * 0.4f, SmallFont(w, h) * 1.6f);

    /// <summary>
    /// THE SCORE COLUMN - score, banked, cargo and their two lines of small
    /// print - stacked upward off the driving pads.
    ///
    /// It had no rect at all, and two things follow from that. Its box was
    /// `w - pad * 2` wide, the full screen, for the written reason that a
    /// right-aligned label in a narrow box is clipped on the LEFT - true, and
    /// the same shape of mistake as the price, the wanted row and two banners
    /// before it. And it grows UPWARD from the pads with no floor, so on a
    /// short window it runs off the top: photographed at 733x293 with the
    /// CARGO line cut in half by the edge of the screen.
    ///
    /// The left edge is the headline gap's right edge, so a long line still
    /// has somewhere to run without reaching the column on the other side.
    /// </summary>
    public Rect ManifestBox(int w, int h)
    {
        float pad = Mathf.Max(10f, h * 0.025f);
        int min = Mathf.Min(w, h);
        float score = Mathf.Round(Mathf.Clamp(min * 0.075f, 30f, 74f));
        float under = Mathf.Round(Mathf.Clamp(min * 0.030f, 15f, 26f));
        float banked = Mathf.Round(Mathf.Clamp(min * 0.042f, 20f, 40f));

        float height = ManifestContentHeight(w, h);
        float bottom = TouchPad.RectFor(TouchPad.Pad.Up, w, h).y - pad * 0.6f;

        // THE FIRST LINE STAYS ON THE SCREEN. If the stack does not fit above
        // the pads it is pushed DOWN rather than off the top - the pads are
        // touch targets that survive a little overlap, and a line nobody can
        // read does not.
        //
        // The box keeps its FULL height when that happens. The first cut
        // clamped the top and returned `bottom - top`, so the box shrank while
        // the drawing kept stacking upward from the same place - the block
        // board's fault a third time, and the photograph still showed CARGO
        // cut by the top edge. The drawing takes its baseline from `yMax`, so
        // moving the box down moves the stack down with it.
        // BELOW THE SETTINGS ICONS, AND BELOW THE DEBUG READOUT WHEN IT IS UP.
        //
        // On a short window the stack is pushed down off the pads and lands in
        // the top-right corner, which is where the sound and debug buttons
        // live - photographed at 733x293 with BANKED drawn behind them. The
        // debug readout drops into that same corner from the same icon, and
        // measured at 1920x1080 it lay over the column from y=297 to y=483.
        //
        // The readout yields nothing and the column moves, because the readout
        // is developer chrome behind a toggle and SCORE, BANKED and CARGO are
        // what the player is playing for. Same shape as the condition bar
        // stepping under the F1 panel.
        float corner = TouchPad.RectFor(TouchPad.Pad.Debug, w, h).yMax + pad * 0.5f;
        if (GameSettings.Debug)
        {
            var readout = DebugPanelBox(w, h, 8);
            if (readout.height > 0f) corner = readout.yMax + pad * 0.5f;
        }
        float top = Mathf.Max(corner, Mathf.Max(pad, bottom - height));

        // ALWAYS THE STRIP RIGHT OF THE GAP, never the full width.
        //
        // There was a branch here: below the SIM switch there is nothing to
        // the left, so the column could have the whole screen and its long
        // lines would not be clipped. It fired the moment the debug readout
        // pushed the column down, and the column then swallowed the gap and
        // was drawn over the model list - measured at 1920x1080, a box from
        // x=27 across a list at x=371.
        //
        // A permanent layout cannot depend on which transient thing happens to
        // be in the gap at the time. The strip is narrow and the type shrinks
        // to it, which is already how the lines fit.
        var head = HeadlineBox(w, h);
        float left = head.width > 0f ? head.xMax : pad;
        return new Rect(left, top, w - pad - left, height);
    }

    /// <summary>
    /// How tall the score column's five rows actually are: the tail line, the
    /// caption, BANKED, SCORE and CARGO. Shared with the box, so the two
    /// cannot drift.
    /// </summary>
    public float ManifestContentHeight(int w, int h)
    {
        int min = Mathf.Min(w, h);
        float score = Mathf.Round(Mathf.Clamp(min * 0.075f, 30f, 74f));
        float under = Mathf.Round(Mathf.Clamp(min * 0.030f, 15f, 26f));
        float banked = Mathf.Round(Mathf.Clamp(min * 0.042f, 20f, 40f));
        return under * 1.5f * 3f + banked * 1.3f + score * 1.25f;
    }

    /// <summary>
    /// What the streaming list says next to a model.
    ///
    /// IT WAS IN GERMAN, on the driving HUD, in a build whose every other
    /// string is English: "aus Cache", "fehlgeschlagen", "wartet". No test
    /// looked at it - the one German check in this project reads the model
    /// LABELS, which have been English all along - and no photograph had ever
    /// been taken of the HUD with the list up. The frame found it in one look.
    ///
    /// Static so the words can be asserted without a scene.
    /// </summary>
    public static string StreamMark(ModelStreamer.State state, float sizeMb, float progress)
    {
        switch (state)
        {
            case ModelStreamer.State.Loaded:
                // zero means it came from cache, which is worth saying
                return sizeMb > 0.01f ? $"{sizeMb:0.0} MB" : "cached";
            case ModelStreamer.State.Failed:
                return "failed";
            case ModelStreamer.State.Loading:
                return sizeMb > 0.01f
                    ? $"{Mathf.RoundToInt(progress * 100f)} %  {sizeMb:0.0} MB"
                    : $"{Mathf.RoundToInt(progress * 100f)} %";
            default:
                return "waiting";
        }
    }

    /// <summary>
    /// THE HEADLINE STACK, row by row: the price, the per-cent line, the
    /// liquidation line and the block clock.
    ///
    /// Measured from the UNFITTED price size on purpose. The price shrinks
    /// when the gap between the columns is narrow, and the rows underneath it
    /// were placed from the shrunk size - so the ticker, the liquidation line
    /// and the block clock all jumped up the screen the moment the price
    /// gained a digit. The rows are where they are; only the price's own
    /// glyphs change size inside its row.
    ///
    /// Row 0 is the price, 1 the per-cent line, 2 the liquidation line, 3 the
    /// block clock, in the same 1.12 / 1.55 / 2.7 steps the drawing used.
    /// </summary>
    public float HeadlineRowY(int w, int h, int row)
    {
        float price = Mathf.RoundToInt(Mathf.Min(w, h) * 0.13f);
        float sub = Mathf.RoundToInt(Mathf.Min(w, h) * 0.045f);
        float top = h * 0.015f;
        switch (row)
        {
            case 0: return top;
            case 1: return top + price * 1.12f;
            case 2: return top + price * 1.12f + sub * 1.55f;
            default: return top + price * 1.12f + sub * 2.7f;
        }
    }

    /// <summary>
    /// The liquidation line - "LIQUIDATED $12.4M · binance" - third row of the
    /// headline stack, in the gap between the columns like the rest of it.
    /// </summary>
    public Rect LiquidationBox(int w, int h)
    {
        var head = HeadlineBox(w, h);
        // THE ROW'S OWN HEIGHT, which is the distance to the row under it -
        // not the 1.6 line-heights the drawing asked for. Measured at
        // 1920x1080 the rect was 78.4 px tall in a 56.4 px row, so it reached
        // into the block clock below: a box claiming more than it has, which
        // is the block board's fault again in a different corner. One line of
        // the sub font is 49 px, so the room is enough for what is drawn.
        float y = HeadlineRowY(w, h, 2);
        return new Rect(head.x, y, head.width, HeadlineRowY(w, h, 3) - y);
    }

    /// <summary>The block clock under it, fourth row.</summary>
    public Rect BlockTimerBox(int w, int h)
    {
        float font = Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 22f, 46f);
        var head = HeadlineBox(w, h);

        // THE SUB-LINE IS PART OF IT. `DrawBlockTimer` draws "BLOCK 965,853 -
        // 2:23" and then "the block is the round - arrive before it closes"
        // under it at `font * 1.2`, while the box stopped at `font * 1.35` - so
        // the sentence was outside its own rect, and the model list, which is
        // measured to sit below this box, was drawn across it. Photographed on
        // a real 844x390 player. The block board's fault in a fourth place.
        return new Rect(head.x, HeadlineRowY(w, h, 3), head.width,
                        font * 1.2f + SmallFont(w, h) * 1.6f);
    }

    /// <summary>
    /// The IRRADIATED warning, in the gap for the reason UNDER FIRE is.
    ///
    /// It was the fourth `Rect(0, y, w, ...)` with centred text in this file.
    /// The WASTED band is deliberately NOT one of these: it is a dark scrim
    /// drawn the full width behind a word the size of the screen, on a run
    /// that is already over, and covering the HUD is what it is for.
    /// </summary>
    public Rect IrradiatedBox(int w, int h)
    {
        float font = Mathf.Clamp(Mathf.Min(w, h) * 0.045f, 20f, 40f);
        var head = HeadlineBox(w, h);
        return new Rect(head.x, h * 0.30f, head.width, font * 1.6f);
    }

    /// <summary>
    /// The UNDER FIRE banner's text line.
    ///
    /// In the GAP, not across the screen. It was `Rect(0, h * 0.14f, w, ...)`
    /// with the text centred - the price's mistake for the third time - and
    /// measured at 1920x1080 that box lay straight over the condition bar.
    /// The text was centred so it LOOKED fine, which is exactly why it went
    /// unseen: a box that covers the numbers a driver reads is a box that can
    /// cover them the moment anything in it grows or moves.
    /// </summary>
    public Rect UnderFireBox(int w, int h)
    {
        float font = Mathf.RoundToInt(Mathf.Min(w, h) * 0.045f);
        var head = HeadlineBox(w, h);
        return new Rect(head.x, h * 0.14f, head.width, font * 1.5f);
    }

    /// <summary>
    /// The wanted row, top right.
    ///
    /// It used to be `new Rect(0, pad, w - pad, ...)` - the width of the whole
    /// screen, with the text right-aligned inside it. Right-aligned text in a
    /// full-width box looks correct and is the same mistake the price had: the
    /// BOX covers the block board, so nothing can be checked against it and
    /// anything that grows in it reaches across the picture. It is the width
    /// of what it draws now: five pips and the word under them.
    /// </summary>
    public Rect WantedBox(int w, int h)
    {
        float pad = Mathf.Max(10f, h * 0.025f);
        float font = Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 24f, 46f);
        float height = font * 1.4f;
        float pip = height * 0.62f;
        float width = pip * 1.35f * 4f + pip;          // five pips and their gaps
        return new Rect(w - pad - width, pad, width, height);
    }

    /// <summary>
    /// The gap the centred headline is allowed to use.
    ///
    /// The price was drawn into `new Rect(0, y, w, ...)` - the whole screen -
    /// and centred in it. On a desktop that is fine because the columns are a
    /// long way apart; on an iPhone the dollar sign of "$79,810" landed on top
    /// of the block board. Photographed at 22:17.
    ///
    /// Centring inside the GAP instead keeps the headline where a headline
    /// belongs and cannot reach either column, whatever the aspect. The left
    /// edge is the widest thing in the left stack - the practice switch is
    /// wider than the block board - and the right edge is the settings column.
    /// </summary>
    public Rect HeadlineBox(int w, int h)
    {
        // THE LEFT EDGE IS ASKED OF THE BOXES, not recomputed from two of
        // their formulas. It was `max(block, practice)`, and the condition bar
        // is neither: it inherits the diagnostics panel's FIXED 320 px, which
        // is wider than the block board on a 1024-wide window. The banner's
        // box then started 1.6 px inside it - measured, not noticed by eye.
        float pad = Mathf.Max(10f, h * 0.022f);
        float blockRight = pad + Mathf.Min(300f, w * 0.24f) + pad;
        float left = Mathf.Max(Mathf.Max(blockRight, PracticeBox(w, h).xMax),
                               Mathf.Max(HealthBox(w, h).xMax, ExposureBox(w, h).xMax)) + pad;
        // THE RIGHT EDGE IS WHICHEVER RIGHT-HAND THING REACHES FURTHEST IN.
        //
        // It was measured against the settings column alone, and the wanted
        // row is wider than that: five pips and their gaps came 70 px further
        // left than the icons at 1920x1080, so the headline's box ran under
        // them. Both are asked, and the nearer one wins.
        float s = TouchPad.ButtonSize(w, h), m = TouchPad.Margin(w, h);
        float right = Mathf.Min(w - (m + s * 0.7f) - pad, WantedBox(w, h).x - pad);

        // And the debug readout, which is wider than the settings column it
        // hangs from - 260 px against about 60 - so with it up the gap's right
        // edge is ITS left edge. Measured at 1024x768: the readout reached to
        // x=744.8 and the block clock's box ran to 753.
        if (GameSettings.Debug)
        {
            // Only when it is actually drawn. An empty rect is at x=0, and
            // clamping to that took the gap negative - the headline vanished
            // and the score column took the whole width across the condition
            // bar. Measured at 1000x360.
            var readout = DebugPanelBox(w, h, 8);
            if (readout.height > 0f) right = Mathf.Min(right, readout.x - pad);
        }

        // AND IF THERE IS NO GAP, THERE IS NO GAP.
        //
        // This used to floor the width at 60 px, which invents room that does
        // not exist: on a phone held upright - 390 wide - the practice switch
        // alone is 52% of the screen and the two columns meet in the middle.
        // The floor put the headline's box 64 px INTO the wanted row and the
        // arithmetic said everything was fine.
        //
        // An empty box instead, and the drawing steps aside. The price is
        // worth less than the controls it would be sitting on, and this file
        // already does the same thing for the loading panel.
        // A GAP OR NOTHING, and one threshold for which. The box used to
        // report any positive room while the drawing refused to use anything
        // under 60 px, so at 640x480 it claimed 34.88 px that nothing would
        // ever be drawn in - a number that is neither a gap nor nothing, and
        // every box measured from it inherited the fiction.
        float room = right - left;
        return new Rect(left, 0f, room >= UsableGap ? room : 0f, h);
    }

    /// <summary>
    /// The narrowest gap worth drawing a headline in. Below it the price, the
    /// clock, the cards and the model list all step aside instead.
    /// </summary>
    public const float UsableGap = 60f;

    /// <summary>
    /// The practice switch, under the whole left column.
    ///
    /// It was measured from the block board and the condition bar only, so
    /// adding the danger meter to that column laid the switch straight over
    /// it. Public with the rest of the column so the whole stack can be
    /// checked for overlap in one place rather than trusted.
    /// </summary>
    public Rect PracticeBox(int w, int h)
    {
        float pad = Mathf.Max(10f, h * 0.025f);
        int min = Mathf.Min(w, h);
        // Below the warning row, not below the meter: the row is always there
        // so the switch does not move when the warning appears.
        float top = ExposureWarningBox(w, h).yMax + pad * 0.8f;
        float bh = Mathf.Max(42f, min * 0.070f);

        // AND THE PAIR SHRINKS RATHER THAN THE COLUMN LEAVING THE SCREEN.
        // With the diagnostics panel up, a phone in landscape had 12 px under
        // the SIM switch - clearance, not comfort, and written down as such -
        // and the warning row spent it: the column ended 9 px past the bottom
        // edge. Of everything in that column the two switches are the ones
        // with slack in them, so they take the loss. Floored at 28 px, which
        // still holds their two lines; below that the answer is fewer rows,
        // not smaller ones.
        float room = h - pad - top;
        float need = bh * 1.78f + 6f;              // practice, gap, SIM at 0.78
        if (need > room) bh = Mathf.Max(28f, (room - 6f) / 1.78f);

        return new Rect(pad, top, Mathf.Min(w * 0.52f, 300f), bh);
    }

    /// <summary>The simulated-strike switch, directly under PRACTICE.</summary>
    public Rect SimBox(int w, int h)
    {
        var box = PracticeBox(w, h);
        return new Rect(box.x, box.y + box.height + 6f, box.width, box.height * 0.78f);
    }

    public Rect ExposureBox(int w, int h)
    {
        // UNDER THE CONDITION BAR, in the same column and the same width.
        //
        // It used to sit top right, under the wanted stars, on the reasoning
        // that stacking it on the stars would make it jump when the heat
        // crossed a star boundary. True, and it solved that by putting the two
        // things a driver reads together - how hurt am I, how much is this
        // worth - at opposite ends of the screen. They are one column now:
        // condition, then danger, directly beneath it.
        var health = HealthBox(w, h);
        float pad = Mathf.Max(8f, h * 0.02f);
        float lh = SmallFont(w, h) * 1.5f;
        return new Rect(health.x, health.yMax + pad * 0.4f,
                        health.width, lh + Mathf.Max(8f, h * 0.018f));
    }

    /// <summary>
    /// The exposure meter — section 18A of the P2P spec, made visible.
    ///
    /// This is the one HUD element that exists to teach a rule rather than
    /// report a state. Exposure multiplies the score, so a run that never goes
    /// near the fighting scores near zero no matter how full the bed is or how
    /// fast it arrives. That is an easy rule to state and an impossible one to
    /// discover by driving, unless the multiplier is on the screen while the
    /// choice is being made.
    ///
    /// So the bar shows two different things at once: how much exposure the
    /// run has BANKED (the fill, which only ever grows) and whether it is
    /// earning any RIGHT NOW (the bright cap and the warning). Without the
    /// second, a player creeping along the map edge sees a bar that simply
    /// stopped, and reads it as a bug.
    /// </summary>
    void DrawExposure(int w, int h)
    {
        if (runScore == null) return;

        // AND IT SHOWS IN PRACTICE TOO, which is why it looked deleted.
        //
        // `RunScore.Running` is false while the truck is invulnerable, and
        // practice makes it invulnerable - so the one meter that exists to
        // TEACH a rule was hidden from exactly the mode a player learns in.
        // the owner, 22:18: "old UI had exposure, we do not show it". It was
        // never removed; it was switched off by the mode he was in.
        //
        // In practice it reads what it reads and banks nothing, which is the
        // truth about practice and worth seeing.
        if (!runScore.Running && !Blwp.PracticeMode.On) return;

        var box = ExposureBox(w, h);
        float lh = _small.fontSize * 1.5f;
        float barH = box.height - lh;
        float e = runScore.Exposure;
        float rate = runScore.Rate;
        bool cold = rate < 0.03f;

        // Two different reasons to earn nothing, and they need different
        // advice. Out of the corridor: get closer to the fighting. In the
        // corridor but not gaining ground: circling pays nothing, drive on.
        // WHICH KIND OF NOTHING. Out of the corridor, or in it and going
        // round in circles - the live rate is zero in both, so this used to
        // ask `RateNow()`, a second C# threat model, which has been deleted.
        // The core's own last warm reading tells them apart.
        bool stalled = !runScore.MakingProgress && runScore.LastLiveRate >= 0.03f;

        var label = new GUIStyle(_small) { alignment = TextAnchor.UpperRight, fontStyle = FontStyle.Bold };
        Shadowed(new Rect(box.x, box.y, box.width, lh),
                 $"DANGER  ×{e:0.00}", label,
                 cold ? new Color(1f, 0.45f, 0.40f)
                      : Color.Lerp(new Color(1f, 0.86f, 0.35f), new Color(0.45f, 1f, 0.62f), e));

        var track = new Rect(box.x, box.y + lh, box.width, barH);
        GUI.color = new Color(0f, 0f, 0f, 0.45f);
        GUI.DrawTexture(track, _flat);

        GUI.color = Color.Lerp(new Color(1f, 0.55f, 0.25f), new Color(0.45f, 1f, 0.62f), e);
        GUI.DrawTexture(new Rect(track.x, track.y, track.width * e, track.height), _flat);

        // The live cap: how fast exposure is accruing at this instant, drawn
        // as a bright block riding the fill edge. It is the only part of the
        // meter that reacts within a second of turning the wheel.
        if (!cold)
        {
            float cap = Mathf.Min(track.width * 0.06f * Mathf.Clamp01(rate / 2f) + 2f,
                                  Mathf.Max(2f, track.width - track.width * e));
            float pulse = 0.6f + 0.4f * Mathf.Sin(Time.unscaledTime * 7f);
            GUI.color = new Color(1f, 1f, 1f, pulse);
            GUI.DrawTexture(new Rect(track.x + track.width * e, track.y, cap, track.height), _flat);
        }
        GUI.color = Color.white;

        if (cold)
        {
            // Drawn in its own, wider box. The meter is a quarter of the
            // screen; this sentence is not, and in the meter's box it lost its
            // second half off the left edge - "OUT OF THE FIGHT ·" and nothing
            // after it, which reads as a truncation bug rather than a warning.
            // ONE LINE, NEVER WRAPPED. `GUI.skin.label` wraps by default and
            // `CalcSize` measures the unwrapped width, so the fit below was
            // computed for one line while the label broke into two - the
            // second of which was drawn straight over the practice switch.
            // Photographed at 733x293 as "... GET CLOSER TO THE / FIGHTING".
            var warn = new GUIStyle(_small)
            {
                alignment = TextAnchor.UpperRight,
                fontStyle = FontStyle.Bold,
                wordWrap = false,
                clipping = TextClipping.Clip,
            };
            float k = 0.55f + 0.45f * Mathf.Sin(Time.unscaledTime * 4.5f);
            var warnBox = ExposureWarningBox(w, h);

            // AND IT SHRINKS TO THE COLUMN instead of reaching out of it. The
            // sentence is about 45 characters and the column is 249 to 320 px
            // wide at the shapes this is checked at, so at full size it does
            // not fit - which is what the old 560 px box was working around.
            // Floored at 9 px: below that the warning is not readable and the
            // right answer would be a shorter sentence, not smaller type.
            // THE VERDICT SURVIVES, THE INSTRUCTION GOES. Forty-eight
            // characters do not fit a 243 px column at the 9 px floor - shrunk
            // to fit they were clipped on the LEFT, which turned "NO SCORE OUT
            // HERE" into "SCORE OUT HERE" and said the opposite. So where
            // there is no room the sentence loses its second half rather than
            // its first, and the type stays readable.
            string full = stalled ? "NO SCORE FOR LAPS  ·  HEAD FOR THE DROP-OFF"
                                  : "NO SCORE OUT HERE  ·  GET CLOSER TO THE FIGHTING";
            string brief = stalled ? "NO SCORE FOR LAPS" : "NO SCORE OUT HERE";
            string say = warn.CalcSize(new GUIContent(full)).x <= warnBox.width - 6f
                       ? full
                       : (warn.CalcSize(new GUIContent(brief)).x <= warnBox.width - 6f
                          ? brief : full);
            // A MARGIN, because the fit was a pixel or two short and the
            // clipping takes it off the LEFT - "SCORE OUT HERE" where "NO
            // SCORE OUT HERE" was meant, which reads as the opposite. Six
            // pixels, and the fit is applied again after the round down.
            float room = warnBox.width - 6f;
            for (int pass = 0; pass < 3; pass++)
            {
                float need = warn.CalcSize(new GUIContent(say)).x;
                if (need <= room || need <= 1f) break;
                int smaller = Mathf.FloorToInt(warn.fontSize * room / need);
                warn.fontSize = Mathf.Max(9, Mathf.Min(warn.fontSize - 1, smaller));
                if (warn.fontSize <= 9) break;
            }

            Shadowed(warnBox,
                     // Both open with NO SCORE and close with the action.
                     // The previous pair buried the verdict in the middle -
                     // "NO GROUND GAINED · CIRCLING EARNS NOTHING" - and the
                     // eye lands on EARNING, which says the opposite of what
                     // the line means.
                     say, warn, new Color(1f, 0.42f, 0.36f, k));
        }
    }

    /// <summary>
    /// Being shot at, in a way that cannot be missed: a red rim on the screen
    /// that flares with every hit.
    ///
    /// Tracers were already drawn at the truck, but with a battle going on all
    /// around them they read as part of the scenery rather than as fire coming
    /// this way.
    /// </summary>
    void DrawUnderFire(int w, int h)
    {
        if (health == null) return;
        float since = Time.unscaledTime - health.LastHitAt;
        if (since > 1.1f) return;

        float k = 1f - since / 1.1f;
        float band = Mathf.Min(w, h) * 0.13f;
        var red = new Color(0.9f, 0.12f, 0.10f, 0.42f * k);

        GUI.color = red;
        GUI.DrawTexture(new Rect(0f, 0f, w, band), _flat);
        GUI.DrawTexture(new Rect(0f, h - band, w, band), _flat);
        GUI.DrawTexture(new Rect(0f, 0f, band, h), _flat);
        GUI.DrawTexture(new Rect(w - band, 0f, band, h), _flat);
        GUI.color = Color.white;

        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Min(w, h) * 0.045f),
        };
        Shadowed(UnderFireBox(w, h), "UNDER FIRE",
                 style, new Color(1f, 0.35f, 0.3f, k));
    }

    /// <summary>
    /// Where the gate is and how far.
    ///
    /// From the spawn the delivery gate is 230 m away and behind a battle -
    /// invisible, and there is nothing on screen saying which way to go. An
    /// arrow at the edge of the screen when it is off camera, a distance when
    /// it is not.
    /// </summary>
    /// <summary>
    /// The liquidation crater: an atom on the hole, and a warning while the
    /// truck is standing in it.
    ///
    /// The contract asks for exactly those two - "on-screen warning plus the
    /// atom symbol" - so there is nothing else here. Both read the CORE: where
    /// the craters are and how wide, and whether the truck's own position is
    /// inside one. No damage is computed here and no second bowl is drawn; the
    /// rate, the falloff and the dose stay in `packages/core`.
    ///
    /// Built on `DrawWaypoint`'s shape below - the same camera lookup, the
    /// same `WorldToScreenPoint`, the same `Shadowed` - so the two markers
    /// behave alike rather than each having their own idea of the screen.
    /// </summary>
    /// <summary>
    /// The trefoil, drawn rather than typed.
    ///
    /// `\u2622` was typed first and the build's font has not got it: the
    /// warning came up reading IRRADIATED with nothing either side of it, and
    /// the crater carried a filled box - the missing-glyph square. A symbol
    /// that renders as a box is not the symbol the contract asks for, so it is
    /// three blades and a hub off the same 1x1 texture the rest of this file
    /// draws its bars with.
    /// </summary>
    void Trefoil(Vector2 at, float size, Color colour)
    {
        var old = GUI.color;
        GUI.color = colour;
        for (int i = 0; i < 3; i++)
        {
            var m = GUI.matrix;
            GUIUtility.RotateAroundPivot(60f + i * 120f, at);
            GUI.DrawTexture(new Rect(at.x - size * 0.20f, at.y - size * 0.52f,
                                     size * 0.40f, size * 0.40f), _flat);
            GUI.matrix = m;
        }
        GUI.DrawTexture(new Rect(at.x - size * 0.13f, at.y - size * 0.13f,
                                 size * 0.26f, size * 0.26f), _flat);
        GUI.color = old;
    }

    void DrawFallout(int w, int h)
    {
        if (!Blwp.BlwpCore.Available || truck == null) return;
        int open = Blwp.BlwpCore.CraterCount;
        if (open == 0) return;

        var cam = Camera.main;
        if (cam == null)
        {
            var chase = Object.FindFirstObjectByType<ChaseCamera>();
            cam = chase != null ? chase.GetComponent<Camera>() : null;
        }
        if (cam == null) return;

        var mark = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.040f, 18f, 34f)),
        };
        var yellow = new Color(0.96f, 0.86f, 0.20f);

        for (int i = 0; i < open; i++)
        {
            if (!Blwp.BlwpCore.CraterAt(i, truck.transform.position.y + 1.5f,
                                        out var at, out float _)) continue;
            var vp = cam.WorldToScreenPoint(at);
            if (vp.z <= 0f) continue;                       // behind the camera
            float x = Mathf.Clamp(vp.x, 20f, w - 20f);
            float y = Mathf.Clamp(h - vp.y, 20f, h - 20f);
            Trefoil(new Vector2(x, y), mark.fontSize * 1.6f, yellow);
        }

        var p = truck.transform.position;
        if (!Blwp.BlwpCore.Irradiated(p.x, p.z)) return;

        // Pulsed, like the wanted stars, because a warning that does not move
        // reads as part of the furniture.
        var warn = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.045f, 20f, 40f)),
        };
        var hot = new Color(0.96f, 0.86f, 0.20f,
                            0.7f + 0.3f * Mathf.Sin(Time.unscaledTime * 6.5f));
        var band = IrradiatedBox(w, h);
        Shadowed(band, "IRRADIATED", warn, hot);

        // The contract asks for a simulated strike to be MARKED as one. Same
        // pictures either way - the core cannot tell a simulated liquidation
        // from a live one, and neither can the drawing - so the only honest
        // difference is a word saying which.
        if (Bootstrap.Simulated)
        {
            var tag = new GUIStyle(_small) { alignment = TextAnchor.UpperCenter };
            Shadowed(new Rect(band.x, band.y + band.height, band.width, _small.fontSize * 1.6f),
                     "SIM  -  no liquidation on the feed", tag,
                     new Color(0.96f, 0.86f, 0.20f, 0.75f));
        }
        float half = warn.fontSize * 3.0f;
        // The two radiation marks flank the word, so they follow the band
        // rather than the middle of the screen.
        float mid = band.x + band.width * 0.5f;
        Trefoil(new Vector2(mid - half, band.y + band.height * 0.5f), warn.fontSize * 1.3f, hot);
        Trefoil(new Vector2(mid + half, band.y + band.height * 0.5f), warn.fontSize * 1.3f, hot);
    }

    void DrawWaypoint(int w, int h)
    {
        if (gate == null || truck == null) return;

        var cam = Camera.main;
        if (cam == null)
        {
            var chase = Object.FindFirstObjectByType<ChaseCamera>();
            cam = chase != null ? chase.GetComponent<Camera>() : null;
        }
        if (cam == null) return;

        var at = new Vector3(gate.gateX, truck.transform.position.y + 4f, 0f);
        float distance = Vector3.Distance(truck.transform.position, at);

        var vp = cam.WorldToScreenPoint(at);
        bool ahead = vp.z > 0f;
        float x = ahead ? vp.x : w - vp.x;
        float y = h - vp.y;

        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.032f, 15f, 26f)),
        };

        // clamped to a margin, so it becomes an edge arrow once the gate is
        // off to the side or behind
        float margin = Mathf.Min(w, h) * 0.09f;
        bool offScreen = !ahead || x < margin || x > w - margin || y < margin || y > h - margin;
        x = Mathf.Clamp(x, margin, w - margin);
        y = Mathf.Clamp(y, margin, h - margin);

        var colour = new Color(0.42f, 0.86f, 1f);
        Shadowed(new Rect(x - 90f, y - style.fontSize * 1.6f, 180f, style.fontSize * 1.6f),
                 offScreen ? "▲ DROP-OFF" : "DROP-OFF", style, colour);
        Shadowed(new Rect(x - 90f, y, 180f, style.fontSize * 1.6f),
                 $"{distance:0} m", style, new Color(1f, 1f, 1f, 0.9f));
    }

    /// <summary>
    /// WASTED, over a drained and slowed world.
    ///
    /// Fades up with the sequence rather than snapping on, and sits slightly
    /// above centre the way GTA does - dead centre reads as a menu.
    /// </summary>
    void DrawWasted(int w, int h)
    {
        if (wasted == null || wasted.Intensity <= 0.01f) return;

        float k = wasted.Intensity;
        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Min(w, h) * 0.17f),
        };

        // a band behind it, so the word holds against a bright sky
        float bandH = style.fontSize * 1.5f;
        var band = new Rect(0f, h * 0.34f, w, bandH);
        GUI.color = new Color(0f, 0f, 0f, 0.42f * k);
        GUI.DrawTexture(band, _flat);

        // grows very slightly as it comes up, which is what sells the weight
        float scale = Mathf.Lerp(0.94f, 1f, k);
        style.fontSize = Mathf.RoundToInt(style.fontSize * scale);

        GUI.color = Color.white;
        style.normal.textColor = new Color(0f, 0f, 0f, 0.6f * k);
        GUI.Label(new Rect(band.x + 3f, band.y + 4f, band.width, band.height), "WASTED", style);
        style.normal.textColor = new Color(0.86f, 0.13f, 0.13f, k);
        GUI.Label(band, "WASTED", style);
        GUI.color = Color.white;
    }

    /// <summary>
    /// Condition of the truck, bottom left, plus the countdown while it burns.
    ///
    /// Drawn as a bar rather than a number because the thing the player needs
    /// off a glance at 60 km/h is how much is left, not how much exactly.
    /// </summary>
    /// <summary>
    /// Where the condition bar sits: directly under the diagnostics panel, and
    /// the same width, so the two read as one block rather than two things
    /// that happen to share a corner. Public so a test can check it stays put
    /// when the panel above it grows a line.
    /// </summary>
    public Rect HealthBox(int w, int h)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        float barH = Mathf.Max(12f, h * 0.022f);
        float lh = SmallFont(w, h) * 1.5f;
        var diag = DiagnosticsBox(w, h);

        // UNDER whatever occupies the top left. That is the diagnostics box
        // when it is up, and the block readout otherwise - the condition bar
        // was landing straight on top of the block, its clock and the board.
        float top = showDiagnostics ? diag.yMax + pad * 0.4f
                                    : pad + BlockBoxHeight(w, h) + pad * 0.5f;
        return new Rect(diag.x, top, diag.width, barH + lh);
    }

    /// <summary>How tall the block readout is. Shared, so nothing lands on it.</summary>
    /// <summary>
    /// The rows `DrawBlock` lays out, in line-heights, in order: the inset it
    /// starts at, the title, the clock bar, the time left, and the pending
    /// line.
    ///
    /// ONE LIST, WALKED BY BOTH the drawing and the measurement, because they
    /// disagreed: the box claimed 3.20 lines and the content ran to 3.77, so
    /// "in this block: 0 sat" was drawn OUTSIDE the yellow border and the
    /// condition bar was laid on top of it. Photographed on an iPhone at
    /// 22:17. With a leaderboard the box claimed 4.40 against 6.17 drawn.
    ///
    /// Two numbers for the same layout is how that happens, so there is one.
    /// </summary>
    static readonly float[] BlockRows = { 0.15f, 1f, 0.62f, 1f, 1f };

    /// <summary>The gap, the heading and a row apiece, when there is a board.</summary>
    const float BlockBoardGap = 1.4f, BlockBoardHead = 1f, BlockBoardRow = 0.95f;

    /// <summary>How far down the box the drawing actually reaches.</summary>
    public float BlockContentHeight(int w, int h)
    {
        if (block == null) return 0f;
        float lh = SmallFont(w, h) * 1.55f;
        int rows = Mathf.Min(5, block.Board.Count);

        float lines = 0f;
        foreach (var step in BlockRows) lines += step;
        if (rows > 0) lines += BlockBoardGap + BlockBoardHead + rows * BlockBoardRow;
        return lh * lines;
    }

    /// <summary>How tall the block readout is. Shared, so nothing lands on it.</summary>
    public float BlockBoxHeight(int w, int h)
    {
        if (block == null) return 0f;
        // A fifth of a line of air under the last thing drawn, so the border
        // does not sit on the text it is meant to contain.
        return BlockContentHeight(w, h) + SmallFont(w, h) * 1.55f * 0.18f;
    }

    void DrawHealth(int w, int h)
    {
        if (health == null) return;

        float pad = Mathf.Max(8f, h * 0.02f);
        float barH = Mathf.Max(12f, h * 0.022f);
        float lh = _small.fontSize * 1.5f;
        var box = HealthBox(w, h);

        var label = new GUIStyle(_small) { fontStyle = FontStyle.Bold };
        label.normal.textColor = Color.white;
        Shadowed(new Rect(box.x, box.y, box.width, lh),
                 health.IsDestroyed
                     ? $"WRECKED — back in {Mathf.CeilToInt(health.RespawnIn)}s"
                     : health.IsInvulnerable
                         ? "CONDITION 100%  ·  protected"
                         : $"CONDITION {Mathf.CeilToInt(health.Fraction * 100f)}%",
                 label,
                 health.IsDestroyed ? Down
                                    : health.IsInvulnerable ? new Color(0.55f, 0.8f, 1f)
                                                            : Color.white);

        var track = new Rect(box.x, box.y + lh, box.width, barH);
        GUI.color = new Color(0f, 0f, 0f, 0.5f);
        GUI.DrawTexture(track, _flat);

        // the bar drains while it burns, so the wait reads as a bar too
        float fill = health.IsDestroyed
            ? (health.respawnSeconds > 0f ? health.RespawnIn / health.respawnSeconds : 0f)
            : health.Fraction;

        GUI.color = health.IsDestroyed
            ? new Color(1f, 0.45f, 0.15f, 0.9f)
            : Color.Lerp(Down, Up, health.Fraction);
        GUI.DrawTexture(new Rect(track.x + 2f, track.y + 2f,
                                 Mathf.Max(0f, (track.width - 4f) * fill),
                                 track.height - 4f), _flat);
        GUI.color = Color.white;
    }

    /// <summary>
    /// What is still coming, and what has arrived.
    ///
    /// The models stream in behind the game, which is invisible by design - and
    /// invisible is indistinguishable from broken. This was reported as the
    /// models not loading while all four were in fact arriving. It retires
    /// itself a few seconds after the last one lands, so it does not become
    /// permanent furniture.
    /// </summary>
    void DrawStreamingPanel(int w, int h)
    {
        if (streamer == null || streamer.Items.Count == 0) return;

        // AND NOT WHILE A CARD IS UP. Both stand in the gap - it is the only
        // column with nothing permanent in it - and of the two, a list of
        // model names is the one to drop while the player is being told what
        // his run was worth.
        if (SendOffShowing || ArrivalShowing) return;
        // gone once everything has settled, unless something failed - a failure
        // is worth leaving on screen
        if (streamer.AllDone && streamer.Failed == 0 && streamer.SinceDone > 4f) return;

        float pad = Mathf.Max(8f, h * 0.02f);
        // ONE PITCH, asked of the same function the box uses - the box is
        // sized from it, so a second copy here would put the last row outside
        // the frame the border draws.
        float lh = StreamingLineHeight(w, h, streamer.Items.Count);
        var box = StreamingBox(w, h, streamer.Items.Count);

        GUI.color = new Color(0f, 0f, 0f, 0.45f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;

        float y = box.y + pad * 0.4f;
        var head = new GUIStyle(_small) { fontStyle = FontStyle.Bold };
        head.normal.textColor = Color.white;
        float totalMb = 0f;
        foreach (var it in streamer.Items) totalMb += it.sizeMb;
        GUI.Label(new Rect(box.x + pad * 0.6f, y, box.width, lh),
                  streamer.AllDone
                      ? (totalMb > 0.01f ? $"Models loaded  ({totalMb:0.0} MB)" : "Models loaded")
                      : "Loading models", head);
        y += lh;

        foreach (var item in streamer.Items)
        {
            var style = new GUIStyle(_small);
            switch (item.state)
            {
                case ModelStreamer.State.Loaded: style.normal.textColor = Up; break;
                case ModelStreamer.State.Failed: style.normal.textColor = Down; break;
                case ModelStreamer.State.Loading:
                    style.normal.textColor = new Color(1f, 0.82f, 0.35f); break;
                default: style.normal.textColor = new Color(0.65f, 0.68f, 0.72f); break;
            }
            string mark = StreamMark(item.state, item.sizeMb, item.progress);
            GUI.Label(new Rect(box.x + pad * 0.6f, y, box.width, lh), $"{item.label}  {mark}", style);
            y += lh;
        }
    }

    void Update()
    {
        var kb = UnityEngine.InputSystem.Keyboard.current;
        if (kb != null && kb.f1Key.wasPressedThisFrame) showDiagnostics = !showDiagnostics;
    }

    void OnGUI()
    {
        Styles();
        int w = Screen.width, h = Screen.height;

        /* ---------------------------------------------------- headline price */
        // The loading panel needs the top of the screen, and the price is not
        // what the player is reading while choosing freight. It steps aside
        // into the corner rather than fighting the panel for the same pixels.
        bool loading = loadout != null && loadout.IsOpen;

        if (market != null && !loading)
        {
            var head = HeadlineBox(w, h);
            string text = market.Price > 0 ? $"${market.Price:N0}" : "— — —";
            // No room between the columns: the headline is not drawn at all
            // rather than drawn on top of something that matters.
            if (head.width <= 0f) return;
            var colour = market.Fresh ? Color.white : new Color(1f, 1f, 1f, 0.55f);

            // AND IT SHRINKS TO FIT THE GAP rather than spilling out of it.
            // A phone in landscape leaves about a third of its width between
            // the two columns, and 13% of the short side is a wider number
            // than that: measured, not assumed, off the style itself.
            float wanted = _price.CalcSize(new GUIContent(text)).x;
            if (wanted > head.width && wanted > 1f)
                _price.fontSize = Mathf.Max(14, Mathf.FloorToInt(_price.fontSize * head.width / wanted));

            Shadowed(new Rect(head.x, HeadlineRowY(w, h, 0), head.width, _price.fontSize * 1.3f),
                     text, _price, colour);

            double chg = market.DayChangePct;
            string sub = market.Price > 0
                // The liquidation socket is named only when it is NOT well, so
                // the line stays short in the normal case and cannot stay quiet
                // in the case that actually happened: spot live, futures dead,
                // and no liquidation for a whole session.
                // PRICE AND PER CENT, nothing else. the owner, 17:52: the feed
                // roll - "live . liq binance/9 bybit okx" - ran the width of
                // an iPhone straight through the scene. It was connection
                // telemetry on the one line a player reads for the market, and
                // the strike's own line already names the exchange that
                // mattered. `Venues()` and `market.Status` are still there for
                // the debug panel.
                ? $"{chg:+0.00;-0.00;0.00}% 24h"
                : $"verbinde … ({market.Status})";
            Shadowed(new Rect(head.x, HeadlineRowY(w, h, 1), head.width, _sub.fontSize * 1.6f),
                     sub, _sub, chg >= 0 ? Up : Down);

            DrawLiquidations(w, h, HeadlineRowY(w, h, 2));
            DrawBlockTimer(w, h, HeadlineRowY(w, h, 3));
        }

        // Everything the game HUD draws sits UNDER the loading window. IMGUI
        // has no z-order between components - it draws in whatever order the
        // components happen to run - so the health bar, the diagnostics and the
        // model list were landing on top of the panel. Depth is inverted:
        // higher is further back.
        GUI.depth = loading ? 10 : 0;

        if (loading && market != null && market.Price > 0)
        {
            var small = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft, fontStyle = FontStyle.Bold };
            Shadowed(LoadingPriceBox(w, h),
                     $"${market.Price:N0}   {market.DayChangePct:+0.00;-0.00;0.00}% 24h",
                     small, market.DayChangePct >= 0 ? Up : Down);
        }

        // At the ramp none of this is what the player is reading, and all of it
        // was covering the window: the condition bar, the streaming list, the
        // waypoint and the diagnostics.
        if (loading)
        {
            DrawWasted(w, h);
            return;
        }

        DrawBlock(w, h);
        DrawWanted(w, h);
        DrawExposure(w, h);
        DrawUnderFire(w, h);
        DrawWaypoint(w, h);
        DrawFallout(w, h);
        DrawHealth(w, h);
        DrawWasted(w, h);
        DrawManifest(w, h);
        DrawStreamingPanel(w, h);

        if (!showDiagnostics) return;

        /* ------------------------------------------------------- diagnostics */
        float pad = Mathf.Max(8f, Screen.height * 0.02f);
        float lh = _small.fontSize * 1.45f;   // still the line height for Line()
        var box = DiagnosticsBox(w, h);

        GUI.color = new Color(0f, 0f, 0f, 0.42f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;

        float y = box.y + pad * 0.5f;
        void Line(string s) { GUI.Label(new Rect(box.x + pad * 0.6f, y, box.width, lh), s, _small); y += lh; }

        if (truck != null)
        {
            int grounded = 0;
            foreach (var a in truck.axles)
            {
                if (a?.left != null && a.left.isGrounded) grounded++;
                if (a?.right != null && a.right.isGrounded) grounded++;
            }
            var rb = truck.GetComponent<Rigidbody>();
            // Tempo and Drift, from the core when one answers.
            //
            // `SpeedKmh` is `_rb.linearVelocity.magnitude * 3.6f` and `Slip`
            // is `|InverseTransformDirection(_rb.linearVelocity).x|`, both off
            // a body that has been kinematic since the core took the driving.
            // Measured in the player build: this panel read 0.00 km/h and
            // 0.000 m/s while the truck was doing 68.16 km/h and sliding
            // 2.645 m/s sideways. The zeroes are the dead body, not the rule.
            //
            // Tempo is `TruckSpeed`, which is what the MAIN readout above
            // already reads, so the screen carries one speed and not two.
            // Drift is `TruckSlip`, the chassis-frame projection from (t) -
            // not a second formula worked out here.
            bool core = Blwp.BlwpCore.Available;
            float tempo = core ? Blwp.BlwpCore.TruckSpeed * 3.6f : truck.SpeedKmh;
            float drift = core ? Blwp.BlwpCore.TruckSlip : truck.Slip;
            Line($"Tempo   {tempo:0} km/h");
            Line($"Gas {DriveInput.Throttle:+0.0;-0.0; 0.0}  Lenk {DriveInput.Steer:+0.0;-0.0; 0.0}  {(DriveInput.Handbrake ? "HB" : "")}");
            Line($"Drift   {drift:0.0} m/s   Raeder {grounded}/4");
            if (rb != null) Line($"Pos     {rb.position.x:0}, {rb.position.z:0}");
        }
        if (market != null)
        {
            Line($"Fluss   {market.Flow:+0.00;-0.00; 0.00}");
            Line($"Liquid. {market.Liquidations.Count} / 90 s");
        }
        if (Blwp.BlwpCore.Available)
        {
            // Counted off the CORE, which is what is on the screen now. This
            // read `field.Army`, a simulation that no longer runs.
            int ab = 0, ar = 0, ib = 0, ir = 0, heli = 0, bomb = 0;
            for (int i = 0; i < Blwp.Layout.UNITS; i++)
            {
                if (!Blwp.BlwpCore.UnitAlive(i)) continue;
                bool bull = Blwp.BlwpCore.UnitSide(i) < 0;
                if (Blwp.BlwpCore.UnitIsArmour(i)) { if (bull) ab++; else ar++; }
                else { if (bull) ib++; else ir++; }
            }
            for (int i = 0; i < Blwp.Layout.MAX_HELIS; i++) if (Blwp.BlwpCore.HeliAlive(i)) heli++;
            for (int i = 0; i < Blwp.Layout.MAX_BOMBS; i++) if (Blwp.BlwpCore.BombAlive(i)) bomb++;
            Line($"Panzer   gruen {ab}  rot {ar}");
            Line($"Soldaten gruen {ib}  rot {ir}");
            Line($"Luft     {heli} Heli  {bomb} Bombe(n)");
        }
        if (field != null && truck != null)
        {
            float front = field.FrontlineZ(truck.transform.position.x);
            bool bull = field.IsBullHeld(truck.transform.position.x, truck.transform.position.z);
            Line($"Front   z={front:0}");
            Line(bull ? "Gebiet  BULLEN" : "Gebiet  BAEREN");
        }
    }
}
