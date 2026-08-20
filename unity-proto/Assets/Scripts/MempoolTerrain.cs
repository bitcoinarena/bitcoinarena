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
            using (var req = UnityWebRequest.Get(mempoolApi + "/mempool"))
            {
                yield return req.SendWebRequest();
                if (req.result == UnityWebRequest.Result.Success)
                {
                    if (TryParseHistogram(req.downloadHandler.text, out var p)) { _profile = p; Build(); }
                }
                else Debug.LogWarning($"[MempoolTerrain] {req.error} - keeping the previous relief");
            }
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

    /// <summary>Fee rate at a column, normalised so sub-sat markets still have relief.</summary>
    float HeightAt(float u, float v)
    {
        int c = Mathf.Clamp(Mathf.RoundToInt(u * (columns - 1)), 0, columns - 1);
        float fee = Mathf.Max(_profile[c], subSat);
        // log keeps a 400 sat/vB spike from dwarfing the rest of the map
        float h = Mathf.Log10(1f + fee) * feeHeight;
        // rolling ground so the map is not a staircase of flat bands
        h += Mathf.PerlinNoise(u * 7f, v * 5f) * baseRelief;
        return h;
    }

    public void Build()
    {
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

    /// <summary>Ground height under a world position, for placing props and the road.</summary>
    public float SampleWorld(float worldX, float worldZ)
    {
        float u = Mathf.Clamp01(worldX / width + 0.5f);
        float v = Mathf.Clamp01(worldZ / depth + 0.5f);
        return HeightAt(u, v);
    }
}
