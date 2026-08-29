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

    GUIStyle _head, _small, _btn;
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

    /// <summary>
    /// Fill the bed with the best paying freight that fits: highest fee rate
    /// first, which is what the next block would take.
    /// </summary>
    public void Auto()
    {
        if (feed == null || bay == null) return;
        bay.Clear();

        var sorted = new List<MempoolFeed.Tx>(feed.Offers);
        sorted.Sort((a, b) => b.FeeRate.CompareTo(a.FeeRate));
        foreach (var tx in sorted) bay.TryAdd(tx);

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
