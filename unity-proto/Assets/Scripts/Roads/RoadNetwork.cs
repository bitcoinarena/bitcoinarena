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

    [Tooltip("Where the paving at the plaza end stops and the road may begin. " +
             "Set before the object is activated, because Awake is what " +
             "builds the ribbons - the model does not exist before then, so " +
             "it cannot be reached through it.")]
    public float pavedTo = float.NaN;

    public RoadModel Model { get; private set; }

    /// <summary>
    /// Height of the surface anything STANDS on at this point - the road deck
    /// where there is one, the bare ground everywhere else.
    ///
    /// The deck is laid <see cref="lift"/> above the terrain, so units seated
    /// straight onto terrain.SampleSurface sank into the road by exactly that
    /// much wherever they drove on it.
    ///
    /// The lift fades out across the last stretch of the shoulder. Switched on
    /// and off at the edge a tank half on the road would step 45 cm as it
    /// crossed the line.
    /// </summary>
    public float SurfaceHeight(float x, float z) => Ground(x, z) + Lift(x, z);

    /// <summary>
    /// The bare ground here, with no deck on it - and it comes from the CORE.
    ///
    /// `surfaceAt` in sim.js is the one thing that says what the ground is, and
    /// it is the relief LESS the craters. Unity's terrain is the relief alone:
    /// `MempoolTerrain` draws the hills the round started with and has never
    /// heard of a strike, so everything seated on `SampleSurface` stood on a
    /// lid over the hole. Measured on the running build, at the centre of the
    /// biggest crater the rule can make, the two answers were 4.418 m and
    /// -1.562 m.
    ///
    /// This is the funnel. Everything that stands on the map - the truck, the
    /// army, the effects, the gate, and the road ribbon itself - comes through
    /// here, so there is one answer rather than six that drift apart.
    ///
    /// The terrain stays as the fallback for the Editor, where there is no core
    /// at all, and for the frames before the relief has been uploaded.
    /// </summary>
    public float Ground(float x, float z)
    {
        if (Blwp.BlwpCore.HasSurface) return Blwp.BlwpCore.SurfaceAt(x, z);
        return terrain != null ? terrain.SampleSurface(x, z) : 0f;
    }

    /// <summary>
    /// How far the deck stands above whatever the ground is here - zero off the
    /// road, <see cref="lift"/> on it, faded across the shoulder.
    ///
    /// Split out of <see cref="SurfaceHeight"/> because the ground underneath it
    /// is no longer Unity's to answer: the core knows about craters and the
    /// terrain does not. The deck is drawn by Unity and only Unity, so the lift
    /// stays here and is added to whichever surface the caller starts from.
    /// </summary>
    public float Lift(float x, float z)
    {
        if (Model == null) return 0f;

        var lane = Model.LaneAt(x, z, RoadModel.HalfWidth + Shoulder);
        if (lane == null) return 0f;

        float d = Mathf.Abs(z - Model.CenterZ(lane.Value, x));
        float t = Mathf.InverseLerp(RoadModel.HalfWidth + Shoulder,
                                    RoadModel.HalfWidth, d);
        return lift * Mathf.Clamp01(t);
    }

    /// <summary>How far past the edge the deck height is blended out.</summary>
    public const float Shoulder = 2.6f;

    readonly Dictionary<Lane, Mesh> _meshes = new Dictionary<Lane, Mesh>();
    readonly Dictionary<Lane, float> _lastSignature = new Dictionary<Lane, float>();
    float _rebuildAcc;

    /// <summary>Lane meshes, exposed so a test can check they were built on the ground.</summary>
    public IReadOnlyDictionary<Lane, Mesh> Meshes => _meshes;

    void Awake()
    {
        Model = new RoadModel();
        if (!float.IsNaN(pavedTo)) Model.PlazaPavedTo = pavedTo;
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
                // A tint per lane, but multiplied INTO the asphalt rather than
                // replacing it: a flat colour in _BaseColor would hide the photo
                // the material now carries.
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

        // and so do the craters: the deck follows the ground into the hole, and
        // a ribbon whose fingerprint ignored the strike would go on bridging it
        // until something else happened to move. A serial and a count catch both
        // ends - a crater arriving, and a crater expiring after its 10-20 rounds.
        s += Blwp.BlwpCore.StrikeCount * 1e3f + Blwp.BlwpCore.CraterCount;

        foreach (var d in Model.Cuts) if (d.lane == lane) s += 1000f + Mathf.Round(d.x) + Mathf.Round(d.t);
        foreach (var w in Model.Wears) if (w.lane == lane) s += 7f + Mathf.Round(w.x) + Mathf.Round(w.wear * 20f);
        return s;
    }

    void Rebuild(Lane lane)
    {
        _lastSignature[lane] = Signature(lane);
        var mesh = _meshes[lane];
        int n = segmentsPerLane;

        // Never over the post office's own concrete: the building spans the
        // start of the map and its apron is 26 m of paving in front of the
        // doors, so a lane that begins at the plaza mark begins inside the
        // loading bays.
        float x0 = Mathf.Max(Model.PlazaX + 4f, Model.PlazaPavedTo);
        float x1 = Model.DepotX - 4f;
        var verts = new List<Vector3>(n * 2 + 2);
        var uvs = new List<Vector2>(n * 2 + 2);
        var tris = new List<int>(n * 6);

        // One texture tile every TileMetres, measured along the road as it is
        // actually driven. Emitting UVs in tile units means the material needs
        // no tiling factor, so the asphalt cannot end up repeated four thousand
        // times because two scalings were applied on top of each other.
        const float TileMetres = 4f;
        float run = 0f;
        var prev = Vector3.zero;

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
            float gl = Ground(left.x, left.z);
            float gr = Ground(right.x, right.z);

            left.y = gl + lift - broken * 0.55f;
            right.y = gr + lift - broken * 0.55f + broken * 0.25f;
            verts.Add(left);
            verts.Add(right);

            var centre = new Vector3(x, (left.y + right.y) * 0.5f, z);
            if (i > 0) run += Vector3.Distance(prev, centre);
            prev = centre;
            float v = run / TileMetres;
            float uWidth = RoadModel.HalfWidth * 2f / TileMetres;   // square tiles
            uvs.Add(new Vector2(0f, v));
            uvs.Add(new Vector2(uWidth, v));
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
        // near white, so the asphalt reads as asphalt: these only shade one
        // route slightly against the next
        Lane.BullRear => new Color(0.78f, 0.80f, 0.82f),
        Lane.Bull     => new Color(1.00f, 1.00f, 1.00f),
        Lane.Bear     => new Color(0.94f, 0.90f, 0.86f),
        _             => new Color(0.72f, 0.70f, 0.68f),
    };

    /// <summary>Stable per-position jitter, so a worn stretch does not shimmer.</summary>
    static float Random01(float x, Lane lane)
    {
        float v = Mathf.Sin(x * 12.9898f + (int)lane * 78.233f) * 43758.5453f;
        return Mathf.Abs(v - Mathf.Floor(v));
    }
}
