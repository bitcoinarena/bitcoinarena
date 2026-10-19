// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    public bool IsOpen
    {
        get => _isOpen;
        private set
        {
            // THE PAGE IS TOLD (2026-09-26 14:02: the node strip lay across the truck and LOAD while the cargo
            // was being chosen) - it keeps its node strip hidden while this panel is open.
            if (_isOpen != value) Arena.ArenaCore.LoadoutOpen(value);
            _isOpen = value;
        }
    }
    bool _isOpen;

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

    /// <summary>
    /// CLOSE WITHOUT ROLLING OUT (2026-09-26, the 21:13 case): the node refused the entry before the run was live,
    /// so the round is not played - the chooser closes, the bed is cleared, and the truck stays locked for the lobby.
    /// </summary>
    public void Dismiss()
    {
        IsOpen = false;
        if (yard != null) yard.Close();
        if (bay != null) bay.Clear();
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

        // And the round starts in the core. Without this the core played one
        // round per session: `outcome` latches, `init` runs once in Start, and
        // the respawn all three endings go through only moves the truck. A
        // browser dump of round two against a fresh `init` had twelve of
        // thirty words still carrying round one - `S_STATE` delivered, the
        // danger, the dead, the replacement and sortie clocks - and RUN_LIVE
        // gates damage, danger, delivery and score alike.
        if (truck != null)
        {
            var core = truck.GetComponent<Arena.CoreDrivenTruck>();
            if (core != null) core.StartRound();
        }

        // AND WHAT WENT ON THE BED, after the round has started because
        // starting it clears the state this writes into.
        //
        // The war hunts a fat load harder: the reach a tank notices the truck
        // at, whether the truck outranks the tank in front of it, and what a
        // shell does all scale with this. The retired C# had the field and the
        // rule and never assigned it, so the freight choice cost nothing;
        // measured in the core, a full load is written off in 8.1 s against an
        // empty one's 85.3 s at fifty metres behind the line.
        //
        // THE LOAD, NOT THE WANTED LEVEL. This used to send `bay.Heat` - a
        // float this side worked out - and a host write is in no batch, no
        // mark and no transcript: the page's core carried 57229 and every
        // replay of the same transcript carried 0, so a committee and every
        // ghost it drew hunted a run the player was not driving. Two integers
        // cross now, the bridge publishes them, and the core decides the cost.
        if (bay != null) Arena.ArenaCore.SubmitLoad(bay.FeeCarried, bay.BtcHundredths, bay.VsizeList);
        // and kept with the page for this round, so a reload mid-run puts these parcels back on the bed (ResumeDriving)
        if (bay != null) Arena.ArenaCore.KeepCargo(BedText(bay.Slots));

        // AND THE RUN'S SESSION IS NOTED, so the replay the result offers is this run's and not the one before
        Arena.ArenaCore.RunStarts();

        // THE DRIVE STARTS TOP-DOWN, THE MINER IN FRAME (2026-09-26 14:08, 2026-09-27 11:31): PLAY's fly-in ran on
        // under this panel, and a quick ROLL OUT drove off beneath it facing away from the miner. Rolling out ends it and
        // puts the camera over the truck with the gate it is driving to held in view until the player swipes.
        var chase = FindFirstObjectByType<ChaseCamera>();
        if (chase != null)
        {
            var gate = FindFirstObjectByType<DeliveryGate>();
            chase.destination = gate != null ? gate.Mouth : (Vector3?)null;
            chase.EndFlyIn();
        }
    }

    [Tooltip("How full AUTO will load the bed. Deliberately short of full: " +
             "it is the quick option, not the best one, and topping the load " +
             "up by hand has to be worth doing.")]
    public float autoFill = 0.6f;

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
            // THE ROOM, AS C IS (2026-10-04 08:54: C is the bed fill, "not the BTC value"; the 2026-10-04 audit: AUTO
            // stopped on room-or-BTC, so a BTC-bound load could leave C below its 60%). The 20 BTC cap still binds - TryAdd
            // refuses any parcel past it, and once it is reached nothing more goes on.
            if (bay.Fill >= autoFill || bay.BtcFill >= 1f) break;
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

    /// <summary>
    /// A RUN RESUMED AFTER A RELOAD (2026-10-03, the mid-run reload playthrough: the player saw this panel over the
    /// resumed run, the arrows did not drive, the run ended MISSED). The run is already rolling in the core - its load is in
    /// the seats' record - so the panel closes and the truck is handed back, as a roll-out does, without a second load and
    /// without restarting anything (StartRound keeps a live round's core anyway).
    /// </summary>
    public void ResumeDriving()
    {
        IsOpen = false;
        if (yard != null) yard.Close();
        if (truck != null) truck.controlsLocked = false;
        // THE RUN'S PARCELS BACK ON THE BED (the redone playthrough: the resumed truck drove with "CARGO empty"): the ones ROLL
        // OUT kept for this round. Display only - the core already carries the load it was handed.
        var kept = ParseBed(Arena.ArenaCore.KeptCargo());
        if (bay != null && kept.Count > 0) { bay.Clear(); foreach (var tx in kept) bay.TryAdd(tx); }
        ConfirmedSats = bay != null ? bay.FeeCarried : 0;
        ConfirmedAt = Time.unscaledTime;
        Arena.ArenaCore.RunStarts();
        var chase = FindFirstObjectByType<ChaseCamera>();
        if (chase != null)
        {
            var gate = FindFirstObjectByType<DeliveryGate>();
            chase.destination = gate != null ? gate.Mouth : (Vector3?)null;
            chase.EndFlyIn();
        }
        Debug.Log($"[arena] resumed run: the cargo panel closed, driving on with {kept.Count} parcel(s) kept from before the reload");
    }

    /// <summary>The bed as text the page keeps: "txid,fee,vsize,value" per parcel, ';' between them, in loading order.</summary>
    public static string BedText(IEnumerable<CargoBay.Slot> slots)
    {
        var parts = new List<string>();
        foreach (var s in slots)
            if (s != null && s.tx != null && !string.IsNullOrEmpty(s.tx.txid) && s.tx.txid.IndexOfAny(new[] { ',', ';' }) < 0)
                parts.Add($"{s.tx.txid},{s.tx.feeSats},{s.tx.vsize},{s.tx.valueSats}");
        return string.Join(";", parts);
    }

    /// <summary>The parcels of a kept bed; a malformed parcel is skipped, nothing at all is an empty list.</summary>
    public static List<MempoolFeed.Tx> ParseBed(string text)
    {
        var txs = new List<MempoolFeed.Tx>();
        if (string.IsNullOrEmpty(text)) return txs;
        foreach (var part in text.Split(';'))
        {
            var f = part.Split(',');
            if (f.Length != 4 || f[0].Length == 0) continue;
            if (!long.TryParse(f[1], out var fee) || !int.TryParse(f[2], out var vsize) || !long.TryParse(f[3], out var value)) continue;
            txs.Add(new MempoolFeed.Tx { txid = f[0], feeSats = fee, vsize = vsize, valueSats = value });
        }
        return txs;
    }

    void Update()
    {
        if (IsOpen && Arena.ArenaCore.ResumedRun()) ResumeDriving();
        if (health != null && health.IsDestroyed && !_wasDestroyed)
        {
            if (bay != null) bay.Clear();
            if (yard != null) yard.Close();
        }
        if (health != null) _wasDestroyed = health.IsDestroyed;

        if (IsOpen && truck != null) truck.controlsLocked = true;

        // THE CORE IS TOLD AS THE BED CHANGES, NOT ONLY AT ROLL OUT (2026-10-04 13:30, playtest,: after
        // AUTO the truck read 68% and LOAD stayed x0.00000). Whenever the bed differs from the load the core last took - AUTO,
        // a parcel added, a parcel removed - the load is declared again, so the core's C (and the LOAD the panel prints from
        // it) moves with the bed. A load the bridge drops (one a tick) is simply declared again on the next frame. Before the
        // run rolls out the truck is held in the bay, so no exposure accrues while the load is still being chosen.
        if (IsOpen && bay != null)
        {
            string bed = BedSignature();
            if (bed != _bedDeclared && Arena.ArenaCore.SubmitLoad(bay.FeeCarried, bay.BtcHundredths, bay.VsizeList))
                _bedDeclared = bed;
        }
    }

    string _bedDeclared;
    string BedSignature() => bay.FeeCarried + "|" + bay.BtcHundredths + "|" + bay.VsizeList;

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
            // IN ITS OWN CELL (2026-10-16: "must be gleichmäßig and fit the dialog"): the caption is the bottom
            // of the crate's cell, the cell's width - every caption of a row on one line, none wider than its cell, all inside the
            // panel. Before, each hung under its own crate at max(140 px, 13 % of the screen), wider than a phone's cell.
            var box = c.label.width > 0f ? c.label
                    : new Rect(c.screen.x - 70f, c.screen.y + c.radius + 3f, 140f, _cap.fontSize * 2.5f);
            float wCap = box.width;

            // a plate behind the text: crate colours run light and so does the sky
            GUI.color = new Color(0f, 0f, 0f, c.loaded ? 0.62f : 0.45f);
            GUI.DrawTexture(new Rect(box.x + wCap * 0.03f, box.y - 2f, wCap * 0.94f, box.height), _flat);
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
            string head = c.loaded ? "ON BOARD" : $"FILLS {share}%";
            var headStyle = new GUIStyle(_cap);
            headStyle.fontSize = Mathf.Min(headStyle.fontSize, Mathf.Max(8, Mathf.RoundToInt(box.height * 0.40f)));
            DriveHud.FitLine(headStyle, head, box.width - 6f, 8);
            GUI.Label(new Rect(box.x, box.y, box.width, headStyle.fontSize * 1.5f), head, headStyle);

            _capSub.normal.textColor = new Color(1f, 1f, 1f, 0.85f);
            // The stake and the danger it attracts, on one line and plainly
            // labelled, so the trade is visible before it is made.
            int risk = bay != null ? Mathf.RoundToInt(bay.HeatOf(c.tx) * 100f) : 0;
            // WHOLE OR SHRUNK, NEVER CLIPPED (measured at 390x844: "0.00023427 BTC · danger" was cut at both edges and read
            // "23427 BTC"): three significant digits, fitted to the crate's own width.
            string sub = c.loaded ? $"fills {share}% · danger +{risk}%"
                                  : BtcShort(c.tx.Btc) + $" · danger +{risk}%" + (c.tx.Whale ? "  🐋" : "");
            var subStyle = new GUIStyle(_capSub);
            subStyle.fontSize = Mathf.Min(subStyle.fontSize, Mathf.Max(7, Mathf.RoundToInt(box.height * 0.30f)));
            if (DriveHud.FitLine(subStyle, sub, box.width - 6f, 7))
                GUI.Label(new Rect(box.x, box.y + headStyle.fontSize * 1.3f, box.width, subStyle.fontSize * 1.5f), sub, subStyle);

            // Two lines only. Twenty-one crates in three rows leaves no room
            // for a third, and the value is already told by the colour.
        }
    }

    void OnGUI()
    {
        if (!IsOpen || bay == null) return;
        if (splash != null && splash.Showing) return;
        if (CleanHud.On) return;
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
        // Wide enough for the words, and no wrapping: at 150 px "LIVE MEMPOOL"
        // broke onto a second line and spilled out of its own pill.
        var tag = new GUIStyle(_small)
            { alignment = TextAnchor.MiddleLeft, fontStyle = FontStyle.Bold, wordWrap = false };
        float tagW = Mathf.Clamp(panel.width * 0.20f, 190f, 300f);
        var count = new GUIStyle(_small) { alignment = TextAnchor.MiddleRight };
        string ramp = yard.Captions().Count + " on the ramp";
        float countW = count.CalcSize(new GUIContent(ramp)).x;
        // the add-ons button stands where the count did: the title keeps clear of it as of the count
        if (AddonsPanel.Instance != null && AddonsPanel.Instance.ShopAvailable)
            countW = new GUIStyle(_small) { fontStyle = FontStyle.Bold, wordWrap = false }.CalcSize(new GUIContent(AddonsLabel)).x + 20f;

        // THE TITLE BETWEEN THE PILL AND THE COUNT, NEVER UNDER EITHER (2026-09-29 21:48, CARGO-BTC-2148: on his
        // phone "LIVE MEMPOOL" lay over "CHOOSE YOUR MEMPOOL CARGO", read "LIVE MEMPOOL C" / "HOOSE ..."). Centred, with
        // the wider of the two side boxes kept clear on both sides, and its font shrunk to the room that leaves.
        float side = 14f + Mathf.Max(tagW, countW + 2f) + 10f;
        var titleRect = new Rect(bar.x + side, bar.y, Mathf.Max(0f, bar.width - 2f * side), bar.height);
        string heading = "CHOOSE YOUR MEMPOOL CARGO";
        if (DriveHud.FitLine(title, heading, titleRect.width, 10))
        {
            title.normal.textColor = new Color(0f, 0f, 0f, 0.6f);
            GUI.Label(new Rect(titleRect.x + 2f, titleRect.y + 3f, titleRect.width, titleRect.height), heading, title);
            title.normal.textColor = PanelSkin.Gold;
            GUI.Label(titleRect, heading, title);
        }
        PanelSkin.Tag(new Rect(bar.x + 14f, bar.y + bar.height * 0.28f, tagW, bar.height * 0.44f),
                      feed != null && feed.Fresh ? "● LIVE MEMPOOL" : "○ CONNECTING",
                      feed != null && feed.Fresh ? PanelSkin.Cyan : new Color(1f, 1f, 1f, 0.5f), tag);

        // BUY ADD-ONS WHERE THE PARCELS ARE LOADED (2026-10-16): in the count's place when this game sells
        // something - the add-ons panel over the cargo screen
        var addons = AddonsPanel.Instance;
        if (addons != null && addons.ShopAvailable)
        {
            var abtn = new GUIStyle(_small) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold, wordWrap = false };
            abtn.normal.textColor = new Color(0.07f, 0.07f, 0.07f);
            var ar = AddonsButtonRect(bar, abtn);
            GUI.color = new Color(0.97f, 0.58f, 0.10f);
            GUI.DrawTexture(ar, Texture2D.whiteTexture);
            GUI.color = Color.white;
            if (GUI.Button(ar, AddonsLabel, abtn)) addons.OpenAddons();
        }
        else
        {
            count.normal.textColor = new Color(1f, 1f, 1f, 0.55f);
            GUI.Label(new Rect(bar.x, bar.y, bar.width - 16f, bar.height), ramp, count);
        }

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

        // ONE LINE, FITTED TO THE TRACK (measured at 390x844: "TRUCK 0 BTC of 20 BTC · 0 parcels" wrapped and was cut)
        var fitted = new GUIStyle(style);
        fitted.normal.textColor = Color.white;
        if (DriveHud.FitLine(fitted, label, track.width - 8f, 8))
            GUI.Label(new Rect(track.x + 8f, track.y - fitted.fontSize * 1.35f,
                               track.width, fitted.fontSize * 1.4f), label, fitted);
    }

    /// <summary>
    /// Capacity, risk and reward, with the reward given the most room.
    ///
    /// The bed filling up was the only thing shown, which says what fits and
    /// nothing about whether it is worth taking. Risk is what the load makes of
    /// the run, and the reward is what the whole thing is for.
    /// </summary>
    /// <summary>
    /// WHERE THE CAPACITY BAR SITS, derived rather than guessed (2026-09-21).
    ///
    /// The bay draws at `GUI.depth = -100`, in front of everything the driving HUD has; a box that overlaps
    /// this one is not a faint box, it is no box at all. The assault log has to step clear of it while the
    /// player is choosing cargo, so the rectangle is public and computed ONCE here - the same mistake
    /// `PanelRect` was written to stop: deriving the same box twice is what puts things outside it.
    /// </summary>
    public Rect BottomBarRect(int w, int h)
    {
        int min = Mathf.Min(w, h);
        float pad = Mathf.Max(10f, h * 0.022f);
        float head = Mathf.RoundToInt(Mathf.Clamp(min * 0.034f, 15f, 26f));
        float barW = Mathf.Min(w * 0.94f, 1040f);
        float lh = head * 1.6f;
        float panelH = lh * 5.1f + (ButtonHeight(w, h, lh) - lh);
        return new Rect((w - barW) * 0.5f, h - panelH - pad, barW, panelH);
    }

    /// <summary>A phone: the browser says so, or the screen is held upright. A desktop in landscape is neither.</summary>
    public static bool Phone(int w, int h) => DriveHud.Mobile || h > w;

    /// <summary>AUTO's and ROLL OUT's height: the row's on a desktop, 2.2 rows on a phone - a thumb's target.</summary>
    public static float ButtonHeight(int w, int h, float lh) => Phone(w, h) ? lh * 2.2f : lh;

    /// <summary>A parcel's BTC on its crate: three significant digits (0.000234, 0.0036, 12.3), no trailing zeros.</summary>
    public static string BtcShort(double btc)
    {
        if (btc <= 0) return "0 BTC";
        int decimals = btc >= 100 ? 0 : Mathf.Clamp(2 - Mathf.FloorToInt((float)System.Math.Log10(btc)), 0, 8);
        return System.Math.Round(btc, decimals).ToString("0.########", System.Globalization.CultureInfo.InvariantCulture) + " BTC";
    }

    /// <summary>A parcel's or a load's BTC, as a block explorer writes it: up to eight decimals, no trailing zeros.</summary>
    public static string BtcLabel(double btc) =>
        btc.ToString("0.########", System.Globalization.CultureInfo.InvariantCulture) + " BTC";

    void Bar(int w, int h, int min, float pad)
    {
        float barW = Mathf.Min(w * 0.94f, 1040f);
        float lh = _head.fontSize * 1.6f;
        // 5.1, not 4.4: the reward column gained a line spelling out that the
        // sats are a stake, and at 4.4 that line landed on the ROLL OUT button.
        float panelH = lh * 5.1f;
        var panel = BottomBarRect(w, h);

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
        // THE GAUGE IS THE BED FILL - THE C THE LOAD WILL SET (2026-10-04 08:54: "the same fraction the gauge shows";
        // the 2026-10-04 audit: it drew room-or-BTC, so a BTC-bound truck read full while C stayed lower). The BTC carried
        // against the truck's 20 BTC cap is in the label beside it.
        Gauge(new Rect(panel.x + inner, top, gaugeW, gaugeH), bay.Fill,
              refused ? new Color(1f, 0.35f, 0.3f)
                      : Color.Lerp(new Color(0.3f, 0.75f, 0.45f), new Color(1f, 0.78f, 0.2f), bay.Fill),
              refused ? "TRUCK  —  FULL"
                      : $"TRUCK  {Mathf.RoundToInt(bay.Fill * 100f)}%  ·  {BtcShort(bay.BtcCarried)} of {CargoBay.BtcLimit:0.##} BTC  ·  {bay.Count} parcels",
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
        // THE LOAD FACTOR IS THE CORE'S C (RULED 2026-09-26, A): this printed Unity's bed fill (x0.83..0.90) under
        // LOAD x DANGER x SPEED, while the score multiplies the core's cargo word - set once, at init, to 0.70 on this
        // core, whatever is loaded. The bed fill stays on the gauge as TRUCK FULL %, which does not enter the score. That
        // the loadout choice does not move the score is what this core does, and the panel now says so.
        // THE CORE'S C, which moves with the bed (Update declares the load as it changes): on 7e2123d1 the bed fill, on
        // a 2069b4c2 round the 0.7 its rules give every load - the panel prints what the run will be scored at.
        string load = LoadLabel(Arena.ArenaCore.CargoWord);
        while (reward.fontSize > 12 && reward.CalcSize(new GUIContent(load)).x > rw) reward.fontSize--;
        GUI.Label(new Rect(rx, top - reward.fontSize * 0.1f, rw, reward.fontSize * 1.3f), load, reward);

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
        // BIGGER TO TAP ON A PHONE (2026-09-29 21:48, CARGO-BTC-2148: AUTO and ROLL OUT were too small
        // to tap); a desktop keeps its size. `ButtonHeight` also sizes the bar (BottomBarRect), so the taller buttons
        // stay inside it.
        float bh = ButtonHeight(w, h, lh);
        float by = panel.yMax - bh - lh * 0.25f;
        float bw = gaugeW;
        var btn = new GUIStyle(_btn);
        if (Phone(w, h)) btn.fontSize = Mathf.RoundToInt(Mathf.Max(_btn.fontSize, bh * 0.42f));
        // THE LABELS FIT THE BUTTONS (measured at 390x844 with the bigger font: "NOTHING LOADED" read "THING LOADI")
        var autoStyle = new GUIStyle(btn); DriveHud.FitLine(autoStyle, "AUTO  (60%)", bw - 12f, 10);
        if (GUI.Button(new Rect(panel.x + inner, by, bw, bh), "AUTO  (60%)", autoStyle)) Auto();

        GUI.enabled = bay.IsLoaded;
        string go = bay.IsLoaded ? "ROLL OUT" : "NOTHING LOADED";
        var goStyle = new GUIStyle(btn); DriveHud.FitLine(goStyle, go, bw - 12f, 10);
        if (GUI.Button(new Rect(panel.x + inner * 2f + gaugeW, by, bw, bh), go, goStyle)) Confirm();
        GUI.enabled = true;
    }

    public const string AddonsLabel = "BUY ADD-ONS";

    /// <summary>The cargo screen's BUY ADD-ONS: at the title bar's right end, its words' width, 60 % of the bar high.</summary>
    public static Rect AddonsButtonRect(Rect bar, GUIStyle style)
    {
        float tw = style.CalcSize(new GUIContent(AddonsLabel)).x + 20f;
        float bh = bar.height * 0.60f;
        return new Rect(bar.xMax - 14f - tw, bar.y + (bar.height - bh) * 0.5f, tw, bh);
    }

    /// <summary>The panel's LOAD number: the core's C (S_CARGO on the 1e-5 grid), to the five decimals the card prints.</summary>
    public static string LoadLabel(int cargoWord) =>
        "×" + CoreScoreFactors.Cargo(cargoWord).ToString("0.00000", System.Globalization.CultureInfo.InvariantCulture);
}
