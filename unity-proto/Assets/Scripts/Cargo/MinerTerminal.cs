using UnityEngine;

/// <summary>
/// The miner's display: what is being mined, and how deep the mempool is.
///
/// The model used to carry all of this as baked texture - the word MINING, a
/// hashrate, three transaction ids and their amounts. Baked numbers are wrong
/// from the first minute and can only be corrected by re-exporting the
/// building, so the screen now ships blank and is filled here.
///
/// Text is TextMesh rather than a RenderTexture. A render texture for four
/// lines costs 1.5 MB of VRAM and a second camera; four text meshes cost
/// neither, and the screen is flat and always faces the same way, which is
/// exactly the case TextMesh handles well.
/// </summary>
public class MinerTerminal : MonoBehaviour
{
    public MempoolFeed feed;
    public MempoolTerrain terrain;

    [Tooltip("How often the three transactions are re-drawn, in seconds. " +
             "Slow on purpose: a wall of text that reshuffles every frame is " +
             "unreadable from a moving truck.")]
    public float rollSeconds = 4f;

    [Tooltip("The screen quad from the model, 96 x 36 in its own local space.")]
    public Transform screen;

    public Transform[] bars;

    const int Lines = 4;                 // MINING + three transactions
    TextMesh[] _text;
    float _nextRoll;
    float[] _barTarget;

    void Start()
    {
        if (screen == null) { enabled = false; return; }
        BuildText();
        _barTarget = new float[bars != null ? bars.Length : 0];
        for (int i = 0; i < _barTarget.Length; i++) _barTarget[i] = 0.35f;
    }

    /// <summary>
    /// Four lines laid out in the screen's own local space.
    ///
    /// The screen is 96 x 36 with its origin at the centre, so the rows are
    /// placed either side of zero. The bars occupy the bottom third, which is
    /// why nothing is written below y = -4.
    /// </summary>
    void BuildText()
    {
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        if (font == null) font = Resources.GetBuiltinResource<Font>("Arial.ttf");

        _text = new TextMesh[Lines];
        float[] rows = { 14f, 7f, 1f, -5f };
        float[] size = { 1.35f, 1f, 1f, 1f };

        for (int i = 0; i < Lines; i++)
        {
            var go = new GameObject("TerminalLine" + i);
            go.transform.SetParent(screen, false);
            go.transform.localPosition = new Vector3(-44f, rows[i], -0.2f);
            go.transform.localRotation = Quaternion.identity;
            go.layer = screen.gameObject.layer;

            var tm = go.AddComponent<TextMesh>();
            tm.font = font;
            tm.fontSize = 80;
            tm.characterSize = 0.9f * size[i];
            tm.anchor = TextAnchor.MiddleLeft;
            tm.alignment = TextAlignment.Left;
            tm.color = i == 0 ? new Color(0.42f, 1f, 0.55f) : new Color(0.60f, 1f, 0.72f);
            tm.text = i == 0 ? "MINING" : "";

            var mr = go.GetComponent<MeshRenderer>();
            mr.sharedMaterial = font.material;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            _text[i] = tm;
        }

        // Fitted by measurement, not by arithmetic: TextMesh sizing depends on
        // the font atlas and does not follow characterSize in world units in
        // any way worth predicting. Draw once, measure, scale to fit.
        FitRow(0, 26f);
    }

    void FitRow(int i, float targetHeight)
    {
        var mr = _text[i].GetComponent<MeshRenderer>();
        float h = mr.bounds.size.y;
        if (h > 0.001f)
        {
            float k = targetHeight / h * _text[i].transform.localScale.y;
            _text[i].transform.localScale = Vector3.one * Mathf.Clamp(k, 0.05f, 40f);
        }
    }

    void Update()
    {
        Bars();

        if (Time.unscaledTime < _nextRoll) return;
        _nextRoll = Time.unscaledTime + rollSeconds;
        Transactions();
    }

    /// <summary>
    /// Three of the transactions currently on offer, shortened.
    ///
    /// The same list the loading bay is built from, so the display is showing
    /// the freight that is actually sitting in the yard - and a delivered
    /// parcel leaves the wall.
    /// </summary>
    void Transactions()
    {
        if (feed == null || _text == null) return;
        var offers = feed.Offers;
        if (offers == null || offers.Count == 0) return;

        for (int row = 1; row < Lines; row++)
        {
            int at = (row - 1 + Mathf.FloorToInt(Time.unscaledTime / rollSeconds)) % offers.Count;
            var tx = offers[at];
            string id = tx.txid != null && tx.txid.Length >= 16
                ? tx.txid.Substring(0, 16).ToUpperInvariant()
                : (tx.txid ?? "");
            _text[row].text = $"{id}   ₿ {tx.Btc:0.000}";
            if (row == 1) FitRow(1, 5.5f);
            else _text[row].transform.localScale = _text[1].transform.localScale;
        }
    }

    /// <summary>
    /// The bars are the live fee histogram, not a loop.
    ///
    /// Same data the terrain relief is built from, so the wall and the ground
    /// tell the same story about how congested the chain is. Eased rather than
    /// snapped: the histogram arrives every twenty seconds and a step change
    /// across twenty-four bars reads as a glitch.
    /// </summary>
    void Bars()
    {
        if (bars == null || bars.Length == 0) return;

        var profile = terrain != null ? terrain.FeeProfile(bars.Length) : null;
        if (profile != null)
            for (int i = 0; i < bars.Length; i++)
                _barTarget[i] = Mathf.Max(0.06f, profile[i]);

        float k = 1f - Mathf.Exp(-Time.unscaledDeltaTime * 3f);
        for (int i = 0; i < bars.Length; i++)
        {
            if (bars[i] == null) continue;
            var s = bars[i].localScale;
            s.y = Mathf.Lerp(s.y, _barTarget[i], k);
            bars[i].localScale = s;
        }
    }
}
