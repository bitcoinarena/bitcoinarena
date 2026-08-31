using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Mempool Goggles, rebuilt from mempool.space's block-overview graph.
///
/// Their layout, in the shape it actually takes:
///   - the block is a square grid of slots, 32 x 32 here
///   - a transaction occupies a SQUARE of slots whose side grows with the
///     square root of its weight, so area is proportional to vsize and a
///     transaction ten times heavier is about three times wider
///   - transactions are placed largest first, scanning row by row from the
///     bottom left for the first free square that fits
///   - colour runs by fee rate, from the dark green of a one-sat transaction
///     through olive and yellow to red at the top of the range
///
/// Faithful to the arrangement rather than to their exact placer: theirs
/// animates transactions between positions as blocks are mined, which needs a
/// per-transaction identity across frames that a 16 m wall on a building does
/// not earn.
/// </summary>
public class GogglesWall : MonoBehaviour
{
    public MempoolFeed feed;
    public Transform screen;

    [Tooltip("Slots across the wall. mempool uses a square grid; 32 gives a " +
             "readable smallest tile at 16 m.")]
    public int slots = 32;

    [Tooltip("Metres across the panel.")]
    public float size = 16f;

    [Tooltip("How often the wall is rebuilt.")]
    public float rebuildSeconds = 2.5f;

    [Tooltip("How much of the grid the tiles should cover. The placer needs " +
             "slack to find a home for every square, so this is not 1: at " +
             "0.92 it starts dropping transactions it cannot fit, at 0.85 it " +
             "places all forty across every mempool shape I tried.")]
    public float fill = 0.85f;

    float _next;
    Material _shared;
    readonly List<GameObject> _tiles = new();

    /// <summary>
    /// mempool's fee-rate ramp: deep green at the bottom of the market, olive
    /// and yellow through the middle, red for anything paying to jump.
    /// </summary>
    public static Color Colour(float satPerVb)
    {
        float t = Mathf.Clamp01(Mathf.Log10(1f + Mathf.Max(0f, satPerVb)) / Mathf.Log10(101f));
        if (t < 0.34f) return Color.Lerp(new Color(0.10f, 0.30f, 0.14f),
                                         new Color(0.29f, 0.55f, 0.20f), t / 0.34f);
        if (t < 0.68f) return Color.Lerp(new Color(0.29f, 0.55f, 0.20f),
                                         new Color(0.80f, 0.80f, 0.22f), (t - 0.34f) / 0.34f);
        return Color.Lerp(new Color(0.80f, 0.80f, 0.22f),
                          new Color(0.85f, 0.25f, 0.18f), (t - 0.68f) / 0.32f);
    }

    /// <summary>
    /// Side of a transaction's square, in slots.
    ///
    /// Area tracks vsize, so the side tracks its square root - which is the
    /// whole reason the graph reads as a size comparison rather than a list.
    ///
    /// <paramref name="scale"/> is what turns a proportion into a size. The
    /// first version fixed it at one slot per 180 vB, which is mempool.space's
    /// own figure for a full block of several thousand transactions. The feed
    /// here holds forty. Forty transactions at a block's scale came out as
    /// forty tiles of half a metre huddled in the corner of a 16 m wall, which
    /// from the road is a wall with nothing on it - which is exactly what was
    /// reported. The scale is now derived from what is actually in the feed,
    /// so the same forty fill the same wall, and the RELATIVE areas - the only
    /// thing the graph is saying - are untouched.
    /// </summary>
    public static int SideFor(int vsize, int maxSide, float scale)
    {
        float side = Mathf.Sqrt(Mathf.Max(1, vsize)) * scale;
        return Mathf.Clamp(Mathf.RoundToInt(side), 1, maxSide);
    }

    /// <summary>
    /// The slots-per-sqrt-vB that fills the grid with what the feed holds.
    ///
    /// Solving sum(k*sqrt(v))^2 = fill * slots^2 for k, which is just
    /// k = sqrt(fill / sum(v)) * slots. Capped so that a feed of three
    /// transactions gives three big tiles rather than three tiles bigger than
    /// the wall, and floored at the block-accurate scale so a full mempool
    /// dump is never inflated.
    /// </summary>
    public static float ScaleFor(IReadOnlyList<MempoolFeed.Tx> offers, int slots, float fill)
    {
        double total = 0;
        for (int i = 0; i < offers.Count; i++) total += Mathf.Max(1, offers[i].vsize);
        if (total <= 0) return 1f;
        float k = slots * Mathf.Sqrt(Mathf.Clamp01(fill) / (float)total);
        return Mathf.Clamp(k, 1f / Mathf.Sqrt(180f), slots * 0.25f);
    }

    void Update()
    {
        if (screen == null || feed == null || Time.unscaledTime < _next) return;
        _next = Time.unscaledTime + rebuildSeconds;
        Rebuild();
    }

    public void Rebuild()
    {
        var offers = feed != null ? feed.Offers : null;
        if (offers == null || offers.Count == 0) return;

        foreach (var t in _tiles) if (t != null) Destroy(t);
        _tiles.Clear();

        if (_shared == null)
        {
            var sh = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color");
            _shared = new Material(sh);
        }

        // largest first, which is both mempool's order and what makes the
        // scanning placer produce a tight arrangement
        var sorted = new List<MempoolFeed.Tx>(offers);
        sorted.Sort((a, b) => b.vsize.CompareTo(a.vsize));

        var taken = new bool[slots, slots];
        float cell = size / slots;
        float scale = ScaleFor(sorted, slots, fill);

        foreach (var tx in sorted)
        {
            int side = SideFor(tx.vsize, Mathf.Max(1, slots / 3), scale);
            if (!Place(taken, side, out int px, out int py)) continue;

            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            q.name = "tile";
            Destroy(q.GetComponent<Collider>());
            q.transform.SetParent(screen, false);
            q.layer = screen.gameObject.layer;

            // a hairline between tiles, as the original has
            float w = side * cell * 0.88f;

            // In FRONT of the panel, and facing out of it.
            //
            // The screen's local +z points at the apron - measured, not
            // assumed - so the tiles were being hung 12 cm INSIDE the
            // building, behind an opaque panel, with their one visible face
            // pointing further in. Two reasons to see nothing, which is
            // exactly what the wall showed. A Unity quad's normal is its -z,
            // hence the half turn: without it the tiles are in the right place
            // and still culled.
            q.transform.localPosition = new Vector3(
                (px + side * 0.5f) * cell - size * 0.5f,
                (py + side * 0.5f) * cell - size * 0.5f,
                0.12f);
            q.transform.localScale = new Vector3(w, w, 1f);
            q.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);

            var mr = q.GetComponent<MeshRenderer>();
            mr.sharedMaterial = new Material(_shared) { color = Colour(tx.FeeRate) };
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            _tiles.Add(q);
        }
    }

    /// <summary>First free side x side square, scanning from the bottom left.</summary>
    static bool Place(bool[,] taken, int side, out int px, out int py)
    {
        int n = taken.GetLength(0);
        for (int y = 0; y + side <= n; y++)
            for (int x = 0; x + side <= n; x++)
            {
                bool free = true;
                for (int j = 0; j < side && free; j++)
                    for (int i = 0; i < side; i++)
                        if (taken[x + i, y + j]) { free = false; break; }
                if (!free) continue;

                for (int j = 0; j < side; j++)
                    for (int i = 0; i < side; i++) taken[x + i, y + j] = true;
                px = x; py = y;
                return true;
            }
        px = py = 0;
        return false;
    }
}
