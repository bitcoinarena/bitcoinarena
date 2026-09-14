using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

/// <summary>
/// The title screen: what the game is, how it is played, and a PLAY button.
///
/// It is not decoration. Browsers refuse to start audio until the page has
/// been clicked, so without a button to press the first run was silent - and
/// the loading ramp opened on a player who had not been told what any of it
/// was for.
///
/// The battlefield runs behind it from the god view, which is where the old
/// VIEW button went: the whole field on show while the rules are being read
/// is worth more than a button nobody pressed twice.
/// </summary>
public class SplashScreen : MonoBehaviour
{
    public ChaseCamera chase;
    public LoadoutPanel loadout;
    public TruckController truck;
    public GameAudio audioSource;

    /// <summary>True until the player has pressed PLAY.</summary>
    public bool Showing { get; private set; } = true;

    Texture2D _flat;
    GUIStyle _title, _sub, _body, _btn;

    // THE DAILY'S LOBBY (M3.3-34, the owner 2026-09-12 22:11-22:16): this screen is
    // the lobby when the page is one - the rounds, who you are, PLAY and
    // SPECTATE. Null when the page is not a lobby (offline, or a round).
    Blwp.LobbyState _lobby;
    float _polledAt = -10f, _shownAt = -10f;
    string _pickId = "", _nameWhy = "";
    int _offset;
    bool _joining, _autoPlay, _hiddenTold;
    string _joinWhy = "";
    float _joinedAt = -1f;
    // the owner's four how-to panels (2026-09-14 07:55), loaded once, and where they were drawn
    Texture2D _howToWhole;
    bool _howToAsked;
    Rect _lastHowTo;
    Rect[] _lastHowToCells;
    Rect _lastName, _lastKey, _lastMore;
    string _lastNotice = "";
    readonly System.Collections.Generic.List<(Blwp.LobbyRow row, Rect rect)> _drawnRows =
        new System.Collections.Generic.List<(Blwp.LobbyRow row, Rect rect)>();

    void Awake()
    {
        _flat = new Texture2D(1, 1);
        _flat.SetPixel(0, 0, Color.white);
        _flat.Apply();

        // Silence until the button is pressed. A browser would refuse to play
        // it anyway, and starting muted means the first thing heard is the
        // engine rather than half a second of clipped noise.
        AudioListener.volume = 0f;
    }

    void Start()
    {
        if (chase == null) chase = FindFirstObjectByType<ChaseCamera>();
        if (loadout == null) loadout = FindFirstObjectByType<LoadoutPanel>();
        if (truck == null) truck = FindFirstObjectByType<TruckController>();
        if (audioSource == null) audioSource = FindFirstObjectByType<GameAudio>();

        // the whole field, from above, while the rules are being read
        if (chase != null && chase.View != ChaseCamera.Mode.God) chase.Toggle();

        // SENT HERE BY PLAY IN THE LOBBY: the round starts, with no second PLAY.
        _autoPlay = Blwp.DailyLobby.AutoPlay();
    }

    void Update()
    {
        if (!Showing)
        {
            if (!_hiddenTold && Blwp.DailyLobby.Compiled) { _hiddenTold = true; Blwp.DailyLobby.Shown("{\"showing\":false}"); }
            return;
        }
        // held here, whatever else thinks it should be driveable
        if (truck != null) truck.controlsLocked = true;
        if (_autoPlay && Time.frameCount > 3) { _autoPlay = false; Play(); return; }

        // The page's lobby, asked again every 0.75 s (it asks the seats every 5 s).
        if (Time.unscaledTime - _polledAt > 0.75f)
        {
            _polledAt = Time.unscaledTime;
            _lobby = Blwp.DailyLobby.Poll();
            if (_lobby != null)
            {
                int k = Blwp.DailyLobby.Keep(_lobby.rows, _pickId);
                _pickId = k >= 0 ? _lobby.rows[k].id : "";
            }
        }

        // PLAY IN THE LOBBY TAKES THE SEAT IN THIS PAGE (the owner 2026-09-13 07:11):
        // no reload, so no second loading screen - the round starts here once the
        // page has joined it.
        if (_joining && _lobby != null)
        {
            if (_lobby.join.state == "joined" && _joinedAt < 0f) _joinedAt = Time.unscaledTime;
            string next = Blwp.DailyLobby.AfterJoin(_lobby, Blwp.BlwpNet.Running,
                                                    _joinedAt < 0f ? 0f : Time.unscaledTime - _joinedAt);
            if (next == "play") { _joining = false; Play(); return; }
            if (next == "refused") { _joining = false; _joinWhy = _lobby.join.why; _polledAt = -10f; }
        }
    }

    /// <summary>Free camera, without starting the round.</summary>
    public void Spectate()
    {
        WakeAudio();
        var cam = Object.FindFirstObjectByType<SpectatorCamera>();
        if (cam != null) cam.Enter();
        Showing = false;
    }

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern void UnlockAudio();
#endif

    /// <summary>
    /// Wakes the browser's audio, from inside the gesture that asked for it.
    ///
    /// A phone browser will not start an AudioContext outside a user gesture,
    /// and iOS additionally wants something PLAYED inside that same gesture
    /// before it will believe the context is in use - which is why the game
    /// was silent on a phone while being perfectly audible on a desktop, where
    /// Unity's own one-shot resume is enough.
    /// </summary>
    public static void WakeAudio()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        try { UnlockAudio(); } catch (System.Exception e) { Debug.LogWarning(e.Message); }
#endif
    }

    public void Play()
    {
        // Fly in from over the middle of the field.
        //
        // A cut straight to the tailgate shows neither the fighting nor the
        // building the freight comes out of, which are the two things worth
        // seeing before a run. It starts high over the battlefield looking at
        // the post office and swings onto the truck as it arrives.
        var chase = FindFirstObjectByType<ChaseCamera>();
        var post = FindFirstObjectByType<PostOffice>();
        if (chase != null)
            chase.FlyIn(new Vector3(0f, 52f, 0f),
                        post != null ? post.BayPosition + Vector3.up * 18f
                                     : new Vector3(-114f, 20f, 0f),
                        4.2f);

        Showing = false;
        WakeAudio();
        AudioListener.volume = 1f;
        if (chase != null && chase.View == ChaseCamera.Mode.God) chase.Toggle();
        if (loadout != null) loadout.Open();      // straight to the ramp
    }

    void Styles(int sw, int sh)
    {
        int min = Mathf.Min(sw, sh);
        if (_title == null)
        {
            _title = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold };
            // wrapped, because the standfirst and the footnote are sentences,
            // and a centred style that cannot wrap runs straight off the panel
            _sub = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.MiddleCenter, wordWrap = true };
            _body = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperLeft, wordWrap = true };
            // No skin box: the gradient and border underneath are the button,
            // and Unity's default grey would sit on top of them.
            _btn = new GUIStyle(GUI.skin.label)
                { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold };
        }
        _title.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.070f, 30f, 68f));
        _sub.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.028f, 14f, 24f));
        _body.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.026f, 13f, 22f));
        _btn.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.040f, 18f, 34f));
    }

    /// <summary>
    /// Every rectangle on the screen, in one place.
    ///
    /// The layout is arithmetic and nothing else, which is what lets it be
    /// checked by measurement rather than by looking at it. That matters here:
    /// OnGUI never runs in batch mode, so a title screen can only be tested at
    /// all if its geometry can be asked for without drawing it - and the
    /// version of this screen that drew its hint line inside its own second
    /// button looked perfectly fine on the one window it was written for.
    /// </summary>
    public struct Frame
    {
        public Rect panel, head, copy, hint, play, spectate, build;
        public float pad;
    }

    /// <summary>
    /// Lays the screen out from the bottom up: the buttons take their room
    /// first, the hint takes a line above them, and the copy gets whatever is
    /// left over. Nothing in here can land on anything else, at any size.
    /// </summary>
    public static Frame Measure(float w, float h, float subFont, float btnFont)
    {
        float pw = Mathf.Min(w * 0.86f, 900f);
        float ph = Mathf.Min(h * 0.88f, 760f);
        var panel = new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);
        var head = new Rect(panel.x, panel.y, panel.width, Mathf.Clamp(ph * 0.13f, 44f, 96f));

        float pad = pw * 0.07f;
        // AND NO MORE THAN 7% OF THE HEIGHT, up and down. The pad is the width's,
        // and on a phone held sideways that is a wide margin on a short screen:
        // measured, at 800x360 the lobby had 55 px for its rounds - one row
        // (LobbyScreenTests). Across, the pad stays the width's.
        float padV = Mathf.Min(pad, ph * 0.07f);
        float inner = panel.width - pad * 2f;
        float bh = Mathf.Max(30f, btnFont * 2.0f);
        float gap = Mathf.Max(8f, padV * 0.35f);

        // one row, one baseline, one height - the primary takes two thirds
        // because it is the one to press
        float row = panel.yMax - padV * 0.6f - bh;
        float wide = (inner - gap) * 0.62f;
        var play = new Rect(panel.x + pad, row, wide, bh);
        var spectate = new Rect(play.xMax + gap, row, inner - wide - gap, bh);

        float hintHigh = subFont * 1.5f;
        var hint = new Rect(panel.x + pad, row - gap - hintHigh, inner, hintHigh);

        // WHICH BUILD THIS IS, on its own line under the title bar.
        //
        // A row of its own rather than tucked into a corner of another one:
        // twice in one session a measured fix "changed nothing on the phone"
        // and both times the page was serving an older build than the one
        // being argued about. It is only useful if it cannot be drawn over.
        var build = new Rect(panel.x + pad, head.yMax + ph * 0.008f,
                             inner, Mathf.Max(12f, subFont * 1.3f));

        float top = build.yMax + ph * 0.02f;
        var copy = new Rect(panel.x + pad, top, inner,
                            Mathf.Max(0f, hint.y - padV * 0.25f - top));

        return new Frame { panel = panel, head = head, copy = copy, hint = hint,
                           play = play, spectate = spectate, pad = pad, build = build };
    }

    void OnGUI()
    {
        if (!Showing) return;
        // LAID OUT IN CSS PIXELS, DRAWN AT THE SCREEN'S SCALE. A phone's canvas is
        // 2-3x its CSS size, and a title screen laid out in device pixels showed an
        // iPhone text about 8 points high (measured, M3.3-34). IMGUI's matrix
        // scales the drawing and the touches alike.
        float scale = Blwp.DailyLobby.UiScale();
        var screenMatrix = GUI.matrix;
        GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
        int w = Mathf.RoundToInt(Screen.width / scale), h = Mathf.RoundToInt(Screen.height / scale);
        Styles(w, h);
        GUI.depth = -200;                          // in front of everything


        // A wash rather than a curtain: the battle behind this is the best
        // argument the game has, and it is running whether anyone watches or
        // not.
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.62f);
        GUI.DrawTexture(new Rect(0, 0, w, h), _flat);
        GUI.color = Color.white;

        // The copy is given the space that is left, and set smaller until it
        // fits in it. A hard floor under the text is the only thing that makes
        // "the buttons are clear of it" true on a window nobody tried - a
        // phone in landscape has about a third of the height this was drawn
        // for.
        var f = Measure(w, h, _sub.fontSize, _btn.fontSize);
        bool lobby = _lobby != null;
        for (int guard = 0; !lobby && guard < 8 && _body.fontSize > 10; guard++)
        {
            if (Copy(f.copy.width, false, 0f, 0f) <= f.copy.height) break;
            Shrink(0.92f);
            f = Measure(w, h, _sub.fontSize, _btn.fontSize);
        }

        var panel = f.panel;
        var head = f.head;
        float pw = panel.width, ph = panel.height, pad = f.pad;

        PanelSkin.Glow(panel, PanelSkin.Gold, 6, 0.34f);
        PanelSkin.Body(panel);
        PanelSkin.Border(panel, new Color(PanelSkin.Gold.r, PanelSkin.Gold.g, PanelSkin.Gold.b, 0.85f));
        PanelSkin.Scan(panel, PanelSkin.Cyan, 5.5f);

        float tape = Mathf.Clamp(pw * 0.011f, 9f, 17f);
        PanelSkin.Hazard(new Rect(panel.x + 2f, head.yMax, tape, panel.yMax - head.yMax - 2f),
                         PanelSkin.Gold);
        PanelSkin.Hazard(new Rect(panel.xMax - tape - 2f, head.yMax, tape, panel.yMax - head.yMax - 2f),
                         PanelSkin.Gold);

        PanelSkin.Gradient(head, new Color(0.17f, 0.14f, 0.07f, 0.98f),
                                 new Color(0.07f, 0.065f, 0.05f, 0.98f));
        PanelSkin.Rule(new Rect(head.x, head.yMax - 3f, head.width, 3f), PanelSkin.Gold);

        _title.normal.textColor = new Color(0f, 0f, 0f, 0.6f);
        GUI.Label(new Rect(head.x + 3f, head.y + 4f, head.width, head.height), Title, _title);
        _title.normal.textColor = PanelSkin.Gold;
        GUI.Label(head, Title, _title);

        // The build, right-aligned on its own row under the title bar.
        var stamp = new GUIStyle(_sub)
        {
            alignment = TextAnchor.MiddleRight,
            fontSize = Mathf.Max(10, Mathf.RoundToInt(_sub.fontSize * 0.8f)),
        };
        stamp.normal.textColor = new Color(1f, 1f, 1f, 0.5f);
        GUI.Label(f.build, $"build {BuildStamp.Current}", stamp);

        if (lobby) Lobby(f.copy); else Copy(f.copy.width, true, f.copy.x, f.copy.y);
        Buttons(f);

        PanelSkin.Corners(panel, PanelSkin.Gold, 4f);
        Report(w, h, f);
        GUI.matrix = screenMatrix;
    }

    // ------------------------------------------------------------ the lobby

    /// <summary>
    /// The lobby in the copy area: who you are with NAME and KEY, then the
    /// rounds - each with its seats' word - and the one PLAY will join picked
    /// out. Laid out by `DailyLobby.MeasureLobby`, which is measured on every
    /// phone shape (LobbyScreenTests). Every word comes from the page.
    /// </summary>
    void Lobby(Rect copy)
    {
        float font = _sub.fontSize;
        var l = Blwp.DailyLobby.MeasureLobby(copy, font, Screen.height > Screen.width);
        _lastName = l.name; _lastKey = l.key; _lastMore = l.more; _lastHowTo = l.howTo; _lastHowToCells = l.howToCells;
        var you = _lobby.you;

        // THE OWNER'S HOW-TO, FOUR PANELS, EACH WHOLE (2026-09-14 07:55): load
        // mempool TXs, cross the front (closer = more points), deliver to miners,
        // stake sats and win. 1-2-3-4 in a row on a desktop, 1-2 over 3-4 on a
        // phone; drawn with their alpha, so the knocked-out white shows the panel.
        // EACH FROM THE OWNER'S WHOLE, BY ITS OWN BOX: the tiles that came with it
        // were cut at half height and split panels 1 and 2 (measured, 1280x800).
        // A cell is exactly its panel's shape, so nothing is stretched.
        if (!_howToAsked) { _howToAsked = true; _howToWhole = Resources.Load<Texture2D>(Blwp.DailyLobby.HowToWhole); }
        if (_howToWhole != null && l.howToCells != null)
            for (int i = 0; i < l.howToCells.Length; i++)
            {
                var cell = l.howToCells[i];
                if (cell.width <= 0f || cell.height <= 0f) continue;
                GUI.DrawTextureWithTexCoords(cell, _howToWhole, Blwp.DailyLobby.PanelUv(i));
            }

        var youStyle = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), wordWrap = true, richText = true, alignment = TextAnchor.MiddleLeft };
        youStyle.normal.textColor = Color.white;
        // A WITHDRAWAL AVAILABLE (the owner 2026-09-14) takes the key's line until it is withdrawn;
        // a name the page refused still comes first, and KEY still shows the key.
        _lastNotice = Blwp.DailyLobby.WithdrawNotice(_lobby);
        string second = !string.IsNullOrEmpty(_nameWhy) ? $"<color=#ff7b72>{Escape(_nameWhy)}</color>"
            : !string.IsNullOrEmpty(_lastNotice) ? $"<color=#3fb950><b>{Escape(_lastNotice)}</b></color>"
            : $"<color=#9fb3c8>key {Escape(you.fingerprint)}</color>";
        // SET SMALLER UNTIL IT FITS ITS BOX. Measured on an iPhone (390x844 at 3x):
        // the name wrapped to a third line in a two-line box, and the box clipped
        // "You are" at the top and the key at the bottom (the owner 22:16: every
        // element fully visible).
        var youText = new GUIContent($"You are <b>{Escape(you.name)}</b> · {(you.custom ? "your name" : "made from your key")}\n{second}");
        while (youStyle.fontSize > 10 && youStyle.CalcHeight(youText, l.you.width) > l.you.height) youStyle.fontSize--;
        GUI.Label(l.you, youText, youStyle);
        if (SmallButton(l.name, "NAME")) { WakeAudio(); _nameWhy = Blwp.DailyLobby.EditName(); _polledAt = -10f; }
        if (SmallButton(l.key, "KEY")) Blwp.DailyLobby.KeyBackup();

        var rows = _lobby.rows;
        int needed = 2;
        foreach (var r in rows) if (r.needed > 0) { needed = r.needed; break; }
        var head = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft, wordWrap = false };
        head.normal.textColor = PanelSkin.Gold;
        GUI.Label(l.head, Fit(head, $"ROUNDS · JOIN NEEDS {needed} OF {needed} SEATS", l.head.width), head);
        if (_offset >= rows.Length) _offset = 0;
        if (l.rows > 0 && rows.Length > l.rows)
        {
            int pages = (rows.Length + l.rows - 1) / l.rows;
            if (SmallButton(l.more, $"{_offset / l.rows + 1}/{pages} >")) _offset = (_offset + l.rows) % rows.Length;
        }
        else _offset = 0;

        _drawnRows.Clear();
        var rowStyle = new GUIStyle(_body)
            { fontSize = Mathf.RoundToInt(font), alignment = TextAnchor.MiddleLeft, wordWrap = false, clipping = TextClipping.Clip };
        for (int i = 0; i < l.rows && _offset + i < rows.Length; i++)
        {
            var r = rows[_offset + i];
            var rect = new Rect(l.list.x, l.list.y + i * l.rowH, l.list.width, l.rowH - 4f);
            bool picked = r.joinable && r.id == _pickId;
            PanelSkin.Gradient(rect,
                r.joinable ? new Color(0.13f, 0.12f, 0.07f, 0.95f) : new Color(0.08f, 0.09f, 0.10f, 0.90f),
                r.joinable ? new Color(0.08f, 0.075f, 0.05f, 0.95f) : new Color(0.06f, 0.065f, 0.075f, 0.90f));
            PanelSkin.Border(rect, picked ? PanelSkin.Gold : new Color(1f, 1f, 1f, r.joinable ? 0.35f : 0.15f));
            rowStyle.fontSize = Mathf.RoundToInt(font);
            rowStyle.normal.textColor = r.joinable ? (picked ? PanelSkin.Gold : Color.white) : new Color(1f, 1f, 1f, 0.5f);
            var inner = new Rect(rect.x + 8f, rect.y, rect.width - 16f, rect.height);
            GUI.Label(inner, FitWords(rowStyle, Blwp.DailyLobby.RowWords(r), inner.width), rowStyle);
            if (r.joinable && GUI.Button(rect, GUIContent.none, GUIStyle.none)) _pickId = r.id;
            _drawnRows.Add((r, rect));
        }
        if (rows.Length == 0 && l.list.height > 0)
        {
            var none = new GUIStyle(_body) { fontSize = Mathf.RoundToInt(font), wordWrap = true };
            none.normal.textColor = new Color(1f, 1f, 1f, 0.7f);
            GUI.Label(l.list, "No round is open for entry right now. The seats are asked again every 5 seconds."
                + (_lobby.refused.Length > 0 ? $"\nNot listed: {_lobby.refused.Length}" : ""), none);
        }
    }

    /// <summary>What PLAY will do, on the hint line - short enough for a phone.</summary>
    string LobbyHint()
    {
        if (_joining) return string.IsNullOrEmpty(_lobby.join.stage) ? "joining the round …" : $"joining the round - {_lobby.join.stage} …";
        if (!string.IsNullOrEmpty(_joinWhy)) return $"not seated: {_joinWhy}";
        int k = Blwp.DailyLobby.Keep(_lobby.rows, _pickId);
        if (k >= 0)
        {
            var r = _lobby.rows[k];
            return $"PLAY joins round {Short(r.id)} - {r.agree} of {r.needed} seats agree";
        }
        return _lobby.rows.Length > 0 ? "PLAY waits for a round both seats agree on" : "PLAY waits for an open round";
    }

    void JoinPicked()
    {
        WakeAudio();
        _joinWhy = "";
        _joinedAt = -1f;
        _joining = Blwp.DailyLobby.Join(_pickId);
        // the last poll still holds the press before this one: it is not this join's answer
        if (_joining && _lobby != null) _lobby.join = new Blwp.LobbyJoin { state = "joining" };
        _polledAt = -10f;
    }

    bool SmallButton(Rect r, string label)
    {
        PanelSkin.Gradient(r, new Color(0.10f, 0.14f, 0.20f, 0.95f), new Color(0.06f, 0.09f, 0.13f, 0.95f));
        PanelSkin.Border(r, new Color(0.55f, 0.75f, 1f, 0.75f));
        var s = new GUIStyle(_btn) { fontSize = Mathf.RoundToInt(Mathf.Min(_btn.fontSize, _sub.fontSize * 1.1f)) };
        s.normal.textColor = new Color(0.70f, 0.85f, 1f);
        Shrink(s, label, r);
        return GUI.Button(r, label, s);
    }

    static string Fit(GUIStyle style, string text, float width)
    {
        var c = new GUIContent(text);
        while (style.fontSize > 10 && style.CalcSize(c).x > width) style.fontSize--;
        return text;
    }

    /// <summary>The longest of the wordings that fits; the shortest, smaller, when none does.</summary>
    static string FitWords(GUIStyle style, string[] words, float width)
    {
        foreach (var w in words)
            if (style.CalcSize(new GUIContent(w)).x <= width) return w;
        return Fit(style, words[words.Length - 1], width);
    }

    static string Escape(string s) => (s ?? "").Replace("<", "‹").Replace(">", "›");
    static string Short(string id) => string.IsNullOrEmpty(id) ? "" : (id.Length > 8 ? id.Substring(0, 8) : id);

    static string R(Rect r) => string.Format(System.Globalization.CultureInfo.InvariantCulture,
        "[{0:0},{1:0},{2:0},{3:0}]", r.x, r.y, r.width, r.height);
    static string J(string s) => "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    /// <summary>
    /// WHAT WAS DRAWN, told to the page twice a second: the rows as shown, the
    /// buttons and where they are, and whether PLAY can be pressed. OnGUI
    /// cannot be read from outside, so without this "the lobby is visible" is
    /// an assumption; with it a probe measures it and presses the real buttons.
    /// </summary>
    void Report(int w, int h, Frame f)
    {
        if (!Blwp.DailyLobby.Compiled || Event.current.type != EventType.Repaint) return;
        if (Time.unscaledTime - _shownAt < 0.5f) return;
        _shownAt = Time.unscaledTime;
        var sb = new System.Text.StringBuilder();
        sb.Append("{\"showing\":true,\"lobby\":").Append(_lobby != null ? "true" : "false");
        sb.Append(",\"screen\":[").Append(w).Append(',').Append(h).Append(']');
        sb.Append(",\"panel\":").Append(R(f.panel));
        sb.Append(",\"play\":").Append(R(f.play)).Append(",\"playEnabled\":")
          .Append(_lobby == null || (!_joining && !string.IsNullOrEmpty(_pickId)) ? "true" : "false");
        sb.Append(",\"spectate\":").Append(R(f.spectate)).Append(",\"hint\":").Append(R(f.hint));
        if (_lobby != null)
        {
            sb.Append(",\"you\":").Append(J(_lobby.you.name)).Append(",\"withdrawNotice\":").Append(J(_lastNotice)).Append(",\"name\":").Append(R(_lastName))
              .Append(",\"key\":").Append(R(_lastKey)).Append(",\"howTo\":").Append(R(_lastHowTo))
              .Append(",\"howToCells\":[").Append(_lastHowToCells == null ? "" : string.Join(",", System.Array.ConvertAll(_lastHowToCells, R))).Append(']')
              .Append(",\"howToDrawn\":").Append(_howToWhole != null && _lastHowToCells != null ? _lastHowToCells.Length : 0).Append(",\"picked\":").Append(J(_pickId))
              .Append(",\"listed\":").Append(_lobby.rows.Length).Append(",\"rows\":[");
            for (int i = 0; i < _drawnRows.Count; i++)
            {
                var (row, rect) = _drawnRows[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":").Append(J(row.id)).Append(",\"joinable\":").Append(row.joinable ? "true" : "false")
                  .Append(",\"agree\":").Append(row.agree).Append(",\"needed\":").Append(row.needed)
                  .Append(",\"rect\":").Append(R(rect)).Append('}');
            }
            sb.Append(']');
        }
        sb.Append('}');
        Blwp.DailyLobby.Shown(sb.ToString());
    }

    public const string Title = "BTC LOGISTICS WAR";
    public const string PlayLabel = "▶  PLAY";
    public const string SpectateLabel = "SPECTATE";

    const string Standfirst = "HAUL REAL MEMPOOL FREIGHT THROUGH A LIVE BATTLEFIELD";
    const string Footnote = "One Bitcoin block is one round - and every fee, block and " +
                            "transaction on this map is the live chain, right now.";
    const string Hint = "sound starts when you press play";

    static readonly string[] Steps = { "1 · LOAD", "2 · DRIVE", "3 · DELIVER" };
    static readonly string[] Says =
    {
        "Take transactions off the ramp at the post office. A full bed is worth " +
        "more at the far end - and pulls both armies onto you on the way there.",
        "W A S D, or the pads on a touchscreen. The points are in the fighting: " +
        "a run down the quiet edge of the map scores almost nothing, however " +
        "much freight it is carrying.",
        "Reach the miner before the block closes. The run scores cargo times " +
        "exposure times speed - and a load that misses the block scores zero, " +
        "however well it was driven.",
    };

    /// <summary>
    /// Draws the copy, or measures it - one routine for both, because a layout
    /// measured by one and drawn by another comes apart the first time either
    /// is edited.
    /// </summary>
    float Copy(float width, bool draw, float x, float y)
    {
        float top = y;

        _sub.normal.textColor = PanelSkin.Cyan;
        y += Line(_sub, Standfirst, x, y, width, draw) + _sub.fontSize * 0.9f;

        var stepHead = new GUIStyle(_body) { fontStyle = FontStyle.Bold };
        stepHead.normal.textColor = PanelSkin.Gold;
        for (int i = 0; i < Steps.Length; i++)
        {
            float high = Line(stepHead, Steps[i], x, y, width, draw);
            if (draw) PanelSkin.Rule(new Rect(x, y + high, width * 0.10f, 2f), PanelSkin.Gold);
            y += high + _body.fontSize * 0.55f;

            _body.normal.textColor = new Color(1f, 1f, 1f, 0.88f);
            y += Line(_body, Says[i], x, y, width, draw) + _body.fontSize * 0.85f;
        }

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.62f);
        y += Line(_sub, Footnote, x, y, width, draw);
        return y - top;
    }

    /// <summary>Sets one block of text and returns how tall it turned out.</summary>
    static float Line(GUIStyle style, string what, float x, float y, float width, bool draw)
    {
        var content = new GUIContent(what);
        float height = style.CalcHeight(content, width);
        if (draw) GUI.Label(new Rect(x, y, width, height), content, style);
        return height;
    }

    void Shrink(float by)
    {
        _sub.fontSize = Mathf.Max(10, Mathf.RoundToInt(_sub.fontSize * by));
        _body.fontSize = Mathf.Max(10, Mathf.RoundToInt(_body.fontSize * by));
    }

    /// <summary>
    /// PLAY and the spectator camera, side by side on one baseline.
    ///
    /// They used to be stacked in two different heights with the hint line
    /// drawn across the lower one, and the second was labelled INSPECT, which
    /// says nothing about what it is for. It is a debug camera and it now says
    /// so.
    /// </summary>
    void Buttons(Frame f)
    {
        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.42f);
        if (_lobby != null)
        {
            var hint = new GUIStyle(_sub) { wordWrap = false };
            hint.normal.textColor = new Color(1f, 1f, 1f, 0.6f);
            GUI.Label(f.hint, Fit(hint, LobbyHint(), f.hint.width), hint);
        }
        else GUI.Label(f.hint, Hint, _sub);

        // IN THE LOBBY, PLAY JOINS THE PICKED ROUND - and there is nothing to
        // press until a round has both of its seats' word (M3.3-34).
        bool canPlay = _lobby == null || (!_joining && !string.IsNullOrEmpty(_pickId));
        // the button breathes, so the eye finds it
        float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.4f);
        if (canPlay) PanelSkin.Glow(f.play, PanelSkin.Gold, 4, 0.18f + 0.22f * pulse);
        PanelSkin.Gradient(f.play, canPlay ? new Color(0.30f, 0.24f, 0.06f, 0.95f) : new Color(0.14f, 0.14f, 0.14f, 0.9f),
                                   canPlay ? new Color(0.16f, 0.13f, 0.04f, 0.95f) : new Color(0.09f, 0.09f, 0.09f, 0.9f));
        PanelSkin.Border(f.play, canPlay ? PanelSkin.Gold : new Color(1f, 1f, 1f, 0.25f));
        var gold = new GUIStyle(_btn);
        gold.normal.textColor = canPlay ? PanelSkin.Gold : new Color(1f, 1f, 1f, 0.35f);
        Shrink(gold, PlayLabel, f.play);
        if (GUI.Button(f.play, PlayLabel, gold) && canPlay)
        {
            if (_lobby != null) JoinPicked(); else Play();
        }

        // A free camera, offered before the run rather than hidden behind a
        // key. The two buildings are the most expensive things in the project
        // and are normally only ever seen from behind a truck at windscreen
        // height; flying round them is how you find out whether they are
        // actually right.
        PanelSkin.Gradient(f.spectate, new Color(0.10f, 0.14f, 0.20f, 0.95f),
                                       new Color(0.06f, 0.09f, 0.13f, 0.95f));
        PanelSkin.Border(f.spectate, new Color(0.55f, 0.75f, 1f, 0.75f));
        var blue = new GUIStyle(_btn);
        blue.normal.textColor = new Color(0.70f, 0.85f, 1f);
        Shrink(blue, SpectateLabel, f.spectate);
        if (GUI.Button(f.spectate, SpectateLabel, blue)) Spectate();
    }

    /// <summary>
    /// Sets a button's label to fit inside the button.
    ///
    /// GUI.Button clips rather than wraps, and DEBUG SPECTATE is twice the
    /// word PLAY - on a phone the secondary would otherwise read "DEBUG SPE".
    /// </summary>
    static void Shrink(GUIStyle style, string label, Rect into)
    {
        var content = new GUIContent(label);
        while (style.fontSize > 9 && style.CalcSize(content).x > into.width - 10f)
            style.fontSize--;
    }
}
