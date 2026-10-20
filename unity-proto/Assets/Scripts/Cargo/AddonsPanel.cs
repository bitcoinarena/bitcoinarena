// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Runtime.InteropServices;
using UnityEngine;

/// <summary>One add-on as the page lists it (index.html ARENA_ADDONS_VIEW).</summary>
[Serializable]
public class AddonItem
{
    public string id = "", name = "", what = "";
    public int priceSat;
    public bool owned, use;
}

/// <summary>The last purchase the page made: its number, the item, and from which round it plays ("next" or "after-next").</summary>
[Serializable]
public class AddonBought
{
    public int seq;
    public string id = "", name = "", txid = "", from = "";
}

/// <summary>The page's add-ons, as Unity reads them.</summary>
[Serializable]
public class AddonsState
{
    public bool shop, read, bad;
    public string game = "", busy = "", said = "";
    public int seq;
    public AddonBought bought;
    public AddonItem[] items = new AddonItem[0];
}

/// <summary>
/// BUY ADD-ONS INSIDE UNITY (2026-10-16: "The buy feature must also be inside unity on the loading screen as
/// 'buy addons' where you load the packages, and when the round has closed and the countdown is showing there is also the option to
/// buy items. There is a visual confirmation in unity when the game is active and an item has been purchased.").
///
/// The panel lists what the page's game sells (the page's ARENA_ADDONS_VIEW) and buys through the page - the same purchase as its
/// shop sheet: the wallet pays, the seats keep the record. It opens from the cargo screen's BUY ADD-ONS (LoadoutPanel) and from the
/// page's "Buy add-ons" beside the next round's countdown (SendMessage("Bootstrap", "OpenAddons")).
///
/// A purchase is confirmed on screen wherever the player is: a gold banner, the item's name, and from which round it plays - an
/// entry already made keeps what it named (every node replays the run from it), so a truck bought while loading or in the countdown
/// drives from the next entry the page makes.
/// </summary>
public class AddonsPanel : MonoBehaviour
{
    public static AddonsPanel Instance { get; private set; }

    /// <summary>How long the purchase banner stays, in seconds.</summary>
    public const float BannerS = 6f;

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern string ArenaAddonsState();
    [DllImport("__Internal")] static extern int ArenaAddonsBuy(string id);
    [DllImport("__Internal")] static extern int ArenaAddonsUse(string id, int on);
    [DllImport("__Internal")] static extern int ArenaAddonsOpen();
#else
    static string ArenaAddonsState() => TestState ?? "";
    static int ArenaAddonsBuy(string id) { Bought?.Invoke(id); return 1; }
    static int ArenaAddonsUse(string id, int on) => 1;
    static int ArenaAddonsOpen() => 1;
#endif
    /// <summary>The editor's stand-in for the page's view (tests).</summary>
    public static string TestState;
    /// <summary>The editor's stand-in for a purchase asked of the page (tests).</summary>
    public static Action<string> Bought;

    public bool IsOpen { get; private set; }
    public AddonsState State => _s;
    /// <summary>True when the page's game sells something: the cargo screen shows BUY ADD-ONS then.</summary>
    public bool ShopAvailable => _s != null && _s.shop && _s.items != null && _s.items.Length > 0;

    AddonsState _s;
    float _polledAt = -99f;
    int _seenSeq = -1;
    AddonBought _banner;
    float _bannerAt = -99f;
    GUIStyle _title, _body, _small, _btn, _buy;
    Texture2D _flat, _orange, _orangeHi, _orangeBusy;

    void Awake() { Instance = this; }
    void OnDestroy() { if (Instance == this) Instance = null; }

    /// <summary>The page's JSON, or null when it says nothing readable.</summary>
    public static AddonsState Parse(string json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { var s = JsonUtility.FromJson<AddonsState>(json); if (s != null && s.items == null) s.items = new AddonItem[0]; return s; }
        catch { return null; }
    }

    /// <summary>
    /// A NEW PURCHASE TO CONFIRM: the page's count of purchases has moved past the one already seen. The first reading only sets the
    /// count - an earlier purchase is not confirmed again on a reload.
    /// </summary>
    public static bool IsNewPurchase(int seenSeq, AddonsState s) =>
        seenSeq >= 0 && s != null && s.bought != null && s.seq > seenSeq && s.bought.seq == s.seq;

    /// <summary>The banner's first line.</summary>
    public static string BannerTitle(AddonBought b) => (b == null || string.IsNullOrEmpty(b.name) ? "ADD-ON" : b.name.ToUpperInvariant()) + " BOUGHT";

    /// <summary>The banner's second line: from which round it plays.</summary>
    public static string BannerLine(AddonBought b) =>
        b != null && b.from == "after-next"
            ? "Yours for good. Your next round is already entered - it plays from the round after."
            : "Yours for good. It plays from your next round.";

    /// <summary>An item's button: OWNED, PAYING while it is bought, else its price.</summary>
    public static string ButtonLabel(AddonItem it, string busy) =>
        it.owned ? "OWNED" : !string.IsNullOrEmpty(busy) && busy == it.id ? "PAYING ..." : $"BUY · {it.priceSat} sat";

    /// <summary>Opens the panel - the cargo screen's BUY ADD-ONS, or the page's countdown box through SendMessage.</summary>
    public void OpenAddons()
    {
        IsOpen = true;
        ArenaAddonsOpen();
        Poll();
        Debug.Log("[AddonsPanel] open");
    }

    public void Close() { IsOpen = false; }

    void Poll()
    {
        _polledAt = Time.unscaledTime;
        var s = Parse(ArenaAddonsState());
        if (s == null) return;
        if (IsNewPurchase(_seenSeq, s)) { _banner = s.bought; _bannerAt = Time.unscaledTime; Debug.Log($"[AddonsPanel] bought {s.bought.id}, plays from {s.bought.from}"); }
        if (s.seq > _seenSeq) _seenSeq = s.seq;
        _s = s;
    }

    void Update()
    {
        // open: twice a second, for the price, the paying and the answer; closed: every 1.5 s, for the banner and the cargo button
        if (Time.unscaledTime - _polledAt > (IsOpen ? 0.5f : 1.5f)) Poll();
    }

    /// <summary>True while the purchase banner is up.</summary>
    public bool BannerShowing => _banner != null && Time.unscaledTime - _bannerAt < BannerS;

    void Styles()
    {
        if (_title != null) return;
        _flat = Texture2D.whiteTexture;
        _title = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft, wordWrap = false };
        _title.normal.textColor = PanelSkin.Gold;
        _body = new GUIStyle(GUI.skin.label) { wordWrap = true, alignment = TextAnchor.UpperLeft };
        _body.normal.textColor = new Color(0.9f, 0.92f, 0.95f);
        _small = new GUIStyle(_body);
        _small.normal.textColor = new Color(1f, 1f, 1f, 0.62f);
        _btn = new GUIStyle(GUI.skin.button) { fontStyle = FontStyle.Bold, wordWrap = false };
        // THE BUY BUTTON IS SOLID ORANGE WITH BLACK WORDS (the owner's phone 06:24Z: "The buy button isn't readable" - a
        // grey skin button tinted orange by GUI.color, its words dark on dark): its own background, never a tint
        _orange = Solid(new Color(0.97f, 0.58f, 0.10f)); _orangeHi = Solid(new Color(1f, 0.70f, 0.28f)); _orangeBusy = Solid(new Color(0.55f, 0.40f, 0.20f));
        _buy = new GUIStyle(GUI.skin.button) { fontStyle = FontStyle.Bold, wordWrap = false, alignment = TextAnchor.MiddleCenter };
        _buy.normal.background = _orange; _buy.hover.background = _orangeHi; _buy.active.background = _orangeHi; _buy.focused.background = _orange;
        _buy.normal.textColor = _buy.hover.textColor = _buy.active.textColor = _buy.focused.textColor = new Color(0.06f, 0.06f, 0.06f);
        _buy.border = new RectOffset(0, 0, 0, 0);
    }

    static Texture2D Solid(Color c) { var t = new Texture2D(1, 1); t.SetPixel(0, 0, c); t.Apply(); return t; }

    /// <summary>
    /// THE ITEM'S PICTURE (the owner: "no icon"): the shop sheet's truck, drawn - an orange bed, a grey cab, two wheels - in
    /// a dark tile, the page's ITEM_PICTURE in rectangles.
    /// </summary>
    void Icon(Rect r, string itemId)
    {
        PanelSkin.Gradient(r, new Color(0.06f, 0.07f, 0.09f, 1f), new Color(0.03f, 0.04f, 0.05f, 1f));
        PanelSkin.Border(r, new Color(1f, 1f, 1f, 0.10f));
        float u = r.width / 40f;
        Box(new Rect(r.x + 3f * u, r.y + 14f * u, 24f * u, 12f * u), new Color(0.97f, 0.58f, 0.10f));   // the bed
        Box(new Rect(r.x + 27f * u, r.y + 17f * u, 9f * u, 9f * u), new Color(0.79f, 0.82f, 0.85f));   // the cab
        Box(new Rect(r.x + 7f * u, r.y + 26f * u, 6f * u, 6f * u), new Color(0.13f, 0.13f, 0.13f));    // the wheels
        Box(new Rect(r.x + 28f * u, r.y + 26f * u, 6f * u, 6f * u), new Color(0.13f, 0.13f, 0.13f));
    }

    void Box(Rect r, Color c) { GUI.color = c; GUI.DrawTexture(r, _flat); GUI.color = Color.white; }

    void OnGUI()
    {
        if (CleanHud.On) return;
        if (!IsOpen && !BannerShowing) return;
        Styles();
        GUI.depth = -300;   // over the cargo screen (-100) and the HUD
        int w = Screen.width, h = Screen.height;
        float scale = Mathf.Max(1f, Arena.DailyLobby.UiScale());
        _title.fontSize = Mathf.RoundToInt(20f * scale);
        _body.fontSize = Mathf.RoundToInt(15f * scale);
        _small.fontSize = Mathf.RoundToInt(13f * scale);
        _btn.fontSize = Mathf.RoundToInt(15f * scale);
        if (IsOpen) DrawPanel(w, h, scale);
        if (BannerShowing) DrawBanner(w, h, scale);
    }

    /// <summary>The panel's rectangle: centred, at most 560 css px wide, 92 % of a phone.</summary>
    public static Rect PanelRect(int w, int h, float scale)
    {
        float pw = Mathf.Min(w * 0.92f, 560f * scale);
        float ph = Mathf.Min(h * 0.80f, 420f * scale);
        return new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);
    }

    void DrawPanel(int w, int h, float scale)
    {
        // the world behind dimmed, and no click reaches what is under the panel
        GUI.color = new Color(0f, 0f, 0f, 0.55f);
        GUI.DrawTexture(new Rect(0, 0, w, h), _flat);
        GUI.color = Color.white;
        var p = PanelRect(w, h, scale);
        PanelSkin.Glow(p, PanelSkin.Gold);
        PanelSkin.Gradient(p, new Color(0.10f, 0.11f, 0.14f, 0.98f), new Color(0.05f, 0.06f, 0.08f, 0.98f));
        PanelSkin.Border(p, new Color(PanelSkin.Gold.r, PanelSkin.Gold.g, PanelSkin.Gold.b, 0.85f));
        float pad = 16f * scale, y = p.y + pad, inner = p.width - 2f * pad;

        GUI.Label(new Rect(p.x + pad, y, inner, 28f * scale), "BUY ADD-ONS", _title);
        float closeW = 92f * scale;
        if (GUI.Button(new Rect(p.xMax - pad - closeW, y, closeW, 30f * scale), "CLOSE", _btn)) Close();
        y += 36f * scale;
        GUI.Label(new Rect(p.x + pad, y, inner, 40f * scale), "Bought once with your wallet, yours for good in every round of this game.", _small);
        y += 44f * scale;

        if (_s == null || !_s.shop) GUI.Label(new Rect(p.x + pad, y, inner, 30f * scale), "This game sells nothing.", _body);
        else
        {
            foreach (var it in _s.items)
            {
                // THE WORDS FIT (the owner: "text doesn't fit" - "· 500" then "sat" cut at the row's floor): the icon, the words
                // in the room left between it and the button, and the row as tall as the words need; the price is on the button
                float icon = 52f * scale, bw = Mathf.Min(140f * scale, inner * 0.36f), bh = 40f * scale, gap = 12f * scale;
                float textX = icon + 2f * gap, textW = inner - textX - bw - 2f * gap;
                var name = new GUIStyle(_body) { fontStyle = FontStyle.Bold, wordWrap = true };
                float nameH = name.CalcHeight(new GUIContent(it.name), textW), whatH = string.IsNullOrEmpty(it.what) ? 0f : _small.CalcHeight(new GUIContent(it.what), textW);
                float rowH = Mathf.Max(icon + 2f * gap, nameH + whatH + 3f * gap, (it.owned ? bh + 30f * scale : bh) + 2f * gap);
                var row = new Rect(p.x + pad, y, inner, rowH);
                PanelSkin.Gradient(row, new Color(0.13f, 0.15f, 0.19f, 0.95f), new Color(0.09f, 0.10f, 0.13f, 0.95f));
                PanelSkin.Border(row, new Color(1f, 1f, 1f, 0.12f));
                Icon(new Rect(row.x + gap, row.y + (rowH - icon) * 0.5f, icon, icon), it.id);
                GUI.Label(new Rect(row.x + textX, row.y + gap, textW, nameH), it.name, name);
                if (whatH > 0f) GUI.Label(new Rect(row.x + textX, row.y + gap + nameH + 2f * scale, textW, whatH), it.what, _small);
                var b = new Rect(row.xMax - bw - gap, row.y + (it.owned ? gap : (rowH - bh) * 0.5f), bw, bh);
                if (it.owned)
                {
                    var own = new GUIStyle(_body) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
                    own.normal.textColor = new Color(0.35f, 0.85f, 0.45f);
                    GUI.Label(b, "OWNED", own);
                    bool use = GUI.Toggle(new Rect(b.x, b.yMax, bw, 26f * scale), it.use, " Play with it");
                    if (use != it.use) { ArenaAddonsUse(it.id, use ? 1 : 0); it.use = use; }
                }
                else
                {
                    bool free = string.IsNullOrEmpty(_s.busy);
                    var buy = new GUIStyle(_buy) { fontSize = _btn.fontSize };
                    DriveHud.FitLine(buy, ButtonLabel(it, _s.busy), b.width - 12f * scale, 10);
                    if (!free) { buy.normal.background = buy.hover.background = buy.active.background = _orangeBusy; }
                    if (GUI.Button(b, ButtonLabel(it, _s.busy), buy) && free) { ArenaAddonsBuy(it.id); _polledAt = -99f; }
                }
                y += rowH + 10f * scale;
            }
            if (!_s.read) GUI.Label(new Rect(p.x + pad, y, inner, 24f * scale), "Reading what you own ...", _small);
            else if (!string.IsNullOrEmpty(_s.said))
            {
                var said = new GUIStyle(_body);
                said.normal.textColor = _s.bad ? new Color(1f, 0.45f, 0.4f) : new Color(0.55f, 0.9f, 0.6f);
                GUI.Label(new Rect(p.x + pad, y, inner, p.yMax - y - pad), _s.said, said);
            }
        }
        // what lies under the panel takes no click while it is open
        var e = Event.current;
        if (e != null && (e.type == EventType.MouseDown || e.type == EventType.MouseUp || e.type == EventType.TouchDown)) e.Use();
    }

    /// <summary>The banner's rectangle: across the top third, at most 640 css px wide.</summary>
    public static Rect BannerRect(int w, int h, float scale)
    {
        float bw = Mathf.Min(w * 0.92f, 640f * scale), bh = 96f * scale;
        return new Rect((w - bw) * 0.5f, h * 0.16f, bw, bh);
    }

    void DrawBanner(int w, int h, float scale)
    {
        float age = Time.unscaledTime - _bannerAt;
        // in over a quarter second, a gold pulse, out over the last half second
        float a = Mathf.Clamp01(age / 0.25f) * Mathf.Clamp01((BannerS - age) / 0.5f);
        var r = BannerRect(w, h, scale);
        float pulse = 0.5f + 0.5f * Mathf.Sin(age * 6f);
        GUI.color = new Color(1f, 1f, 1f, a);
        PanelSkin.Glow(r, PanelSkin.Gold, 6, 0.30f + 0.25f * pulse);
        PanelSkin.Gradient(r, new Color(0.22f, 0.17f, 0.05f, 0.97f), new Color(0.09f, 0.07f, 0.03f, 0.97f));
        PanelSkin.Border(r, PanelSkin.Gold);
        var t = new GUIStyle(_title) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(24f * scale) };
        DriveHud.FitLine(t, BannerTitle(_banner), r.width - 24f * scale, 12);
        GUI.Label(new Rect(r.x, r.y + 10f * scale, r.width, 34f * scale), BannerTitle(_banner), t);
        var l = new GUIStyle(_body) { alignment = TextAnchor.UpperCenter };
        GUI.Label(new Rect(r.x + 16f * scale, r.y + 50f * scale, r.width - 32f * scale, r.height - 52f * scale), BannerLine(_banner), l);
        GUI.color = Color.white;
    }
}
