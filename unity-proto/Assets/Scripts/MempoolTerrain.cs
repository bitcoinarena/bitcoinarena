using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// The battlefield IS the mempool. Distance from the frontline is queue depth
/// in blocks; height is the fee rate at that depth. A congested mempool is
/// therefore literally harder terrain to cross.
///
/// Ported from src/world/battlefield.js in the three.js build, which is the
/// reference for the shape of the relief.
/// </summary>
[RequireComponent(typeof(MeshFilter), typeof(MeshRenderer), typeof(MeshCollider))]
public class MempoolTerrain : MonoBehaviour
{
    [Header("Extent (world units, matching the three.js build)")]
    public float width = 260f;
    public float depth = 170f;
    public int columns = 160;
    public int rows = 96;

    [Header("Relief")]
    [Tooltip("Vertical scale of one sat/vB of fee rate.")]
    public float feeHeight = 9f;
    public float baseRelief = 5.5f;
    [Tooltip("Fee rates below 1 sat/vB still need visible relief in a quiet market.")]
    public float subSat = 0.01f;

    [Header("Live data")]
    [Tooltip("Unused - the host list lives in MempoolHosts so that one outage " +
             "does not have to be fixed in three places. Kept so an existing " +
             "scene reference does not break.")]
    public string mempoolApi = "https://mempool.space/api";
    public float refreshSeconds = 20f;

    // fee histogram as [feeRate, vsize] pairs, deepest queue last
    float[] _profile;
    Mesh _mesh;
    Vector3[] _verts;

    void Awake()
    {
        _mesh = new Mesh { name = "MempoolTerrain", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
        GetComponent<MeshFilter>().sharedMesh = _mesh;
        // A flat profile until the first fetch lands, so the scene is never empty.
        _profile = new float[columns];
        for (int i = 0; i < columns; i++) _profile[i] = 1f;
        Build();
    }

    void Start() => StartCoroutine(PollMempool());

    IEnumerator PollMempool()
    {
        while (true)
        {
            yield return MempoolHosts.Get("/mempool", 10f, text =>
            {
                if (text != null && TryParseHistogram(text, out var p)) { _profile = p; Build(); }
                else if (text == null)
                    Debug.LogWarning("[MempoolTerrain] no host answered - keeping the previous relief");
            });
            yield return new WaitForSeconds(refreshSeconds);
        }
    }

    /// <summary>
    /// /api/mempool returns fee_histogram as [[feeRate, vsize], ...]. We want a
    /// fee rate per column, so the histogram is walked as a queue: each entry
    /// fills as many columns as its vsize is worth in blocks.
    /// </summary>
    bool TryParseHistogram(string json, out float[] profile)
    {
        profile = null;
        int at = json.IndexOf("\"fee_histogram\"");
        if (at < 0) return false;
        int open = json.IndexOf('[', at);
        int close = json.IndexOf("]]", open);
        if (open < 0 || close < 0) return false;

        var pairs = new List<Vector2>();
        var body = json.Substring(open + 1, close - open);
        foreach (var chunk in body.Split('['))
        {
            var t = chunk.Trim().TrimEnd(']', ',', ' ');
            if (t.Length == 0) continue;
            var bits = t.Split(',');
            if (bits.Length < 2) continue;
            if (float.TryParse(bits[0], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var fee) &&
                float.TryParse(bits[1], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var vsize))
                pairs.Add(new Vector2(fee, vsize));
        }
        if (pairs.Count == 0) return false;

        float total = 0f;
        foreach (var p in pairs) total += p.y;
        float perColumn = Mathf.Max(total / columns, 1f);

        profile = new float[columns];
        int idx = 0;
        float carried = 0f;
        for (int c = 0; c < columns; c++)
        {
            float want = perColumn;
            float weighted = 0f, taken = 0f;
            while (want > 0f && idx < pairs.Count)
            {
                float available = pairs[idx].y - carried;
                float use = Mathf.Min(available, want);
                weighted += pairs[idx].x * use;
                taken += use; want -= use; carried += use;
                if (carried >= pairs[idx].y - 0.001f) { idx++; carried = 0f; }
            }
            profile[c] = taken > 0f ? weighted / taken : (c > 0 ? profile[c - 1] : 1f);
        }
        return true;
    }

    /// <summary>
    /// The fee histogram, normalised to 0..1, resampled to however many
    /// buckets the caller wants.
    ///
    /// The terrain already fetches and holds this - it is what the relief is
    /// made of - so the miner's display bars read the same data rather than
    /// polling for it a second time. Returns null before the first fetch
    /// lands, which callers must treat as "leave what is on screen" rather
    /// than "the mempool is empty".
    /// </summary>
    public float[] FeeProfile(int buckets)
    {
        if (_profile == null || buckets <= 0) return null;

        var outp = new float[buckets];
        float peak = 0.01f;
        for (int i = 0; i < buckets; i++)
        {
            // average the columns falling into this bucket, so a coarse bar
            // chart is not a random sample of a fine histogram
            int from = Mathf.FloorToInt(i / (float)buckets * _profile.Length);
            int to = Mathf.Max(from + 1, Mathf.FloorToInt((i + 1) / (float)buckets * _profile.Length));
            float sum = 0f; int n = 0;
            for (int c = from; c < to && c < _profile.Length; c++) { sum += _profile[c]; n++; }
            outp[i] = n > 0 ? Mathf.Log10(1f + sum / n) : 0f;
            peak = Mathf.Max(peak, outp[i]);
        }
        for (int i = 0; i < buckets; i++) outp[i] = Mathf.Clamp01(outp[i] / peak);
        return outp;
    }

    /// <summary>
    /// The fee histogram in sat/vB, resampled to however many buckets the
    /// caller wants - the raw rates rather than the normalised profile.
    ///
    /// FeeProfile answers "how tall", which is all the terrain needs. A chart
    /// that also wants to COLOUR its bars needs to know what rate each one
    /// stands for, and dividing a normalised number back out is guesswork.
    /// </summary>
    public float[] FeeRates(int buckets)
    {
        if (_profile == null || buckets <= 0) return null;
        var outp = new float[buckets];
        for (int i = 0; i < buckets; i++)
        {
            int from = Mathf.FloorToInt(i / (float)buckets * _profile.Length);
            int to = Mathf.Max(from + 1, Mathf.FloorToInt((i + 1) / (float)buckets * _profile.Length));
            float sum = 0f; int n = 0;
            for (int c = from; c < to && c < _profile.Length; c++) { sum += _profile[c]; n++; }
            outp[i] = n > 0 ? sum / n : 0f;
        }
        return outp;
    }

    /// <summary>Fee rate at a column, normalised so sub-sat markets still have relief.</summary>
    [Tooltip("How much of each end of the map is levelled off into an apron, " +
             "as a fraction of the width. The two buildings stand there and " +
             "their approaches have to be flat.")]
    public float apronFraction = 0.30f;

    [Tooltip("How much of each end is DEAD level, as a fraction of the width. " +
             "Inside this the ground is one height exactly; between it and " +
             "apronFraction the relief eases in, so there is no step.")]
    public float apronLevelFraction = 0.19f;

    float HeightAt(float u, float v)
    {
        int c = Mathf.Clamp(Mathf.RoundToInt(u * (columns - 1)), 0, columns - 1);
        float fee = Mathf.Max(_profile[c], subSat);
        // log keeps a 400 sat/vB spike from dwarfing the rest of the map
        float h = Mathf.Log10(1f + fee) * feeHeight;
        // rolling ground so the map is not a staircase of flat bands
        h += Mathf.PerlinNoise(u * 7f, v * 5f) * baseRelief;

        // Both ends are levelled into an apron.
        //
        // Mempool relief is generated across the whole map, including the runs
        // in to the two buildings - so a busy block raised the ground into the
        // finish straight and the miner sat in a hillside with the road
        // climbing through its foundations.
        //
        // Easing the relief towards flat was not enough, and the post office
        // is what proved it. A blend that only REACHES flat at the map edge is
        // still sloping everywhere the building actually stands: its apron
        // slab is one 26 x 168 m plane laid at a single sampled height, so a
        // metre of remaining relief anywhere under it is a metre of daylight
        // under one end - which is how the truck came to spawn beneath its own
        // loading dock. Inside apronLevelFraction the ground is therefore
        // exactly one height, and the relief eases in beyond it.
        float ease = Mathf.Max(0.001f, Mathf.Clamp01(apronFraction));
        float level = Mathf.Clamp(apronLevelFraction, 0f, ease - 0.001f);

        float into = Mathf.InverseLerp(1f - ease, 1f - level, u);
        if (into > 0f)
        {
            float flat = Mathf.Log10(1f + Mathf.Max(_profile[columns - 1], subSat)) * feeHeight;
            h = Mathf.Lerp(h, flat, Mathf.SmoothStep(0f, 1f, into));
        }

        float outOf = Mathf.InverseLerp(ease, level, u);
        if (outOf > 0f)
        {
            float flat = Mathf.Log10(1f + Mathf.Max(_profile[0], subSat)) * feeHeight;
            h = Mathf.Lerp(h, flat, Mathf.SmoothStep(0f, 1f, outOf));
        }
        return h;
    }

    /// <summary>
    /// Bumped on every rebuild. Anything laid on the ground has to watch this:
    /// when live mempool data reshapes the terrain, a road built against the
    /// old heights is left floating or buried.
    /// </summary>
    public int Version { get; private set; }

    public void Build()
    {
        Revision++;

        Version++;
        int vx = columns, vz = rows;
        if (_verts == null || _verts.Length != vx * vz) _verts = new Vector3[vx * vz];
        var uvs = new Vector2[vx * vz];

        for (int z = 0; z < vz; z++)
        {
            float v = z / (float)(vz - 1);
            for (int x = 0; x < vx; x++)
            {
                float u = x / (float)(vx - 1);
                int i = z * vx + x;
                _verts[i] = new Vector3((u - 0.5f) * width, HeightAt(u, v), (v - 0.5f) * depth);
                // 0..1 across the whole map: the territory texture is world-sized,
                // so it must not tile or the frontline would appear five times
                uvs[i] = new Vector2(u, v);
            }
        }

        var tris = new int[(vx - 1) * (vz - 1) * 6];
        int t = 0;
        for (int z = 0; z < vz - 1; z++)
            for (int x = 0; x < vx - 1; x++)
            {
                int i = z * vx + x;
                tris[t++] = i; tris[t++] = i + vx; tris[t++] = i + 1;
                tris[t++] = i + 1; tris[t++] = i + vx; tris[t++] = i + vx + 1;
            }

        _mesh.Clear();
        _mesh.vertices = _verts;
        _mesh.uv = uvs;
        _mesh.triangles = tris;
        _mesh.RecalculateNormals();
        _mesh.RecalculateTangents();
        _mesh.RecalculateBounds();
        // the truck drives on this, so the collider has to follow every rebuild
        GetComponent<MeshCollider>().sharedMesh = null;
        GetComponent<MeshCollider>().sharedMesh = _mesh;
    }

    /// <summary>
    /// Analytic ground height. This is what the mesh is GENERATED from, not
    /// what it looks like - see SampleSurface for the difference.
    /// </summary>
    public float SampleWorld(float worldX, float worldZ)
    {
        float u = Mathf.Clamp01(worldX / width + 0.5f);
        float v = Mathf.Clamp01(worldZ / depth + 0.5f);
        return HeightAt(u, v);
    }

    /// <summary>
    /// Height of the DRAWN surface: the exact plane of the triangle under this
    /// point, matching how the mesh is wound in Build().
    ///
    /// The mesh is a triangulation of HeightAt, and between grid points the two
    /// disagree by a few tenths. Anything laid on the ground - roads, props -
    /// has to follow the triangle, or it sinks into the terrain wherever the
    /// chord happens to sit above the curve.
    /// </summary>
    /// <summary>
    /// Goes up by one every time the relief is rebuilt.
    ///
    /// The ground here comes from a live fetch, so it changes under whatever
    /// is using it. Anything holding a copy - the deterministic core does -
    /// needs to know when its copy went stale.
    /// </summary>
    public int Revision { get; private set; }

    /// <summary>
    /// The relief as a grid of Q16.16 metres, row-major, for the core.
    ///
    /// Sampled through SampleSurface rather than HeightAt so it is the surface
    /// the truck actually drives on, triangle split and all.
    /// </summary>
    public int[] HeightGrid(int cols, int rows)
    {
        var g = new int[cols * rows];
        for (int r = 0; r < rows; r++)
        {
            float z = ((float)r / (rows - 1) - 0.5f) * depth;
            for (int c = 0; c < cols; c++)
            {
                float x = ((float)c / (cols - 1) - 0.5f) * width;
                g[r * cols + c] = Mathf.RoundToInt(SampleSurface(x, z) * 65536f);
            }
        }
        return g;
    }

    public float SampleSurface(float worldX, float worldZ)
    {
        int vx = columns, vz = rows;
        float fu = Mathf.Clamp01(worldX / width + 0.5f) * (vx - 1);
        float fv = Mathf.Clamp01(worldZ / depth + 0.5f) * (vz - 1);

        int x0 = Mathf.Clamp(Mathf.FloorToInt(fu), 0, vx - 2);
        int z0 = Mathf.Clamp(Mathf.FloorToInt(fv), 0, vz - 2);
        float tx = fu - x0, tz = fv - z0;

        float U(int gx, int gz) => HeightAt(gx / (float)(vx - 1), gz / (float)(vz - 1));
        float a = U(x0, z0);          // A
        float b = U(x0, z0 + 1);      // B
        float c = U(x0 + 1, z0);      // C
        float d = U(x0 + 1, z0 + 1);  // D

        // Build() winds each cell as (A,B,C) then (C,B,D); the split runs from
        // B to C, so tx + tz < 1 lands in the first triangle.
        return tx + tz < 1f
            ? a + (c - a) * tx + (b - a) * tz
            : d + (b - d) * (1f - tx) + (c - d) * (1f - tz);
    }
}
