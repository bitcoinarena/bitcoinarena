using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Draws the five routes and keeps them looking as wrecked as they are.
///
/// Damage is shown in the GEOMETRY rather than in a shader: worn stretches get
/// their surface broken up, and a cut section has its triangles removed
/// outright, so the road visibly ends in rubble. That reads correctly under any
/// material and needs no custom shader in URP.
/// </summary>
public class RoadNetwork : MonoBehaviour
{
    public MempoolTerrain terrain;
    public Battlefield field;
    public Material roadMaterial;

    /// <summary>
    /// Above the drawn surface. The road has no collider, so this costs nothing
    /// in handling - it only has to clear z-fighting and the last of the
    /// triangulation error.
    /// </summary>
    public float lift = 0.45f;
    public int segmentsPerLane = 200;

    public RoadModel Model { get; private set; }

    readonly Dictionary<Lane, Mesh> _meshes = new Dictionary<Lane, Mesh>();
    readonly Dictionary<Lane, float> _lastSignature = new Dictionary<Lane, float>();
    float _rebuildAcc;

    /// <summary>Lane meshes, exposed so a test can check they were built on the ground.</summary>
    public IReadOnlyDictionary<Lane, Mesh> Meshes => _meshes;

    void Awake()
    {
        Model = new RoadModel();
        if (field != null) Model.FrontlineAt = field.FrontlineZ;

        foreach (var lane in RoadModel.Order)
        {
            var go = new GameObject($"Road_{lane}");
            go.transform.SetParent(transform, false);
            var mesh = new Mesh { name = $"Road_{lane}" };
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            if (roadMaterial != null)
            {
                // instance per lane, so the five routes are told apart at a glance
                var m = new Material(roadMaterial);
                m.SetColor("_BaseColor", TintFor(lane));
                mr.sharedMaterial = m;
            }
            _meshes[lane] = mesh;
            _lastSignature[lane] = float.NaN;
            Rebuild(lane);
        }
    }

    void Update()
    {
        if (Model == null) return;
        Model.Tick(Time.deltaTime);

        // The frontline moves every frame, but rebuilding five ribbons at frame
        // rate is wasted work - the seam drifts slowly.
        _rebuildAcc += Time.deltaTime;
        if (_rebuildAcc < 0.25f) return;
        _rebuildAcc = 0f;

        foreach (var lane in RoadModel.Order)
        {
            float sig = Signature(lane);
            if (!Mathf.Approximately(sig, _lastSignature[lane])) Rebuild(lane);
        }
    }

    /// <summary>Cheap fingerprint of everything that would change a lane's mesh.</summary>
    float Signature(Lane lane)
    {
        // the ground itself counts: live mempool data reshapes it, and a road
        // built against the old heights ends up floating over the new ones
        float s = terrain != null ? terrain.Version * 1e5f : 0f;
        if (lane == Lane.Front) s += Mathf.Round(Model.CenterZ(lane, 0f) * 4f);
        foreach (var d in Model.Cuts) if (d.lane == lane) s += 1000f + Mathf.Round(d.x) + Mathf.Round(d.t);
        foreach (var w in Model.Wears) if (w.lane == lane) s += 7f + Mathf.Round(w.x) + Mathf.Round(w.wear * 20f);
        return s;
    }

    void Rebuild(Lane lane)
    {
        _lastSignature[lane] = Signature(lane);
        var mesh = _meshes[lane];
        int n = segmentsPerLane;

        float x0 = Model.PlazaX + 4f, x1 = Model.DepotX - 4f;
        var verts = new List<Vector3>(n * 2 + 2);
        var uvs = new List<Vector2>(n * 2 + 2);
        var tris = new List<int>(n * 6);

        var severity = new float[n + 1];
        for (int i = 0; i <= n; i++)
        {
            float t = i / (float)n;
            float x = Mathf.Lerp(x0, x1, t);
            float z = Model.CenterZ(lane, x);
            severity[i] = Model.SeverityAt(lane, x);

            // road normal in the xz plane, from the centreline's own slope
            float dz = Model.CenterZ(lane, x + 1f) - Model.CenterZ(lane, x - 1f);
            var side = new Vector3(-dz, 0f, 2f).normalized;

            // a worn surface is broken up, so damage is visible on the road itself
            float broken = severity[i] * Random01(x, lane) * 0.9f;

            // Sample the ground under each EDGE, not just the centreline. A
            // ribbon held flat across its width floats on one side and buries
            // itself on the other wherever the terrain slopes sideways.
            var left = new Vector3(x, 0f, z) - side * RoadModel.HalfWidth;
            var right = new Vector3(x, 0f, z) + side * RoadModel.HalfWidth;
            float gl = terrain != null ? terrain.SampleSurface(left.x, left.z) : 0f;
            float gr = terrain != null ? terrain.SampleSurface(right.x, right.z) : 0f;

            left.y = gl + lift - broken * 0.55f;
            right.y = gr + lift - broken * 0.55f + broken * 0.25f;
            verts.Add(left);
            verts.Add(right);
            uvs.Add(new Vector2(0f, t * n * 0.5f));
            uvs.Add(new Vector2(1f, t * n * 0.5f));
        }

        for (int i = 0; i < n; i++)
        {
            // a cut section is missing, not merely dark: the road ends in rubble
            if (severity[i] > 0.82f || severity[i + 1] > 0.82f) continue;
            // Winding matters: with left at v and right at v+1, the order
            // (v, v+2, v+1) puts the normal in -Y and Unity culls the road as a
            // back face - drawn every frame and invisible from above.
            int v = i * 2;
            tris.Add(v); tris.Add(v + 1); tris.Add(v + 2);
            tris.Add(v + 1); tris.Add(v + 3); tris.Add(v + 2);
        }

        mesh.Clear();
        mesh.SetVertices(verts);
        mesh.SetUVs(0, uvs);
        mesh.SetTriangles(tris, 0);
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();
    }

    /// <summary>
    /// Route colours follow the risk they carry: deep flanks are muted, the
    /// contested frontline track is the one that shouts.
    /// </summary>
    public static Color TintFor(Lane lane) => lane switch
    {
        Lane.BullRear => new Color(0.16f, 0.30f, 0.18f),   // deep green, quiet
        Lane.Bull     => new Color(0.22f, 0.48f, 0.26f),   // green
        Lane.Front    => new Color(0.82f, 0.62f, 0.14f),   // amber: contested
        Lane.Bear     => new Color(0.52f, 0.21f, 0.19f),   // red
        _             => new Color(0.31f, 0.14f, 0.14f),   // deep red, quiet
    };

    /// <summary>Stable per-position jitter, so a worn stretch does not shimmer.</summary>
    static float Random01(float x, Lane lane)
    {
        float v = Mathf.Sin(x * 12.9898f + (int)lane * 78.233f) * 43758.5453f;
        return Mathf.Abs(v - Mathf.Floor(v));
    }
}
