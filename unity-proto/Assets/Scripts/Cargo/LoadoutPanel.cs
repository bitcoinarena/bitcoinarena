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

    void Start()
    {
        Open();                                   // the first run starts here too
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
    public void Confirm()
    {
        if (bay == null || !bay.IsLoaded) return;      // nothing aboard, nothing to run
        IsOpen = false;
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
        _cap.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.034f, 15f, 26f));
        _capSub.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.029f, 13f, 22f));
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
            float wCap = Mathf.Max(180f, Screen.width * 0.19f);
            float y = c.screen.y + c.radius + 4f;
            var box = new Rect(c.screen.x - wCap * 0.5f, y, wCap, _cap.fontSize * 3.6f);

            // a plate behind the text: crate colours run light and so does the sky
            GUI.color = new Color(0f, 0f, 0f, c.loaded ? 0.62f : 0.45f);
            GUI.DrawTexture(new Rect(box.x + wCap * 0.06f, box.y - 2f,
                                     wCap * 0.88f, box.height), _flat);
            GUI.color = Color.white;

            // The fee is what the run pays out, so it leads. Everything else
            // is how you judge whether it is worth the room it takes.
            _cap.normal.textColor = c.loaded ? new Color(0.45f, 0.95f, 0.6f)
                                             : new Color(1f, 0.85f, 0.35f);
            GUI.Label(new Rect(box.x, box.y, box.width, _cap.fontSize * 1.5f),
                      $"+{c.tx.feeSats:N0} sat", _cap);

            _capSub.normal.textColor = new Color(1f, 1f, 1f, 0.85f);
            GUI.Label(new Rect(box.x, box.y + _cap.fontSize * 1.35f, box.width, _capSub.fontSize * 1.5f),
                      $"{c.tx.FeeRate:0.0} sat/vB   ·   {c.tx.vsize} vB", _capSub);

            GUI.Label(new Rect(box.x, box.y + _cap.fontSize * 1.35f + _capSub.fontSize * 1.25f,
                               box.width, _capSub.fontSize * 1.5f),
                      c.loaded ? "GELADEN — antippen zum Abladen"
                               : $"{c.tx.Btc:0.####} BTC{(c.tx.Whale ? "  🐋" : "")}", _capSub);
        }
    }

    void OnGUI()
    {
        if (!IsOpen || bay == null) return;
        Styles();

        int w = Screen.width, h = Screen.height;
        float pad = Mathf.Max(10f, h * 0.022f);
        float barW = Mathf.Min(w * 0.92f, 760f);
        float lh = _head.fontSize * 1.7f;
        float panelH = lh * 3.5f;
        var panel = new Rect((w - barW) * 0.5f, h - panelH - pad, barW, panelH);

        DrawCaptions();

        GUI.color = new Color(0f, 0f, 0f, 0.62f);
        GUI.DrawTexture(panel, _flat);
        GUI.color = Color.white;

        float y = panel.y + lh * 0.15f;
        GUI.Label(new Rect(panel.x, y, panel.width, lh),
                  "LADERAMPE — Pakete antippen zum Aufladen, nochmal antippen zum Abladen", _head);
        y += lh * 0.95f;

        // ------------------------------------------------------- fill gauge
        float gaugeW = panel.width - pad * 2f;
        var track = new Rect(panel.x + pad, y, gaugeW, lh * 0.55f);
        GUI.color = new Color(1f, 1f, 1f, 0.16f);
        GUI.DrawTexture(track, _flat);

        bool refused = yard != null && Time.unscaledTime - yard.RefusedAt < 0.7f;
        GUI.color = refused ? new Color(1f, 0.35f, 0.3f, 0.95f)
                            : Color.Lerp(new Color(0.3f, 0.75f, 0.45f), new Color(1f, 0.78f, 0.2f), bay.Fill);
        GUI.DrawTexture(new Rect(track.x + 2f, track.y + 2f,
                                 Mathf.Max(0f, (track.width - 4f) * bay.Fill), track.height - 4f), _flat);
        GUI.color = Color.white;
        y += lh * 0.75f;

        string usd = market != null && market.Price > 0
            ? $"   ·   ${bay.BtcCarried * market.Price:N0}" : "";
        GUI.Label(new Rect(panel.x, y, panel.width, lh * 0.9f),
                  refused
                      ? "KEIN PLATZ MEHR — erst etwas abladen"
                      : $"{bay.Count} Pakete   ·   {Mathf.RoundToInt(bay.Fill * 100f)}% belegt   ·   " +
                        $"{bay.FeeCarried:N0} sat{usd}", _small);
        y += lh * 0.95f;

        // ---------------------------------------------------------- buttons
        float bw = (panel.width - pad * 3f) * 0.5f;
        if (GUI.Button(new Rect(panel.x + pad, y, bw, lh * 1.05f), "AUTO", _btn)) Auto();

        GUI.enabled = bay.IsLoaded;
        if (GUI.Button(new Rect(panel.x + pad * 2f + bw, y, bw, lh * 1.05f),
                       bay.IsLoaded ? "LOSFAHREN" : "NICHTS GELADEN", _btn)) Confirm();
        GUI.enabled = true;
    }
}
