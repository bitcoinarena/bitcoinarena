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
        float width = w - pad * 2f;
        float x = pad;

        // ABOVE the driving pads, measured off the pads themselves rather than
        // guessed at: throttle and brake are stacked in the bottom right corner
        // and the score was sitting across them.
        float padsTop = TouchPad.RectFor(TouchPad.Pad.Up, w, h).y;
        float bottom = padsTop - pad * 0.6f;

        // Banked is deliberately its own size: bigger than the small print,
        // smaller than the pending figure. It is the number that survives.
        var banked = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.LowerRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.042f, 20f, 40f)),
        };

        bool live = runScore != null && runScore.Running;
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
        var box = new Rect(pad, pad + BlockBoxHeight(w, h) + HealthBoxHeight(w, h) + pad * 1.4f,
                           bw, bh);

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

        var simBox = new Rect(box.x, box.y + box.height + 6f, box.width, box.height * 0.78f);
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
        Button(TouchPad.RectFor(TouchPad.Pad.Sound, w, h),
               GameSettings.Sound ? "SOUND" : "MUTED", GameSettings.Sound,
               GameSettings.ToggleSound);
        Button(TouchPad.RectFor(TouchPad.Pad.Debug, w, h),
               "DEBUG", GameSettings.Debug, GameSettings.ToggleDebug);
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
        float bw = Mathf.Min(w * 0.42f, 260f);
        var box = new Rect(w - bw - Mathf.Max(10f, h * 0.025f),
                           TouchPad.RectFor(TouchPad.Pad.Debug, w, h).yMax + lh * 0.6f,
                           bw, lh * lines.Count + lh * 0.6f);

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
        if (!Blwp.BlwpCore.Available) return;
        int serial = Blwp.BlwpCore.StrikeCount;
        if (serial != _strikeSeen) { _strikeSeen = serial; _strikeAt = Time.time; }
        if (serial <= 0 || Time.time - _strikeAt > 8f) return;   // the last few seconds only

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
        Shadowed(new Rect(0, y, w, _sub.fontSize * 1.6f), line, _sub,
                 new Color(1f, 0.72f, 0.25f));
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

        Shadowed(new Rect(0f, y, w, style.fontSize * 1.35f),
                 $"BLOCK {block.Height:N0}   ·   {left / 60}:{left % 60:00}", style, colour);

        var sub = new GUIStyle(_small) { alignment = TextAnchor.UpperCenter };
        Shadowed(new Rect(0f, y + style.fontSize * 1.2f, w, _small.fontSize * 1.6f),
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
    void DrawSendOff(int w, int h)
    {
        if (loadout == null) return;
        const float Hold = 3.4f;
        float since = Time.unscaledTime - loadout.ConfirmedAt;
        if (since < 0f || since >= Hold) return;

        float k = Mathf.Clamp01((Hold - since) / (Hold * 0.3f));
        int min = Mathf.Min(w, h);

        int head = Mathf.RoundToInt(Mathf.Min(w * 0.034f, min * 0.060f));
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
        float cardW = Mathf.Min(w * 0.92f, head * 26f);
        var card = new Rect((w - cardW) * 0.5f, h * 0.20f, cardW,
                            padY * 2f + head * 1.3f + sub.fontSize * 1.3f);

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
        int head = Mathf.RoundToInt(Mathf.Min(w * 0.040f, min * 0.070f));
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
        float cardH = padY * 2f + head * 1.35f + mid.fontSize * 1.3f
                    + line.fontSize * 3.4f;
        float cardW = Mathf.Min(w * 0.92f, head * 26f);
        var card = new Rect((w - cardW) * 0.5f, h * 0.18f, cardW, cardH);

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

        float y = pad + lh * 0.15f;
        Shadowed(new Rect(pad * 1.5f, y, bw, lh), $"BLOCK #{block.Height}", head,
                 new Color(1f, 0.86f, 0.35f));
        y += lh;

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
        y += lh * 0.62f;

        int secs = Mathf.CeilToInt(block.Remaining);
        Shadowed(new Rect(pad * 1.5f, y, bw, lh), $"{secs / 60}:{secs % 60:00} left", line,
                 new Color(1f, 1f, 1f, 0.85f));
        y += lh;
        Shadowed(new Rect(pad * 1.5f, y, bw, lh),
                 $"in this block: {block.PendingSats:N0} sat  ·  {block.PendingBtc:0.###} BTC",
                 line, Up);
        y += lh * 1.4f;

        if (block.Board.Count == 0) return;

        Shadowed(new Rect(pad * 1.5f, y, bw, lh), "BEST BLOCKS", head, new Color(1f, 1f, 1f, 0.8f));
        y += lh;
        for (int i = 0; i < block.Board.Count && i < 5; i++)
        {
            var b = block.Board[i];
            Shadowed(new Rect(pad * 1.5f, y, bw, lh),
                     $"{i + 1}.  #{b.height}   {b.sats:N0} sat   {b.btc:0.##} BTC",
                     line, i == 0 ? Up : new Color(1f, 1f, 1f, 0.7f));
            y += lh * 0.95f;
        }
    }

    /// <summary>
    /// The wanted level, top right, as stars.
    ///
    /// The risk was set at the loading ramp and then never mentioned again, so
    /// the consequence of a greedy load was invisible the moment it mattered.
    /// Filled stars for the heat, and they pulse while it is high.
    /// </summary>
    void DrawWanted(int w, int h)
    {
        if (bay == null || !bay.IsLoaded) return;

        int stars = Mathf.Clamp(Mathf.CeilToInt(bay.Heat * 5f), 0, 5);
        if (stars <= 0) return;

        float pad = Mathf.Max(10f, h * 0.025f);
        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 24f, 46f)),
        };

        // a slow pulse at high heat, so a five star run never settles down
        float pulse = bay.Heat > 0.55f
            ? 0.75f + 0.25f * Mathf.Sin(Time.unscaledTime * 5.5f) : 1f;
        var colour = Color.Lerp(new Color(1f, 0.86f, 0.35f), new Color(1f, 0.32f, 0.25f), bay.Heat);
        colour.a = pulse;

        var box = new Rect(0f, pad, w - pad, style.fontSize * 1.4f);
        Shadowed(box, new string('★', stars) + new string('☆', 5 - stars), style, colour);

        var sub = new GUIStyle(_small) { alignment = TextAnchor.UpperRight };
        Shadowed(new Rect(0f, pad + style.fontSize * 1.25f, w - pad, _small.fontSize * 1.6f),
                 stars >= 4 ? "HUNTED" : "WANTED", sub, colour);
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
    public Rect ExposureBox(int w, int h)
    {
        float pad = Mathf.Max(10f, h * 0.025f);
        float starFont = Mathf.Clamp(Mathf.Min(w, h) * 0.055f, 24f, 46f);
        float small = SmallFont(w, h);
        float top = pad + starFont * 1.25f + small * 1.9f;
        float width = Mathf.Min(w * 0.26f, 300f);
        return new Rect(w - width - pad, top, width, small * 1.5f + Mathf.Max(10f, h * 0.020f));
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
        if (runScore == null || !runScore.Running) return;

        var box = ExposureBox(w, h);
        float lh = _small.fontSize * 1.5f;
        float barH = box.height - lh;
        float e = runScore.Exposure;
        float rate = runScore.Rate;
        bool cold = rate < 0.03f;

        // Two different reasons to earn nothing, and they need different
        // advice. Out of the corridor: get closer to the fighting. In the
        // corridor but not gaining ground: circling pays nothing, drive on.
        bool stalled = !runScore.MakingProgress && runScore.RateNow() >= 0.03f;

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
            var warn = new GUIStyle(_small) { alignment = TextAnchor.UpperRight, fontStyle = FontStyle.Bold };
            float k = 0.55f + 0.45f * Mathf.Sin(Time.unscaledTime * 4.5f);
            float ww = Mathf.Min(w * 0.75f, 560f);
            Shadowed(new Rect(box.xMax - ww, box.yMax + 2f, ww, lh),
                     // Both open with NO SCORE and close with the action.
                     // The previous pair buried the verdict in the middle -
                     // "NO GROUND GAINED · CIRCLING EARNS NOTHING" - and the
                     // eye lands on EARNING, which says the opposite of what
                     // the line means.
                     stalled ? "NO SCORE FOR LAPS  ·  HEAD FOR THE DROP-OFF"
                             : "NO SCORE OUT HERE  ·  GET CLOSER TO THE FIGHTING", warn,
                     new Color(1f, 0.42f, 0.36f, k));
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
        Shadowed(new Rect(0f, h * 0.14f, w, style.fontSize * 1.5f), "UNDER FIRE",
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
        var band = new Rect(0f, h * 0.30f, w, warn.fontSize * 1.6f);
        Shadowed(band, "IRRADIATED", warn, hot);

        // The contract asks for a simulated strike to be MARKED as one. Same
        // pictures either way - the core cannot tell a simulated liquidation
        // from a live one, and neither can the drawing - so the only honest
        // difference is a word saying which.
        if (Bootstrap.Simulated)
        {
            var tag = new GUIStyle(_small) { alignment = TextAnchor.UpperCenter };
            Shadowed(new Rect(0f, band.y + band.height, w, _small.fontSize * 1.6f),
                     "SIM  -  no liquidation on the feed", tag,
                     new Color(0.96f, 0.86f, 0.20f, 0.75f));
        }
        float half = warn.fontSize * 3.0f;
        Trefoil(new Vector2(w * 0.5f - half, band.y + band.height * 0.5f), warn.fontSize * 1.3f, hot);
        Trefoil(new Vector2(w * 0.5f + half, band.y + band.height * 0.5f), warn.fontSize * 1.3f, hot);
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
    public float BlockBoxHeight(int w, int h)
    {
        if (block == null) return 0f;
        float lh = SmallFont(w, h) * 1.55f;
        int rows = Mathf.Min(5, block.Board.Count);
        return lh * (3.2f + (rows > 0 ? 1.2f + rows * 0.95f : 0f));
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
        // gone once everything has settled, unless something failed - a failure
        // is worth leaving on screen
        if (streamer.AllDone && streamer.Failed == 0 && streamer.SinceDone > 4f) return;

        float pad = Mathf.Max(8f, h * 0.02f);
        float lh = _small.fontSize * 1.5f;
        float width = Mathf.Min(290f, w * 0.34f);
        var box = new Rect(w - width - pad, h * 0.30f, width, lh * (streamer.Items.Count + 1) + pad);

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
            string mark;
            switch (item.state)
            {
                case ModelStreamer.State.Loaded:
                    style.normal.textColor = Up;
                    // zero means it came from cache, which is worth saying
                    mark = item.sizeMb > 0.01f ? $"{item.sizeMb:0.0} MB" : "aus Cache";
                    break;
                case ModelStreamer.State.Failed:
                    style.normal.textColor = Down; mark = "fehlgeschlagen"; break;
                case ModelStreamer.State.Loading:
                    style.normal.textColor = new Color(1f, 0.82f, 0.35f);
                    mark = item.sizeMb > 0.01f
                        ? $"{Mathf.RoundToInt(item.progress * 100f)} %  {item.sizeMb:0.0} MB"
                        : $"{Mathf.RoundToInt(item.progress * 100f)} %";
                    break;
                default:
                    style.normal.textColor = new Color(0.65f, 0.68f, 0.72f); mark = "wartet"; break;
            }
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
            string text = market.Price > 0 ? $"${market.Price:N0}" : "— — —";
            var colour = market.Fresh ? Color.white : new Color(1f, 1f, 1f, 0.55f);
            Shadowed(new Rect(0, h * 0.015f, w, _price.fontSize * 1.3f), text, _price, colour);

            double chg = market.DayChangePct;
            string sub = market.Price > 0
                // The liquidation socket is named only when it is NOT well, so
                // the line stays short in the normal case and cannot stay quiet
                // in the case that actually happened: spot live, futures dead,
                // and no liquidation for a whole session.
                ? $"{chg:+0.00;-0.00;0.00}% 24h   ·   {market.Status}   ·   {Venues()}"
                : $"verbinde … ({market.Status})";
            Shadowed(new Rect(0, h * 0.015f + _price.fontSize * 1.12f, w, _sub.fontSize * 1.6f),
                     sub, _sub, chg >= 0 ? Up : Down);

            DrawLiquidations(w, h, h * 0.015f + _price.fontSize * 1.12f + _sub.fontSize * 1.55f);
            DrawBlockTimer(w, h, h * 0.015f + _price.fontSize * 1.12f + _sub.fontSize * 2.7f);
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
            Shadowed(new Rect(w * 0.02f, h * 0.012f, w * 0.4f, _small.fontSize * 1.6f),
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
