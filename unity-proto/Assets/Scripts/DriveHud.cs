using UnityEngine;

/// <summary>
/// Heads-up display.
///
/// The BTC price is the headline: it is the thing the whole battlefield is
/// made of, so it sits centred at the top at a size you can read from arm's
/// length on a phone. Everything else is diagnostic and deliberately smaller.
/// </summary>
public class DriveHud : MonoBehaviour
{
    public TruckController truck;
    public MarketFeed market;
    public Battlefield field;
    public bool showDiagnostics = true;

    GUIStyle _price, _sub, _small;
    Texture2D _flat;

    static readonly Color Up = new Color(0.30f, 0.88f, 0.48f);
    static readonly Color Down = new Color(1f, 0.42f, 0.42f);

    void Awake()
    {
        _flat = new Texture2D(1, 1); _flat.SetPixel(0, 0, Color.white); _flat.Apply();
    }

    void Styles()
    {
        int min = Mathf.Min(Screen.width, Screen.height);
        if (_price == null)
        {
            _price = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter, fontStyle = FontStyle.Bold };
            _sub = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperCenter };
            _small = new GUIStyle(GUI.skin.label);
        }
        _price.fontSize = Mathf.RoundToInt(min * 0.13f);
        _sub.fontSize = Mathf.RoundToInt(min * 0.045f);
        _small.fontSize = Mathf.RoundToInt(Mathf.Clamp(min * 0.032f, 13f, 20f));
        _small.normal.textColor = Color.white;
    }

    /// <summary>Drawn twice with an offset: the sky and the dirt are both bright.</summary>
    void Shadowed(Rect r, string text, GUIStyle style, Color colour)
    {
        var prev = style.normal.textColor;
        style.normal.textColor = new Color(0f, 0f, 0f, 0.55f);
        GUI.Label(new Rect(r.x + 2, r.y + 3, r.width, r.height), text, style);
        style.normal.textColor = colour;
        GUI.Label(r, text, style);
        style.normal.textColor = prev;
    }

    void OnGUI()
    {
        Styles();
        int w = Screen.width, h = Screen.height;

        /* ---------------------------------------------------- headline price */
        if (market != null)
        {
            string text = market.Price > 0 ? $"${market.Price:N0}" : "— — —";
            var colour = market.Fresh ? Color.white : new Color(1f, 1f, 1f, 0.55f);
            Shadowed(new Rect(0, h * 0.015f, w, _price.fontSize * 1.3f), text, _price, colour);

            double chg = market.DayChangePct;
            string sub = market.Price > 0
                ? $"{chg:+0.00;-0.00;0.00}% 24h   ·   {market.Status}"
                : $"verbinde … ({market.Status})";
            Shadowed(new Rect(0, h * 0.015f + _price.fontSize * 1.12f, w, _sub.fontSize * 1.6f),
                     sub, _sub, chg >= 0 ? Up : Down);
        }

        if (!showDiagnostics) return;

        /* ------------------------------------------------------- diagnostics */
        float pad = Mathf.Max(8f, Screen.height * 0.02f);
        float lh = _small.fontSize * 1.45f;
        int lines = 6 + (market != null ? 2 : 0);
        var box = new Rect(pad, pad, Mathf.Min(320f, w * 0.34f), lh * lines + pad);

        GUI.color = new Color(0f, 0f, 0f, 0.42f);
        GUI.DrawTexture(box, _flat);
        GUI.color = Color.white;

        float y = box.y + pad * 0.5f;
        void Line(string s) { GUI.Label(new Rect(box.x + pad * 0.6f, y, box.width, lh), s, _small); y += lh; }

        if (truck != null)
        {
            int grounded = 0;
            foreach (var a in truck.axles)
            {
                if (a?.left != null && a.left.isGrounded) grounded++;
                if (a?.right != null && a.right.isGrounded) grounded++;
            }
            var rb = truck.GetComponent<Rigidbody>();
            Line($"Tempo   {truck.SpeedKmh:0} km/h");
            Line($"Gas {DriveInput.Throttle:+0.0;-0.0; 0.0}  Lenk {DriveInput.Steer:+0.0;-0.0; 0.0}  {(DriveInput.Handbrake ? "HB" : "")}");
            Line($"Drift   {truck.Slip:0.0} m/s   Raeder {grounded}/4");
            if (rb != null) Line($"Pos     {rb.position.x:0}, {rb.position.z:0}");
        }
        if (market != null)
        {
            Line($"Fluss   {market.Flow:+0.00;-0.00; 0.00}");
            Line($"Liquid. {market.Liquidations.Count} / 90 s");
        }
        if (field != null && truck != null)
        {
            float front = field.FrontlineZ(truck.transform.position.x);
            bool bull = field.IsBullHeld(truck.transform.position.x, truck.transform.position.z);
            Line($"Front   z={front:0}");
            Line(bull ? "Gebiet  BULLEN" : "Gebiet  BAEREN");
        }
    }
}
