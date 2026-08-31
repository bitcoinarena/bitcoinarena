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

    [Tooltip("How often the histogram is re-read.")]
    public float shiftSeconds = 0.5f;

    [Tooltip("Tallest a bar may stand, as a fraction of its authored height. " +
             "The bars are 11 m at full scale on a 36 m screen and would " +
             "otherwise run up through the transaction lines above them.")]
    public float maxBar = 0.82f;

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

        // The amounts get their own column, right-aligned.
        //
        // They were part of the same string as the txid, separated by three
        // spaces, in a proportional font - so where an amount started depended
        // on how wide the sixteen hex digits before it happened to be, and
        // three lines of numbers stepped raggedly across the screen. A column
        // is a column: same right edge, whatever is to the left of it.
        _amounts = new TextMesh[Lines];
        for (int i = 1; i < Lines; i++)
        {
            var col = new GameObject("TerminalAmount" + i);
            col.transform.SetParent(screen, false);
            col.transform.localPosition = new Vector3(-40f, rows[i], -0.2f);
            col.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
            col.layer = screen.gameObject.layer;

            var am = col.AddComponent<TextMesh>();
            am.font = font;
            am.fontSize = 80;
            am.characterSize = 1f;
            am.anchor = TextAnchor.MiddleRight;
            am.alignment = TextAlignment.Right;
            am.color = new Color(0.60f, 1f, 0.72f);
            am.text = "";

            var amr = col.GetComponent<MeshRenderer>();
            amr.sharedMaterial = font.material;
            amr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            amr.receiveShadows = false;
            _amounts[i] = am;
        }

        // The hashrate gets its own text, in its own colour.
        //
        // It was appended to the word MINING with a run of spaces, in the same
        // green, which made the biggest number on the building look like part
        // of a label. It is the whole network's rate - about 900 EH/s - and it
        // belongs to nothing else on the screen, so it is set apart: amber,
        // right-hand end of the same row, reading back towards the word it
        // belongs to.
        var hash = new GameObject("TerminalHashrate");
        hash.transform.SetParent(screen, false);
        hash.transform.localPosition = new Vector3(-44f, rows[0], -0.2f);
        hash.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
        hash.layer = screen.gameObject.layer;
        _hash = hash.AddComponent<TextMesh>();
        _hash.font = font;
        _hash.fontSize = 80;
        _hash.characterSize = 1f;
        _hash.anchor = TextAnchor.MiddleRight;
        _hash.alignment = TextAlignment.Right;
        _hash.color = new Color(1f, 0.76f, 0.26f);
        _hash.text = "";
        var hr = hash.GetComponent<MeshRenderer>();
        hr.sharedMaterial = font.material;
        hr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        hr.receiveShadows = false;

        _rowHeight = high;
        FitRow(0);
    }

    float[] _rowHeight;
    TextMesh[] _amounts;
    TextMesh _header, _hash;
    float _hashHeight = 6.5f;

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
            for (int i = 0; i < Lines; i++)
            {
                FitRow(i);
                if (_amounts != null && i > 0 && _amounts[i] != null)
                    FitTo(_amounts[i], _rowHeight[i], 34f);
            }

        // What the whole network is worth, at the other end of the row.
        //
        // It wanders: the figure is a Poisson estimate from blocks found in a
        // window, not a measurement, and no dashboard shows the same number
        // twice. Steady in its leading digits, restless in the last, which is
        // what a real readout looks like.
        if (_hash != null && stats != null)
        {
            float eh = stats.Exahash;
            string want = eh > 0.5f ? $"{eh:0} EH/s" : "";
            if (_hash.text != want) { _hash.text = want; FitHash(); }
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
            _text[row].text = id;
            if (_amounts != null && _amounts[row] != null)
            {
                _amounts[row].text = Amount(tx);
                FitTo(_amounts[row], _rowHeight[row], 34f);
            }
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

    /// <summary>Scales the hashrate to the header row, in the screen's units.</summary>
    void FitHash() => FitTo(_hash, _hashHeight, 40f);

    /// <summary>Scales one text to a height, and no wider than it is allowed.</summary>
    void FitTo(TextMesh tm, float height, float width)
    {
        var mr = tm != null ? tm.GetComponent<MeshRenderer>() : null;
        if (mr == null) return;
        var size = mr.localBounds.size;
        if (size.y < 0.001f || size.x < 0.001f) return;
        float k = Mathf.Max(0.001f, Mathf.Min(height / size.y, width / size.x));
        tm.transform.localScale = new Vector3(k, k * verticalStretch, k);
    }

    /// <summary>
    /// The bars ARE the mempool: the fee curve of everything waiting, richest
    /// on the left, height and colour both the rate being paid.
    ///
    /// They used to scroll - each bar shifted left every half second and a new
    /// sample entered at the right - with a random multiplier of 0.72 to 1.34
    /// applied to that sample "so two quiet minutes are not a flat line". That
    /// is a screensaver: twenty-four bars, none of which stood for anything in
    /// particular, jittering. It looked random because it WAS random.
    ///
    /// Now bar i is the fee rate of the i-th 24th of the queue, taken from the
    /// projected blocks' own fee ranges off mempool.space's socket - so it
    /// moves every couple of seconds because the mempool moved, and it is
    /// coloured on the same ramp as the goggles wall at the other end of the
    /// map. Read left to right it is the shape of the market: a wall that
    /// steps down gently is a chain keeping up, a red block on the left is a
    /// fee war, and a flat green run is a quiet night.
    /// </summary>
    void Bars()
    {
        if (bars == null || bars.Length == 0) return;

        if (Time.unscaledTime >= _nextShift)
        {
            _nextShift = Time.unscaledTime + shiftSeconds;

            // live first, the terrain's slow histogram as the fallback
            var rates = stats != null ? stats.FeeCurve(bars.Length) : null;
            if (rates == null && terrain != null) rates = terrain.FeeRates(bars.Length);

            if (rates != null)
            {
                // Scaled to the range the queue is actually paying, not to
                // zero. On a quiet night the whole mempool sits between 0.36
                // and 0.5 sat/vB with one transaction paying 200, and a scale
                // that runs from nothing to the highest bar drew that as one
                // tower and twenty-three stubs - true, and unreadable. The
                // ends are trimmed so a single outlier cannot set the scale
                // for the other twenty-three.
                var sorted = new float[rates.Length];
                System.Array.Copy(rates, sorted, rates.Length);
                System.Array.Sort(sorted);
                float lo = Mathf.Log10(1f + sorted[Mathf.Clamp(sorted.Length / 10, 0, sorted.Length - 1)]);
                float hi = Mathf.Log10(1f + sorted[Mathf.Clamp(sorted.Length * 9 / 10, 0, sorted.Length - 1)]);
                if (hi - lo < 0.02f) { hi = lo + 0.02f; }

                for (int i = 0; i < _barTarget.Length && i < rates.Length; i++)
                {
                    // log, like every fee chart: a 400 sat/vB spike must not
                    // flatten the rest of the market into the floor
                    float h = Mathf.InverseLerp(lo, hi, Mathf.Log10(1f + Mathf.Max(0f, rates[i])));
                    // Floor and ceiling. The floor is so an empty bucket is a
                    // low bar rather than no bar at all - a missing bar reads
                    // as a broken display. The ceiling is geometry: the bars
                    // stand at the bottom of a 36 m screen and are 11 m tall
                    // at full scale, which reaches the transaction lines above
                    // them and strikes the third one through.
                    _barTarget[i] = Mathf.Clamp(Mathf.Lerp(0.12f, maxBar, h), 0.12f, maxBar);
                }
                Paint(rates);
            }
        }

        // Eased rather than snapped: a step change across twenty-four bars
        // reads as a glitch, and the socket delivers a new curve every couple
        // of seconds.
        float k = 1f - Mathf.Exp(-Time.unscaledDeltaTime * 3f);
        for (int i = 0; i < bars.Length; i++)
        {
            if (bars[i] == null) continue;
            var s = bars[i].localScale;
            s.y = Mathf.Lerp(s.y, _barTarget[i], k);
            bars[i].localScale = s;
        }
    }

    float _nextShift;
    MaterialPropertyBlock _paint;
    static readonly int BaseColorFactor = Shader.PropertyToID("baseColorFactor");
    static readonly int EmissiveFactor = Shader.PropertyToID("emissiveFactor");
    static readonly int BaseColor = Shader.PropertyToID("_BaseColor");
    static readonly int Emission = Shader.PropertyToID("_EmissionColor");

    /// <summary>
    /// Colours each bar by what it is paying, without touching the shared
    /// material - a property block per renderer, so twenty-four bars still
    /// cost one material.
    /// </summary>
    void Paint(float[] rates)
    {
        _paint ??= new MaterialPropertyBlock();
        for (int i = 0; i < bars.Length && i < rates.Length; i++)
        {
            if (bars[i] == null) continue;
            var r = bars[i].GetComponent<Renderer>();
            if (r == null) continue;

            var c = GogglesWall.Colour(rates[i]);
            r.GetPropertyBlock(_paint);

            // The building comes in through glTFast, so its materials are the
            // glTF shader graph and its colour is "baseColorFactor" - not
            // "_BaseColor", which is what URP's own Lit calls it. Setting the
            // wrong name is not an error, it just quietly does nothing, which
            // is exactly how twenty-four bars stayed one colour.
            var mat = r.sharedMaterial;
            if (mat != null && mat.HasProperty(BaseColorFactor)) _paint.SetColor(BaseColorFactor, c);
            if (mat != null && mat.HasProperty(EmissiveFactor)) _paint.SetColor(EmissiveFactor, c * 0.8f);
            if (mat != null && mat.HasProperty(BaseColor)) _paint.SetColor(BaseColor, c);
            if (mat != null && mat.HasProperty(Emission)) _paint.SetColor(Emission, c * 0.8f);
            r.SetPropertyBlock(_paint);
        }
    }
}
