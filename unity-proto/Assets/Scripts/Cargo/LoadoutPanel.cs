using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The loading bay: pick the transactions to run, then drive.
///
/// It opens when the truck spawns and every time it comes back, and it holds
/// the truck until something is aboard. Auto picks the best paying load that
/// fits, which is what a player who does not want to read hex will press.
/// </summary>
public class LoadoutPanel : MonoBehaviour
{
    public MempoolFeed feed;
    public CargoBay bay;
    public TruckController truck;
    public TruckHealth health;
    public MarketFeed market;

    /// <summary>True while the bay is open and the truck is held.</summary>
    public bool IsOpen { get; private set; }

    readonly HashSet<string> _picked = new HashSet<string>();
    Vector2 _scroll;
    GUIStyle _head, _row, _btn;
    bool _wasDestroyed;

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
        _picked.Clear();
        if (bay != null) bay.Clear();
        if (truck != null) truck.controlsLocked = true;
    }

    /// <summary>Load what is ticked and let the player go.</summary>
    public void Confirm()
    {
        if (bay != null && feed != null)
        {
            var load = new List<MempoolFeed.Tx>();
            foreach (var tx in feed.Offers)
                if (_picked.Contains(tx.txid)) load.Add(tx);
            bay.Load(load);
        }
        IsOpen = false;
        if (truck != null) truck.controlsLocked = false;
    }

    /// <summary>
    /// The best paying load that fits: highest fee rate first, which is what
    /// the next block would pick too.
    /// </summary>
    public void Auto()
    {
        if (feed == null || bay == null) return;
        var sorted = new List<MempoolFeed.Tx>(feed.Offers);
        sorted.Sort((a, b) => b.FeeRate.CompareTo(a.FeeRate));

        _picked.Clear();
        for (int i = 0; i < sorted.Count && i < bay.capacity; i++)
            _picked.Add(sorted[i].txid);
    }

    void Update()
    {
        // A truck destroyed mid-run drops its load; the bay reopens on respawn
        // through the event, not from here.
        if (health != null && health.IsDestroyed && !_wasDestroyed && bay != null) bay.Clear();
        if (health != null) _wasDestroyed = health.IsDestroyed;

        // held for as long as the bay is open, even if something else clears it
        if (IsOpen && truck != null) truck.controlsLocked = true;
    }

    void Styles()
    {
        if (_head != null) return;
        _head = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, wordWrap = false };
        _row = new GUIStyle(GUI.skin.label) { wordWrap = false };
        _btn = new GUIStyle(GUI.skin.button) { fontStyle = FontStyle.Bold };
    }

    void OnGUI()
    {
        if (!IsOpen || feed == null || bay == null) return;
        Styles();

        int w = Screen.width, h = Screen.height;
        int min = Mathf.Min(w, h);
        _head.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.030f, 14f, 22f));
        _row.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.026f, 12f, 19f));
        _btn.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.030f, 14f, 22f));

        float pw = Mathf.Min(w * 0.86f, 720f);
        float ph = Mathf.Min(h * 0.80f, 620f);
        var panel = new Rect((w - pw) * 0.5f, (h - ph) * 0.5f, pw, ph);

        GUI.color = new Color(0f, 0f, 0f, 0.82f);
        GUI.DrawTexture(panel, Texture2D.whiteTexture);
        GUI.color = Color.white;

        float pad = pw * 0.035f;
        float lh = _row.fontSize * 2.1f;
        float y = panel.y + pad * 0.7f;

        _head.normal.textColor = Color.white;
        GUI.Label(new Rect(panel.x + pad, y, pw - pad * 2f, lh),
                  $"LADERAMPE — {feed.Offers.Count} Transaktionen  ·  {feed.Status}", _head);
        y += lh;
        GUI.Label(new Rect(panel.x + pad, y, pw - pad * 2f, lh),
                  $"Platz: {_picked.Count} / {bay.capacity}", _row);
        y += lh * 1.1f;

        // ---------------------------------------------------------- the list
        float listH = ph - (y - panel.y) - pad * 3.2f - lh * 1.6f;
        var view = new Rect(panel.x + pad, y, pw - pad * 2f, listH);
        var inner = new Rect(0f, 0f, view.width - 22f, feed.Offers.Count * lh);
        _scroll = GUI.BeginScrollView(view, _scroll, inner);

        float ry = 0f;
        foreach (var tx in feed.Offers)
        {
            bool on = _picked.Contains(tx.txid);
            var row = new Rect(0f, ry, inner.width, lh);

            GUI.color = on ? new Color(0.25f, 0.55f, 0.35f, 0.65f) : new Color(1f, 1f, 1f, 0.06f);
            GUI.DrawTexture(row, Texture2D.whiteTexture);
            GUI.color = Color.white;

            _row.normal.textColor = tx.Whale ? new Color(0.49f, 0.88f, 1f) : Color.white;
            string usd = market != null && market.Price > 0
                ? $"  ·  ${tx.Btc * market.Price:N0}" : "";
            GUI.Label(new Rect(row.x + 8f, row.y, row.width - 16f, row.height),
                      $"{(on ? "☑" : "☐")}  {tx.Short}   {tx.FeeRate:0.0} sat/vB   " +
                      $"{tx.vsize} vB   {tx.Btc:0.###} BTC{usd}{(tx.Whale ? "   🐋" : "")}", _row);

            // Clicked when there is room, or to take one off again.
            if (GUI.Button(row, GUIContent.none, GUIStyle.none))
            {
                if (on) _picked.Remove(tx.txid);
                else if (_picked.Count < bay.capacity) _picked.Add(tx.txid);
            }
            ry += lh;
        }
        GUI.EndScrollView();

        // ------------------------------------------------------------ buttons
        float by = panel.yMax - pad - lh * 1.4f;
        float bw = (pw - pad * 3f) * 0.5f;

        if (GUI.Button(new Rect(panel.x + pad, by, bw, lh * 1.4f), "AUTO", _btn)) Auto();

        GUI.enabled = _picked.Count > 0;
        if (GUI.Button(new Rect(panel.x + pad * 2f + bw, by, bw, lh * 1.4f),
                       _picked.Count > 0 ? $"LOSFAHREN ({_picked.Count})" : "NICHTS GEWÄHLT", _btn))
            Confirm();
        GUI.enabled = true;
    }
}
