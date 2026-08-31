using UnityEngine;

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
    }

    void Update()
    {
        if (!Showing) return;
        // held here, whatever else thinks it should be driveable
        if (truck != null) truck.controlsLocked = true;
    }

    /// <summary>Free camera, without starting the round.</summary>
    public void Spectate()
    {
        var cam = Object.FindFirstObjectByType<SpectatorCamera>();
        if (cam != null) cam.Enter();
        Showing = false;
    }

    public void Play()
    {
        Showing = false;
        AudioListener.volume = 1f;
        if (chase != null && chase.View == ChaseCamera.Mode.God) chase.Toggle();
        if (loadout != null) loadout.Open();      // straight to the ramp
    }

    void Styles()
    {
        int min = Mathf.Min(Screen.width, Screen.height);
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
        public Rect panel, head, copy, hint, play, spectate;
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
        float inner = panel.width - pad * 2f;
        float bh = Mathf.Max(30f, btnFont * 2.0f);
        float gap = Mathf.Max(8f, pad * 0.35f);

        // one row, one baseline, one height - the primary takes two thirds
        // because it is the one to press
        float row = panel.yMax - pad * 0.6f - bh;
        float wide = (inner - gap) * 0.62f;
        var play = new Rect(panel.x + pad, row, wide, bh);
        var spectate = new Rect(play.xMax + gap, row, inner - wide - gap, bh);

        float hintHigh = subFont * 1.5f;
        var hint = new Rect(panel.x + pad, row - gap - hintHigh, inner, hintHigh);

        float top = head.yMax + ph * 0.03f;
        var copy = new Rect(panel.x + pad, top, inner,
                            Mathf.Max(0f, hint.y - pad * 0.25f - top));

        return new Frame { panel = panel, head = head, copy = copy, hint = hint,
                           play = play, spectate = spectate, pad = pad };
    }

    void OnGUI()
    {
        if (!Showing) return;
        Styles();
        GUI.depth = -200;                          // in front of everything

        int w = Screen.width, h = Screen.height;

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
        for (int guard = 0; guard < 8 && _body.fontSize > 10; guard++)
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

        Copy(f.copy.width, true, f.copy.x, f.copy.y);
        Buttons(f);

        PanelSkin.Corners(panel, PanelSkin.Gold, 4f);
    }

    public const string Title = "BTC LOGISTICS WAR";
    public const string PlayLabel = "▶  PLAY";
    public const string SpectateLabel = "DEBUG SPECTATE";

    const string Standfirst = "HAUL REAL MEMPOOL FREIGHT THROUGH A LIVE BATTLEFIELD";
    const string Footnote = "One Bitcoin block is one round - and every fee, block and " +
                            "transaction on this map is the live chain, right now.";
    const string Hint = "sound starts when you press play";

    static readonly string[] Steps = { "1 · LOAD", "2 · DRIVE", "3 · DELIVER" };
    static readonly string[] Says =
    {
        "Take transactions off the ramp at the post office. Their fees are your " +
        "payout - and the richer the load, the harder both armies come after it.",
        "W A S D, or the pads on a touchscreen. Infantry goes under the wheels; " +
        "a tank does not.",
        "Reach the miner before the block closes. What gets through in time is " +
        "confirmed and paid; what does not is worth nothing.",
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
        GUI.Label(f.hint, Hint, _sub);

        // the button breathes, so the eye finds it
        float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.4f);
        PanelSkin.Glow(f.play, PanelSkin.Gold, 4, 0.18f + 0.22f * pulse);
        PanelSkin.Gradient(f.play, new Color(0.30f, 0.24f, 0.06f, 0.95f),
                                   new Color(0.16f, 0.13f, 0.04f, 0.95f));
        PanelSkin.Border(f.play, PanelSkin.Gold);
        var gold = new GUIStyle(_btn);
        gold.normal.textColor = PanelSkin.Gold;
        Shrink(gold, PlayLabel, f.play);
        if (GUI.Button(f.play, PlayLabel, gold)) Play();

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
