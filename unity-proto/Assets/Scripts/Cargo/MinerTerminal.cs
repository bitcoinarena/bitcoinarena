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
    public ChainStats stats;

    [Tooltip("How often the three transactions are re-drawn, in seconds. " +
             "Fast: this is a mempool ticker, and a wall that changes twice a " +
             "minute reads as a photograph of one.")]
    public float rollSeconds = 0.4f;

    [Tooltip("The screen quad from the model, 96 x 36 in its own local space.")]
    public Transform screen;

    public Transform[] bars;

    [Tooltip("Undoes the building's height squash on the lettering. The miner " +
             "is scaled (1, 0.45, 1), and text inheriting that is legible but " +
             "visibly squat.")]
    public float verticalStretch = 1f;

    [Tooltip("How often the histogram scrolls one column left.")]
    public float shiftSeconds = 0.5f;

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
        // Local units on a 96 x 36 screen whose origin is its centre.
        //
        // The bars own everything below y = -6. The bottom row used to sit AT
        // -6 and stand 4.2 high, so it reached down to -8 and its descenders
        // crossed the histogram. Rows now stop at -3.5 with the last one 3.8
        // high, which leaves a metre of daylight.
        float[] rows = { 14f, 7.5f, 2f, -3.5f };
        float[] high = { 6.5f, 3.8f, 3.8f, 3.8f };

        for (int i = 0; i < Lines; i++)
        {
            var go = new GameObject("TerminalLine" + i);
            go.transform.SetParent(screen, false);
            // +44, not -44. Measured: the screen's local +x runs to world +z,
            // and the player drives in +x, so their left hand is world +z.
            // Anchored at -44 the whole display sat on the right-hand end of
            // the panel and read away from the reader.
            go.transform.localPosition = new Vector3(44f, rows[i], -0.2f);
            // Half a turn: TextMesh draws on its -Z face, so a child sharing
            // the quad's orientation faces INTO the building and is read
            // through the panel - which is why MINING came out as ENINIM.
            go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
            go.layer = screen.gameObject.layer;

            var tm = go.AddComponent<TextMesh>();
            tm.font = font;
            tm.fontSize = 80;
            tm.characterSize = 1f;      // real size comes from FitRow
            // Left-anchored, and the row is turned round - so the text runs
            // from the anchor towards the panel's -x, which is the reader's
            // right. Start at the left edge, read rightwards, as text does.
            tm.anchor = TextAnchor.MiddleLeft;
            tm.alignment = TextAlignment.Left;
            tm.color = i == 0 ? new Color(0.42f, 1f, 0.55f) : new Color(0.60f, 1f, 0.72f);
            tm.text = i == 0 ? "MINING" : "";
            if (i == 0) _header = tm;

            var mr = go.GetComponent<MeshRenderer>();
            mr.sharedMaterial = font.material;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            _text[i] = tm;
        }

        _rowHeight = high;
        FitRow(0);
    }

    float[] _rowHeight;
    TextMesh _header;

    /// <summary>
    /// Scales a row to its target height, measured in the SCREEN's own units.
    ///
    /// The first version divided by Renderer.bounds, which is world space -
    /// and the screen sits under a building scaled (1, 0.45, 1) and turned
    /// ninety degrees, so the correction was applied through two transforms it
    /// knew nothing about and the lettering came out three times the height of
    /// the panel. The mesh's own bounds are in the text's local space and need
    /// no such unpicking.
    /// </summary>
    void FitRow(int i)
    {
        // Renderer.localBounds, NOT MeshFilter.sharedMesh.
        //
        // TextMesh manages its mesh internally and leaves sharedMesh null, so
        // the whole fit routine was returning on its first line and had never
        // run at all - which is why the header stood three times the height of
        // the panel and a transaction line ran 107 m across a 96 m screen.
        // localBounds is in the text object's own space, which is exactly the
        // frame the scale below is expressed in.
        var mr = _text[i].GetComponent<MeshRenderer>();
        if (mr == null) return;

        var size = mr.localBounds.size;
        if (size.y < 0.001f || size.x < 0.001f) return;

        // Whichever runs out first, height or width.
        //
        // Fitting on height alone put a 24-character transaction line at 108 m
        // across a 96 m panel - the header is six characters and fits at any
        // height the row allows, a txid plus an amount does not.
        const float Usable = 88f;                    // 96 wide, with a margin
        float k = Mathf.Min(_rowHeight[i] / size.y, Usable / size.x);
        k = Mathf.Clamp(k, 0.001f, 5f);
        _text[i].transform.localScale = new Vector3(k, k * verticalStretch, k);

    }

    int _refit;

    void Update()
    {
        Bars();

        // Fitting is deferred a frame or two after the text changes.
        //
        // TextMesh rebuilds its mesh at the end of the frame, so measuring
        // sharedMesh.bounds in the same frame as the assignment measures the
        // PREVIOUS string - which is how a 24-character transaction line came
        // out 107 m wide on a 96 m panel after being fitted against the width
        // of the word MINING.
        if (_refit > 0 && --_refit == 0)
            for (int i = 0; i < Lines; i++) FitRow(i);

        // What this farm is worth, beside the word MINING.
        //
        // A tenth of the network, and it wanders: a pool dashboard never shows
        // the same number twice because the figure is a Poisson estimate from
        // found shares, not a measurement. Steady to three digits, restless in
        // the last one, which is what a real rig looks like.
        if (_header != null && stats != null)
        {
            float eh = stats.OurExahash;
            string want = eh > 0.5f ? $"MINING          {eh:0} EH/s" : "MINING";
            if (_header.text != want) { _header.text = want; _refit = 2; }
        }

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
            _text[row].text = $"{id}   {Amount(tx)}";
            _refit = 2;
        }
    }

    /// <summary>
    /// A readable amount with its unit.
    ///
    /// "0.000" was on every line, because real mempool transactions are mostly
    /// a few tens of thousands of satoshis and three decimals of BTC rounds
    /// all of that to nothing. Below a hundredth of a coin the honest unit is
    /// the satoshi; above it, BTC. The unit is always spelled out - a bare
    /// number on a wall says nothing about what it counts.
    /// </summary>
    static string Amount(MempoolFeed.Tx tx)
    {
        double btc = tx.Btc;
        if (btc >= 0.01) return $"{btc:0.###} BTC";
        if (btc > 0) return $"{tx.valueSats:N0} sat";
        return "0 sat";
    }

    /// <summary>
    /// The bars are the live fee histogram, not a loop.
    ///
    /// Same data the terrain relief is built from, so the wall and the ground
    /// tell the same story about how congested the chain is. Eased rather than
    /// snapped: the histogram arrives every twenty seconds and a step change
    /// across twenty-four bars reads as a glitch.
    /// </summary>
    float _nextShift;

    void Bars()
    {
        if (bars == null || bars.Length == 0) return;

        // A ROLLING chart, not a static profile.
        //
        // Setting all 24 bars from the fee histogram was correct data and dead
        // to look at: the histogram moves slowly, so the wall was a still life
        // that happened to be accurate. It now scrolls - every bar shifts one
        // place left and a fresh sample enters at the right - which is how a
        // mempool chart reads as live, and is also true: each column really is
        // a later reading than the one beside it.
        if (Time.unscaledTime >= _nextShift)
        {
            _nextShift = Time.unscaledTime + shiftSeconds;

            var profile = terrain != null ? terrain.FeeProfile(bars.Length) : null;
            float entering = 0.3f;
            if (profile != null)
            {
                // the newest reading is the busy end of the histogram
                float sum = 0f;
                for (int i = 0; i < profile.Length; i++) sum += profile[i];
                entering = Mathf.Clamp01(sum / Mathf.Max(1, profile.Length) * 1.6f);
            }
            // a little jitter, so two quiet minutes are not a flat line
            entering = Mathf.Clamp(entering * Random.Range(0.72f, 1.34f), 0.08f, 1f);

            for (int i = 0; i < _barTarget.Length - 1; i++) _barTarget[i] = _barTarget[i + 1];
            _barTarget[_barTarget.Length - 1] = entering;
        }

        float k = 1f - Mathf.Exp(-Time.unscaledDeltaTime * 6f);
        for (int i = 0; i < bars.Length; i++)
        {
            if (bars[i] == null) continue;
            var s = bars[i].localScale;
            s.y = Mathf.Lerp(s.y, _barTarget[i], k);
            bars[i].localScale = s;
        }
    }
}
