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
            _sub = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter };
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

        float pw = Mathf.Min(w * 0.86f, 900f);
        float ph = Mathf.Min(h * 0.84f, 660f);
        var panel = new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);
        float bar = Mathf.Clamp(ph * 0.13f, 44f, 96f);
        var head = new Rect(panel.x, panel.y, panel.width, bar);

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
        GUI.Label(new Rect(head.x + 3f, head.y + 4f, head.width, head.height), "BTC LOGISTICS WAR", _title);
        _title.normal.textColor = PanelSkin.Gold;
        GUI.Label(head, "BTC LOGISTICS WAR", _title);

        float pad = pw * 0.07f;
        float y = head.yMax + ph * 0.035f;

        _sub.normal.textColor = PanelSkin.Cyan;
        GUI.Label(new Rect(panel.x, y, panel.width, _sub.fontSize * 1.6f),
                  "RUN MEMPOOL FREIGHT ACROSS A LIVE BATTLEFIELD", _sub);
        y += _sub.fontSize * 2.1f;

        // three numbered steps, each with its own accent rule
        string[] heads = { "1 · LOAD", "2 · DRIVE", "3 · DELIVER" };
        string[] bodies =
        {
            "Pick parcels at the ramp. The fee is your payout — and the more you " +
            "carry, the harder both armies hunt you.",
            "W A S D or the on-screen pads. Soldiers go under the wheels; a tank " +
            "does not. Watch your condition.",
            "Reach the gate at the far end before the block closes. Whatever " +
            "arrives in time is confirmed and scored.",
        };

        var stepHead = new GUIStyle(_body) { fontStyle = FontStyle.Bold };
        for (int i = 0; i < 3; i++)
        {
            stepHead.normal.textColor = PanelSkin.Gold;
            GUI.Label(new Rect(panel.x + pad, y, panel.width - pad * 2f, _body.fontSize * 1.5f),
                      heads[i], stepHead);
            PanelSkin.Rule(new Rect(panel.x + pad, y + _body.fontSize * 1.45f, pw * 0.09f, 2f),
                           PanelSkin.Gold);
            y += _body.fontSize * 1.9f;

            _body.normal.textColor = new Color(1f, 1f, 1f, 0.88f);
            GUI.Label(new Rect(panel.x + pad, y, panel.width - pad * 2f, _body.fontSize * 3.2f),
                      bodies[i], _body);
            y += _body.fontSize * 2.9f;
        }

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.6f);
        GUI.Label(new Rect(panel.x, y, panel.width, _sub.fontSize * 1.6f),
                  "A block is a round. Playing it safe costs you the block.", _sub);

        float bw = pw * 0.44f, bh = _btn.fontSize * 2.2f;
        var play = new Rect(panel.x + (pw - bw) * 0.5f, panel.yMax - pad * 0.75f - bh, bw, bh);

        // the button breathes, so the eye finds it
        float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.4f);
        PanelSkin.Glow(play, PanelSkin.Gold, 4, 0.18f + 0.22f * pulse);
        PanelSkin.Gradient(play, new Color(0.30f, 0.24f, 0.06f, 0.95f),
                                 new Color(0.16f, 0.13f, 0.04f, 0.95f));
        PanelSkin.Border(play, PanelSkin.Gold);
        _btn.normal.textColor = PanelSkin.Gold;
        if (GUI.Button(play, "▶   PLAY", _btn)) Play();

        // A free camera, offered before the run rather than hidden behind a
        // key. The two buildings are the most expensive things in the project
        // and normally only ever seen from behind a truck at windscreen
        // height; flying round them is how you find out whether they are
        // actually right.
        var spec = new Rect(play.x, play.y - bh * 1.15f, bw, bh * 0.78f);
        PanelSkin.Gradient(spec, new Color(0.10f, 0.14f, 0.20f, 0.95f),
                                 new Color(0.06f, 0.09f, 0.13f, 0.95f));
        PanelSkin.Border(spec, new Color(0.55f, 0.75f, 1f, 0.75f));
        var was = _btn.normal.textColor;
        _btn.normal.textColor = new Color(0.70f, 0.85f, 1f);
        if (GUI.Button(spec, "◈   INSPECT", _btn)) Spectate();
        _btn.normal.textColor = was;

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.42f);
        GUI.Label(new Rect(panel.x, play.y - _sub.fontSize * 1.7f, panel.width, _sub.fontSize * 1.5f),
                  "sound starts when you press play", _sub);

        PanelSkin.Corners(panel, PanelSkin.Gold, 4f);
    }
}
