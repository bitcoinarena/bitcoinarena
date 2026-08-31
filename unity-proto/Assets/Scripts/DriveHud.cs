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
        if (gate.SinceDelivery >= Hold) return;

        // Full strength for most of it, then fade. A linear fade from the first
        // frame spends the whole time getting harder to read.
        float k = Mathf.Clamp01((Hold - gate.SinceDelivery) / (Hold * 0.28f));
        int min = Mathf.Min(w, h);

        var big = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(min * 0.072f),
        };
        var mid = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(min * 0.056f),
        };
        var line = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperCenter,
            fontSize = Mathf.RoundToInt(min * 0.034f),
        };

        float y = h * 0.20f;

        big.normal.textColor = new Color(Up.r, Up.g, Up.b, k);
        GUI.Label(new Rect(0f, y, w, big.fontSize * 1.5f),
                  $"DELIVERED  {gate.LastRun:N0} sat to the miner", big);
        y += big.fontSize * 1.45f;

        if (runScore == null) return;

        mid.normal.textColor = new Color(1f, 0.86f, 0.35f, k);
        GUI.Label(new Rect(0f, y, w, mid.fontSize * 1.4f),
                  $"SCORE  +{runScore.LastScore:N0}", mid);
        y += mid.fontSize * 1.35f;

        // The working, which is the whole point of showing a score at all: it
        // is where the player reads WHY a careful full run scored 40 and a
        // reckless half-empty one scored 700.
        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.92f);
        GUI.Label(new Rect(0f, y, w, line.fontSize * 1.7f),
                  $"load {runScore.LastCargo:0.00}   ×   danger {runScore.LastExposure:0.00}" +
                  $"   ×   speed {runScore.LastTime:0.00}   ×  1000", line);
        y += line.fontSize * 1.7f;

        line.normal.textColor = new Color(1f, 1f, 1f, k * 0.6f);
        GUI.Label(new Rect(0f, y, w, line.fontSize * 1.7f),
                  "the sats were your stake and came back — the score is what you earned", line);
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
                     stalled ? "NO GROUND GAINED  ·  CIRCLING EARNS NOTHING"
                             : "TOO FAR FROM THE FIGHTING  ·  EARNING NOTHING", warn,
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
                ? $"{chg:+0.00;-0.00;0.00}% 24h   ·   {market.Status}"
                : $"verbinde … ({market.Status})";
            Shadowed(new Rect(0, h * 0.015f + _price.fontSize * 1.12f, w, _sub.fontSize * 1.6f),
                     sub, _sub, chg >= 0 ? Up : Down);
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
            Line($"Tempo   {truck.SpeedKmh:0} km/h");
            Line($"Gas {DriveInput.Throttle:+0.0;-0.0; 0.0}  Lenk {DriveInput.Steer:+0.0;-0.0; 0.0}  {(DriveInput.Handbrake ? "HB" : "")}");
            Line($"Drift   {truck.Slip:0.0} m/s   Raeder {grounded}/4");
            if (rb != null) Line($"Pos     {rb.position.x:0}, {rb.position.z:0}");
        }
        if (market != null)
        {
            Line($"Fluss   {market.Flow:+0.00;-0.00; 0.00}");
            Line($"Liquid. {market.Liquidations.Count} / 90 s");
        }
        if (field?.Army != null)
        {
            Line($"Panzer   gruen {field.Army.ArmourOf(Army.Side.Bull)}  rot {field.Army.ArmourOf(Army.Side.Bear)}");
            Line($"Soldaten gruen {field.Army.InfantryOf(Army.Side.Bull)}  rot {field.Army.InfantryOf(Army.Side.Bear)}");
            Line($"Luft     {field.Army.Helicopters.Count} Heli  {field.Army.Bombs.Count} Bombe(n)");
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
