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
            _btn = new GUIStyle(GUI.skin.button) { fontStyle = FontStyle.Bold };
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
        var gold = new Color(1f, 0.86f, 0.35f);

        // a dark wash, not a solid fill: the battle is worth watching
        GUI.color = new Color(0.02f, 0.03f, 0.05f, 0.72f);
        GUI.DrawTexture(new Rect(0, 0, w, h), _flat);
        GUI.color = Color.white;

        float pw = Mathf.Min(w * 0.86f, 900f);
        float ph = Mathf.Min(h * 0.82f, 640f);
        var panel = new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);

        GUI.color = new Color(0.05f, 0.05f, 0.07f, 0.92f);
        GUI.DrawTexture(panel, _flat);
        GUI.color = new Color(gold.r, gold.g, gold.b, 0.8f);
        foreach (var edge in new[]
        {
            new Rect(panel.x, panel.y, panel.width, 3f),
            new Rect(panel.x, panel.yMax - 3f, panel.width, 3f),
            new Rect(panel.x, panel.y, 3f, panel.height),
            new Rect(panel.xMax - 3f, panel.y, 3f, panel.height),
        }) GUI.DrawTexture(edge, _flat);
        GUI.color = Color.white;

        float pad = pw * 0.06f;
        float y = panel.y + pad * 0.7f;

        _title.normal.textColor = gold;
        GUI.Label(new Rect(panel.x, y, panel.width, _title.fontSize * 1.3f),
                  "BTC LOGISTICS WAR", _title);
        y += _title.fontSize * 1.35f;

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.75f);
        GUI.Label(new Rect(panel.x, y, panel.width, _sub.fontSize * 1.6f),
                  "Run mempool freight across a live battlefield", _sub);
        y += _sub.fontSize * 2.4f;

        _body.normal.textColor = new Color(1f, 1f, 1f, 0.92f);
        GUI.Label(new Rect(panel.x + pad, y, panel.width - pad * 2f, ph * 0.42f),
            "The ground you drive on is the Bitcoin mempool: the hills are the fee " +
            "histogram, the freight is real unconfirmed transactions.\n\n" +
            "1.  LOAD  —  pick parcels at the ramp. The fee is your payout. The " +
            "more you carry, the harder both armies hunt you.\n\n" +
            "2.  DRIVE  —  W A S D or the on-screen pads. Soldiers go under the " +
            "wheels; a tank does not. Watch your condition.\n\n" +
            "3.  DELIVER  —  reach the gate at the far end before the block closes. " +
            "Whatever arrives in time is confirmed and scored.\n\n" +
            "A block is a round. Playing it safe costs you the block.", _body);

        float bw = pw * 0.42f, bh = _btn.fontSize * 2.1f;
        var play = new Rect(panel.x + (pw - bw) * 0.5f, panel.yMax - pad - bh, bw, bh);
        if (GUI.Button(play, "▶  PLAY", _btn)) Play();

        _sub.normal.textColor = new Color(1f, 1f, 1f, 0.45f);
        GUI.Label(new Rect(panel.x, play.y - _sub.fontSize * 1.8f, panel.width, _sub.fontSize * 1.6f),
                  "sound starts when you press play", _sub);
    }
}
