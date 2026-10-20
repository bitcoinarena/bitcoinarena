// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The Mempool Post Office: where the run starts.
///
/// Counterpart to the miner at the other end. The truck rolls out of a loading
/// bay rather than appearing on an empty apron, and the building's displays
/// carry the same live chain state the rest of the map is built from - the fee
/// estimate, the unconfirmed count, the blocks, and a treemap of what is
/// actually waiting.
///
/// Everything on it is data at runtime and nothing is baked, for the same
/// reason as the miner's terminal: a number in a texture is wrong within the
/// minute and can only be corrected by re-exporting a building.
/// </summary>
public class PostOffice : MonoBehaviour
{
    public GameObject model;
    public MempoolTerrain terrain;
    public MempoolFeed feed;
    public MarketFeed market;
    public BlockClock clock;
    public ChainStats stats;

    [Tooltip("Where the building stands. Mirrors the delivery gate.")]
    public float postX = -114.4f;

    /// <summary>
    /// Bay the player is given when nobody else is on the map: the middle one.
    ///
    /// It was Bay 0, which is the far corner of the building - 6.8 m from the
    /// edge of the map, with the whole run then made along the boundary where
    /// the two armies barely reach. The war is fought across the middle, so a
    /// solo player who starts at the end of the rank drives seventeen seconds
    /// down an empty verge before anything happens. Twenty-four bays exist for
    /// twenty-four players; the one player there is gets the one in the
    /// middle - and specifically the one the road leaves from, so the truck
    /// starts centred on its own lane rather than straddling the kerb.
    /// </summary>
    public const int SoloBay = 13;

    /// <summary>
    /// Where a bay's centreline runs. Public because the road has to leave
    /// from a door: the solo bay was at z = 3.4 and the nearest lane ran down
    /// z = 9, so the truck spawned five metres off the edge of the only road
    /// it could take, which from the cab looks exactly like being parked
    /// crooked.
    /// </summary>
    public static float BayZ(int bay) => FirstPortZ + PortPitch * Mathf.Clamp(bay, 0, 23);

    /// <summary>Where the truck should stand, once the building is up.</summary>
    public Vector3 BayPosition { get; private set; }
    public bool HasBay { get; private set; }

    // Measured off the import, in the model's own local space AFTER glTFast
    // has mirrored x - which it does to get from glTF's right-handed frame to
    // Unity's, so every x below is the negative of what a glTF viewer shows.
    //
    //   facade front face   x =  0        (the rivets stand 0.3 proud of it)
    //   bay mouths          x = -8.9 .. -0.5, y 1.1 .. 9.1, 5.0 wide in z
    //   the hall behind     x = -42.8
    //   the apron in front  x = +5 .. +31, the full 168 m of z
    //   24 ports            z = -78.2 .. +78.2 on a 6.8 pitch
    //   shell               z = +-84.15, 51.95 tall
    const float PortPitch = 6.8f;
    const float FirstPortZ = -78.2f;
    const float MouthHalf = 2.5f;      // clear half-width of one bay
    const float MouthHigh = 9.2f;
    const float ShellHalf = 84.15f;
    const float ShellHigh = 52f;
    const float FacadeX = 0f;

    /// <summary>How far the apron paving reaches in front of the facade.</summary>
    public const float ApronReach = 31f;
    const float WallDepth = 8f;        // the barrier runs back INTO the hall

    [Tooltip("How far out on the apron the truck is parked, in metres from " +
             "the facade. The apron slab reaches 31 m, so this has to stay " +
             "inside it or the truck starts on bare ground.")]
    public float bayStandoff = 14f;

    /// <summary>
    /// Clearance between the model's apron slab and the ground it is laid on.
    ///
    /// The slab is 5 cm thick and centred on the model's own zero, so setting
    /// the building down at exactly the sampled height buries half of it and
    /// leaves 26 x 168 m of coplanar geometry fighting the terrain for depth.
    /// A hand's width of lift costs nothing and settles it.
    /// </summary>
    const float ApronLift = 0.06f;

    GameObject _up;
    Transform _shell;
    int _seenGround = -1;
    readonly List<TextMesh> _feeRate = new();
    readonly List<TextMesh> _feeUsd = new();
    TextMesh _unconf;
    readonly List<TextMesh> _blockFace = new();
    readonly List<TextMesh> _blockHeight = new();
    readonly List<TextMesh> _blockLabel = new();
    Transform _goggles;
    float _nextData, _nextCount;

    /// <summary>
    /// The height the building stands at: the LOWEST ground under its apron.
    ///
    /// One building, one height - it is a concrete slab, not a blanket. The
    /// terrain is levelled dead flat at this end of the map precisely so that
    /// this is exact, and the lowest of several samples is taken rather than
    /// one at the centre so that any relief that does survive leaves the
    /// building slightly proud of the ground instead of hovering over it with
    /// the road running underneath - which is what happened, and what put the
    /// truck under its own loading dock.
    /// </summary>
    float Ground()
    {
        if (terrain == null && !Arena.ArenaCore.HasSurface) return 0f;
        float low = float.MaxValue;
        for (int i = 0; i <= 8; i++)
        {
            float z = Mathf.Lerp(-ShellHalf, ShellHalf, i / 8f);
            low = Mathf.Min(low, Surface(postX, z));
            low = Mathf.Min(low, Surface(postX + bayStandoff, z));
            low = Mathf.Min(low, Surface(postX + ApronReach, z));
        }
        return low;
    }

    /// <summary>
    /// The ground under the depot, from the CORE: relief less craters.
    ///
    /// Same funnel as the truck, the army, the roads and the gate. A strike
    /// lands on a unit at the seam and reaches up to 40 m; the apron's own
    /// sample columns run from x -114.4 out to -83.4, so a crater in the -50s
    /// already touches one. Sampled at Unity's terrain the depot went on
    /// standing at the height of ground that is no longer there, over its
    /// own hole.
    ///
    /// The sampling rule itself does not change: the same twenty-seven points,
    /// and still the LOWEST of them, so the building sits slightly proud
    /// rather than hovering with the road running underneath.
    ///
    /// The terrain stays as the fallback where no core answers - the Editor.
    /// </summary>
    float Surface(float x, float z) =>
        Arena.ArenaCore.HasSurface ? Arena.ArenaCore.SurfaceAt(x, z)
                                 : (terrain != null ? terrain.SampleSurface(x, z) : 0f);

    public Vector3 BayFor(int bay)
    {
        float z = BayZ(bay);
        float x = postX + bayStandoff;
        // the ground the truck will actually rest on, not the ground at the
        // building's centre 78 m away
        return new Vector3(x, Surface(x, z) + 1.4f, z);
    }

    void Start()
    {
        // The bay is known from arithmetic, not from the model, so the truck
        // can be parked in it before the building has finished streaming.
        BayPosition = BayFor(SoloBay);
        HasBay = true;

        Wall();
        if (model != null) Show(model);
    }

    /// <summary>The building has arrived from the streamer.</summary>
    public void Show(GameObject asset)
    {
        if (asset == null || _up != null) return;

        _up = Instantiate(asset, new Vector3(postX, Ground() + ApronLift, 0f),
                          Quaternion.identity, transform);
        _up.name = "MempoolPostOffice";

        Wire(_up);

        // Same treatment as the miner: batch the static parts in place rather
        // than reparenting, which shears anything rotated.
        var statics = new List<GameObject>();
        foreach (var r in _up.GetComponentsInChildren<Renderer>(true))
        {
            bool live = false;
            for (var t = r.transform; t != null && t != _up.transform; t = t.parent)
                if (IsLive(t.name)) { live = true; break; }
            if (!live) statics.Add(r.gameObject);
        }
        StaticBatchingUtility.Combine(statics.ToArray(), _up);
    }

    /// <summary>
    /// Kept OUT of the static batch. Anything that carries drawn lettering belongs here, whether or not the words
    /// change.
    ///
    /// THE WHITEPAPER IS ON THIS LIST BECAUSE OF WHAT BATCHING DOES TO A MEASUREMENT (2026-09-18 22:16,
    /// photographed: the page sprawled across the depot). `StaticBatchingUtility.Combine` swaps every batched
    /// renderer's mesh for the combined building, so after it runs the plate's own renderer reports the BUILDING's
    /// box - 12.2 x 9.4 m - and so does the text hanging under it. `Fit` then measured one wrong box against another
    /// and logged "94% x 92%" every five seconds while the lettering was drawn six times the size of its plaque.
    /// That is the trap the comments in `Room` already name - the mesh the plate was authored with is not the object
    /// on screen - one layer along: this time it was batching that swapped the mesh, not streaming.
    /// </summary>
    static bool IsLive(string n) =>
        n == "goggles_screen" || n == "unconf_count" || n == "whitepaper_print"
        || n.StartsWith("fee_rate_") && !n.Contains("unit")
        || n.StartsWith("fee_usd_") && !n.Contains("unit")
        || n.StartsWith("next_face_") && !n.Contains("plate")
        || n.StartsWith("mined_face_") && !n.Contains("plate")
        || n.StartsWith("block_label_") && !n.Contains("case");

    /// <summary>
    /// The facade, as collision: solid except the 24 bay mouths.
    ///
    /// The building spans the map, so without this the start of the map has no
    /// boundary at all - and with it, the only way onto the road is out of a
    /// bay, which is the point of a loading dock.
    ///
    /// The slabs run from the facade BACKWARDS into the hall. They used to run
    /// forwards, 6 m out onto the apron, which put an invisible wall in front
    /// of the doors the truck is parked at.
    /// </summary>
    void Wall()
    {
        var shell = new GameObject("PostOfficeShell");
        shell.transform.SetParent(transform, false);
        shell.transform.position = new Vector3(postX, Ground(), 0f);
        _shell = shell.transform;

        // Buried, for the same reason the miner's facade is: the shell sits at
        // one terrain sample and the ground rolls away to either side.
        const float Footing = 20f;
        float h = ShellHigh + Footing, y = h * 0.5f - Footing;
        float x = FacadeX - WallDepth * 0.5f;

        // one slab per gap between bays, plus the two ends
        float pillar = PortPitch - MouthHalf * 2f;
        for (int i = 0; i <= 24; i++)
        {
            float z = FirstPortZ - PortPitch * 0.5f + PortPitch * i;
            Slab(shell.transform, $"Pillar{i:00}", new Vector3(x, y, z),
                 new Vector3(WallDepth, h, pillar));
        }

        // The two ends, from the outermost pillar out to the edge of the
        // shell. There used to be one of these and it was parked at z = -41,
        // in the middle of the doors, while both actual ends stood open - a
        // 2.5 m gap at each corner that a 2.4 m truck fits through.
        float lastEdge = FirstPortZ + PortPitch * 23.5f;   // 81.6
        float endWidth = Mathf.Max(0.5f, ShellHalf - lastEdge);
        foreach (int side in new[] { -1, 1 })
            Slab(shell.transform, side < 0 ? "EndLeft" : "EndRight",
                 new Vector3(x, y, side * (lastEdge + endWidth * 0.5f)),
                 new Vector3(WallDepth, h, endWidth));

        // over every mouth
        Slab(shell.transform, "Lintel",
             new Vector3(x, MouthHigh + (ShellHigh - MouthHigh) * 0.5f, 0f),
             new Vector3(WallDepth, ShellHigh - MouthHigh, ShellHalf * 2f));
    }

    void Slab(Transform parent, string name, Vector3 at, Vector3 size)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = at;
        go.AddComponent<BoxCollider>().size = size;
    }

    /// <summary>
    /// Puts words on the whitepaper that can actually be read.
    ///
    /// The printed page cannot be made legible and it is not a resolution
    /// problem: the paper carries about 2500 characters across 970 pixels,
    /// which is four pixels a character IN THE FILE, and on screen the plaque
    /// is a few hundred pixels wide - under two pixels a letter. No texture
    /// and no filter fixes that; the page was recompressed, restored to full
    /// resolution, given anisotropic filtering and a mip bias, and stayed a
    /// grey smear, because the arithmetic was never going to work.
    ///
    /// So the content changes instead. The title, the author and the opening
    /// of the abstract are drawn as text, sized to fill the plaque, which is
    /// legible from across the yard - and is what anyone looking at it wants
    /// to read anyway.
    /// </summary>
    void Paper(Transform plate)
    {
        // No cover sheet any more: the model ships this page BLANK now, so
        // there is nothing underneath to hide. It used to carry a photograph
        // of the whitepaper that could not be made legible at any resolution -
        // four pixels a character in the file, under two on screen - and the
        // drawn text had to be laid over a white quad to cover it.
        var room = Room(plate);

        var tm = Plate(plate, new Color(0.06f, 0.06f, 0.07f), 0.94f,
                       TextAnchor.MiddleCenter, default, "_text", 0.94f);
        _paper = tm;
        // SHAPED TO THE PLATE THAT IS THERE, which is LANDSCAPE.
        //
        // Every comment that used to sit here called the plate "9.4 x 12.2 -
        // portrait, about 0.77" and cut the text into eleven short lines to
        // match it. Measured on the running build, the plate is 73.8 x 52.5 -
        // landscape, 1.41 - because the building streams in and swaps the mesh
        // under a node that keeps its name. This is the same trap that held
        // the page at 22% through four attempts, and it was still here, one
        // layer along: the fill was raised to 0.94 and the block was still
        // being shaped for a page that no longer exists.
        //
        //     plate 73.8 x 52.5, room 69.4 x 49.4, text 70.7 x 100.9,
        //     k 0.489 -> drawn 34.6 x 49.4, covering 47% x 94%
        //
        // `Fit` takes the tighter axis, so a portrait block on a landscape
        // plate fills the height, runs out, and leaves half the width empty
        // however high the fill is set. Seven lines with the longest about
        // twenty-two characters puts the block near the plate's own 1.41.
        tm.text = "BITCOIN\n" +
                  "A Peer-to-Peer\n" +
                  "Electronic Cash System\n" +
                  "\n" +
                  "Satoshi Nakamoto\n" +
                  "satoshin@gmx.com\n" +
                  "31 Oct 2008";
        // Fitted here AND again once it has a mesh. TextMesh builds its own
        // geometry internally and Renderer.localBounds is empty on the frame
        // the text is set, so a single Fit at wire time scaled it against
        // nothing and left it at a ninth of the plate.
    }

    TextMesh _paper;

    /// <summary>
    /// Keeps a printed page readable from further than arm's length.
    ///
    /// The whitepaper and the genesis print are pages of body text on a plaque
    /// two metres across. At any distance the mip chain takes over and every
    /// glyph collapses into the same flat grey - the texture is not too small,
    /// it is being averaged away before it reaches the screen. Anisotropic
    /// filtering and a negative mip bias hold the sharper level in view for
    /// the angles these are actually read at.
    ///
    /// Applied to these two only. It is a cost, and it buys nothing on a
    /// concrete wall.
    /// </summary>
    static void Sharpen(Transform plate)
    {
        var mr = plate.GetComponent<MeshRenderer>();
        if (mr == null) return;
        foreach (var m in mr.materials)
        {
            if (m == null) continue;
            foreach (var id in new[] { "_BaseMap", "_MainTex", "_EmissionMap" })
            {
                if (!m.HasProperty(id)) continue;
                var tex = m.GetTexture(id) as Texture2D;
                if (tex == null) continue;
                tex.anisoLevel = 16;
                tex.mipMapBias = -1.25f;
                tex.filterMode = FilterMode.Trilinear;
            }
        }
    }

    /// <summary>Hangs a text mesh on one of the model's blank plates.</summary>
    TextMesh Plate(Transform plate, Color colour, float fill = 0.88f,
                   TextAnchor anchor = TextAnchor.MiddleCenter, Vector2 offset = default,
                   string suffix = "_text", float wideFill = 0f)
    {
        var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        var go = new GameObject(plate.name + suffix);
        go.transform.SetParent(plate, false);
        var room0 = Room(plate);
        go.transform.localPosition = new Vector3(offset.x * room0.x, offset.y * room0.y, -0.15f);
        go.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
        go.layer = plate.gameObject.layer;

        var tm = go.AddComponent<TextMesh>();
        tm.font = font;
        tm.fontSize = 80;
        tm.characterSize = 1f;
        tm.anchor = anchor;
        tm.alignment = TextAlignment.Center;
        tm.color = colour;
        tm.text = "";

        var mr = go.GetComponent<MeshRenderer>();
        mr.sharedMaterial = font.material;
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        // Width and height are allowed different shares of the plate: the
        // block height takes the top half of a face but is entitled to the
        // whole width of it, and scaling both by one number made a seven-digit
        // number that fitted in half the plate's WIDTH - which is a small
        // number on a big sign.
        // FRACTIONS, not metres. What is kept is the share of the plate this
        // lettering is entitled to; the plate's size is read fresh every fit,
        // from what is drawn.
        _room[tm] = new Vector2(wideFill > 0f ? wideFill : fill, fill);
        return tm;
    }

    /// <summary>
    /// The face of the plate AS DRAWN, in world metres.
    ///
    /// It used to answer off `MeshFilter.sharedMesh.bounds` - the mesh the
    /// plate was authored with - and that is a different object from the one
    /// on screen: measured on the running build, the whitepaper's mesh says
    /// 73.8 x 52.5 while the renderer draws 12.2 x 9.4 m. The page was fitted
    /// to the first and photographed sprawled across the depot, and the test
    /// that guards it read the same stale mesh and called it 89% full.
    ///
    /// The renderer's bounds are what the camera sees, so that is what both
    /// the fit and its test ask now. A plate is flat, so its thinnest world
    /// axis is thickness and the other two are the face.
    /// </summary>
    public static Vector2 Room(Transform plate)
    {
        if (plate == null) return new Vector2(4f, 1f);

        // IN THE PLATE'S OWN AXES, not the world's. `Renderer.bounds` is a world-axis box round a plate that hangs on
        // a building at an angle, so it grows with the angle and loses which way is up - and after
        // StaticBatchingUtility.Combine it is the whole building. The plate's own mesh, scaled by what the plate is
        // drawn at, is the face the camera sees: measured against the model file, whitepaper_print is a 9.4 x 12.2
        // quad and that is what this now answers.
        var mf = plate.GetComponent<MeshFilter>();
        var mr0 = plate.GetComponent<MeshRenderer>();
        if (mf != null && mf.sharedMesh != null && (mr0 == null || !mr0.isPartOfStaticBatch))
            return Face(Drawn(mf.sharedMesh.bounds.size, plate.lossyScale));

        var mr = plate.GetComponent<Renderer>();
        if (mr == null) return new Vector2(4f, 1f);

        // THE FALLBACK STAYS IN THE PLATE'S AXES TOO. It used to hand `Renderer.bounds` - a WORLD-axis box - to
        // `Face`, and measured plate by plate that box has swapped its axes: every fee plate on this building reads
        // 5.2 x 1.5 x 0.0 as its own mesh and 0.0 x 1.5 x 5.2 as its world box, because the plate is turned a quarter
        // round. `localBounds` is the same geometry in the space the plate is drawn in, so width stays width.
        return Face(Drawn(mr.localBounds.size, plate.lossyScale));
    }

    /// <summary>
    /// The two axes a flat thing is drawn on - the largest and the middle,
    /// the smallest being its thickness - as (width, height) with width the
    /// larger of the two.
    /// </summary>
    /// <summary>A local size at the scale it is drawn at. Sizes are never negative, whatever the scale's sign.</summary>
    public static Vector3 Drawn(Vector3 size, Vector3 lossy) =>
        new Vector3(size.x * Mathf.Abs(lossy.x), size.y * Mathf.Abs(lossy.y), size.z * Mathf.Abs(lossy.z));

    public static Vector2 Face(Vector3 size)
    {
        // THE THIN AXIS IS THICKNESS; THE OTHER TWO KEEP THEIR ORDER (2026-09-18 22:16, photographed: the
        // whitepaper spilling off its plaque). This used to return the biggest axis as the WIDTH and the middle one as
        // the height, which silently turns every portrait plate into a landscape one: the whitepaper's plate is
        // 9.4 wide x 12.2 tall and was read as 12.2 x 9.4, so the page was fitted to 11.4 m of width on a 9.4 m
        // plaque and hung over both edges. Width is the first axis the face spans, height the second.
        float small = Mathf.Min(size.x, Mathf.Min(size.y, size.z));
        if (size.z <= small) return new Vector2(Mathf.Max(0.001f, size.x), Mathf.Max(0.001f, size.y));
        if (size.y <= small) return new Vector2(Mathf.Max(0.001f, size.x), Mathf.Max(0.001f, size.z));
        return new Vector2(Mathf.Max(0.001f, size.z), Mathf.Max(0.001f, size.y));
    }

    readonly Dictionary<TextMesh, Vector2> _room = new();
    readonly List<TextMesh> _nextHeight = new();

    /// <summary>
    /// Scales a plate's text to fill it - both ways, and no further.
    ///
    /// Renderer.localBounds, not the mesh: TextMesh builds its mesh
    /// internally and leaves sharedMesh null, which is the trap the miner's
    /// terminal fell into first.
    /// </summary>
    /// <summary>
    /// Kept as the name the callers use. There is nothing to reconcile any
    /// more: `Fit` reads the drawn plate every time it runs, so a plate that
    /// has been swapped under its own name is simply measured again.
    /// </summary>
    void Refit(TextMesh tm) => Fit(tm);


    /// <summary>
    /// Scale the lettering to the share of its plate it is entitled to, in
    /// the metres the camera sees.
    ///
    /// Relative, not absolute: the text's own drawn size is measured and the
    /// scale is multiplied by the ratio it is short or over by, so one pass
    /// lands on the target and every pass after it is a no-op.
    /// </summary>
    void Fit(TextMesh tm)
    {
        var mr = tm.GetComponent<MeshRenderer>();
        if (mr == null || !_room.TryGetValue(tm, out var share)) return;
        if (tm.transform.parent == null) return;

        Vector2 plate = Room(tm.transform.parent);
        // The lettering measured the same way: its own box, in its own axes, at the size it is drawn. A world-axis
        // box round a text mesh on an angled wall is wider than the words are.
        Vector2 text = Face(Drawn(mr.localBounds.size, tm.transform.lossyScale));
        if (text.x < 0.001f || text.y < 0.001f) return;

        float f = Mathf.Min(plate.x * share.x / text.x, plate.y * share.y / text.y);
        if (f < 0.0001f || float.IsNaN(f)) return;
        tm.transform.localScale *= Mathf.Clamp(f, 0.01f, 100f);

        if (tm == _paper && Time.time - _saidPaper > 5f)
        {
            _saidPaper = Time.time;
            var after = Face(Drawn(mr.localBounds.size, tm.transform.lossyScale));
            Debug.Log($"[paper] drawn plate {plate.x:F1} x {plate.y:F1} m, "
                      + $"text {after.x:F1} x {after.y:F1} m, covering "
                      + $"{(100f * after.x / plate.x):F0}% x {(100f * after.y / plate.y):F0}%");
        }
    }

    float _saidPaper = -99f;

    void Wire(GameObject root)
    {
        var white = Color.white;
        var green = new Color(0.35f, 0.95f, 0.45f);
        var blue = new Color(0.45f, 0.65f, 1f);
        var amber = new Color(1f, 0.78f, 0.28f);

        foreach (var t in root.GetComponentsInChildren<Transform>(true))
        {
            string n = t.name;
            if (n == "goggles_screen")
            {
                _goggles = t;
                var wall = gameObject.AddComponent<GogglesWall>();
                wall.feed = feed;
                wall.stream = FindFirstObjectByType<MempoolBlockStream>();
                wall.screen = t;
            }
            else if (n == "whitepaper_print")
            {
                // Guarded, because Wire() is one loop over every transform in
                // the building: anything thrown in here stops the rest of it,
                // and the block band is wired AFTER this. One decorative
                // plaque took the whole display wall down with it.
                try { Sharpen(t); Paper(t); }
                catch (System.Exception e)
                { Debug.LogWarning("[PostOffice] whitepaper: " + e.Message); }
            }
            else if (n == "genesis_block_print") Sharpen(t);
            else if (n == "unconf_count") _unconf = Plate(t, white);
            else if (n.StartsWith("fee_rate_") && !n.Contains("unit"))
                _feeRate.Add(Plate(t, white));
            else if (n.StartsWith("fee_usd_") && !n.Contains("unit"))
                _feeUsd.Add(Plate(t, green));
            else if (n.StartsWith("next_face_") && !n.Contains("plate"))
            {
                // Laid out exactly like a mined face: the number on top in its
                // own size, the detail underneath. It was only on the thin
                // caption strip above the block - 1.1 m of it against an 8.2 m
                // face - so the projected half of the band was numbered in
                // something you could not read from the road while the mined
                // half carried it large. Two halves of one display should not
                // describe the same thing in two different sizes.
                _nextHeight.Add(Plate(t, green, 0.46f, TextAnchor.LowerCenter,
                                      new Vector2(0f, 0.10f), "_height", 0.92f));
                _blockFace.Add(Plate(t, white, 0.30f, TextAnchor.UpperCenter,
                                     new Vector2(0f, -0.16f), "_text", 0.86f));
            }
            else if (n.StartsWith("mined_face_") && !n.Contains("plate"))
            {
                // Two texts on one face, not three lines in one.
                //
                // The height is what identifies a block and it was set at the
                // same size as its transaction count, so from the road the
                // whole row read as three interchangeable grey paragraphs. It
                // now takes the top half of the face on its own, in the amber
                // an explorer uses for a confirmed block, with the detail
                // underneath at a third of the size.
                _blockHeight.Add(Plate(t, amber, 0.46f, TextAnchor.LowerCenter,
                                       new Vector2(0f, 0.10f), "_height", 0.92f));
                _blockFace.Add(Plate(t, white, 0.30f, TextAnchor.UpperCenter,
                                     new Vector2(0f, -0.16f), "_text", 0.86f));
            }
            // The caption strip is left blank on purpose.
            //
            // The number is drawn large on the face of the block now, and the
            // strip sits over that same face in this model - so every block
            // carried its height twice, once readable and once as a small blue
            // smudge across the top of it.
        }
    }

    /// <summary>
    /// Put the building back on the ground after the ground has moved.
    ///
    /// It moves regularly: the terrain IS the fee histogram, and every poll
    /// that finds a different mempool rebuilds it at a different height. A
    /// building set down once at boot is correct for about twenty seconds and
    /// hanging in the air, or buried to the windows, for the rest of the
    /// session. MempoolTerrain.Version exists to be watched for exactly this.
    /// </summary>
    void Settle()
    {
        float ground = Ground();
        if (_up != null)
            _up.transform.position = new Vector3(postX, ground + ApronLift, 0f);
        if (_shell != null)
            _shell.position = new Vector3(postX, ground, 0f);
        BayPosition = BayFor(SoloBay);
    }

    void Update()
    {
        if (terrain != null && terrain.Version != _seenGround)
        {
            _seenGround = terrain.Version;
            Settle();
        }

        if (_up == null) return;

        // Fitted ONCE, and only when there is something to measure.
        //
        // Renderer.localBounds is empty on the frame TextMesh is written, so a
        // fit at wire time scales against nothing. The obvious repair - retry
        // every frame until it settles - is worse: localBounds comes back
        // already scaled, so each retry divides the room by an ever smaller
        // text and shrinks it again. Eight retries took the page to a fifth of
        // its plate and held it there, which is why the number would not move
        // however the fill or the line breaks were changed.
        // KEEP FITTING IT. `Fit` reads the drawn plate and the drawn text
        // every time and multiplies the scale by the ratio it is short or
        // over by, so the first pass with a real mesh lands on the target and
        // every pass after it is a no-op. There is nothing left to latch:
        // the plate that used to be swapped under this node is simply
        // measured again.
        //
        // What was here instead re-derived the room at fit time and wrote
        // METRES into `_room`, which now holds the fraction of the plate the
        // lettering is entitled to - so the paper was told its share was 11.5
        // and came out 107 m wide on a 12.2 m plate.
        if (_paper != null)
        {
            var pmr = _paper.GetComponent<MeshRenderer>();
            if (pmr != null && pmr.bounds.size.magnitude > 0.001f) Fit(_paper);
        }

        // The counter runs on its own clock. It is the one number on the
        // building that moves between one look and the next, and a mempool
        // counter that updates every other second reads as a photograph.
        if (Time.unscaledTime >= _nextCount)
        {
            _nextCount = Time.unscaledTime + 0.5f;
            Unconfirmed();
        }

        if (Time.unscaledTime < _nextData) return;
        _nextData = Time.unscaledTime + 2f;

        Fees();
        Blocks();
    }

    /// <summary>
    /// Four priority tiers, taken from the live fee profile.
    ///
    /// mempool.space shows no priority, low, medium and high; the profile is
    /// already a fee-rate distribution, so the tiers are just quantiles of it.
    /// </summary>
    void Fees()
    {
        if (_feeRate.Count < 4 || stats == null || !stats.HasFees) return;

        // Straight from the node. These were derived from the terrain's
        // normalised fee profile times a constant - numbers not so much wrong
        // as unrelated to anything, and it showed.
        int[] tier = { stats.FeeNone, stats.FeeLow, stats.FeeMedium, stats.FeeHigh };
        for (int i = 0; i < 4 && i < _feeRate.Count; i++)
        {
            float rate = tier[i];
            _feeRate[i].text = $"{tier[i]}";
            Fit(_feeRate[i]);

            if (i < _feeUsd.Count)
            {
                // a plain transaction is about 140 vB
                double usd = market != null && market.Price > 0
                    ? rate * 140.0 / 1e8 * market.Price : 0.0;
                _feeUsd[i].text = usd > 0 ? $"{usd:0.00} $" : "—";
                Fit(_feeUsd[i]);
            }
        }
    }

    void Unconfirmed()
    {
        if (_unconf == null) return;
        // The REAL count. It used to be the length of the freight list times
        // 1900 - a made-up number wearing a real one's clothes.
        int n = stats != null ? stats.Unconfirmed : 0;
        string was = _unconf.text;
        _unconf.text = n > 0 ? $"{n:N0}" : "—";
        if (_unconf.text != was) Fit(_unconf);
    }

    /// <summary>How long ago a block was found, the way an explorer says it.</summary>
    static string Ago(int minutes)
    {
        if (minutes < 1) return "just now";
        if (minutes == 1) return "1 minute ago";
        if (minutes < 60) return $"{minutes} minutes ago";
        int h = minutes / 60, m = minutes % 60;
        return m == 0 ? (h == 1 ? "1 hour ago" : $"{h} hours ago")
                      : $"{h}h {m}m ago";
    }

    /// <summary>
    /// The block row, as mempool.space arranges it.
    ///
    /// Left of the divider are PROJECTED blocks - what the mempool would pay
    /// if it were mined now: fees in BTC, how many transactions, roughly when.
    /// Right are blocks that exist: their height, transaction count, and how
    /// long ago. Two different things drawn as the same cube, which is exactly
    /// why each needs its own words - in English, like the explorer they are
    /// copied from, rather than half of one language and half of the other.
    /// </summary>
    void Blocks()
    {
        if (stats == null) return;

        int tip = stats.Recent.Count > 0 ? stats.Recent[0].height
                : (clock != null ? clock.Height : 0);

        for (int i = 0; i < _blockFace.Count; i++)
        {
            if (i < 5)
            {
                var up = i < stats.Upcoming.Count ? stats.Upcoming[i] : null;
                _blockFace[i].text = up == null ? "—"
                    : $"{up.totalFeeSats / 1e8:0.000} BTC\n{up.nTx:N0} tx\nin ~{up.inMinutes} min";
                if (i < _nextHeight.Count)
                {
                    _nextHeight[i].text = tip > 0 ? $"{tip + 1 + i:N0}" : "—";
                    Refit(_nextHeight[i]);
                }
            }
            else
            {
                int at = i - 5;
                var m = at < stats.Recent.Count ? stats.Recent[at] : null;
                // The height goes ON the block, large, in its own colour. It
                // was on the strip above it and nowhere else, which is a
                // caption rather than a label - and a mined block without its
                // number is not identifiable as anything.
                // The fee, as the projected half has always shown it. A block
                // was worth 0.009 BTC before it was mined and nothing at all
                // afterwards, which made the two halves of one band read as
                // two unrelated displays.
                _blockFace[i].text = m == null ? "—"
                    : $"{m.totalFeeSats / 1e8:0.000} BTC\n{m.nTx:N0} tx\n{Ago(m.AgeMinutes)}";
                if (at < _blockHeight.Count)
                {
                    _blockHeight[at].text = m == null ? "—" : $"{m.height:N0}";
                    Refit(_blockHeight[at]);
                }
            }
            Refit(_blockFace[i]);
        }

    }
}
