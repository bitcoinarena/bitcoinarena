// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    /// The deck is laid <see cref="lift"/> above the terrain, so units resting
    /// straight onto terrain.SampleSurface sank into the road by exactly that
    /// much wherever they drove on it.
    ///
    /// The lift fades out across the last stretch of the shoulder. Switched on
    /// and off at the edge a tank half on the road would step 45 cm as it
    /// crossed the line.
    /// </summary>
    /// <summary>
    /// ROADS ARE WHOLE AGAIN (2026-09-17 17:38, roads-incomplete-1737.jpg: "roads are incomplete - fragments only,
    /// the candle ribbon ate the roads"). The 13:42 rule cut every road out of the chart band because the candles were 2 m
    /// walls then; the ribbon is ground now (1 m, 25% ramps, 0.5 m wick ridges), so the roads run through the band
    /// again - on the ground under it, so the bodies cover the road rather than the road the bodies (13:09, below).
    /// </summary>
    /// <summary>
    /// AND THE ROAD IS NOT DRAWN OVER THE CHART (2026-09-19 13:09, roads-cover-candles-1309.jpg: "roads cover
    /// the candles - don't draw roads where candles are"). Laid ON the live candle layer, as it was from 17:38, the
    /// ribbon rode up onto every body it crossed and painted asphalt over the one thing the game is about. It lies on
    /// the ground UNDER the candles now: the bodies stand up through it, so the chart covers the road where they meet
    /// and the road is whole everywhere else - which is what 17:38 asked for. Nothing that stands on it moves: the
    /// core's surface carries the plateau and <see cref="Rest"/> takes the higher of the two.
    /// </summary>
    public const int Across = 5;

    /// <summary>The live candle layer at a world point, metres - 0 where no candle stands.</summary>
    static float CandleLayerAt(float x, float z) =>
        CandleTerrain.LiveWords != null ? CandleTerrain.LayerAt(CandleTerrain.LiveWords, x, z) : 0f;

    /// <summary>How far the chart has scrolled, metres: the holes in the ribbon move with it.</summary>
    static float CandleShift() =>
        CandleTerrain.LiveWords != null ? CandleTerrain.LiveWords[Arena.Layout.CV_SHIFT] / 65536f : 0f;

    public float SurfaceHeight(float x, float z)
    {
        float bare = Ground(x, z);
        if (Model == null) return bare;

        var lane = Model.LaneAt(x, z, RoadModel.HalfWidth + Shoulder);
        if (lane == null) return bare;

        // THE RIBBON'S OWN SURFACE, not a second opinion about it.
        //
        // The mesh lays two vertices per cross-section and spans them flat, so
        // the drawn road is a CHORD between its edges - and things standing on
        // it were resting on the ground under their own feet instead, which
        // over a crest is above that chord and in a hollow below it. Measured
        // against the ribbon's own vertices in a built world: 0.272 m of float
        // at (59.7, 45.2), the tyre in the air over the road it is on.
        //
        // Wear is the other half. The mesh drops its left edge by
        // `broken * 0.55` and its right by `broken * 0.30`, drawing a worn
        // stretch as a rut, and the resting knew nothing about it.
        //
        // So the surface is built here the way the mesh builds it, at a point
        // instead of at a vertex: the same `side`, the same edge samples, the
        // same wear, and the same shoulder fade so nothing steps at the edge.
        float centreZ = Model.CenterZ(lane.Value, x);
        float slope = Model.CenterZ(lane.Value, x + 1f) - Model.CenterZ(lane.Value, x - 1f);
        var side = new Vector3(-slope, 0f, 2f).normalized;

        float across = (z - centreZ) * side.z;
        float t = Mathf.Clamp01((across + RoadModel.HalfWidth) / (2f * RoadModel.HalfWidth));

        // the same stations the mesh lays (Across of them), each on the ground under the candles, lerped
        float st = t * (Across - 1);
        int k0 = Mathf.Min(Across - 2, Mathf.FloorToInt(st));
        float Station(int k)
        {
            var p = new Vector3(x, 0f, centreZ) + side * RoadModel.HalfWidth * (2f * k / (float)(Across - 1) - 1f);
            return DeckGround(p.x, p.z);
        }
        float broken = Model.SeverityAt(lane.Value, x) * Random01(x, lane.Value) * 0.9f;
        float deck = Mathf.Lerp(Station(k0), Station(k0 + 1), st - k0) + lift - broken * 0.55f + broken * 0.25f * t;

        float d = Mathf.Abs(z - centreZ);
        float fade = Mathf.Clamp01(Mathf.InverseLerp(RoadModel.HalfWidth + Shoulder,
                                                     RoadModel.HalfWidth, d));
        return Rest(bare, deck, fade);
    }

    /// <summary>
    /// What stands on the road rests on: the deck, faded across the shoulder - or the core's surface where that is higher.
    /// The deck lies on the ground UNDER the candles (<see cref="DeckGround"/>), so on a candle's plateau the surface is
    /// the higher one and a truck or a tank there stands on the plateau, not in it. Pure, for the tests.
    /// </summary>
    public static float Rest(float surface, float deck, float fade) => Mathf.Max(surface, Mathf.Lerp(surface, deck, fade));

    /// <summary>
    /// THE GROUND THE ROAD RIBBON IS LAID ON: the core's surface without the candle layer (WAR_TACTICS.md §4.15). There is
    /// no road in the core; the ribbon is drawn here only. Laid on `SurfaceAt` it climbed the candles: measured, the deck
    /// was over a candle along 8.5 / 26.5 / 11.5 / 8.0 m of 236 m (BullRear / Bull / Bear / BearRear) and sampled edge to
    /// edge it drew a slope where the core has a 2 m wall. The candles are drawn by CandleTerrain, standing on this ground.
    /// </summary>
    public float DeckGround(float x, float z)
    {
        if (Arena.ArenaCore.HasSurface) return Arena.ArenaCore.TerrainAt(x, z);
        return terrain != null ? terrain.SampleSurface(x, z) : 0f;
    }

    /// <summary>
    /// The bare ground here, with no deck on it - and it comes from the CORE.
    ///
    /// `surfaceAt` in sim.js is the one thing that says what the ground is, and
    /// it is the relief LESS the craters. Unity's terrain is the relief alone:
    /// `MempoolTerrain` draws the hills the round started with and has never
    /// heard of a strike, so everything resting on `SampleSurface` stood on a
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
        if (Arena.ArenaCore.HasSurface) return Arena.ArenaCore.SurfaceAt(x, z);
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

    /// <summary>
    /// How far the DRAWN ribbon is lowered here by wear, in metres.
    ///
    /// The left edge's drop, exposed as a point query so the diagnostic can
    /// print it. The gap this used to name - `SurfaceHeight` giving the truck
    /// `lift` in full while the ribbon drew itself at `lift - wear` - was
    /// measured at 0.272 m and is closed: `SurfaceHeight` builds the ribbon's
    /// surface the way the mesh builds it, wear and all.
    /// </summary>
    public float WearAt(float x, float z)
    {
        if (Model == null) return 0f;
        var lane = Model.LaneAt(x, z, RoadModel.HalfWidth + Shoulder);
        if (lane == null) return 0f;
        return Model.SeverityAt(lane.Value, x) * Random01(x, lane.Value) * 0.9f * 0.55f;
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
        s += Arena.ArenaCore.StrikeCount * 1e3f + Arena.ArenaCore.CraterCount;

        // AND THE CHART'S OWN SCROLL: the holes the ribbon leaves for the candles move with the bodies, so a lane
        // whose shift has changed is stale. Rounded to a tenth of a metre, which is a third of the 0.576 m/s slide
        // per rebuild tick - fine enough that a hole never lags a body by a visible amount, coarse enough that a
        // lane is not rebuilt on float noise.
        s += Mathf.Round(CandleShift() * 10f) * 0.017f;

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
        // AND NOT INSIDE THE MINER EITHER (2026-09-19 13:09, miner-entrance-covered-1309.jpg). DepotX - 4 is
        // x 114, which is the facade - the model's origin - and the building stands on the ground from x 53.8 m, so
        // the last 24 m of ribbon was drawn inside it. The end is the core's own door now (Arena.Layout
        // MINER_DOOR_X, 90.4 m), the same number the candle field is refitted to: Unity draws what the core says and
        // does not keep a second idea of where the world ends. The truck still reaches the miner - the approach past
        // the door is the building's own apron, as the post office's is at the other end.
        float x1 = Arena.Layout.MINER_DOOR_X / 65536f;
        var verts = new List<Vector3>(n * 2 + 2);
        var uvs = new List<Vector2>(n * 2 + 2);
        var tris = new List<int>(n * 6);
        var onCandle = new List<bool>(n * 2 + 2);

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
            // FIVE ACROSS, not two: an 8 m chord from edge to edge missed the ribbon's 4 m ramps. Each vertex
            // samples the ground under the candles.
            float centreY = 0f;
            float uWidth = RoadModel.HalfWidth * 2f / TileMetres;   // square tiles
            if (i > 0) run += Vector3.Distance(prev, new Vector3(x, prev.y, z));
            float v = run / TileMetres;
            for (int k = 0; k < Across; k++)
            {
                float a = k / (float)(Across - 1);
                var p = new Vector3(x, 0f, z) + side * RoadModel.HalfWidth * (2f * a - 1f);
                p.y = DeckGround(p.x, p.z) + lift - broken * 0.55f + broken * 0.25f * a;
                verts.Add(p);
                uvs.Add(new Vector2(uWidth * a, v));
                onCandle.Add(CandleLayerAt(p.x, p.z) > 0.01f);
                if (k == Across / 2) centreY = p.y;
            }
            prev = new Vector3(x, centreY, z);
        }

        for (int i = 0; i < n; i++)
        {
            // a cut section is missing, not merely dark: the road ends in rubble
            if (severity[i] > 0.82f || severity[i + 1] > 0.82f) continue;
            // Winding matters: with left at v and right at v+1, the order
            // (v, v+2, v+1) puts the normal in -Y and Unity culls the road as a
            // back face - drawn every frame and invisible from above.
            for (int k = 0; k + 1 < Across; k++)
            {
                int v = i * Across + k, w = v + Across;
                // NO ASPHALT WHERE A CANDLE STANDS (2026-09-19 13:09 and 15:56: "roads still cover the
                // candles"). Laying the ribbon on the ground under the chart was not enough: the deck stands 0.45 m
                // over the bare ground and a candle's ramp needs 1.80 m of its 2.59 m half to climb that high, so
                // 69% of every ramp the road crossed was buried under asphalt. A quad with a candle under any of
                // its four corners is not emitted - the road is whole between the bodies and absent under them.
                if (onCandle[v] || onCandle[v + 1] || onCandle[w] || onCandle[w + 1]) continue;
                tris.Add(v); tris.Add(v + 1); tris.Add(w);
                tris.Add(v + 1); tris.Add(w + 1); tris.Add(w);
            }
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
