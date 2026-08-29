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
    public bool showDiagnostics = true;
    public ModelStreamer streamer;
    public TruckHealth health;
    public WastedSequence wasted;
    public DeliveryGate gate;
    public CargoBay bay;

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

        float pad = Mathf.Max(8f, h * 0.02f);
        float lh = SmallFont(w, h) * 1.6f;
        float width = Mathf.Min(300f, w * 0.30f);
        var box = new Rect(w - width - pad, pad, width, lh * 2.2f);

        GUI.color = new Color(0f, 0f, 0f, 0.42f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;

        var st = new GUIStyle(_small) { alignment = TextAnchor.MiddleRight };
        st.normal.textColor = Color.white;
        GUI.Label(new Rect(box.x, box.y, box.width - pad * 0.6f, lh),
                  bay.IsLoaded
                      ? $"Ladung: {bay.Count} Pakete  ·  {bay.FeeCarried:N0} sat"
                      : "Ladung: leer", st);

        var st2 = new GUIStyle(st) { fontStyle = FontStyle.Bold };
        st2.normal.textColor = Up;
        GUI.Label(new Rect(box.x, box.y + lh, box.width - pad * 0.6f, lh),
                  $"Geliefert: {gate.SatsDelivered:N0} sat  ·  {gate.Runs} Fahrten", st2);

        // the flash on arrival
        if (gate.SinceDelivery < 2.6f)
        {
            float k = 1f - gate.SinceDelivery / 2.6f;
            var big = new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontStyle = FontStyle.Bold,
                fontSize = Mathf.RoundToInt(Mathf.Min(w, h) * 0.075f),
            };
            big.normal.textColor = new Color(Up.r, Up.g, Up.b, k);
            GUI.Label(new Rect(0f, h * 0.24f, w, big.fontSize * 1.6f),
                      $"GELIEFERT  +{gate.LastRun:N0} sat", big);
        }
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
        float top = showDiagnostics ? diag.yMax + pad * 0.4f : pad;
        return new Rect(diag.x, top, diag.width, barH + lh);
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
                     ? $"ZERSTÖRT — neu in {Mathf.CeilToInt(health.RespawnIn)}s"
                     : health.IsInvulnerable
                         ? "Zustand 100%  ·  geschützt"
                         : $"Zustand {Mathf.CeilToInt(health.Fraction * 100f)}%",
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
                      ? (totalMb > 0.01f ? $"Modelle geladen  ({totalMb:0.0} MB)" : "Modelle geladen")
                      : "Modelle werden geladen", head);
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

    void OnGUI()
    {
        Styles();
        int w = Screen.width, h = Screen.height;

        /* ---------------------------------------------------- headline price */
        if (market != null)
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
