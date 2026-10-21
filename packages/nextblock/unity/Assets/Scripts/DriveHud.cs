// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.Globalization;
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
    public Arena.StrikeTheatre strike;
    int _saidStrike = -1, _strikeSeen = -1;
    float _strikeAt = -99f;
    public RunScore runScore;

    GUIStyle _price, _sub, _small;
    Texture2D _flat;
    AudioSource _horn;
    int _hornsPlayed;

    static readonly Color Up = new Color(0.30f, 0.88f, 0.48f);
    static readonly Color Down = new Color(1f, 0.42f, 0.42f);


    // THE HUD LOOKS NOTHING UP AND MEASURES NOTHING TWICE (comment 986, 2026-10-08): in a named profile of the
    // 7 s after 100 % (Pixel 7a profile, 10x CPU) DriveHud.OnGUI spent 25-33 ms in FindFirstObjectByType and 42-43 ms in
    // GUIStyle.CalcSize, every frame, for objects that stay and labels that do not change. A found object is kept until it is
    // destroyed or its GameObject goes inactive - when FindFirstObjectByType would no longer return it - and a size is kept per
    // font, size, style, padding, rich text, wrap and text. The same objects and the same sizes, so the same pixels.
    SpectatorCamera _spectatorFound;
    ChaseCamera _chaseFound;
    Arena.CoreDrivenTruck _coreFound;

    static T Found<T>(ref T cached) where T : Component
    {
        if (cached == null || !cached.gameObject.activeInHierarchy) cached = Object.FindFirstObjectByType<T>();
        return cached;
    }

    static readonly Dictionary<(int, int, FontStyle, int, int, bool, bool, string), Vector2> _measured =
        new Dictionary<(int, int, FontStyle, int, int, bool, bool, string), Vector2>();

    public static Vector2 Measure(GUIStyle style, string text)
    {
        var key = (style.font != null ? style.font.GetInstanceID() : 0, style.fontSize, style.fontStyle,
                   style.padding.horizontal, style.padding.vertical, style.richText, style.wordWrap, text ?? "");
        if (_measured.TryGetValue(key, out var size)) return size;
        if (_measured.Count > 2048) _measured.Clear();
        size = style.CalcSize(new GUIContent(text));
        _measured[key] = size;
        return size;
    }

    void Awake()
    {
        // NO LAYOUT PASS (comment 983, 2026-10-08): this HUD uses no GUILayout, so IMGUI's Layout call of
        // OnGUI built, measured and drew every label for nothing - 463-476 ms of the 7 s after 100 % at 10x CPU as an Android
        // phone (named profile), the whole draw twice a frame. Its buttons are plain GUI.Button, on the input and Repaint events.
        useGUILayout = false;
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
    // Public because a test reads it: a spectator's market note must be the SMALL style, never the headline's, and
    // that comparison is the difference between a note and the billboard the owner photographed on 2026-09-18 20:00.
    public static int SmallFont(int w, int h) =>
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
        bool live = runScore != null && (runScore.Running || Arena.PracticeMode.On);
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
                ? $"CARGO  {bay.Count} parcels  ·  {LoadoutPanel.BtcLabel(bay.BtcCarried)}" : "CARGO  empty";
            string tailNow = runScore == null
                ? $"{gate.Runs} runs delivered"
                : $"best {CoreScoreFactors.Points(runScore.Best)}  ·  {gate.Runs} runs  ·  {gate.SatsDelivered:N0} sat";
            float widest = Mathf.Max(Measure(under, longest).x,
                                     Measure(under, tailNow).x);
            widest = Mathf.Max(widest, Measure(banked, "BANKED  0,000.00000").x);
            widest = Mathf.Max(widest, Measure(score, "SCORE  0,000.00000").x);
            if (widest > width && widest > 1f)
            {
                float k = width / widest;
                score.fontSize = Mathf.Max(10, Mathf.FloorToInt(score.fontSize * k));
                under.fontSize = Mathf.Max(10, Mathf.FloorToInt(under.fontSize * k));
                banked.fontSize = Mathf.Max(10, Mathf.FloorToInt(banked.fontSize * k));
            }
        }

        // NOTHING UNDER THE RESULT CARD (2026-09-25, PRIORITIES item 3: "nothing overlaps"; measured 2026-09-26 at
        // 1280x720: CARGO / SCORE / BANKED ran under the card's bottom-right corner). The card carries the run's score and
        // its working while it stands, so this block steps aside until it is gone.
        // AND UNDER THE WRECK'S SUMMARY (2026-10-04: on WASTED the summary panel and this block shared ~110 px at
        // 1280x720) - the same rule: the summary carries this run's result, the block reads 0 there anyway.
        bool scoreBlock = !ArrivalShowing && !_wreckSummaryUp;
        if (scoreBlock != _scoreBlockWas)
        {
            _scoreBlockWas = scoreBlock;
            Debug.Log("[arena] score block " + (scoreBlock ? "drawn" : "stepped aside") + (_wreckSummaryUp ? " (the wreck's summary is up)" : ArrivalShowing ? " (the result card is up)" : ""));
        }
        if (scoreBlock)
        {
            string tail = runScore == null
                ? $"{gate.Runs} runs delivered"
                : $"best {CoreScoreFactors.Points(runScore.Best)}  ·  {gate.Runs} runs  ·  {gate.SatsDelivered:N0} sat";
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
                Shadowed(Row(banked.fontSize * 1.3f), $"BANKED  {CoreScoreFactors.Points(runScore.Total)}", banked, Up);

            // SCORE: what the current run would add. Amber, because a wreck takes
            // all of it - the colour is the warning, the line beneath says why.
            var tint = live ? new Color(1f, 0.82f, 0.30f) : new Color(1f, 1f, 1f, 0.45f);
            if (live && runScore.Projected <= 0) tint = new Color(1f, 0.45f, 0.40f);
            Shadowed(Row(score.fontSize * 1.25f), $"SCORE  {CoreScoreFactors.Points(pending)}", score, tint);

            Shadowed(Row(under.fontSize * 1.5f), bay.IsLoaded
                         ? $"CARGO  {bay.Count} parcels  ·  {LoadoutPanel.BtcLabel(bay.BtcCarried)}"
                         : "CARGO  empty",
                     under, bay.IsLoaded ? Color.white : new Color(1f, 1f, 1f, 0.6f));
        }

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

        // A SIGNED RUN SENDS NO PRACTICE (2026-10-04): the box says so and does nothing, like SIM
        bool signedRun = Arena.ArenaNet.Live;
        bool on = Arena.PracticeMode.On && !signedRun;
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
                 Arena.PracticeMode.Words(on, signedRun),
                 sub, new Color(1f, 1f, 1f, 0.7f));

        if (GUI.Button(box, GUIContent.none, GUIStyle.none) && !signedRun) Arena.PracticeMode.Toggle();

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
                 SimWords(sim, Arena.ArenaNet.Live),
                 sub, new Color(1f, 1f, 1f, 0.7f));

        if (GUI.Button(simBox, GUIContent.none, GUIStyle.none)) Bootstrap.ToggleSim();
    }

    /// <summary>
    /// The SIM switch's second line. In a signed run it fires nothing (`Bootstrap.LiquidationMayWriteCore`),
    /// so it says so rather than "firing liquidations".
    /// </summary>
    public static string SimWords(bool sim, bool signedRunLive)
        => signedRunLive ? "off in a signed run"
         : sim ? "firing liquidations  ·  tap to stop"
               : "tap to fire liquidations";

    /// <summary>
    /// Sound and debug, top right.
    ///
    /// Small and out of the way: neither is reached for mid-run, and the
    /// corner they sit in is the only one not already carrying the block
    /// clock, the score or a driving pad.
    /// </summary>
    void DrawSettings(int w, int h)
    {
        IconButton(SettingsRect(TouchPad.Pad.Sound, w, h), Icon.Speaker,
                   GameSettings.Sound, GameSettings.ToggleSound);
        IconButton(SettingsRect(TouchPad.Pad.Debug, w, h), Icon.Bars,
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

        var core = Found(ref _coreFound);
        _fps = Mathf.Lerp(_fps, 1f / Mathf.Max(0.0001f, Time.unscaledDeltaTime), 0.06f);

        var lines = new System.Collections.Generic.List<string>
        {
            $"fps {_fps:0}",
            core != null && core.Driving ? "core DRIVING" : "PhysX driving",
        };

        if (core != null && core.Driving)
        {
            float ONE = Arena.ArenaCore.ONE;
            var st = Arena.ArenaCore.State;
            lines.Add($"tick {Arena.ArenaCore.Tick}");
            lines.Add($"speed {Arena.ArenaCore.TruckSpeed:0.0} m/s   {Arena.ArenaCore.TruckSpeed * 3.6f:0} km/h");
            lines.Add($"pos {st[Arena.Layout.O_TRUCK + Arena.Layout.T_X] / ONE:0.0}, " +
                      $"{st[Arena.Layout.O_TRUCK + Arena.Layout.T_Z] / ONE:0.0}");
            lines.Add($"heading {Arena.ArenaCore.TruckHeading:0}   wheel {Arena.ArenaCore.TruckSteerDegrees:0.0}");
            lines.Add($"surface {core.LastSurface:0.00} m   grade {core.LastGrade:0.000} " +
                      $"({Mathf.Atan(core.LastGrade) * Mathf.Rad2Deg:0.0} deg)");
            lines.Add($"practice {(Arena.PracticeMode.On ? "on" : "off")} ({Arena.PracticeMode.Source})");
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
    /// session looks exactly like a quiet market from behind the wheel, and
    /// that is what happened: Binance futures accepted the connection and never
    /// sent a frame while the price ticked and the HUD said "live".
    /// </summary>
    /// <summary>
    /// THE LINE UNDER THE PRICE.
    ///
    /// Its own function because it is a WORD the player reads, and the words
    /// on this HUD are pinned by tests rather than checked by eye - the German
    /// on the streamed model list was found by a photograph and not by the one
    /// German check this project had, which reads the labels beside it.
    ///
    /// PRICE AND PER CENT, nothing else, once a price has arrived. the owner,
    /// 17:52: the feed roll - "live . liq binance/9 bybit okx" - ran the width
    /// of an iPhone straight through the scene. It was connection telemetry on
    /// the one line a player reads for the market, and the strike's own line
    /// already names the exchange that mattered. `Venues()` and
    /// `market.Status` are still there for the debug panel.
    ///
    /// Before a price arrives it says so. It used to say it in German -
    /// "verbinde … (connecting)" - which is the last German word that was left
    /// anywhere a driver looks.
    /// </summary>
    public static string PriceSubline(double price, double changePct, string status)
        => price > 0 ? $"{changePct:+0.00;-0.00;0.00}% 24h" : "";

    /// <summary>
    /// WHAT IS BROKEN, IN WORDS A PLAYER CAN ACT ON (2026-09-18 20:04).
    ///
    /// A socket's own vocabulary is not a message: "connecting … (error)" says nothing about which connection, what
    /// it costs the player, or whether the game is still worth watching - and photographed at 20:00 it was the whole
    /// sky over the mempool. Each line below names the thing and what the player will SEE go wrong:
    ///
    ///   the price socket   the chart stops moving, so it may be stale
    ///   the round socket   the other trucks stop arriving, so they freeze where they last were
    ///   spectating         there is nothing else on that screen: the live feed is the whole of it
    ///
    /// And a connection that comes back takes its line with it: an error left standing after the fault is gone is a
    /// lie the player cannot tell from the truth. Empty means nothing is wrong that this line has to say.
    /// </summary>
    public const string PriceFeedDown = "Bitcoin price feed is down. Chart may be stale.";
    public const string RoundFeedDown = "Lost the round feed. Other trucks may freeze.";
    public const string SpectateFeedDown = "Spectate lost the live feed.";

    public static string ConnectionTrouble(bool priceFeedOk, bool roundFeedOk, bool spectating)
    {
        if (!roundFeedOk) return spectating ? SpectateFeedDown : RoundFeedDown;
        if (!priceFeedOk) return PriceFeedDown;
        return "";
    }

    /// <summary>
    /// The line itself, wherever the player is: nothing at all when every connection is well, so a recovered feed
    /// takes its message with it.
    /// </summary>
    void DrawConnectionTrouble(int w, int h, GUIStyle style, bool spectating)
    {
        bool priceOk = market != null && PriceFeedOk(market.Price, market.Status);
        bool roundOk = RoundFeedOk(Arena.ArenaNet.Live, Arena.ArenaNet.Ended, Arena.ArenaNet.FeedDown());
        string say = ConnectionTrouble(priceOk, roundOk, spectating);
        if (say.Length == 0) return;
        Shadowed(TroubleBox(w, h), say, style, new Color(1f, 0.72f, 0.3f, 0.95f));
    }

    /// <summary>The price feed is well when a price has arrived and its socket is not in error.</summary>
    public static bool PriceFeedOk(double price, string status) => price > 0 && status != "error";

    /// <summary>
    /// The round feed is well while the page holds a live session, or the run is over and nothing was lost with it.
    /// A run that ENDED is not a broken connection - the player finished - so it says nothing.
    /// </summary>
    public static bool RoundFeedOk(bool sessionLive, bool runEnded, bool socketDown)
        => runEnded || !sessionLive || !socketDown;

    /// <summary>
    /// WHETHER A SPECTATOR IS SHOWN THE MARKET AT ALL (2026-09-18 20:00).
    ///
    /// Only when there is a price. Without one the driving HUD says "connecting ... (status)" under the dashes, which
    /// is the market socket's own telemetry; with no price, no box and no chrome around it, a spectator got that line
    /// alone across the sky. A spectator watches a world, and the socket's word is in the debug panel.
    /// </summary>
    public static bool MarketLineInSpectate(double price) => price > 0;

    /// <summary>
    /// THE DEBUG PANEL'S ROWS, as words rather than as inline strings.
    ///
    /// This panel is behind the DEBUG icon, which is on the driving HUD, so a
    /// player can open it - and every row in it was German: "Tempo", "Gas",
    /// "Lenk", "Raeder", "Fluss", "Panzer gruen/rot", "Soldaten", "Luft",
    /// "Bombe(n)". The sweep that found the connecting word missed all of
    /// them, because it looked for a list of German words that did not contain
    /// any of these; the second sweep looked for umlaut-free German too.
    ///
    /// They are functions for the same reason `PriceSubline` is: what the test
    /// reads has to be what the panel draws. The row COUNT is unchanged, which
    /// is what `DiagnosticsContentHeight` and `DebugPanelBox` are measured on.
    /// </summary>
    public static string SpeedRow(float kmh) => $"Speed   {kmh:0} km/h";

    public static string InputRow(float throttle, float steer, bool handbrake)
        => $"Thr {throttle:+0.0;-0.0; 0.0}  Steer {steer:+0.0;-0.0; 0.0}  {(handbrake ? "HB" : "")}";

    public static string DriftRow(float drift, int grounded)
        => $"Drift   {drift:0.0} m/s   Wheels {grounded}/4";

    public static string FlowRow(float flow) => $"Flow    {flow:+0.00;-0.00; 0.00}";

    public static string ArmourRow(int bull, int bear) => $"Armour   green {bull}  red {bear}";

    public static string InfantryRow(int bull, int bear) => $"Infantry green {bull}  red {bear}";

    public static string AirRow(int helis, int bombs) => $"Air      {helis} heli  {bombs} bomb(s)";

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
    /// <param name="rowToo">false in spectate: there is no headline stack there, so only the centre call-out is drawn.</param>
    void DrawLiquidations(int w, int h, float y, bool rowToo = true)
    {
        // GATED ON THE CORE'S STRIKE, not on the feed's list, and both halves
        // of that were wrong in the first cut of this.
        //
        // A SIMULATED strike never enters `market.Liquidations` at all - the
        // clock hands its size straight to `ArenaCore.Liquidation` - so gating
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
        if (!Arena.ArenaCore.Available) return;
        if (Arena.ArenaCore.StrikeCount <= 0) return;
        if (!Arena.StrikeTheatre.CapCentre.HasValue) return;

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
        float load = Arena.ArenaCore.Available ? Arena.ArenaCore.StrikeLoad : 0f;
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

        if (Arena.ArenaCore.StrikeCount != _saidStrike)
        {
            _saidStrike = Arena.ArenaCore.StrikeCount;
            string was = usd >= 1e6 ? $"${usd / 1e6:0.0}M"
                       : usd >= 1e3 ? $"${usd / 1e3:0.0}k" : $"${usd:0}";
            Debug.Log($"[hud] strike {_saidStrike}: the feed's summary said "
                      + $"\"{was} · {n} order(s) · {string.Join(" ", seen)}\"; "
                      + $"the core says \"{line}\"");
        }
        var liqStyle = new GUIStyle(_sub);
        if (rowToo && FitLine(liqStyle, line, LiquidationBox(w, h).width, 10))
            Shadowed(LiquidationBox(w, h), line, liqStyle, new Color(1f, 0.72f, 0.25f));

        // AND ACROSS THE MIDDLE OF THE SCREEN, while the cloud stands (2026-09-19 13:10: "when a liquidation
        // nuke/bomb hits, show in the CENTER of the screen how much was liquidated, e.g. $305000 Short liquidated").
        // The headline row is 13 px of orange in the corner of a screen with a mushroom cloud in the middle of it -
        // the number belongs where the eye already is. Same clock as the line: it is up exactly while a cloud is.
        var callBox = LiquidationCalloutBox(w, h);
        var call = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(callBox.height * 0.62f),
        };
        string callout = LiquidationCallout(dollars, strike != null ? strike.ArmedSide : null);
        FitInto(call, callout, callBox.width - 16f, 12);
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.55f);
        GUI.DrawTexture(callBox, _flat);
        GUI.color = Color.white;
        Shadowed(callBox, callout, call, new Color(1f, 0.78f, 0.30f));
    }

    /// <summary>
    /// WHAT A NUKE JUST COST SOMEBODY, in the words the owner asked for: "$305,000 SHORT LIQUIDATED".
    ///
    /// The side is the position that was closed, not the side of the market that closed it: `Bootstrap` hands the
    /// theatre `!l.Long`, so bear means a short was liquidated. A simulated strike has no submitter and no side, and
    /// then the line says the money alone rather than inventing one.
    /// </summary>
    public static string LiquidationCallout(double dollars, bool? bear)
    {
        string money = "$" + dollars.ToString("N0", CultureInfo.InvariantCulture);
        return bear == null ? money + "  LIQUIDATED"
             : money + (bear.Value ? "  SHORT LIQUIDATED" : "  LONG LIQUIDATED");
    }

    /// <summary>
    /// The call-out's box: across the middle of the screen, clear of the headline stack above it and of the touch
    /// pads below. Its own method so the layout tests can walk it with everything else.
    /// </summary>
    public Rect LiquidationCalloutBox(int w, int h)
    {
        float height = Mathf.Clamp(Mathf.Min(w, h) * 0.075f, 26f, 76f);
        float width = Mathf.Min(w * 0.72f, 720f);
        return new Rect((w - width) * 0.5f, h * 0.42f - height * 0.5f, width, height);
    }

    void DrawBlockTimer(int w, int h, float y)
    {
        if (block == null || block.Remaining <= 0f) return;

        int left = Mathf.CeilToInt(block.Remaining);
        // before a joined round starts this is the round's countdown to its start, and nothing is late yet
        bool late = left <= 30 && !block.StartsIn;

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
        string clock = block.StartsIn ? $"ROUND STARTS IN   {left / 60}:{left % 60:00}" : $"BLOCK {block.Height:N0}   ·   {left / 60}:{left % 60:00}";
        int size = style.fontSize;
        if (FitLine(style, clock, head.width, 12))
            Shadowed(new Rect(head.x, y, head.width, style.fontSize * 1.35f), clock, style, colour);

        var sub = new GUIStyle(_small) { alignment = TextAnchor.UpperCenter };
        string words = block.StartsIn ? "the same clock on every device - the round's own start"
                     : late ? "DELIVER BEFORE THE BLOCK IS MINED — OR LOSE THE LOAD"
                            : "the block is the round · arrive before it closes";
        if (FitLine(sub, words, head.width, 10))
            Shadowed(new Rect(head.x, y + size * 1.2f, head.width, sub.fontSize * 1.6f), words, sub,
                     new Color(1f, 1f, 1f, late ? 0.95f : 0.6f));
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

    /// <summary>
    /// HOW LONG THE RESULT CARD STANDS: 8 s (2026-09-25 21:53: "The result screen stays up 3 seconds longer. It
    /// holds 5 s now ... Make that 8 s"). Full strength for most of it, the last 28% a fade. The lobby's own hold,
    /// SplashScreen.ResultHoldSeconds, is this same number - one clock - and the lobby waits for the card in any case.
    /// </summary>
    public const float ArrivalHoldSeconds = 8f;

    /// <summary>
    /// THE CARD STANDS WHILE THE NEXT ROUND IS COMING (2026-09-29 21:58, SPECTATE-2158): its 8 s, and on for as
    /// long as the page takes the player to the next round - until "exit game" or that round's start - instead of the lobby.
    /// </summary>
    public static float ArrivalHoldFor(bool continuing) => continuing ? float.MaxValue : ArrivalHoldSeconds;
    // AND WHILE THIS RUN'S RESULT IS NOT SIGNED YET (2026-10-04, option 1): the seats sign at the round's close, so with
    // continue off the card - and the lobby behind it (SplashScreen.LobbyMayCover) - waits for the page's `hold` to clear.
    float ArrivalHoldNow => ArrivalHoldFor(SplashScreen.Continuing || ResultHolding);

    /// <summary>The result summary the page read says hold the card: this run is not signed yet, its round's close + 10 s not passed.</summary>
    public bool ResultHolding { get; private set; }

    /// <summary>The last ending was a miss, not a delivery: with the hold open-ended, only the newer of the two counts.</summary>
    bool LastEndingWasMiss() => gate.MissedAt >= 0f && Time.unscaledTime - gate.MissedAt <= gate.SinceDelivery;

    /// <summary>The fold control's words, exactly.</summary>
    public const string FoldLabel = "fold";
    public const string ShowResultLabel = "show result";
    bool _cardFolded;
    float _foldEnding = float.NaN;

    /// <summary>
    /// THIS RUN'S ENDING, NOT AN OLDER ONE (measured on WASTED at 0.0.2306: "DELIVERED 0 BTC to the miners" over the wreck -
    /// with the hold open-ended while the next round comes, a delivery that never happened on this page, SinceDelivery's
    /// 999 s, and any earlier run's delivery counted as this ending). Only an ending after this run's roll out has a card.
    /// </summary>
    bool EndingIsThisRuns(bool missed)
    {
        float endAt = missed ? gate.MissedAt : Time.unscaledTime - gate.SinceDelivery;
        if (!missed && gate.SinceDelivery >= 900f) return false;                 // never delivered on this page
        return loadout == null || endAt >= loadout.ConfirmedAt - 0.01f;
    }

    /// <summary>Folded is this ending's choice: a new ending (another delivery or miss instant) shows its card again.</summary>
    void FoldResetsFor(float endingAt)
    {
        if (float.IsNaN(_foldEnding) || Mathf.Abs(endingAt - _foldEnding) > 0.5f) { _foldEnding = endingAt; _cardFolded = false; }
    }

    /// <summary>The fold control's place: under the card's bottom edge, at its right - over none of the card's lines.</summary>
    public static Rect FoldTab(Rect card, int h, int fontSize, string label, GUIStyle style)
    {
        float bw = style != null ? Measure(style, label).x + fontSize * 1.6f : fontSize * 8f;
        float bh = fontSize * 2.2f;
        // above the next round's box while it stands, else above the screen's edge as before
        float limit = SplashScreen.Continuing ? CardFloor(h, true, SplashScreen.NextBoxTop) : h - 4f;
        float y = Mathf.Min(card.yMax + 4f, limit - bh);
        return new Rect(card.xMax - bw, y, bw, bh);
    }

    /// <summary>Is the arrival card on screen this frame? (Folded, it is not: the game underneath is.)</summary>
    public bool ArrivalShowing => !_cardFolded && ArrivalHeld;

    /// <summary>
    /// Is this ending's card held - on screen or folded? Folded, the card-less endings' lone "copy game replay" does not
    /// stand in for it (measured folded: that control appeared mid-screen over the game the fold was for).
    /// </summary>
    public bool ArrivalHeld
    {
        get
        {
            if (gate == null || ArrivalIsHiddenBy(SendOffShowing)) return false;
            float Hold = ArrivalHoldNow;
            bool missed = LastEndingWasMiss() && Time.unscaledTime - gate.MissedAt < Hold;
            if (!(missed || gate.SinceDelivery < Hold)) return false;
            return EndingIsThisRuns(missed);
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
        string sendOff = "DELIVERING  " + loadout.ConfirmedSats.ToString("N0", CultureInfo.InvariantCulture) + " sat  TO THE MINERS";
        FitInto(big, sendOff, card.width - 16f, 11);
        FitInto(sub, "GOOD LUCK!", card.width - 16f, 10);

        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.8f * k);
        GUI.DrawTexture(card, _flat);
        GUI.color = new Color(1f, 0.86f, 0.35f, 0.5f * k);
        GUI.DrawTexture(new Rect(card.x, card.y, card.width, 2f), _flat);
        GUI.DrawTexture(new Rect(card.x, card.yMax - 2f, card.width, 2f), _flat);
        GUI.color = Color.white;

        big.normal.textColor = new Color(1f, 0.86f, 0.35f, k);
        GUI.Label(new Rect(card.x, card.y + padY, card.width, head * 1.4f), sendOff, big);

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
        // A CARD THAT IS GONE TAKES ITS "copied!" WITH IT - but only when no copy control is up at all (2026-09-29
        // 17:45, SEE-AND-COPIED-1745: on WRECKED - no result card - this reset ran every frame and wiped the lone
        // control's press before the page answered, so "copied!" never stood). DrawCopyReplayAlone resets it then.
        if (ArrivalIsHiddenBy(SendOffShowing)) return;

        float Hold = ArrivalHoldNow;
        bool missed = LastEndingWasMiss() && Time.unscaledTime - gate.MissedAt < Hold;
        float since = missed ? Time.unscaledTime - gate.MissedAt : gate.SinceDelivery;
        if (!missed && gate.SinceDelivery >= Hold) return;
        if (!EndingIsThisRuns(missed)) return;
        FoldResetsFor(missed ? gate.MissedAt : Time.unscaledTime - gate.SinceDelivery);

        // FULL STRENGTH FOR THE WHOLE HOLD (PRIORITIES item 3: "it stays up ... 8 s"). It faded over the last 28% -
        // from 5.76 s, nearly gone by 7.5 s, measured live 2026-09-26 - so the readable card stood about 6 s of the 8.
        // The lobby takes over at 8 s; until then nothing about the card gets harder to read.
        float k = 1f;

        string headline = ArrivalHeadline(missed, gate.LastBtc);
        string scoreLine = ArrivalScoreLine(missed, runScore == null ? 0 : runScore.LastScore);
        string workLine = runScore == null ? "" : ArrivalWorkLine(missed, runScore.LastCargo, runScore.LastExposure, runScore.LastTime, runScore.LastScore);
        string footLine = ArrivalFootLine(missed);
        // NO WHO-LEADS ROW AND NO RUN-STOPPED SENTENCE (2026-09-29 21:01 CARD-NARROW-2101 and 21:03
        // NO-STOPPED-LINE-2103): LEVEL / BULLS / BEARS and the lead percent (ChartHud.LiveLeading) do not belong on the
        // result, and "RUN STOPPED - the core said DELIVERED at tick N" goes on every ending. The headline says the ending.

        // Sized off the WIDTH, not the smaller dimension, and scaled together to keep the card's bottom on screen.
        float head0 = CardHead(w, h, true);
        var probe = CardIn(w, h, 10f);
        // COPY GAME REPLAY, on the card whenever the run that just ended is one the bridge kept (2026-09-27 13:19:
        // every ending, the run that just ended and not the one before - `ArenaCore.ReplayForThisRun`, taken at the end
        // from the session ROLL OUT found for this run). No longer waiting for the session's closing word as well.
        bool replay = runScore != null && Arena.ArenaCore.ReplayForThisRun;
        // THE RESULT SUMMARY (2026-10-04): under SCORE, above "copy game replay", on a networked run's card
        if (replay) ReadSummary(w, h, head0); else { _summaryLines.Clear(); ResultHolding = false; }
        int summary = _summaryLines.Count;
        float scale = ArrivalScale(w, h, head0, 0f, false, replay, summary);
        int head = Mathf.RoundToInt(head0 * scale);
        var big = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold, fontSize = head };
        var mid = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold, fontSize = Mathf.RoundToInt(ArrivalMidFont(head)),
        };
        var line = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter, fontSize = Mathf.RoundToInt(ArrivalLineFont(head)) };

        // EVERY LINE IS FITTED ON THE LINE THAT IS DRAWN, not on a sample of it (the owner's 13:05 shot
        // delivered-text-clip-1305.jpg: the headline ran off both sides of the card).
        FitInto(big, headline, probe.width - 16f, 11);
        FitInto(mid, scoreLine, probe.width - 16f, 10);
        FitInto(line, workLine.Length > footLine.Length ? workLine : footLine, probe.width - 16f, 9);

        // THE ROWS FROM THE FONTS THAT ARE DRAWN, and the card from the rows.
        float padY = head * 0.55f;
        float[] heights = ArrivalRowHeights(big.fontSize, mid.fontSize, line.fontSize, 0f, false, replay, summary);
        var card = CardIn(w, h, ArrivalHeight(padY, heights));
        var rows = ArrivalRows(card, padY, heights);

        // THE CARD FOLDS (2026-09-29 22:00, PRIORITIES item 2): a control under the card collapses it so the game
        // and spectating are what is seen; "show result" brings it back - during its 8 s and during the countdown.
        var foldStyle = new GUIStyle(GUI.skin.button) { fontSize = Mathf.Max(11, line.fontSize), fontStyle = FontStyle.Bold };
        if (_cardFolded)
        {
            if (GUI.Button(FoldTab(card, h, foldStyle.fontSize, ShowResultLabel, foldStyle), ShowResultLabel, foldStyle)) _cardFolded = false;
            return;
        }
        if (GUI.Button(FoldTab(card, h, foldStyle.fontSize, FoldLabel, foldStyle), FoldLabel, foldStyle)) _cardFolded = true;

        // OPAQUE ENOUGH TO READ (18:39: the truck's cab and the road showed through "BULLS LEADING" and the factors).
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.96f * k);
        GUI.DrawTexture(card, _flat);
        GUI.color = new Color(1f, 0.86f, 0.35f, 0.5f * k);
        GUI.DrawTexture(new Rect(card.x, card.y, card.width, 2f), _flat);
        GUI.DrawTexture(new Rect(card.x, card.yMax - 2f, card.width, 2f), _flat);
        GUI.color = Color.white;

        // THE GAME'S MARK ON ITS RESULT: the icon in the card's top right corner, and its name beside it where
        // the card is wide enough that the name stays clear of the centred headline
        {
            float s = Mathf.Clamp(rows[0].height * 0.62f, 16f, 30f);
            var icon = new Rect(card.xMax - s - 8f, card.y + 6f, s, s);
            NextBlockMark.DrawIcon(icon, k);
            if (card.width >= 560f)
            {
                var tag = new GUIStyle(line) { alignment = TextAnchor.MiddleRight, fontStyle = FontStyle.Bold,
                    fontSize = Mathf.Max(10, Mathf.RoundToInt(line.fontSize * 0.75f)) };
                tag.normal.textColor = new Color(1f, 0.86f, 0.35f, 0.7f * k);
                GUI.Label(new Rect(icon.x - 220f, icon.y, 214f, s), NextBlockMark.Name, tag);
            }
        }

        int r = 0;
        big.normal.textColor = missed ? new Color(1f, 0.42f, 0.36f, k) : new Color(Up.r, Up.g, Up.b, k);
        GUI.Label(Inset(rows[r++]), headline, big);

        if (runScore == null) return;

        mid.normal.textColor = new Color(1f, 0.86f, 0.35f, k);
        GUI.Label(Inset(rows[r++]), scoreLine, mid);
        // The working, which is the whole point of showing a score at all: it is where the player reads WHY a careful
        // full run scored 40 and a reckless half-empty one scored 700.
        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.92f);
        GUI.Label(Inset(rows[r++]), workLine, line);
        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.62f);
        GUI.Label(Inset(rows[r++]), footLine, line);

        if (summary > 0)
        {
            var sl = new GUIStyle(line);
            for (int i = 0; i < summary; i++)
            {
                // the names and the high score bright, this player's line in gold, the balance list quieter
                sl.fontStyle = i == 2 ? FontStyle.Bold : FontStyle.Normal;
                sl.normal.textColor = i == 2 ? new Color(1f, 0.86f, 0.35f, k) : new Color(1f, 1f, 1f, k * (i < 2 ? 0.92f : 0.75f));
                FitInto(sl, _summaryLines[i], rows[r].width - 16f, 9);
                GUI.Label(Inset(rows[r++]), _summaryLines[i], sl);
                sl.fontSize = line.fontSize;
            }
        }

        if (replay) DrawCopyReplay(rows[r++], line.fontSize, line);
    }

    /// <summary>
    /// THE RESULT SUMMARY'S LINES, from the round result the page read (ArenaCore.ResultSummary, refreshed by the page every
    /// 2 s while the card is up), re-read here twice a second. All of them while the card fits unshrunk; when it would have
    /// to shrink and more than three players are listed, the balance list is cut to three rows and "and N more".
    /// </summary>
    void ReadSummary(int w, int h, float head0)
    {
        if (Time.unscaledTime - _summaryReadAt < 0.5f) return;
        _summaryReadAt = Time.unscaledTime;
        string json = Arena.ArenaCore.ResultSummary();
        if (json == _summaryJson) return;
        _summaryJson = json;
        var wire = ResultSummary.Parse(json);
        ResultHolding = wire != null && wire.hold;
        _summaryLines = ResultSummary.Lines(wire);
        if (wire != null && wire.players.Length > 3 && ArrivalScale(w, h, head0, 0f, false, true, _summaryLines.Count) < 1f)
            _summaryLines = ResultSummary.Lines(wire, 3);
        Debug.Log("[arena] result summary" + (ResultHolding ? " (holding)" : "") + ": " + string.Join(" | ", _summaryLines));
    }

    System.Collections.Generic.List<string> _summaryLines = new System.Collections.Generic.List<string>();
    string _summaryJson;
    float _summaryReadAt = -10f;

    /// <summary>
    /// THE ONE "copy game replay" CONTROL, on whatever says the run is over: the result card's own row, or - on the
    /// endings with no card, WASTED and a run the timer or a VOID stopped, and an empty truck - its own row under the
    /// WASTED band (2026-09-27 13:19: "After every round end he must be able to copy a replay").
    /// </summary>
    void DrawCopyReplay(Rect row, int fontSize, GUIStyle line)
    {
        {
            var button = new GUIStyle(GUI.skin.button) { fontSize = fontSize, fontStyle = FontStyle.Bold };
            float bw = Mathf.Min(row.width - 16f, Measure(button, CopyReplayLabel).x + fontSize * 2f);
            // BESIDE, NOT ON (SEE-AND-COPIED-1745, measured on WRECKED's narrow row: the tip covered "…ay"): while "copied!"
            // stands, the button and the tip are centred together, side by side, inside the row
            var tipStyle = new GUIStyle(line) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            float tipW = Measure(tipStyle, CopiedLabel).x + line.fontSize, gap = line.fontSize * 0.5f;
            bool tipUp = CopiedTooltipShows(_copiedAt, Time.unscaledTime);
            float pairW = tipUp ? Mathf.Min(row.width - 8f, bw + gap + tipW) : bw;
            if (tipUp) bw = Mathf.Max(fontSize * 4f, pairW - gap - tipW);
            var rect = new Rect(row.x + (row.width - pairW) * 0.5f, row.y + row.height * 0.15f, bw, row.height * 0.7f);
            if (GUI.Button(rect, CopyReplayLabel, button))
            {
                _replayCopied = Arena.ArenaCore.CopyReplay() == 1;
                Debug.Log("[arena] copy game replay: " + (_replayCopied ? "handed to the page" : "no networked run to copy"));
                if (_replayCopied) { _copyPressedAt = Time.unscaledTime; _copiedAt = -1f; }
            }
            // "copied!" (2026-09-26 07:12): once the page says the clipboard holds the link - its write resolved -
            // not on the press. Beside the button on its own row, so it covers no other line of the card.
            if (_copyPressedAt >= 0f && _copiedAt < 0f && Arena.ArenaCore.ReplayCopied)
            {
                _copiedAt = Time.unscaledTime;
                Debug.Log("[arena] copy game replay: copied! shown");
            }
            if (CopiedTooltipShows(_copiedAt, Time.unscaledTime))
            {
                var tip = new GUIStyle(line) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
                tip.normal.textColor = new Color(0.45f, 1f, 0.55f, 1f);
                float tw = tipW, th = rect.height;
                float tx = Mathf.Min(rect.xMax + gap, row.xMax - tw);
                var tipRect = new Rect(tx, rect.y, tw, th);
                PanelSkin.Gradient(tipRect, new Color(0.08f, 0.20f, 0.10f, 0.96f), new Color(0.05f, 0.14f, 0.07f, 0.96f));
                PanelSkin.Border(tipRect, new Color(0.45f, 1f, 0.55f, 0.9f));
                GUI.Label(tipRect, CopiedLabel, tip);
            }
        }
    }

    bool _replayCopied;
    float _copyPressedAt = -1f, _copiedAt = -1f;
    SplashScreen _splash;

    /// <summary>
    /// WHEN A PRESS OF "copy game replay" IS FORGOTTEN: only when neither the result card nor the lone control is up. Each
    /// frame either one is up, its press and its "copied!" stand (SEE-AND-COPIED-1745: WRECKED has only the lone control).
    /// </summary>
    public static bool CopyStateResets(bool cardShowing, bool loneShowing) => !cardShowing && !loneShowing;

    /// <summary>WHETHER THE LONE CONTROL IS DRAWN: a kept run to copy, no result card carrying it, the lobby not up.</summary>
    public static bool CopyReplayAlone(bool replayForThisRun, bool cardShowing, bool lobbyShowing)
        => replayForThisRun && !cardShowing && !lobbyShowing;

    /// <summary>The control's row where no card is up: under the WASTED band, centred, clear of the pads.</summary>
    public static Rect CopyReplayAloneRow(int w, int h)
    {
        float font = Mathf.Max(12f, Mathf.Min(w, h) * 0.034f);
        float rw = Mathf.Min(w - 32f, font * 16f);
        // just under the WASTED band (DrawWasted: h * 0.34, 1.5 of a font a sixth of the smaller side), wherever that is
        float bandBottom = h * 0.34f + Mathf.Min(w, h) * 0.17f * 1.5f;
        return new Rect((w - rw) * 0.5f, bandBottom + font * 0.6f, rw, font * 2.6f);
    }

    /// <summary>
    /// THE WRECK'S SUMMARY PANEL: under its lone copy-game-replay control, `lines` rows, its font shrunk (to 9 at least) so
    /// the panel ends above `floor` - the screen's edge, or the next round's box while it stands.
    /// </summary>
    public static Rect WreckSummaryPanel(int w, int h, int lines, float floor, out int fontSize)
    {
        var row = CopyReplayAloneRow(w, h);
        int lineFont = Mathf.RoundToInt(Mathf.Max(12f, Mathf.Min(w, h) * 0.034f));
        fontSize = Mathf.RoundToInt(lineFont * 0.8f);
        float lh = fontSize * 1.45f;
        var panel = new Rect(row.x - row.width * 0.25f, row.yMax + 4f, row.width * 1.5f, lh * lines + 8f);
        panel.x = Mathf.Max(8f, panel.x); panel.width = Mathf.Min(w - 16f, panel.width);
        if (panel.yMax > floor)
        {
            float k = Mathf.Max(0f, floor - panel.y) / panel.height;
            fontSize = Mathf.Max(9, Mathf.RoundToInt(fontSize * k));
            panel.height = fontSize * 1.45f * lines + 8f;
        }
        return panel;
    }

    bool _wreckSummaryUp, _scoreBlockWas = true;
    string _wreckPanelLogged;

    void DrawCopyReplayAlone(int w, int h)
    {
        if (_splash == null) _splash = Object.FindFirstObjectByType<SplashScreen>();
        bool lobby = _splash != null && _splash.Showing;
        bool alone = CopyReplayAlone(Arena.ArenaCore.ReplayForThisRun, ArrivalHeld, lobby);
        if (CopyStateResets(ArrivalHeld, alone)) { _copyPressedAt = -1f; _copiedAt = -1f; }
        if (!alone) { _wreckSummaryUp = false; return; }
        var row = CopyReplayAloneRow(w, h);
        var line = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter,
            fontSize = Mathf.RoundToInt(Mathf.Max(12f, Mathf.Min(w, h) * 0.034f)) };
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.85f);
        GUI.DrawTexture(row, _flat);
        GUI.color = Color.white;
        DrawCopyReplay(row, line.fontSize, line);

        // THE RESULT SUMMARY ON A WRECK TOO (2026-10-04): a wreck draws no card, so the same lines stand under its
        // lone control - and the lobby waits for the same hold (SplashScreen reads ResultHolding)
        ReadSummary(w, h, CardHead(w, h, true));
        _wreckSummaryUp = _summaryLines.Count > 0;
        if (_summaryLines.Count == 0) return;
        // ABOVE THE NEXT ROUND'S BOX while it stands, else above the screen's edge as before
        float panelFloor = SplashScreen.Continuing ? CardFloor(h, true, SplashScreen.NextBoxTop) : h - 4f;
        var panel = WreckSummaryPanel(w, h, _summaryLines.Count, panelFloor, out int summaryFont);
        var sl = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = summaryFont };
        float lh = sl.fontSize * 1.45f;
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.85f);
        GUI.DrawTexture(panel, _flat);
        GUI.color = Color.white;
        string panelTag = $"{w}x{h} {panel.x:0},{panel.y:0} {panel.width:0}x{panel.height:0} lines {_summaryLines.Count}";
        if (panelTag != _wreckPanelLogged && Event.current.type == EventType.Repaint)
        {
            _wreckPanelLogged = panelTag;
            Debug.Log($"[arena] wreck summary panel at {panelTag} (x {panel.xMin:0}..{panel.xMax:0}, y {panel.yMin:0}..{panel.yMax:0}); score block {(_scoreBlockWas ? "drawn" : "stepped aside")}");
        }
        for (int i = 0; i < _summaryLines.Count; i++)
        {
            sl.fontStyle = i == 2 ? FontStyle.Bold : FontStyle.Normal;
            sl.normal.textColor = i == 2 ? new Color(1f, 0.86f, 0.35f, 1f) : new Color(1f, 1f, 1f, i < 2 ? 0.92f : 0.75f);
            var r = new Rect(panel.x + 8f, panel.y + 4f + lh * i, panel.width - 16f, lh);
            FitInto(sl, _summaryLines[i], r.width, 9);
            GUI.Label(r, _summaryLines[i], sl);
        }
    }

    /// <summary>The tooltip's word, shown once the clipboard holds the replay link.</summary>
    public const string CopiedLabel = "copied!";
    /// <summary>How long "copied!" stands after the clipboard answered (the card may go first).</summary>
    public const float CopiedTooltipSeconds = 3f;
    public static bool CopiedTooltipShows(float copiedAt, float now) => copiedAt >= 0f && now - copiedAt < CopiedTooltipSeconds;

    static Rect Inset(Rect row) => new Rect(row.x + 8f, row.y, row.width - 16f, row.height);

    /// <summary>
    /// THE FOUR LINES OF THE ARRIVAL CARD, as strings, so the fit is measured on what is drawn.
    ///
    /// Also the reason the separator is a hyphen and the numbers are invariant: the em dash drew as a blank in the
    /// build's font (13:05 shot: "those fees go to the miners   the score is what the run pays you") and the
    /// decimals came out under the browser's culture ("load 0,83" on a German machine) - this build speaks English.
    /// </summary>
    /// BTC TO THE MINERS, NOT SAT FEES (2026-09-29 21:48, CARGO-BTC-2148): the truck carries transactions' BTC.
    public static string ArrivalHeadline(bool missed, double btc) =>
        missed ? "BLOCK MINED WITHOUT YOU"
               : "DELIVERED  " + LoadoutPanel.BtcLabel(btc) + " to the miners";

    /// <summary>The live DANGER meter's words: the core's E (RunScore.Exposure), to two decimals.</summary>
    public static string DangerLabel(float coreE) => "DANGER  ×" + coreE.ToString("0.00", CultureInfo.InvariantCulture);

    public static string ArrivalScoreLine(bool missed, int score) =>
        missed ? "SCORE  0" : "SCORE  +" + CoreScoreFactors.Points(score);

    /// <summary>
    /// THE CORE'S FACTORS AND THEIR PRODUCT (2026-09-25: "load C x danger E x speed T x 1000 = S"). C, E and T to
    /// FIVE decimals (RULED): at four, lanes 10.2 and -10.2 printed C 0.7000 and E 0.2662 for an exact product of 279.461,
    /// and 1000 x 0.7000 x 0.2662 x 1.5 rounds to 280 against the core's 279; at five the printing error is about 0.02
    /// point. S is the core's own S_DELIVERED integer, the same number as the SCORE line. A missed run prints no product:
    /// its C x E x T is not its 0.
    /// </summary>
    public static string ArrivalWorkLine(bool missed, float cargo, float exposure, float time) =>
        ArrivalWorkLine(missed, cargo, exposure, time, null);

    public static string ArrivalWorkLine(bool missed, float cargo, float exposure, float time, int? score) =>
        missed ? "the freight never reached the block"
               : "load " + cargo.ToString("0.00000", CultureInfo.InvariantCulture)
                 + "   ×   danger " + exposure.ToString("0.00000", CultureInfo.InvariantCulture)
                 + "   ×   speed " + time.ToString("0.00000", CultureInfo.InvariantCulture)
                 + "   ×  1000" + (score.HasValue ? "  =  " + CoreScoreFactors.Points(score.Value) : "");

    // NOT "your stake came back". There is no stake in this game: nobody deposits anything, so nothing returns. That
    // was multiplayer vocabulary imported into a build that has no multiplayer, and it described a mechanic the
    // player had never taken part in. The sats are the FEES of the transactions being hauled - they belong to the
    // miner, which is why the headline says delivered to the miners.
    public static string ArrivalFootLine(bool missed) =>
        missed ? "the BTC never reached the block - beat the clock next time"
               : "that BTC goes to the miners - the score is what the run pays you";

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
        Shadowed(new Rect(pad * 1.5f, y, bw, lh), block.StartsIn ? $"starts in {secs / 60}:{secs % 60:00}" : $"{secs / 60}:{secs % 60:00} left", line,
                 new Color(1f, 1f, 1f, 0.85f));
        y += lh * BlockRows[3];
        Shadowed(new Rect(pad * 1.5f, y, bw, lh),
                 $"in this block: {LoadoutPanel.BtcLabel(block.PendingBtc)}",
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
        if (Arena.ArenaCore.RunState != 0) return;

        float heat = Arena.ArenaCore.Heat;
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
    /// <summary>
    /// ONE LINE, WHOLE, OR NOT AT ALL (2026-09-29 21:18, CLIP-2118: on his phone "24h" under the percent was cut in
    /// half by its row, "UNDER FIRE" was clipped to a lone red R in the gap, and a log line started off the card's left
    /// edge). The label is not wrapped; its font shrinks to fit `width`, down to `floor`; and if it still does not fit
    /// the caller draws nothing rather than a clipped piece of it.
    /// </summary>
    public static bool FitLine(GUIStyle style, string line, float width, int floor)
    {
        if (string.IsNullOrEmpty(line)) return false;
        style.wordWrap = false;
        style.clipping = TextClipping.Overflow;
        FitInto(style, line, width, floor);
        return Measure(style, line).x <= width + 0.5f;
    }

    static void FitInto(GUIStyle style, string line, float width, int floor)
    {
        if (width <= 1f || string.IsNullOrEmpty(line)) return;
        for (int pass = 0; pass < 4; pass++)
        {
            float need = Measure(style, line).x;
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
    public Rect CardIn(int w, int h, float height)
    {
        float pad = Mathf.Max(10f, h * 0.022f);
        // A PHONE HELD UPRIGHT GETS THE WIDTH (2026-09-29 21:01, CARD-NARROW-2101: on his phone the centre column
        // broke RUN STOPPED and DELIVERED mid-word). The gap between the columns there is a strip; the card takes the
        // screen's width under the left column (SIM, the column's last box) for the eight seconds it stands.
        if (h > w)
        {
            float wide = w - 2f * Mathf.Max(8f, w * 0.03f);
            return new Rect((w - wide) * 0.5f, SimBox(w, h).yMax + pad, wide, height);
        }
        var head = HeadlineBox(w, h);
        if (head.width <= 0f)
        {
            float wide = Mathf.Min(w * 0.92f, 900f);
            return new Rect((w - wide) * 0.5f, h * 0.20f, wide, height);
        }
        return new Rect(head.x, BlockTimerBox(w, h).yMax + pad, head.width, height);
    }

    /// <summary>
    /// THE ARRIVAL CARD'S ROWS, IN ONE PLACE (the owner's playtest 2026-09-25 18:39, two shots at 2048x887).
    ///
    /// Measured on the shot: "RUN STOPPED - the core said DELIVERED at tick 4596" was drawn across the headline (the
    /// row stood under the block clock, and so did the card), and the foot line ran out under the card's bottom edge -
    /// the box was sized with mid = 0.52 x head and line = 0.40 x head while the draw used 0.82 and 0.48, so the card was
    /// shorter than what was drawn in it. Now the box and the draw read the same fonts and the same rows: the run-stopped
    /// sentence is the card's first row (the card owns the centre while it is up; the sentence is not shortened), then
    /// the headline, the score, who leads, the factors and the foot line - each row as tall as the line drawn in it, one
    /// under another, none crossing the next.
    /// </summary>
    public static float ArrivalMidFont(float head) => Mathf.RoundToInt(head * 0.82f);
    public static float ArrivalLineFont(float head) => Mathf.RoundToInt(head * 0.48f);
    public static float RunStoppedFont(int w, int h) => Mathf.RoundToInt(Mathf.Min(w, h) * 0.030f);

    /// <summary>COPY GAME REPLAY (2026-09-25 18:39): the control's label, exactly.</summary>
    public const string CopyReplayLabel = "copy game replay";

    public static float[] ArrivalRowHeights(float head, float mid, float line, float stoppedHeight, bool lead)
        => ArrivalRowHeights(head, mid, line, stoppedHeight, lead, false);

    public static float[] ArrivalRowHeights(float head, float mid, float line, float stoppedHeight, bool lead, bool replay)
        => ArrivalRowHeights(head, mid, line, stoppedHeight, lead, replay, 0);

    public static float[] ArrivalRowHeights(float head, float mid, float line, float stoppedHeight, bool lead, bool replay, int summary)
    {
        var rows = new System.Collections.Generic.List<float>();
        if (stoppedHeight > 0f) rows.Add(stoppedHeight);
        rows.Add(head * 1.35f);                 // the headline
        rows.Add(mid * 1.3f);                   // SCORE
        if (lead) rows.Add(mid * 1.3f);         // who is leading
        rows.Add(line * 1.7f);                  // the factors
        rows.Add(line * 1.7f);                  // the foot line
        for (int i = 0; i < summary; i++) rows.Add(line * 1.45f);   // the result summary (ResultSummary), under SCORE
        if (replay) rows.Add(line * 2.4f);      // copy game replay: a networked run's
        return rows.ToArray();
    }

    public static float ArrivalHeight(float padY, float[] rows)
    {
        float sum = padY * 2f;
        foreach (float r in rows) sum += r;
        return sum;
    }

    /// <summary>Each row's rect, top to bottom inside the card: the rect a label is drawn in is the row it owns.</summary>
    public static Rect[] ArrivalRows(Rect card, float padY, float[] rows)
    {
        var out_ = new Rect[rows.Length];
        float y = card.y + padY;
        for (int i = 0; i < rows.Length; i++) { out_[i] = new Rect(card.x, y, card.width, rows[i]); y += rows[i]; }
        return out_;
    }

    /// <summary>
    /// THE NEXT ROUND'S BOX IS THE CARD'S FLOOR (MF 19 - measured unattended on 0.0.2523: "joining next round ·
    /// exit game" stood over the result summary's lines, "1 still driving" and "YOU PENDING"). From the run's end until the
    /// next start the page draws that box at 18% above the bottom (index.html #arena-next), and the card here was let down to
    /// 98% of the screen, so a card with its summary ran under the box. While the page takes the player to the next round
    /// (SplashScreen.Continuing) the card - and the fold control under it, `foldReserve` - ends above the box: at the top
    /// the page reports (`nextBoxTop`, a fraction of the canvas from its top), or at NextBoxTopDefault before it has drawn it.
    /// Not continuing, the floor is the screen's as before.
    /// </summary>
    public const float NextBoxTopDefault = 0.70f;
    public static float CardFloor(int h, bool continuing, float nextBoxTop, float foldReserve = 0f)
    {
        float bottom = h - Mathf.Max(8f, h * 0.02f);
        if (!continuing) return bottom;
        float top = nextBoxTop > 0.3f && nextBoxTop < 1f ? nextBoxTop : NextBoxTopDefault;
        return Mathf.Min(bottom, h * top - Mathf.Max(6f, h * 0.01f) - foldReserve);
    }

    /// <summary>The fold control's height and its gap, which stand under the card: what the floor keeps free for them.</summary>
    public static float FoldReserve(float head) => Mathf.Max(11f, ArrivalLineFont(head)) * 2.2f + 4f;

    /// <summary>This frame's floor for an arrival card whose unscaled headline font is `head`.</summary>
    float CardFloorNow(int w, int h, float head) => CardFloor(h, SplashScreen.Continuing, SplashScreen.NextBoxTop, FoldReserve(head));

    /// <summary>
    /// The card at a font scale that keeps its bottom on screen: when the rows are taller than the room under the block
    /// clock, every font shrinks by the same factor - the copy is not shortened.
    /// </summary>
    public float ArrivalScale(int w, int h, float head, float stoppedHeight, bool lead, bool replay = false, int summary = 0, float floor = -1f)
    {
        float padY = head * 0.55f;
        float height = ArrivalHeight(padY, ArrivalRowHeights(head, ArrivalMidFont(head), ArrivalLineFont(head), stoppedHeight, lead, replay, summary));
        float room = (floor >= 0f ? floor : CardFloorNow(w, h, head)) - CardIn(w, h, height).y;
        return height <= room || height <= 1f ? 1f : Mathf.Max(0.4f, room / height);
    }

    /// <summary>The arrival card of a networked run: headline, score, factors, foot line and the copy-game-replay control.</summary>
    public Rect ArrivalBox(int w, int h) => ArrivalBox(w, h, 0f, false, true);

    public Rect ArrivalBox(int w, int h, float stoppedHeight, bool lead, bool replay = false, float floor = -1f, int summaryLines = -1)
    {
        float head = CardHead(w, h, true);
        int summary = replay ? (summaryLines >= 0 ? summaryLines : _summaryLines.Count) : 0;
        float k = ArrivalScale(w, h, head, stoppedHeight, lead, replay, summary, floor);
        head *= k;
        return CardIn(w, h, ArrivalHeight(head * 0.55f,
            ArrivalRowHeights(head, ArrivalMidFont(head), ArrivalLineFont(head), stoppedHeight * k, lead, replay, summary)));
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
        StreamingRoom(w, h, items, out float x, out float width, out float top, out _);
        return new Rect(x, top, width, StreamingLineHeight(w, h, items) * (items + 1) + pad);
    }

    /// <summary>
    /// THE ROOM THE MODEL LIST MAY USE, UNDER HIGH / LOW. Live 0.0.1497 (probe on-12.png, 1280x656): HIGH / LOW (central, the owner
    /// 12:55) and the list both started under the block clock in the headline gap and were painted on each other - measured
    /// 9382 px shared at 1280x800, 8207 at 1280x656, 4588 at 844x390, 3574 at 390x844 - and at 1280x800 with pads the list
    /// also lay on the right steering pad. HIGH / LOW keeps its row; the list starts under that row's box (asked at the
    /// painter's row height), moves right of the steering pads where the gap still holds it, and ends above whatever stands
    /// below it in its own columns - a pad or the HUD chart - or the screen's edge.
    /// </summary>
    public void StreamingRoom(int w, int h, int items, out float x, out float width, out float top, out float bottom)
        => StreamingRoom(w, h, !HighLowYieldsToModelList(w, h, items), out x, out width, out top, out bottom);

    /// <summary>
    /// HIGH / LOW YIELDS WHILE MODELS LOAD ONLY WHERE THE LIST CANNOT FIT UNDER IT - measured, not guessed. The one shape of
    /// the five checked (HudLayoutTests): a phone held upright, 390x844, where under HIGH / LOW the room is 356.6..504.9
    /// px (the HUD chart stands at 521.8 in the same columns) and eleven rows at the 13 px font need 172.9 - 24.6 px short.
    /// There the list keeps its old corner and HIGH / LOW is not painted while the list loads; everywhere else both show.
    /// Asked with the rows the list really draws (ModelListRows), not a fixed eleven.
    /// </summary>
    public bool HighLowYieldsToModelList(int w, int h, int items)
    {
        StreamingRoom(w, h, true, out _, out _, out float top, out float bottom);
        float need = SmallFont(w, h) * (items + 1) + Mathf.Max(8f, h * 0.02f);
        return bottom - top < need;
    }

    /// <summary>
    /// The model rows the list draws. All of them while models load; once loading has settled and something failed, the
    /// list stays up for the failure (it would otherwise retire), and where the full list does not fit under HIGH / LOW -
    /// a phone held upright - it keeps only the failed rows, which do fit, so HIGH / LOW is not hidden for the whole session.
    /// </summary>
    public int ModelListRows(int w, int h)
    {
        if (streamer == null) return 0;
        int all = streamer.Items.Count;
        bool settledOnAFailure = streamer.AllDone && streamer.Failed > 0 && streamer.SinceDone > 4f;
        return settledOnAFailure && HighLowYieldsToModelList(w, h, all) ? streamer.Failed : all;
    }

    void StreamingRoom(int w, int h, bool underHighLow, out float x, out float width, out float top, out float bottom)
    {
        float pad = Mathf.Max(8f, h * 0.02f);
        var head = HeadlineBox(w, h);
        var chart = HudChartPanel(w, h);
        var highLow = HighLowBox(w, h, w, ChartHud.RowHeight(chart.height) + 4f);
        float below = underHighLow ? highLow.yMax + pad : 0f;
        if (head.width <= 0f)
        {
            // no gap beside the left column (a phone held upright): the right-hand corner, under HIGH / LOW where it fits
            width = Mathf.Min(290f, w * 0.34f);
            x = w - width - pad;
            top = Mathf.Max(h * 0.30f, below);
        }
        else
        {
            width = Mathf.Min(290f, head.width);
            x = head.x;
            if (PadsShown)
            {
                float clear = TouchPad.RectFor(TouchPad.Pad.Right, w, h).xMax + pad;
                if (x < clear && clear + width <= head.xMax) x = clear;
            }
            top = Mathf.Max(BlockTimerBox(w, h).yMax + pad, below);
        }
        bottom = h - pad;
        float l = x, r = x + width, t = top, floor = bottom;
        void Below(Rect o) { if (o.width > 0f && o.xMax > l && o.x < r && o.y >= t) floor = Mathf.Min(floor, o.y - pad); }
        if (PadsShown)
            foreach (var p in new[] { TouchPad.Pad.Left, TouchPad.Pad.Right, TouchPad.Pad.Up, TouchPad.Pad.Down, TouchPad.Pad.Handbrake })
                Below(TouchPad.RectFor(p, w, h));
        Below(chart);
        bottom = floor;
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
        StreamingRoom(w, h, items, out _, out _, out float top, out float bottom);
        float room = bottom - top - pad;
        if (room <= 0f) return SmallFont(w, h);
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
                           SettingsRect(TouchPad.Pad.Debug, w, h).yMax + lh * 0.6f,
                           bw, lh * lines + lh * 0.6f);

        // AND IT IS NOT DRAWN AT ALL WHERE IT WOULD PUSH THE SCORE OFF THE
        // SCREEN. The score column steps under this panel, and on a 360-tall
        // window there is not room for both: measured, the column ended at
        // y=365 of 360. Of the two, one is eight lines of developer numbers
        // behind a toggle and the other is what the player is playing for, so
        // where they do not both fit the readout goes.
        if (box.yMax + pad * 0.5f + ManifestContentHeight(w, h) > h) return new Rect();
        // nor onto the pads when they are up
        if (PadsShown && box.yMax > TouchPad.RectFor(TouchPad.Pad.Up, w, h).y) return new Rect();
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
    /// WHERE A BROKEN CONNECTION IS SAID (2026-09-18 20:04): directly under the corner where the market note
    /// sits, in the small style, on the HUD a player is already reading. Not the headline, and not the sky.
    /// </summary>
    public Rect TroubleBox(int w, int h) =>
        new Rect(w * 0.02f, h * 0.012f + SmallFont(w, h) * 1.7f, w * 0.55f, SmallFont(w, h) * 1.6f);

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
        // Under the buttons and the readout - which, on the desktop with the HUD chart top right, stand under the chart.
        float corner = ChartCorner(w, h) + pad * 0.5f;
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
        // On a phone held upright the chart stands over the left / right controls: the column keeps right of it.
        if (Mobile && h > w)
        {
            var chart = MobileChartPanel(w, h);
            if (top < chart.yMax && top + height > chart.y) left = Mathf.Max(left, chart.xMax + pad);
        }
        // With the HUD chart top right and no room under its row: bottom right, left of the pad block, on the screen.
        if (ChartTopRight(w, h) && !ScoreUnderRow(w, h))
        {
            float m = TouchPad.Margin(w, h);
            // AS WIDE AS IT WAS BEFORE THE CHART SHRANK (live 0.0.1508, 1280x656 with pads): its left edge is the headline gap's
            // right edge, which is the chart's left edge, so the 30% smaller chart (16:01) cut the column down and its lines
            // were clipped to "drop-off" and "0". Down here it keeps the strip the full-size chart left it.
            if (!Mobile) left = Mathf.Min(left, ChartPanel(w, h, ChartHud.BaseSize(w, h) * ChartHud.Scale).x - Mathf.Max(10f, h * 0.022f));
            float right = PadsShown ? Mathf.Min(TouchPad.RectFor(TouchPad.Pad.Handbrake, w, h).x, TouchPad.RectFor(TouchPad.Pad.Up, w, h).x) - pad * 0.5f : w - pad;
            return new Rect(left, h - m - height, Mathf.Max(0f, right - left), height);
        }
        return new Rect(left, top, w - pad - left, height);
    }

    /// <summary>
    /// How tall the score column's five rows actually are: the tail line, the
    /// caption, BANKED, SCORE and CARGO. Shared with the box, so the two
    /// cannot drift.
    /// </summary>
    /// <summary>
    /// A phone or tablet browser (Unity's mobile platform flag, taken from the browser on WebGL) - not "a touch screen":
    /// the owner's desktop reports one and shows the pads. Tests set <see cref="MobileOverride"/>.
    /// </summary>
    public static bool Mobile => MobileOverride ?? Application.isMobilePlatform;
    public static bool? MobileOverride;

    /// <summary>
    /// ON MOBILE, DIRECTLY ABOVE THE LEFT / RIGHT CONTROLS (2026-09-17 12:40: "MOBILE: HUD further down, directly
    /// ABOVE the left/right controls. Not mid-screen over the truck"). Its left edge at the left pad's, its bottom half a
    /// margin over the pads; as wide as 1.2x the old chart where that stops short of the throttle column, as tall as it is
    /// where the left column (PRACTICE / SIM) leaves the room. The score column keeps right of it.
    /// </summary>
    public Rect MobileChartPanel(int w, int h)
    {
        float m = TouchPad.Margin(w, h);
        var full = ChartHud.BaseSize(w, h) * ChartHud.Scale;
        var left = TouchPad.RectFor(TouchPad.Pad.Left, w, h);
        var up = TouchPad.RectFor(TouchPad.Pad.Up, w, h);
        float bottom = left.y - m * 0.5f;
        float width = Mathf.Max(0f, Mathf.Min(full.x, up.x - m * 0.5f - left.x));
        float height = Mathf.Max(0f, Mathf.Min(full.y, bottom - (SimBox(w, h).yMax + m * 0.5f)));
        return new Rect(left.x, bottom - height, width, height);
    }

    /// <summary>
    /// The pads are on screen (a touch screen as far as Unity knows). Tests set <see cref="PadsOverride"/>.
    ///
    /// MEASURED AND LEFT ALONE (2026-09-18 20:22): pointing this at "anything that can press a pad" is the honest
    /// question, and it showed that on a screen that draws the pads the score column has 55 px at 1024x768 and 57 at
    /// 1000x360 - it is squeezed between the model list and the handbrake pad, with nowhere else on the screen to go.
    /// That is a layout letter with its own measurements (TASKBOOK), not this one, and the numbers are written down.
    /// </summary>
    public static bool PadsShown => PadsOverride ?? TouchControls.TouchScreen;
    public static bool? PadsOverride;

    /// <summary>
    /// THE HUD CHART TOP RIGHT, ABOVE THE BUTTONS - EVERY SCREEN (2026-09-17 12:35, HARD FAIL: "the HUD is in the
    /// center covering the truck. It must sit TOP RIGHT, above the buttons. Not center, not over the steering arrows").
    /// His screen showed the pads, so the desktop-only rule of the last build left it in the middle. Measured from his
    /// screenshot: a Unity screen of about 3072x1515 (PRACTICE 200 px of the shot for its fixed 300 px). The chart takes the
    /// top-right corner at the margin, 1.2x wide; under it one row - the wanted pips, then the sound and debug buttons at
    /// the right; the score column goes under that row where there is room above the pads (or the screen's bottom), and
    /// otherwise to the bottom right, left of the pad block. The chart's height gives way (never its corner) where even
    /// then the column is short.
    /// </summary>
    public Rect ChartPanel(int w, int h) => ChartPanel(w, h, CornerFullSize(w, h));

    Rect ChartPanel(int w, int h, Vector2 full)
    {
        float m = TouchPad.Margin(w, h), pad = Mathf.Max(10f, h * 0.025f);
        bool under = ScoreUnderRow(w, h);
        float bottom = PadsShown ? TouchPad.RectFor(TouchPad.Pad.Up, w, h).y - pad * 0.6f : h - m;
        // the score column at the bottom right, when it is there, is below the chart's row too (measured at 1000x360
        // before: the column y 215-346 over the wanted row y 225-259)
        if (!under) bottom = Mathf.Min(bottom, h - m - ManifestContentHeight(w, h) - pad * 0.5f);
        float below = m * 0.5f + RowHeight(w, h) + m * 0.5f + (under ? pad * 0.5f + ManifestContentHeight(w, h) : 0f);
        // SCALED, NOT SQUEEZED (2026-09-17, L1: "scaled to the shorter height"): one factor for both sides, so it
        // fits the height and leaves the headline gap left of it a readable card's width (150 px)
        float gapPad = Mathf.Max(10f, h * 0.022f);
        float room = (w - m) - (HeadlineLeft(w, h) + 150f + gapPad);
        float k = Mathf.Clamp01(Mathf.Min(Mathf.Min((bottom - m - below) / full.y, room / full.x), (w - 2f * m) / full.x));
        return new Rect(w - m - full.x * k, m, full.x * k, full.y * k);
    }

    /// <summary>The headline gap's left edge: right of the left column (the same rule as <see cref="HeadlineBox"/>).</summary>
    float HeadlineLeft(int w, int h)
    {
        float gapPad = Mathf.Max(10f, h * 0.022f);
        float blockRight = gapPad + Mathf.Min(300f, w * 0.24f) + gapPad;
        return Mathf.Max(Mathf.Max(blockRight, PracticeBox(w, h).xMax), Mathf.Max(HealthBox(w, h).xMax, ExposureBox(w, h).xMax)) + gapPad;
    }

    /// <summary>
    /// The corner chart's full size: 1.2x the old chart, and on the desktop 30% smaller than that (2026-09-17 16:01,
    /// same corner). A phone on its side keeps the 1.2x.
    /// </summary>
    public Vector2 CornerFullSize(int w, int h) => ChartHud.BaseSize(w, h) * ChartHud.Scale * (Mobile ? 1f : ChartHud.DesktopScale);

    /// <summary>Whether the score column fits under the chart's row at the chart's full height; else it goes bottom right.</summary>
    bool ScoreUnderRow(int w, int h)
    {
        float m = TouchPad.Margin(w, h), pad = Mathf.Max(10f, h * 0.025f);
        var full = CornerFullSize(w, h);
        float bottom = PadsShown ? TouchPad.RectFor(TouchPad.Pad.Up, w, h).y - pad * 0.6f : h - m;
        return m + full.y + m * 0.5f + RowHeight(w, h) + m * 0.5f + pad * 0.5f + ManifestContentHeight(w, h) <= bottom;
    }

    float RowHeight(int w, int h) => Mathf.Max(WantedBoxBase(w, h).height, TouchPad.RectFor(TouchPad.Pad.Sound, w, h).height);

    /// <summary>
    /// Whether the HUD chart stands top right: whenever its corner holds a chart at least half its full height and the
    /// headline gap left of it stays wider than a readable card (150 px, HudLayoutTests' bar). Otherwise under SIM.
    /// </summary>
    public bool ChartTopRight(int w, int h)
    {
        // a phone held upright stands the chart over the drive pads; held on its side it is a wide screen with the same
        // right-side buttons, and takes this corner (L1, 2026-09-17)
        if (Mobile && h > w) return false;
        var chart = ChartPanel(w, h);
        return chart.height >= CornerFullSize(w, h).y * 0.5f - 0.01f;
    }

    /// <summary>
    /// The sound and debug buttons, where the HUD draws and clicks them: TouchPad's corner, or with the HUD chart top right,
    /// in the row under the chart, at the right margin (2026-09-17: "have the HUD above the sound button and the
    /// other button").
    /// </summary>
    public Rect SettingsRect(TouchPad.Pad pad, int w, int h)
    {
        var r = TouchPad.RectFor(pad, w, h);
        if (!ChartTopRight(w, h)) return r;
        r.y = ChartPanel(w, h).yMax + TouchPad.Margin(w, h) * 0.5f + (RowHeight(w, h) - r.height) * 0.5f;
        return r;
    }

    /// <summary>
    /// WHERE THE PAGE'S CONSOLE BUTTON GOES (2026-10-04: it sat on the chart's header). The page cannot see this HUD,
    /// so the HUD says, in its own pixels: the screen it laid out, the bottom of the top-right corner's furniture (chart,
    /// sound and menu row, wanted pips, debug readout - ChartCorner), the corner's right edge, and the throttle pad's
    /// rectangle the button must not land on. The page places the button from these alone.
    /// </summary>
    public string ConsoleSlot(int w, int h)
    {
        float m = TouchPad.Margin(w, h);
        var up = TouchPad.RectFor(TouchPad.Pad.Up, w, h);
        var I = CultureInfo.InvariantCulture;
        // AND THE WANTED / HUNTED CAPTION under the pips (measured 844x390 on 0.0.2515: the button covered "WANTED")
        float bottom = ChartTopRight(w, h) ? Mathf.Max(ChartCorner(w, h), WantedBox(w, h).yMax + SmallFont(w, h) * 1.6f) : ChartCorner(w, h);
        // AND THE FLOOR THE OPEN PANEL MUST STOP ABOVE: the cargo bay's top while the bay is up (measured 844x390 on 0.0.2519,
        // paid round: the panel covered HUNTED, LOAD and the right half of ROLL OUT), else the screen's bottom
        float floor = CargoBayUp() ? loadout.BottomBarRect(w, h).y : h;
        // AND, WITH THE BAY UP, BELOW THE CARGO CHOOSER (measured 1280x720 on 0.0.2521: the button at y 313 and the panel lay on
        // the chooser's bottom row of crates, which are tapped to load): the button goes into the band between the two
        if (CargoBayUp() && loadout.yard != null) bottom = Mathf.Max(bottom, loadout.yard.PanelRect(w, h).yMax);
        return "{\"w\":" + w + ",\"h\":" + h + ",\"top\":" + (bottom + m * 0.25f).ToString("0.#", I)
             + ",\"floor\":" + floor.ToString("0.#", I)
             + ",\"right\":" + (w - m).ToString("0.#", I) + ",\"padX\":" + up.x.ToString("0.#", I) + ",\"padY\":" + up.y.ToString("0.#", I)
             + ",\"padW\":" + up.width.ToString("0.#", I) + ",\"m\":" + m.ToString("0.#", I)
             // WHETHER THE PADS ARE DRAWN: the open console stands above the throttle pad only where there is one
             + ",\"pads\":" + (PadsShown ? 1 : 0) + "}";
    }
    string _consoleSlotSent;

    /// <summary>The cargo bay is drawn: open, and not behind the title or the lobby (LoadoutPanel.OnGUI's own rule).</summary>
    bool CargoBayUp()
    {
        if (loadout == null || !loadout.IsOpen || CleanHud.On) return false;
        if (_splash == null) _splash = Object.FindFirstObjectByType<SplashScreen>();
        return _splash == null || !_splash.Showing;
    }

    /// <summary>The bottom of the top-right corner's own furniture: the settings icons, or the debug readout when it is up.</summary>
    public float ChartCorner(int w, int h)
    {
        float corner = SettingsRect(TouchPad.Pad.Debug, w, h).yMax;
        if (ChartTopRight(w, h)) corner = Mathf.Max(corner, WantedBox(w, h).yMax);
        if (GameSettings.Debug)
        {
            var readout = DebugPanelBox(w, h, 8);
            if (readout.height > 0f) corner = readout.yMax;
        }
        return corner;
    }

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
    /// THE ASSAULT BANNER, under the block clock (2026-09-20 16:22: "a banner BULLS ASSAULT HIGH and a
    /// sound when it starts ... then HIGH TAKEN or ASSAULT ON HIGH FAILS").
    ///
    /// UNDER the clock and not over the price: the headline stack owns the top of the gap and 16:26 says the log
    /// must not overlap the price, which goes for the banner announcing the same war. It keeps its row whether or
    /// not a banner is showing, so the log below does not jump up the screen every time one ends.
    /// </summary>
    public Rect AssaultBannerBox(int w, int h)
    {
        var head = HeadlineBox(w, h);
        var timer = BlockTimerBox(w, h);
        return new Rect(head.x, timer.yMax + h * 0.010f, head.width, AssaultBannerFont(w, h) * 1.4f);
    }

    public static float AssaultBannerFont(int w, int h) => Mathf.Round(Mathf.Clamp(Mathf.Min(w, h) * 0.046f, 18f, 40f));

    /// <summary>
    /// THE DESKTOP ASSAULT LOG, ON THE LEFT HUD STACK UNDER SIM (2026-09-20 16:26 for the log itself, and
    /// 2026-09-20 18:0x for where it goes: "Left column. Under SIM, left-aligned, small font, same six assault
    /// lines, colour still by side. Not the right column - that edge already carries WANTED and the touch
    /// buttons, and the road has to stay clear").
    ///
    /// IT WAS IN THE MIDDLE OF THE SCREEN AND THE ROAD IS THE GAME. Written first into the headline gap under the
    /// block clock, it cleared the price as asked and then sat centred over the road the player is driving down -
    /// photographed on Daily 0.0.1835. The left column is where the game's own switches already live: BLOCK,
    /// CONDITION, DANGER, PRACTICE, SIM, and now this under them, on the same left edge and the same small font.
    ///
    /// The BANNER does not move. It is the loud thing and it is meant to be in front of the player; only the log,
    /// which is a debug line, goes to the edge.
    /// </summary>
    public Rect AssaultLogBox(int w, int h)
    {
        var sim = SimBox(w, h);
        float lh = SmallFont(w, h) * 1.45f;
        float top = sim.yMax + Mathf.Max(8f, h * 0.014f);
        float height = lh * AssaultWatch.Keep;

        // IN THE BAY IT STEPS BELOW THE CARGO PANEL, the same move `RunStoppedBox` makes and for the same
        // reason: IMGUI gives the driving HUD a depth BEHIND the loading window, so a box that overlaps the
        // panel is not a faint box, it is no box at all. The left column above is the panel's while it is open.
        if (loadout != null && loadout.IsOpen && loadout.yard != null)
        {
            float below = loadout.yard.PanelRect(w, h).yMax + Mathf.Max(6f, h * 0.010f);
            if (below > top) top = below;
            // AND IT STOPS ABOVE THE CAPACITY BAR. At 1280x800 the panel ends at 408 and the bar starts at
            // 570, so the column has 162 px - five lines, not six. The log keeps the NEWEST lines when it is
            // short (`AssaultLogLines` drops from the top), which is the half that matters: the line the
            // player has not read yet.
            float floorY = loadout.BottomBarRect(w, h).y - Mathf.Max(4f, h * 0.006f);
            if (floorY - top < height) height = Mathf.Max(lh, floorY - top);
        }

        // AND IT STAYS ON THE SCREEN. The left column already shrinks its switches when the room runs out
        // (PracticeBox), so on a short window this can still be handed a top with less than six lines under it.
        // It gives up lines from the TOP - the oldest - rather than running off the bottom edge.
        float room = h - Mathf.Max(10f, h * 0.025f) - top;
        if (height > room) height = Mathf.Max(lh, room);
        return new Rect(sim.x, top, Mathf.Max(sim.width, Mathf.Min(w * 0.30f, 330f)), height);
    }

    /// <summary>How many of the kept lines actually fit in the box, newest first when the column is short.</summary>
    public int AssaultLogLines(int w, int h)
        => Mathf.Clamp(Mathf.FloorToInt(AssaultLogBox(w, h).height / (SmallFont(w, h) * 1.45f)), 0, AssaultWatch.Keep);

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
        var r = WantedBoxBase(w, h);
        // with the HUD chart top right: in the row under it, left of the sound and debug buttons
        if (ChartTopRight(w, h))
        {
            float m = TouchPad.Margin(w, h);
            r.y = ChartPanel(w, h).yMax + m * 0.5f + (RowHeight(w, h) - r.height) * 0.5f;
            r.x = TouchPad.RectFor(TouchPad.Pad.Sound, w, h).x - m * 0.5f - r.width;
        }
        return r;
    }

    /// <summary>The wanted row's own place, top right, before the desktop HUD chart moves it down.</summary>
    public Rect WantedBoxBase(int w, int h)
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
        // On the desktop the HUD chart stands in the top right (T1): the gap ends left of it.
        if (ChartTopRight(w, h)) right = Mathf.Min(right, ChartPanel(w, h).x - pad);

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
        if (!runScore.Running && !Arena.PracticeMode.On) return;

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
                 DangerLabel(e), label,
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
            string say = Measure(warn, full).x <= warnBox.width - 6f
                       ? full
                       : (Measure(warn, brief).x <= warnBox.width - 6f
                          ? brief : full);
            // A MARGIN, because the fit was a pixel or two short and the
            // clipping takes it off the LEFT - "SCORE OUT HERE" where "NO
            // SCORE OUT HERE" was meant, which reads as the opposite. Six
            // pixels, and the fit is applied again after the round down.
            float room = warnBox.width - 6f;
            for (int pass = 0; pass < 3; pass++)
            {
                float need = Measure(warn, say).x;
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
    /// <summary>
    /// WHAT A PLAYER IS TOLD WHEN THE RUN STOPS, and what they are not.
    ///
    /// The client ends a run when it can no longer produce a transcript
    /// anybody could replay. Until this line existed the reason went to
    /// `Debug.Log` - the browser console - so the truck stopped and the player
    /// was told nothing at all.
    ///
    /// IT MUST NOT LOOK SETTLED. The client's word is `VOID`, and that is the
    /// protocol's name for what a COMMITTEE decides under the no-quorum rule -
    /// not something a browser may announce. What this client knows is that it
    /// cannot record any more of this round, so that is what is said, in the
    /// client's own words about the cause. What the entry pays is nobody's
    /// business here, and no word for it is printed.
    ///
    /// `ending` is `<WORD> <reason>` off the bridge, or empty while the run is
    /// alive. The word is dropped and the reason kept.
    /// </summary>

    /// <summary>
    /// UNDER THE HEADLINE STACK, not floating above it.
    ///
    /// Not `Rect(0, y, w, ...)` with the text centred, which is the mistake
    /// this file records making four times. But the gap alone was not enough:
    /// the first version hung this off `UnderFireBox` and photographed on the
    /// real player it landed straight across "BLOCK 965,982 · 0:55" and the
    /// drop-off marker, two lines of yellow over each other. The horizontal
    /// rule was obeyed and the vertical one had never been asked.
    ///
    /// So it is a ROW of the same stack the price, the liquidation line and
    /// the block clock are rows of: it starts where the block clock's box
    /// ends, and it moves when that one does.
    /// </summary>
    /// <summary>
    /// THE HIGH / LOW LINE'S PLACE, CENTRAL ON THE SCREEN (2026-09-17 12:55): the run-stopped row - reserved in the
    /// headline stack and empty while a run is on - centred on the screen where the gap allows, as wide as its text and never
    /// wider than the gap; where there is no gap (a phone held upright), centred under the block clock on the whole width.
    /// </summary>
    /// <summary>
    /// The panel the HUD chart is drawn in on this screen: above the left pad on a phone held upright, top right on the
    /// desktop, else under SIM off the pads. One place, so the chart painter and the layout tests ask the same question.
    /// </summary>
    public Rect HudChartPanel(int w, int h)
        => Mobile && h > w ? MobileChartPanel(w, h)
         : ChartTopRight(w, h) ? ChartPanel(w, h)
         : ChartHud.PanelFor(w, h, SimBox(w, h));

    public Rect HighLowBox(int w, int h, float width, float height)
    {
        var row = RunStoppedBox(w, h);
        var head = HeadlineBox(w, h);
        if (head.width <= 0f)
        {
            // no gap beside the left column (a phone held upright): under that column, centred - measured, in the row it
            // lay on the danger bar at 390x844
            float m = TouchPad.Margin(w, h);
            float wd = Mathf.Min(width, w - 2f * m);
            return new Rect((w - wd) * 0.5f, Mathf.Max(row.y, SimBox(w, h).yMax + m * 0.5f), wd, height);
        }
        float wd2 = Mathf.Min(width, head.width);
        float x = Mathf.Clamp(w * 0.5f - wd2 * 0.5f, head.x, head.xMax - wd2);
        return new Rect(x, row.y, wd2, height);
    }

    /// <summary>
    /// UNDER THE BLOCK CLOCK - UNLESS THE CARGO PANEL IS OVER THAT BAND (2026-09-20).
    ///
    /// The bay is where this line is needed MOST: a truck still choosing cargo when the block closes is the
    /// path that ends VOID, and it is the one the player cannot read. Measured at 1280x800, the two rects sat
    /// inside each other: the mempool panel is `panelTop 0.10` to `panelBottom 0.51`, y 80 to 408, and this box
    /// was y 326 to 393 - wholly behind it. Photographed both ways on one build: `ring-28.png` is the bay with
    /// the run VOID and no line on screen, `ring-11.png` is the road with the same VOID and the line plainly
    /// there. Same build, same state, different place.
    ///
    /// So when the panel is open the row drops just below it, and when it is not - the road, which is
    /// `ring-11` - nothing moves and that frame is unchanged. One row, one draw, no second HUD.
    ///
    /// AND IT IS TALL ENOUGH FOR THE LAST WORDS. At 1280x800 the copy wraps to three lines, about 83 px, and
    /// the box was `font * 2.8` = 67 px - so it cut at "error the round" and lost "is closed", which is the half
    /// that answers WHY. `font * 4.4` = 106 px holds all three. The copy is not shortened to fit.
    /// </summary>
    public Rect RunStoppedBox(int w, int h)
    {
        float font = Mathf.RoundToInt(Mathf.Min(w, h) * 0.030f);
        var clock = BlockTimerBox(w, h);
        float y = clock.yMax + font * 0.8f;
        if (loadout != null && loadout.IsOpen && loadout.yard != null)
        {
            float below = loadout.yard.PanelRect(w, h).yMax + font * 0.6f;
            if (below > y) y = below;
        }
        return new Rect(clock.x, y, clock.width, font * 4.4f);
    }

    /// <summary>
    /// Nothing else is drawn through the result card while it is up (18:39: the DROP-OFF / DELIVERED marker sat in the
    /// headline). Static so the rule is asserted without a scene.
    /// </summary>
    public static bool WaypointHiddenBy(bool arrivalShowing) => arrivalShowing;

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
        if (FitLine(style, "UNDER FIRE", UnderFireBox(w, h).width, 10))
            Shadowed(UnderFireBox(w, h), "UNDER FIRE", style, new Color(1f, 0.35f, 0.3f, k));
    }

    /// <summary>
    /// THE BANNER AND THE SOUND when an assault is declared, taken or lost.
    ///
    /// The words are `AssaultWatch`'s, which are the core's `CH_ASSAULT` words; nothing about the war is decided
    /// here. Bulls green, bears red, the same two colours the chart gives the two sides.
    /// </summary>
    void DrawAssaultBanner(int w, int h)
    {
        var watch = ChartHud.Watch;
        if (watch == null) return;
        // not under the result card ("HIGH TAKEN" read through it at 1280x720, measured 2026-09-26): nothing overlaps
        if (ArrivalShowing) return;
        float a = watch.BannerAlpha(Time.unscaledTime);
        if (a <= 0f) return;
        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(AssaultBannerFont(w, h)),
        };
        var c = watch.BannerSide == 0 ? Up : Down;
        if (FitLine(style, watch.Banner, AssaultBannerBox(w, h).width, 10))
            Shadowed(AssaultBannerBox(w, h), watch.Banner, style, new Color(c.r, c.g, c.b, a));
    }

    /// <summary>
    /// THE DESKTOP LOG: the last few assault lines with the wall clock on them.
    ///
    /// DESKTOP ONLY, by the letter: "Not on phone." A phone in landscape has the same gap between the columns but
    /// a third of the pixels, and this is a debug line, not part of the game.
    /// </summary>
    void DrawAssaultLog(int w, int h)
    {
        if (Mobile) return;
        var watch = ChartHud.Watch;
        if (watch == null || watch.Log.Count == 0) return;
        // NOT ON THE RESULT CARD (CLIP-2118: "[21:16:33] BULLS ASSAULT ..." read chopped at the card's left edge on the
        // phone). The card owns the screen for its eight seconds.
        if (ArrivalShowing) return;
        var box = AssaultLogBox(w, h);
        float lh = SmallFont(w, h) * 1.45f;
        var style = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft };
        int room = AssaultLogLines(w, h);
        int first = Mathf.Max(0, watch.Log.Count - room);          // the newest that fit, oldest dropped
        for (int i = first; i < watch.Log.Count; i++)
        {
            var line = watch.Log[i];
            // The oldest lines fade rather than vanish, so the log reads newest-at-the-bottom at a glance.
            float fade = watch.Log.Count <= 1 ? 1f : 0.45f + 0.55f * i / (watch.Log.Count - 1);
            var c = line.Side == 0 ? Up : Down;
            var one = new GUIStyle(style);
            if (!FitLine(one, line.Text, box.width, 9)) continue;
            Shadowed(new Rect(box.x, box.y + (i - first) * lh, box.width, lh), line.Text, one,
                     new Color(c.r, c.g, c.b, fade));
        }
    }

    /// <summary>
    /// THE HORN. A short two-note call, built in code because the project carries no audio at all - there is no
    /// AudioListener in the scene either, so one is put on the camera the first time a sound is wanted.
    ///
    /// Deterministic and tiny: one mono PCM clip, made once. Nothing about the war depends on it.
    /// </summary>
    void PlayAssaultHorn()
    {
        if (_horn == null)
        {
            if (Object.FindFirstObjectByType<AudioListener>() == null)
            {
                var cam = Camera.main;
                if (cam != null) cam.gameObject.AddComponent<AudioListener>();
            }
            _horn = gameObject.AddComponent<AudioSource>();
            _horn.playOnAwake = false;
            _horn.spatialBlend = 0f;
            _horn.volume = 0.5f;
            _horn.clip = AssaultHorn();
        }
        if (_horn.clip != null) _horn.PlayOneShot(_horn.clip);
    }

    static AudioClip AssaultHorn()
    {
        const int rate = 44100;
        int n = Mathf.RoundToInt(rate * 0.55f);
        var data = new float[n];
        float phase = 0f;
        for (int i = 0; i < n; i++)
        {
            float t = i / (float)rate;
            float freq = t < 0.16f ? 196f : 262f;                      // two notes, a call rather than a beep
            phase += 2f * Mathf.PI * freq / rate;                      // carried across the change, so no click
            float env = Mathf.Exp(-t * 3.2f) * Mathf.Min(1f, t * 80f);
            data[i] = 0.45f * env * (Mathf.Sin(phase) * 0.75f + Mathf.Sin(phase * 2f) * 0.25f);
        }
        var clip = AudioClip.Create("assault-horn", n, 1, rate, false);
        clip.SetData(data, 0);
        return clip;
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
    /// rate, the falloff and the dose stay in `packages/nextblock`.
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
        if (!Arena.ArenaCore.Available || truck == null) return;
        int open = Arena.ArenaCore.CraterCount;
        if (open == 0) return;

        var cam = Camera.main;
        if (cam == null)
        {
            var chase = Found(ref _chaseFound);
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
            if (!Arena.ArenaCore.CraterAt(i, truck.transform.position.y + 1.5f,
                                        out var at, out float _)) continue;
            var vp = cam.WorldToScreenPoint(at);
            if (vp.z <= 0f) continue;                       // behind the camera
            float x = Mathf.Clamp(vp.x, 20f, w - 20f);
            float y = Mathf.Clamp(h - vp.y, 20f, h - 20f);
            Trefoil(new Vector2(x, y), mark.fontSize * 1.6f, yellow);
        }

        var p = truck.transform.position;
        if (!Arena.ArenaCore.Irradiated(p.x, p.z)) return;

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
        if (FitLine(warn, "IRRADIATED", band.width, 10)) Shadowed(band, "IRRADIATED", warn, hot);

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
            var chase = Found(ref _chaseFound);
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
                 DropOffWords(Arena.ArenaCore.Available && Arena.ArenaCore.RunState == 1, distance),
                 style, new Color(1f, 1f, 1f, 0.9f));
    }

    /// <summary>
    /// The line under DROP-OFF: metres while the run is on, DELIVERED once the core says so
    /// (2026-09-15 16:14). Measured before: the trucks the core had delivered went on
    /// to the tunnel's back wall and the HUD read 11-30 m to a drop-off already made.
    /// </summary>
    public static string DropOffWords(bool delivered, float distance) =>
        delivered ? "DELIVERED" : $"{distance:0} m";

    /// <summary>
    /// WASTED, over a drained and slowed world.
    ///
    /// Fades up with the sequence rather than snapping on, and sits slightly
    /// above centre the way GTA does - dead centre reads as a menu.
    /// </summary>
    // AFTER THE BAND, A SMALL LINE: while the run-end spectate has the view of a WRECKED run, the top of the screen
    // says so in a few words, so the war on screen reads as watched, not as the game going on without the player.
    RunEndSpectate _afterRun;
    void DrawSpectating(int w, int h)
    {
        if (_afterRun == null) _afterRun = Object.FindFirstObjectByType<RunEndSpectate>();
        if (_afterRun == null || !_afterRun.Active || !Arena.ArenaCore.Available || Arena.ArenaCore.RunState != Arena.Layout.RUN_WRECKED) return;
        var style = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.028f, 12f, 22f)),
        };
        // under the block line and its sentence, clear of the price and UNDER FIRE at the top (measured on 0.0.2731)
        var r = new Rect(0f, h * 0.42f, w, style.fontSize * 1.6f);
        GUI.color = Color.white;
        style.normal.textColor = new Color(0f, 0f, 0f, 0.6f);
        GUI.Label(new Rect(r.x + 1f, r.y + 1f, r.width, r.height), "WRECKED \u00b7 spectating", style);
        style.normal.textColor = new Color(0.95f, 0.45f, 0.40f, 0.95f);
        GUI.Label(r, "WRECKED \u00b7 spectating", style);
    }

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
                     ? (DeliveryGate.BackToTheBay(Arena.ArenaNet.RoundSeed)
                        ? $"WRECKED — back in {Mathf.CeilToInt(health.RespawnIn)}s"
                        : "WRECKED")      // a live round's wreck does not come back (2026-09-27 13:25)
                     : health.IsInvulnerable
                         ? "HEALTH 100%  ·  protected"
                         : $"HEALTH {Mathf.CeilToInt(health.Fraction * 100f)}%",
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
    /// <summary>The "Loading models" list is on screen this frame (the conditions DrawStreamingPanel draws it under).</summary>
    public bool ModelListShowing =>
        streamer != null && streamer.Items.Count > 0 && !SendOffShowing && !ArrivalShowing
        && !(streamer.AllDone && streamer.Failed == 0 && streamer.SinceDone > 4f);

    void DrawStreamingPanel(int w, int h)
    {
        // AND NOT WHILE A CARD IS UP. Both stand in the gap - it is the only
        // column with nothing permanent in it - and of the two, a list of
        // model names is the one to drop while the player is being told what
        // his run was worth. And gone once everything has settled, unless
        // something failed - a failure is worth leaving on screen.
        if (!ModelListShowing) return;

        float pad = Mathf.Max(8f, h * 0.02f);
        // ONE PITCH, asked of the same function the box uses - the box is
        // sized from it, so a second copy here would put the last row outside
        // the frame the border draws.
        int rows = ModelListRows(w, h);
        bool failedOnly = rows < streamer.Items.Count;
        float lh = StreamingLineHeight(w, h, rows);
        var box = StreamingBox(w, h, rows);

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
            if (failedOnly && item.state != ModelStreamer.State.Failed) continue;
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
        CleanHud.Poll();

        // THE SOUND THE ASSAULT ASKED FOR. The watch counts the calls it wants; this plays one per call and
        // never more, so a frame that sees two declarations is two horns and a frame that sees none is silent.
        var watch = ChartHud.Watch;
        if (watch != null && watch.Chimes != _hornsPlayed)
        {
            if (watch.Chimes > _hornsPlayed) PlayAssaultHorn();
            _hornsPlayed = watch.Chimes;
        }
    }

    void OnGUI()
    {
        // NOTHING ON THE FIRST FRAME (2026-10-08): the first OnGUI's text layout and font-atlas fill were
        // 320 ms inside Unity's 2.2 s start-up hold at 10x CPU as an Android phone (named profile, DriveHud.OnGUI first draw);
        // drawn from the next frame on, that work leaves the hold.
        if (FirstGuiFrame.Now()) return;
        // THE CONSOLE BUTTON'S SLOT, to the page whenever it changes (a resize, the debug readout)
        if (Event.current.type == EventType.Repaint)
        {
            string slot = ConsoleSlot(Screen.width, Screen.height);
            if (slot != _consoleSlotSent) { _consoleSlotSent = slot; Arena.ArenaCore.HudCorner(slot); }
        }
        if (CleanHud.On) return;
        Styles();
        int w = Screen.width, h = Screen.height;

        // SPECTATE: price only (2026-09-07, a13 / a16).
        // The free camera is looking at the map; every other box is driving
        // chrome. EXIT stays on SpectatorCamera.
        var spectator = Found(ref _spectatorFound);
        bool spectating = spectator != null && spectator.Active;

        /* ---------------------------------------------------- headline price */
        // The loading panel needs the top of the screen, and the price is not
        // what the player is reading while choosing freight. It steps aside
        // into the corner rather than fighting the panel for the same pixels.
        bool loading = loadout != null && loadout.IsOpen;

        if (market != null && !loading && spectating)
        {
            // SPECTATE IS NOT A BILLBOARD (2026-09-18 20:00, photographed): with no price yet, the headline
            // drew "— — —" and under it the market's connection telemetry - "connecting ... (error)" - at 4.5% of the
            // short side. Driving, that line sits under a price with the HUD's own chrome around it; spectating there
            // is no price, no box and no chrome, so it stood alone across the sky over the mempool.
            //
            // A spectator gets the market as a corner note and only when there IS a market: a price and its day. The
            // socket's own word belongs to the debug panel, which is where `market.Status` already lives.
            var note = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft, fontStyle = FontStyle.Bold };
            if (market.Price > 0)
                Shadowed(LoadingPriceBox(w, h),
                         $"${market.Price:N0}   {market.DayChangePct:+0.00;-0.00;0.00}% 24h", note,
                         market.Fresh ? Color.white : new Color(1f, 1f, 1f, 0.55f));
            DrawConnectionTrouble(w, h, note, true);
            // AND WHAT A NUKE COST, ACROSS THE MIDDLE (2026-09-19 15:55: "liquidation text CENTER of screen,
            // also in spectate"). Everything else on this branch is driving chrome and stays off, but the
            // liquidation is the market hitting the battlefield the spectator is watching - it is the one thing on
            // that screen that is not about the truck. The headline row is not drawn here: there is no headline
            // stack in spectate, so the row would hang in the sky.
            DrawLiquidations(w, h, 0f, false);
            return;
        }

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
            float wanted = Measure(_price, text).x;
            if (wanted > head.width && wanted > 1f)
                _price.fontSize = Mathf.Max(14, Mathf.FloorToInt(_price.fontSize * head.width / wanted));

            Shadowed(new Rect(head.x, HeadlineRowY(w, h, 0), head.width, _price.fontSize * 1.3f),
                     text, _price, colour);

            double chg = market.DayChangePct;
            string sub = PriceSubline(market.Price, chg, market.Status);
            var subStyle = new GUIStyle(_sub);
            if (sub.Length > 0 && FitLine(subStyle, sub, head.width, 10))
                Shadowed(new Rect(head.x, HeadlineRowY(w, h, 1), head.width, subStyle.fontSize * 1.6f),
                         sub, subStyle, chg >= 0 ? Up : Down);
            // AND WHAT IS BROKEN, NAMED, in the corner rather than across the headline.
            var small = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft, fontStyle = FontStyle.Bold };
            DrawConnectionTrouble(w, h, small, false);

            if (spectating) return;

            DrawLiquidations(w, h, HeadlineRowY(w, h, 2));
            DrawBlockTimer(w, h, HeadlineRowY(w, h, 3));
        }
        else if (spectating) return;

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
            DrawSpectating(w, h);
            // NO RUN-STOPPED SENTENCE HERE EITHER (NO-STOPPED-LINE-2103): the ending's own band says it.
            // WHAT THE WAR SAID (2026-09-21, measured).
            // This branch returned before `DrawAssaultLog` ever ran, so a declaration made while the player was
            // choosing cargo was not covered by the panel - it was never drawn. Over four rounds on Daily
            // 0.0.1842, 8 of 12 declarations were made with the bay open and the player was told about 0 of
            // them; every one of the 5 whose armour was actually inside the camera's field was a bay one.
            // `AssaultLogBox` steps below the cargo panel so it has somewhere to be.
            DrawAssaultLog(w, h);
            return;
        }

        DrawBlock(w, h);
        DrawWanted(w, h);
        DrawExposure(w, h);
        DrawUnderFire(w, h);
        DrawAssaultBanner(w, h);
        DrawAssaultLog(w, h);
        if (!WaypointHiddenBy(ArrivalShowing)) DrawWaypoint(w, h);
        DrawFallout(w, h);
        DrawHealth(w, h);
        DrawWasted(w, h);
        DrawSpectating(w, h);
        DrawCopyReplayAlone(w, h);
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
            // Speed and Drift, from the core when one answers.
            //
            // `SpeedKmh` is `_rb.linearVelocity.magnitude * 3.6f` and `Slip`
            // is `|InverseTransformDirection(_rb.linearVelocity).x|`, both off
            // a body that has been kinematic since the core took the driving.
            // Measured in the player build: this panel read 0.00 km/h and
            // 0.000 m/s while the truck was doing 68.16 km/h and sliding
            // 2.645 m/s sideways. The zeroes are the dead body, not the rule.
            //
            // Speed is `TruckSpeed`, which is what the MAIN readout above
            // already reads, so the screen carries one speed and not two.
            // Drift is `TruckSlip`, the chassis-frame projection from (t) -
            // not a second formula worked out here.
            bool core = Arena.ArenaCore.Available;
            float tempo = core ? Arena.ArenaCore.TruckSpeed * 3.6f : truck.SpeedKmh;
            float drift = core ? Arena.ArenaCore.TruckSlip : truck.Slip;
            Line(SpeedRow(tempo));
            Line(InputRow(DriveInput.Throttle, DriveInput.Steer, DriveInput.Handbrake));
            Line(DriftRow(drift, grounded));
            if (rb != null) Line($"Pos     {rb.position.x:0}, {rb.position.z:0}");
        }
        if (market != null)
        {
            Line(FlowRow(market.Flow));
            Line($"Liquid. {market.Liquidations.Count} / 90 s");
        }
        if (Arena.ArenaCore.Available)
        {
            // Counted off the CORE, which is what is on the screen now. This
            // read `field.Army`, a simulation that no longer runs.
            int ab = 0, ar = 0, ib = 0, ir = 0, heli = 0, bomb = 0;
            for (int i = 0; i < Arena.Layout.UNITS; i++)
            {
                if (!Arena.ArenaCore.UnitAlive(i)) continue;
                bool bull = Arena.ArenaCore.UnitSide(i) < 0;
                if (Arena.ArenaCore.UnitIsArmour(i)) { if (bull) ab++; else ar++; }
                else { if (bull) ib++; else ir++; }
            }
            for (int i = 0; i < Arena.Layout.MAX_HELIS; i++) if (Arena.ArenaCore.HeliAlive(i)) heli++;
            for (int i = 0; i < Arena.Layout.MAX_BOMBS; i++) if (Arena.ArenaCore.BombAlive(i)) bomb++;
            Line(ArmourRow(ab, ar));
            Line(InfantryRow(ib, ir));
            Line(AirRow(heli, bomb));
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

/// <summary>
/// THE FIRST FRAME THAT DRAWS ANY HUD: true for every OnGUI call in the frame in which the first one came, for
/// every HUD that asks - so DriveHud and SplashScreen both begin drawing on the frame after it, outside Unity's start-up hold.
/// </summary>
static class FirstGuiFrame
{
    static int _first = -1;
    public static bool Now()
    {
        if (_first < 0) _first = Time.frameCount;
        return Time.frameCount == _first;
    }
}
