// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

    [Tooltip("The live transaction socket. The histogram is built from what " +
             "is queued right now, which moves; the projected blocks it used " +
             "to read only change every few seconds.")]
    public MempoolBlockStream stream;

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
    float _saidBars = -99f;

    void Start()
    {
        if (stream == null) stream = FindFirstObjectByType<MempoolBlockStream>();

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
        BuildBarLabels(font);
    }

    /// <summary>
    /// One number per bar, and the unit spelled out once for the row.
    ///
    /// Once, not twenty-four times: the panel's own rule is that a unit is
    /// always spelled out, and a row of "32.5 sat/vB" repeated across the
    /// screen would be a wall of units with the numbers lost in it.
    /// </summary>
    void BuildBarLabels(Font font)
    {
        if (bars == null || bars.Length == 0 || screen == null) return;

        // NO FIGURE PER BAR. There were twenty-four of them, each printing its
        // own rate to one decimal, and they are gone: the shape of the curve
        // is what the wall is for, and a number over every bar turns a
        // skyline into a table. The unit still stands once for the row, so a
        // reader knows what the heights are in.
        _tops = new Vector3[bars.Length];
        _barUnit = MakeBarText(font, "BarUnit", TextAnchor.LowerCenter,
                               new Color(0.42f, 1f, 0.55f, 0.75f));
        _barUnit.text = "sat/vB";
    }

    TextMesh MakeBarText(Font font, string name, TextAnchor anchor, Color colour)
    {
        var go = new GameObject(name);
        go.transform.SetParent(screen, false);
        // The same half turn the rows take: TextMesh draws on its -Z face, so
        // a child sharing the quad's orientation is read through the panel.
        go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
        go.layer = screen.gameObject.layer;

        var tm = go.AddComponent<TextMesh>();
        tm.font = font;
        tm.fontSize = 80;
        tm.characterSize = 1f;          // real size comes from the bar pitch
        tm.anchor = anchor;
        tm.alignment = TextAlignment.Center;
        tm.color = colour;
        tm.text = "";

        var mr = go.GetComponent<MeshRenderer>();
        mr.sharedMaterial = font.material;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        return tm;
    }

    /// <summary>
    /// Put each number over its own bar and size it to the bar pitch.
    ///
    /// Measured from the bars themselves rather than from the authored
    /// numbers: the pitch is the distance between two bar centres in the
    /// screen's own space, and the top is the bar renderer's world bounds
    /// brought into the same space. Nothing here assumes the screen is 96 x 36
    /// or that a bar is 11 m, because both are authored and both have moved.
    /// </summary>
    void PlaceBarLabels()
    {
        if (_tops == null || bars == null || screen == null) return;

        float pitch = 0f;
        Vector3? previous = null;
        for (int i = 0; i < bars.Length && i < _tops.Length; i++)
        {
            if (bars[i] == null) continue;
            var r = bars[i].GetComponent<Renderer>();
            if (r == null) continue;

            var b = r.bounds;
            var top = screen.InverseTransformPoint(new Vector3(b.center.x, b.max.y, b.center.z));
            if (previous.HasValue) pitch = Mathf.Max(pitch, Mathf.Abs(top.x - previous.Value.x));
            previous = top;

            _tops[i] = top;
        }

        if (pitch <= 0.001f) return;

        // THE CEILING, taken from the lowest transaction row rather than from
        // the authored -6. A figure rides its bar, and a bar at `maxBar` on a
        // fee-war day stands where the rows are: the quiet market this was
        // first photographed under held every bar short, which is luck, not a
        // guarantee.
        float rowBottom = 0f; bool haveRow = false;
        if (_text != null && _text.Length > 0 && _text[_text.Length - 1] != null && _rowHeight != null)
        {
            rowBottom = _text[_text.Length - 1].transform.localPosition.y
                      - _rowHeight[_rowHeight.Length - 1] * 0.5f;
            haveRow = true;
        }

        if (_barUnit != null && previous.HasValue)
        {
            var mr = _barUnit.GetComponent<MeshRenderer>();
            if (mr != null && mr.localBounds.size.x > 0.001f)
            {
                float k = Mathf.Clamp(pitch * 1.6f / mr.localBounds.size.x, 0.001f, 5f);
                _barUnit.transform.localScale = new Vector3(k, k * verticalStretch, k);
            }
            // at the quiet end of the curve, past the last bar
            float uh = mr != null ? mr.localBounds.size.y * _barUnit.transform.localScale.y : 0f;
            float uy = previous.Value.y + 0.4f;
            if (haveRow) uy = Mathf.Min(uy, rowBottom - uh - 0.3f);
            _barUnit.transform.localPosition = new Vector3(previous.Value.x - pitch, uy, -0.2f);
        }
    }

    float[] _rowHeight;
    TextMesh[] _amounts;
    TextMesh _header, _hash;

    // ---- the figure behind each bar ---------------------------------------
    //
    // A bar carried its rate twice - as a log-compressed height and as a
    // colour - and nowhere as a number. The height cannot be read back: it is
    // `log10(1 + rate)` mapped between the tenth and ninetieth percentile of
    // the twenty-four and then clamped, which is the right way to draw a fee
    // curve and the wrong way to state one.
    //
    // The figure itself was already being computed and kept - `LiveCurve`
    // writes it into `_live` and `Bars` hands the same array to `Paint`. So
    // this draws what is already there rather than deriving a second number,
    // on the same `shiftSeconds` clock, through the same TextMesh mechanism
    // the transaction rows use. No overlay, no raycast, no second source.
    TextMesh _barUnit;
    int _labelRefit;
    Vector3[] _tops;
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
    /// <summary>
    /// The fee curve of what is queued RIGHT NOW, richest first.
    ///
    /// Built from the socket's own transaction list rather than from the
    /// projected blocks: the projections are recomputed occasionally, the
    /// transactions arrive constantly, and the histogram is supposed to be
    /// the shape of the market as it moves.
    /// </summary>
    float[] LiveCurve(int buckets)
    {
        var s = stream != null ? stream.Transactions : null;
        if (s == null || s.Count < buckets) return null;

        if (_live == null || _live.Length != buckets) _live = new float[buckets];
        if (_sortRates == null || _sortRates.Length != s.Count) _sortRates = new float[s.Count];
        for (int i = 0; i < s.Count; i++) _sortRates[i] = s[i].rate;
        System.Array.Sort(_sortRates);

        // Richest on the left, as the wall reads.
        for (int b = 0; b < buckets; b++)
        {
            int from = (int)((long)(buckets - 1 - b) * s.Count / buckets);
            int to = Mathf.Max(from + 1, (int)((long)(buckets - b) * s.Count / buckets));
            float sum = 0f; int n = 0;
            for (int i = from; i < to && i < _sortRates.Length; i++) { sum += _sortRates[i]; n++; }
            _live[b] = n > 0 ? sum / n : 0f;
        }
        return _live;
    }

    float[] _live, _sortRates;

    void Bars()
    {
        if (bars == null || bars.Length == 0) return;

        if (Time.unscaledTime >= _nextShift)
        {
            _nextShift = Time.unscaledTime + shiftSeconds;

            // The LIVE queue first.
            //
            // FeeCurve is derived from the projected blocks, and those only
            // change when the socket sends a new projection - seconds apart at
            // best, often much longer - so the histogram was correct and
            // completely static. The transactions themselves arrive
            // continuously, so a curve built from what is actually queued right
            // now moves every time the sample is taken, and every movement is
            // a real one.
            var rates = LiveCurve(bars.Length);
            string from = "live mempool";
            if (rates == null && stats != null) { rates = stats.FeeCurve(bars.Length); from = "ChainStats"; }
            if (rates == null && terrain != null) { rates = terrain.FeeRates(bars.Length); from = "terrain"; }
            if (rates == null) from = "nothing";

            // WHAT THE BARS ARE SAYING, and where it came from. The labels
            // print the same array that sets the heights, so if a number on
            // screen disagrees with a bar the fault is downstream of here.
            if (Time.time - _saidBars > 5f)
            {
                _saidBars = Time.time;
                var say = new System.Text.StringBuilder();
                if (rates != null)
                    for (int i = 0; i < rates.Length && i < 6; i++)
                        say.Append(i > 0 ? ", " : "").Append(rates[i].ToString("0.0"));
                int figures = 0;
                foreach (var tm in screen.GetComponentsInChildren<TextMesh>(true))
                    if (tm.name.StartsWith("BarFigure")) figures++;
                Debug.Log($"[bars] {bars.Length} bars from {from}: first six "
                          + $"{say} sat/vB; per-bar figures {figures}"
                          + $", unit \"{(_barUnit != null ? _barUnit.text : "none")}\"");
            }

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

                _labelRefit = 2;      // TextMesh rebuilds at the end of the frame
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

        // Follows the bar it belongs to, so a figure never floats off its own
        // column while the height eases into place.
        PlaceBarLabels();
        if (_labelRefit > 0 && --_labelRefit == 0) PlaceBarLabels();
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
