using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The loading bay. The picking happens in the world - crates in the yard,
/// clicked or tapped - so this is only the instruction, the fill gauge and the
/// two buttons.
///
/// It used to be a scrolling list of hex. That told the player nothing about
/// what they were loading, and the load only appeared after the panel closed,
/// so "does this fit" was a number rather than something you could see.
/// </summary>
public class LoadoutPanel : MonoBehaviour
{
    public MempoolFeed feed;
    public CargoBay bay;
    public PackageYard yard;
    public TruckController truck;
    public TruckHealth health;
    public MarketFeed market;

    /// <summary>True while the bay is open and the truck is held.</summary>
    public bool IsOpen { get; private set; }

    GUIStyle _head, _small, _btn, _cap, _capSub;
    Texture2D _flat;
    bool _wasDestroyed;

    void Awake()
    {
        _flat = new Texture2D(1, 1);
        _flat.SetPixel(0, 0, Color.white);
        _flat.Apply();
    }

    public SplashScreen splash;

    void Start()
    {
        // Not before the title screen has been dismissed: the ramp used to
        // open on a player who had not yet been told what any of it was for.
        if (splash == null) splash = FindFirstObjectByType<SplashScreen>();
        if (splash == null || !splash.Showing) Open();
        if (health != null) health.Respawned += Open;
    }

    void OnDestroy()
    {
        if (health != null) health.Respawned -= Open;
    }

    public void Open()
    {
        IsOpen = true;
        if (bay != null) bay.Clear();
        if (yard != null && feed != null) yard.Open(feed.Offers);
        if (truck != null) truck.controlsLocked = true;
    }

    /// <summary>Shut the yard and let the player go.</summary>
    /// <summary>Unscaled time of the last roll-out, or a long time ago.</summary>
    public float ConfirmedAt { get; private set; } = -99f;

    /// <summary>Sats aboard at the moment of roll-out, for the send-off.</summary>
    public long ConfirmedSats { get; private set; }

    public void Confirm()
    {
        if (bay == null || !bay.IsLoaded) return;      // nothing aboard, nothing to run
        IsOpen = false;
        // Recorded here rather than read off the bay later: the bed is cleared
        // on arrival, and the send-off should name what was actually taken on.
        ConfirmedAt = Time.unscaledTime;
        ConfirmedSats = bay.FeeCarried;
        if (yard != null) yard.Close();
        if (truck != null) truck.controlsLocked = false;
    }

    [Tooltip("How full AUTO will load the bed. Deliberately short of full: " +
             "it is the quick option, not the best one, and topping the load " +
             "up by hand has to be worth doing.")]
    public float autoFill = 0.8f;

    /// <summary>
    /// A quick, decent load: the best paying freight first, which is what the
    /// next block would take - but only up to autoFill. Filling the last of
    /// the bed is left to the player, and choosing what goes in it is the
    /// interesting part.
    /// </summary>
    public void Auto()
    {
        if (feed == null || bay == null) return;
        bay.Clear();

        var sorted = new List<MempoolFeed.Tx>(feed.Offers);
        sorted.Sort((a, b) => b.FeeRate.CompareTo(a.FeeRate));
        foreach (var tx in sorted)
        {
            if (bay.Fill >= autoFill) break;
            bay.TryAdd(tx);
        }

        // the yard has to agree with the bed
        if (yard != null)
        {
            yard.Close();
            yard.Open(feed.Offers);
            foreach (var s in bay.Slots) yard.Hide(s.tx);
        }
    }

    void Update()
    {
        if (health != null && health.IsDestroyed && !_wasDestroyed)
        {
            if (bay != null) bay.Clear();
            if (yard != null) yard.Close();
        }
        if (health != null) _wasDestroyed = health.IsDestroyed;

        if (IsOpen && truck != null) truck.controlsLocked = true;
    }

    void Styles()
    {
        int min = Mathf.Min(Screen.width, Screen.height);
        if (_head == null)
        {
            _head = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            _small = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter };
            _btn = new GUIStyle(GUI.skin.button) { fontStyle = FontStyle.Bold };
        }
        _head.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.034f, 15f, 26f));
        _small.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.026f, 12f, 19f));
        _btn.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.030f, 14f, 22f));
        _head.normal.textColor = Color.white;
        _small.normal.textColor = new Color(1f, 1f, 1f, 0.85f);

        if (_cap == null)
        {
            _cap = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold, wordWrap = false };
            _capSub = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.UpperCenter, wordWrap = false };
        }
        _cap.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.026f, 13f, 21f));
        _capSub.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.021f, 11f, 17f));
    }

    /// <summary>
    /// The numbers under each crate.
    ///
    /// A cube can say how big a transaction is and roughly what it pays, and
    /// nothing else. Everything a haulier would actually decide on - the size
    /// in vB, the rate, what is being moved - has to be written down.
    /// </summary>
    void DrawCaptions()
    {
        if (yard == null) return;

        foreach (var c in yard.Captions())
        {
            float wCap = Mathf.Max(140f, Screen.width * 0.13f);
            float y = c.screen.y + c.radius + 3f;
            var box = new Rect(c.screen.x - wCap * 0.5f, y, wCap, _cap.fontSize * 2.5f);

            // a plate behind the text: crate colours run light and so does the sky
            GUI.color = new Color(0f, 0f, 0f, c.loaded ? 0.62f : 0.45f);
            GUI.DrawTexture(new Rect(box.x + wCap * 0.06f, box.y - 2f,
                                     wCap * 0.88f, box.height), _flat);
            GUI.color = Color.white;

            // What this package BUYS leads, and it is bed share - not sats.
            //
            // The headline used to be "+2.400 sat" in green, which reads as
            // earnings and is not: those sats are the transaction's FEE and
            // they go to the miner, not to the player. All a package buys the
            // player is a slice of the load factor, one of the three terms in
            // the score. "Stake" was multiplayer vocabulary for a mechanic
            // this build does not have - nobody deposits anything here.
            int share = bay != null ? Mathf.RoundToInt(bay.ShareOf(c.tx) * 100f) : 0;
            _cap.normal.textColor = c.loaded ? new Color(0.45f, 0.95f, 0.6f)
                                             : new Color(1f, 0.85f, 0.35f);
            GUI.Label(new Rect(box.x, box.y, box.width, _cap.fontSize * 1.5f),
                      c.loaded ? "ON BOARD" : $"FILLS {share}%", _cap);

            _capSub.normal.textColor = new Color(1f, 1f, 1f, 0.85f);
            // The stake and the danger it attracts, on one line and plainly
            // labelled, so the trade is visible before it is made.
            int risk = bay != null ? Mathf.RoundToInt(bay.HeatOf(c.tx) * 100f) : 0;
            GUI.Label(new Rect(box.x, box.y + _cap.fontSize * 1.25f, box.width, _capSub.fontSize * 1.5f),
                      c.loaded ? $"fills {share}% · danger +{risk}%"
                               : $"{c.tx.feeSats:N0} sat fee · danger +{risk}%"
                                 + (c.tx.Whale ? "  🐋" : ""), _capSub);

            // Two lines only. Twenty-one crates in three rows leaves no room
            // for a third, and the value is already told by the colour.
        }
    }

    void OnGUI()
    {
        if (!IsOpen || bay == null) return;
        if (splash != null && splash.Showing) return;
        Styles();

        // In front of everything the game HUD draws. IMGUI depth is inverted:
        // the lower the number, the closer to the front.
        GUI.depth = -100;

        int w = Screen.width, h = Screen.height;
        int min = Mathf.Min(w, h);
        float pad = Mathf.Max(10f, h * 0.022f);

        Chrome(w, h);
        DrawCaptions();
        Bar(w, h, min, pad);
        Inspector(w, h);
    }

    /// <summary>
    /// The window round the crates: a title bar and a border.
    ///
    /// The crates are drawn by their own camera and the chrome by the GUI on
    /// top of it, so both have to come from the same rectangle - which the
    /// yard owns. Drawn from its numbers, the slate ended up in one place and
    /// the crates in another, with the title sitting over the headline price.
    /// </summary>
    void Chrome(int w, int h)
    {
        if (yard == null) return;

        var panel = yard.PanelRect(w, h);
        var bar = yard.TitleRect(w, h);

        // Outside in: glow, then the frame, then the bar, then the marks.
        PanelSkin.Glow(panel, PanelSkin.Gold);
        PanelSkin.Border(panel, new Color(PanelSkin.Gold.r, PanelSkin.Gold.g, PanelSkin.Gold.b, 0.85f));
        PanelSkin.Scan(panel, PanelSkin.Cyan);

        // hazard tape down both flanks: this is a loading ramp
        float tape = Mathf.Clamp(panel.width * 0.010f, 8f, 16f);
        PanelSkin.Hazard(new Rect(panel.x + 2f, bar.yMax, tape, panel.yMax - bar.yMax - 2f),
                         PanelSkin.Gold);
        PanelSkin.Hazard(new Rect(panel.xMax - tape - 2f, bar.yMax, tape, panel.yMax - bar.yMax - 2f),
                         PanelSkin.Gold);

        // the title bar, lifting towards its own top edge
        PanelSkin.Gradient(bar, new Color(0.16f, 0.14f, 0.08f, 0.98f),
                                new Color(0.07f, 0.065f, 0.05f, 0.98f));
        PanelSkin.Rule(new Rect(bar.x, bar.yMax - 3f, bar.width, 3f), PanelSkin.Gold);

        var title = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(bar.height * 0.50f, 16f, 40f)),
        };
        // a shadow, then the face: IMGUI has no text shadow of its own
        title.normal.textColor = new Color(0f, 0f, 0f, 0.6f);
        GUI.Label(new Rect(bar.x + 2f, bar.y + 3f, bar.width, bar.height), "CHOOSE YOUR MEMPOOL CARGO", title);
        title.normal.textColor = PanelSkin.Gold;
        GUI.Label(bar, "CHOOSE YOUR MEMPOOL CARGO", title);

        // Wide enough for the words, and no wrapping: at 150 px "LIVE MEMPOOL"
        // broke onto a second line and spilled out of its own pill.
        var tag = new GUIStyle(_small)
            { alignment = TextAnchor.MiddleLeft, fontStyle = FontStyle.Bold, wordWrap = false };
        float tagW = Mathf.Clamp(panel.width * 0.20f, 190f, 300f);
        PanelSkin.Tag(new Rect(bar.x + 14f, bar.y + bar.height * 0.28f, tagW, bar.height * 0.44f),
                      feed != null && feed.Fresh ? "● LIVE MEMPOOL" : "○ CONNECTING",
                      feed != null && feed.Fresh ? PanelSkin.Cyan : new Color(1f, 1f, 1f, 0.5f), tag);

        var count = new GUIStyle(_small) { alignment = TextAnchor.MiddleRight };
        count.normal.textColor = new Color(1f, 1f, 1f, 0.55f);
        GUI.Label(new Rect(bar.x, bar.y, bar.width - 16f, bar.height),
                  yard.Captions().Count + " on the ramp", count);

        var hint = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.LowerCenter,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(bar.height * 0.28f, 11f, 19f)),
        };
        hint.normal.textColor = new Color(1f, 1f, 1f, 0.6f);
        GUI.Label(new Rect(panel.x, bar.yMax + 3f, panel.width, hint.fontSize * 1.7f),
                  "Tap to load  ·  tap again to unload  ·  hover for details", hint);

        PanelSkin.Corners(panel, PanelSkin.Gold);
    }

    /// <summary>
    /// The transaction under the pointer, the way a block explorer would put
    /// it - full txid, value, fee, rate, size - but small and out of the way.
    ///
    /// The captions can only carry what fits under a crate. This is where the
    /// rest goes, and it only exists while somebody is actually looking at a
    /// package.
    /// </summary>
    void Inspector(int w, int h)
    {
        var tx = yard != null ? yard.Hovered : null;
        if (tx == null) return;

        var pos = UnityEngine.InputSystem.Mouse.current != null
            ? UnityEngine.InputSystem.Mouse.current.position.ReadValue()
            : Vector2.zero;
        float px = pos.x, py = h - pos.y;

        float bw = Mathf.Min(w * 0.30f, 380f);
        float lh = _small.fontSize * 1.55f;
        float bh = lh * 5.6f;

        // flipped to the other side when it would run off the screen
        var box = new Rect(Mathf.Clamp(px + 18f, 4f, w - bw - 4f),
                           Mathf.Clamp(py + 18f, 4f, h - bh - 4f), bw, bh);

        GUI.color = new Color(0.03f, 0.04f, 0.06f, 0.95f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;
        Frame(box, new Color(0.42f, 0.86f, 1f, 0.8f), 2f);

        float y = box.y + lh * 0.2f;
        var id = new GUIStyle(_small) { fontStyle = FontStyle.Bold, alignment = TextAnchor.UpperLeft };
        id.normal.textColor = new Color(0.42f, 0.86f, 1f);
        GUI.Label(new Rect(box.x + 10f, y, bw - 20f, lh), tx.txid, id);
        y += lh * 1.05f;

        var row = new GUIStyle(_small) { alignment = TextAnchor.UpperLeft };
        row.normal.textColor = new Color(1f, 1f, 1f, 0.9f);

        void Line(string k, string v, Color c)
        {
            var kk = new GUIStyle(row); kk.normal.textColor = new Color(1f, 1f, 1f, 0.55f);
            GUI.Label(new Rect(box.x + 10f, y, bw * 0.42f, lh), k, kk);
            var vv = new GUIStyle(row) { alignment = TextAnchor.UpperRight };
            vv.normal.textColor = c;
            GUI.Label(new Rect(box.x + bw * 0.42f, y, bw * 0.58f - 10f, lh), v, vv);
            y += lh * 0.92f;
        }

        Line("value", $"{tx.Btc:0.########} BTC", Color.white);
        if (market != null && market.Price > 0)
            Line("", $"${tx.Btc * market.Price:N2}", new Color(1f, 1f, 1f, 0.6f));
        Line("fee", $"{tx.feeSats:N0} sat", new Color(1f, 0.86f, 0.35f));
        Line("fee rate", $"{tx.FeeRate:0.0} sat/vB", Color.white);
        Line("size", $"{tx.vsize} vB", Color.white);
    }

    /// <summary>A one pixel frame, drawn as four fills.</summary>
    void Frame(Rect r, Color colour, float thickness)
    {
        GUI.color = colour;
        GUI.DrawTexture(new Rect(r.x, r.y, r.width, thickness), _flat);
        GUI.DrawTexture(new Rect(r.x, r.yMax - thickness, r.width, thickness), _flat);
        GUI.DrawTexture(new Rect(r.x, r.y, thickness, r.height), _flat);
        GUI.DrawTexture(new Rect(r.xMax - thickness, r.y, thickness, r.height), _flat);
        GUI.color = Color.white;
    }

    void Gauge(Rect track, float fill, Color colour, string label, GUIStyle style)
    {
        GUI.color = new Color(1f, 1f, 1f, 0.12f);
        GUI.DrawTexture(track, _flat);
        GUI.color = colour;
        GUI.DrawTexture(new Rect(track.x + 2f, track.y + 2f,
                                 Mathf.Max(0f, (track.width - 4f) * Mathf.Clamp01(fill)),
                                 track.height - 4f), _flat);
        GUI.color = Color.white;
        Frame(track, new Color(1f, 1f, 1f, 0.25f), 1f);

        style.normal.textColor = Color.white;
        GUI.Label(new Rect(track.x + 8f, track.y - style.fontSize * 1.35f,
                           track.width, style.fontSize * 1.4f), label, style);
    }

    /// <summary>
    /// Capacity, risk and reward, with the reward given the most room.
    ///
    /// The bed filling up was the only thing shown, which says what fits and
    /// nothing about whether it is worth taking. Risk is what the load makes of
    /// the run, and the reward is what the whole thing is for.
    /// </summary>
    void Bar(int w, int h, int min, float pad)
    {
        float barW = Mathf.Min(w * 0.94f, 1040f);
        float lh = _head.fontSize * 1.6f;
        // 5.1, not 4.4: the reward column gained a line spelling out that the
        // sats are a stake, and at 4.4 that line landed on the ROLL OUT button.
        float panelH = lh * 5.1f;
        var panel = new Rect((w - barW) * 0.5f, h - panelH - pad, barW, panelH);

        GUI.color = new Color(0.03f, 0.04f, 0.06f, 0.86f);
        GUI.DrawTexture(panel, _flat);
        GUI.color = Color.white;
        Frame(panel, new Color(1f, 0.86f, 0.35f, 0.55f), 2f);

        float inner = pad * 1.2f;
        float gaugeW = (panel.width - inner * 3f) * 0.34f;
        float top = panel.y + lh * 1.05f;
        float gaugeH = lh * 0.5f;

        bool refused = yard != null && Time.unscaledTime - yard.RefusedAt < 0.7f;

        // --- capacity -------------------------------------------------------
        Gauge(new Rect(panel.x + inner, top, gaugeW, gaugeH), bay.Fill,
              refused ? new Color(1f, 0.35f, 0.3f)
                      : Color.Lerp(new Color(0.3f, 0.75f, 0.45f), new Color(1f, 0.78f, 0.2f), bay.Fill),
              refused ? "TRUCK  —  FULL"
                      : $"TRUCK FULL  {Mathf.RoundToInt(bay.Fill * 100f)}%  ·  {bay.Count} parcels",
              _small);

        // --- risk -----------------------------------------------------------
        float heat = bay.Heat;
        Gauge(new Rect(panel.x + inner * 2f + gaugeW, top, gaugeW, gaugeH), heat,
              Color.Lerp(new Color(0.45f, 0.8f, 0.5f), new Color(1f, 0.25f, 0.2f), heat),
              // Short. The explanation used to run onto a second line and
              // straight over the button underneath it.
              $"HUNTED  {Mathf.RoundToInt(heat * 100f)}%  " +
              $"{new string('★', Mathf.Clamp(Mathf.CeilToInt(heat * 5f), 0, 5))}",
              _small);

        // --- reward, given the room it deserves ------------------------------
        var reward = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleRight,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.055f, 24f, 52f)),
        };
        reward.normal.textColor = new Color(1f, 0.86f, 0.35f);
        float rx = panel.x + inner * 2f + gaugeW * 2f;
        float rw = panel.width - (rx - panel.x) - inner;

        var lbl = new GUIStyle(_small) { alignment = TextAnchor.UpperRight };
        lbl.normal.textColor = new Color(1f, 1f, 1f, 0.7f);

        // The big number is the CARGO FACTOR, not the sats.
        //
        // A large sat figure here was read as the prize - understandably, it
        // was the biggest thing on the bar. It is the miners' fee, not the
        // player's pay. Loading buys exactly one of
        // the three terms in the score, so that term is what gets the big
        // type, and the formula is spelled out underneath so the other two are
        // visibly still to be earned by driving.
        // Plain words, not the spec's. "Cargo factor", "exposure" and "time"
        // are the terms in section 18A and they are precise; they are also
        // three pieces of vocabulary to learn before the first run makes any
        // sense. LOAD, DANGER and SPEED say the same thing and need no glossary.
        GUI.Label(new Rect(rx, top - _small.fontSize * 1.35f, rw, _small.fontSize * 1.4f),
                  "LOAD", lbl);
        GUI.Label(new Rect(rx, top - reward.fontSize * 0.1f, rw, reward.fontSize * 1.3f),
                  $"×{Mathf.Clamp01(bay.Fill):0.00}", reward);

        // The formula, drawn in pieces so LOAD can be lit and the other two
        // left grey.
        //
        // "1 of 3 things you are scored on" was a sentence to decode, and it
        // did not survive contact with a player. Three words with one of them
        // burning needs no decoding at all: you can see that you are setting
        // one part, that there are two more, and that they are not yours yet.
        var f = new GUIStyle(_small) { fontStyle = FontStyle.Bold };
        var litC = new Color(1f, 0.86f, 0.35f);
        var dimC = new Color(1f, 1f, 1f, 0.38f);
        string[] parts = { "LOAD", "  ×  ", "DANGER", "  ×  ", "SPEED" };
        var cols = new[] { litC, dimC, dimC, dimC, dimC };

        float total = 0f;
        foreach (var part in parts) total += f.CalcSize(new GUIContent(part)).x;
        float fx = rx + rw - total;
        float fy = top + reward.fontSize * 1.15f;
        for (int i = 0; i < parts.Length; i++)
        {
            float pw = f.CalcSize(new GUIContent(parts[i])).x;
            f.normal.textColor = cols[i];
            GUI.Label(new Rect(fx, fy, pw + 1f, _small.fontSize * 1.5f), parts[i], f);
            fx += pw;
        }

        var sub = new GUIStyle(_small) { alignment = TextAnchor.LowerRight };
        sub.normal.textColor = new Color(1f, 1f, 1f, 0.7f);
        GUI.Label(new Rect(rx, fy + _small.fontSize * 1.5f, rw, _small.fontSize * 1.5f),
                  "you pick LOAD · DANGER and SPEED you earn driving", sub);

        // --- buttons ---------------------------------------------------------
        float by = panel.yMax - lh * 1.25f;
        float bw = gaugeW;
        if (GUI.Button(new Rect(panel.x + inner, by, bw, lh), "AUTO  (80%)", _btn)) Auto();

        GUI.enabled = bay.IsLoaded;
        if (GUI.Button(new Rect(panel.x + inner * 2f + gaugeW, by, bw, lh),
                       bay.IsLoaded ? "ROLL OUT" : "NOTHING LOADED", _btn)) Confirm();
        GUI.enabled = true;
    }
}
