// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering.Universal;

/// <summary>
/// The freight on offer, shown as a panel of floating crates rather than as
/// objects standing in the world.
///
/// The first version laid them out on the ground beside the truck, which made
/// them part of the battlefield: they took terrain, light and perspective from
/// wherever the truck happened to stand. They live on their own layer now,
/// drawn by their own camera over the top of the game, so the selection reads
/// as a panel while the crates stay real 3D objects that can be turned and
/// tapped.
///
/// The panel occupies the upper part of the screen on purpose: the truck bed
/// stays visible underneath, so the load appearing on it is the answer to
/// "will this fit".
/// </summary>
public class PackageYard : MonoBehaviour
{
    /// <summary>Only the yard camera draws this layer.</summary>
    public const int YardLayer = 11;

    [Tooltip("Turn and bob the crates. OFF: twenty-one boxes each turning on " +
             "their own axis is a lot of motion to read a price list through, " +
             "and the panel is a chooser, not a display case. The spin and bob " +
             "values are still computed - they set each crate's resting angle " +
             "and the layout still reserves room for a turning silhouette, so " +
             "this can be switched back on without anything overlapping.")]
    public bool animateCrates = false;

    public MempoolFeed feed;
    public CargoBay bay;
    public Transform truck;
    public Material crateMaterial;

    [Header("Panel")]
    [Tooltip("Crates per row across the panel.")]
    public int perRow = 7;

    [Tooltip("How many stand on the ramp at once, biggest mover first. Two " +
             "rows of five: enough choice to fill the bed without waiting for " +
             "the conveyor, and still large enough to read the numbers under. " +
             "The rest wait their turn and come forward as freight is taken.")]
    public int show = 21;

    public float fieldOfView = 42f;

    [Tooltip("Distance from the yard camera to the crates.")]
    public float depth = 7f;

    [Header("Where the panel sits, as a fraction of the screen")]
    [Tooltip("Clear of the headline price, which takes the top fifth.")]
    public float panelTop = 0.10f;
    // Just above the middle. Three rows with captions need the height, but the
    // truck bed underneath has to stay in view - that is what the panel is for.
    public float panelBottom = 0.51f;
    public float panelInset = 0.03f;

    [Tooltip("Height of the title bar, as a fraction of the panel.")]
    public float titleBar = 0.13f;

    [Tooltip("How much of each cell is kept for the caption under the crate. " +
             "Reserving nothing put one row's numbers on the next row's box.")]
    public float captionFraction = 0.42f;

    /// <summary>Set when a pick was refused for want of room, for the HUD.</summary>
    public float RefusedAt { get; private set; } = -99f;

    class Yarded
    {
        public MempoolFeed.Tx tx;
        public GameObject crate;
        public Vector3 resting;         // where it floats, in the rig's space
        public float reach;          // half its diagonal, plus the bob
        public Vector3 axis;         // what it turns about
        public float spin, bob, phase, size;
        public Rect label;           // its caption's place in its cell, in GUI pixels
    }

    readonly List<Yarded> _yard = new List<Yarded>();

    /// <summary>Waiting their turn. Highest value first.</summary>
    readonly List<MempoolFeed.Tx> _reserve = new List<MempoolFeed.Tx>();
    Camera _cam;
    Transform _rig;
    GameObject _backdrop;
    bool _open;
    bool _stacked;
    Vector2Int _laidOutFor;
    string _showing = "";

    public bool IsOpen => _open;
    public Camera View => _cam;

    void Awake()
    {
        // Parked far under the world: it only ever draws its own layer, and
        // nothing else may wander into shot.
        var rig = new GameObject("YardRig");
        rig.transform.SetParent(transform, false);
        rig.transform.position = new Vector3(0f, -2000f, 0f);
        _rig = rig.transform;

        var camGo = new GameObject("YardCamera");
        camGo.transform.SetParent(_rig, false);
        _cam = camGo.AddComponent<Camera>();
        _cam.cullingMask = 1 << YardLayer;
        _cam.fieldOfView = fieldOfView;
        _cam.nearClipPlane = 0.1f;
        _cam.farClipPlane = 60f;
        _cam.depth = 50f;
        _cam.enabled = false;

        // URP does NOT composite two base cameras the way the built-in
        // pipeline does. clearFlags = Depth on a second base camera leaves the
        // colour buffer undefined and the game simply disappears behind the
        // panel - which is exactly what happened: the panel drew perfectly and
        // took the whole screen with it.
        var data = _cam.GetUniversalAdditionalCameraData();
        data.renderType = CameraRenderType.Overlay;    // clears depth, keeps colour

        _backdrop = GameObject.CreatePrimitive(PrimitiveType.Quad);
        _backdrop.name = "YardBackdrop";
        var col = _backdrop.GetComponent<Collider>();
        if (col != null) Destroy(col);
        _backdrop.transform.SetParent(_rig, false);
        SetLayer(_backdrop, YardLayer);
        _backdrop.SetActive(false);

        var mr = _backdrop.GetComponent<MeshRenderer>();
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        if (crateMaterial != null)
            mr.sharedMaterial = new Material(crateMaterial) { color = new Color(0.04f, 0.05f, 0.07f) };
    }

    /// <summary>
    /// Hang the panel camera off the game camera's stack.
    ///
    /// Deferred to Start: Bootstrap builds the chase camera and the yard in
    /// whatever order it happens to, and an overlay attached to a camera that
    /// does not exist yet is attached to nothing - silently.
    /// </summary>
    void Start() => Attach();

    void Attach()
    {
        if (_stacked || _cam == null) return;
        var chase = FindFirstObjectByType<ChaseCamera>();
        var baseCam = chase != null ? chase.GetComponent<Camera>() : Camera.main;
        if (baseCam == null) return;

        var data = baseCam.GetUniversalAdditionalCameraData();
        if (data == null) return;
        if (!data.cameraStack.Contains(_cam)) data.cameraStack.Add(_cam);
        _stacked = true;
    }

    /// <summary>The smallest cell a crate and its two caption lines read in, in css pixels.</summary>
    public const float MinCellCssW = 88f, MinCellCssH = 62f;

    /// <summary>
    /// THE GRID THE PANEL HOLDS (2026-10-16 on his phone: "The labels for the cargo items must be gleichmäßig
    /// and fit the dialog" - seven columns at 390 px gave each label 50 css px, and "FILLS 13%" with its BTC line overlapped its
    /// neighbours and ran out of the panel): as many columns as cells of MinCellCssW fit across, 3 to perRow, and as many rows as
    /// fit down, 2 to 4 - in css pixels, so a phone and a desktop read the same size.
    /// </summary>
    public (int cols, int rows) Grid(int w, int h)
    {
        var area = WorkArea(w, h);
        float css = Mathf.Max(1f, Arena.DailyLobby.UiScale());
        int cols = Mathf.Clamp(Mathf.FloorToInt(area.width / css / MinCellCssW), 3, Mathf.Max(3, perRow));
        int rows = Mathf.Clamp(Mathf.FloorToInt(area.height / css / MinCellCssH), 2, 4);
        return (cols, rows);
    }

    /// <summary>How many stand on the ramp at this screen: what the grid holds, at most <see cref="show"/>.</summary>
    public int ShowNow { get { var g = Grid(Screen.width, Screen.height); return Mathf.Min(show, g.cols * g.rows); } }

    /// <summary>The columns of the grid at this screen.</summary>
    public int Cols => Mathf.Min(Grid(Screen.width, Screen.height).cols, Mathf.Max(1, _yard.Count));

    /// <summary>
    /// THE ORDER ON THE RAMP (2026-10-16: "be more diverse but largest first"): the biggest parcel first -
    /// the bed share it buys - and among the same size the best paying.
    /// </summary>
    public static int RampOrder(MempoolFeed.Tx a, MempoolFeed.Tx b)
    {
        int bySize = CargoBay.RoomFor(b).CompareTo(CargoBay.RoomFor(a));
        return bySize != 0 ? bySize : b.feeSats.CompareTo(a.feeSats);
    }

    /// <summary>
    /// A DIVERSE CHOICE ("it must not be all of the same so no 9% 9% 9%"): the offers grouped by the room they take,
    /// each group best paying first, and taken one from each group in turn, the largest group first - so the ramp spreads over
    /// every size the mempool has before it repeats one. The whole list comes back in that turn order; the ramp takes the head.
    /// </summary>
    public static List<MempoolFeed.Tx> Diverse(IEnumerable<MempoolFeed.Tx> offers)
    {
        var groups = new SortedDictionary<float, List<MempoolFeed.Tx>>(Comparer<float>.Create((a, b) => b.CompareTo(a)));
        foreach (var tx in offers)
        {
            float room = CargoBay.RoomFor(tx);
            if (!groups.TryGetValue(room, out var g)) groups[room] = g = new List<MempoolFeed.Tx>();
            g.Add(tx);
        }
        foreach (var g in groups.Values) g.Sort((a, b) => b.feeSats.CompareTo(a.feeSats));
        var turn = new List<MempoolFeed.Tx>();
        for (int i = 0; ; i++)
        {
            bool any = false;
            foreach (var g in groups.Values) if (i < g.Count) { turn.Add(g[i]); any = true; }
            if (!any) break;
        }
        return turn;
    }

    public void Open(IEnumerable<MempoolFeed.Tx> offers)
    {
        Close();
        Attach();
        _open = true;
        _showing = Signature(offers);

        // A SPREAD OF SIZES, LARGEST FIRST (before: the best paying 21, almost all the small transactions that pay
        // the most per byte - "FILLS 9%" across the ramp). The fee still decides within a size.
        var sorted = Diverse(offers);
        int take = ShowNow;

        _reserve.Clear();
        if (sorted.Count > take)
        {
            _reserve.AddRange(sorted.GetRange(take, sorted.Count - take));
            sorted.RemoveRange(take, sorted.Count - take);
        }
        sorted.Sort(RampOrder);

        foreach (var tx in sorted) _yard.Add(Build(tx));
        Recolour();
        Layout();
        _cam.enabled = true;
        _backdrop.SetActive(true);
    }

    static void SetLayer(GameObject go, int layer)
    {
        go.layer = layer;
        foreach (Transform child in go.transform) SetLayer(child.gameObject, layer);
    }

    Yarded Build(MempoolFeed.Tx tx)
    {
        var go = bay.MakeCrate(tx);
        go.name = "YardPackage";
        go.transform.SetParent(_rig, false);

        // The WHOLE tree, not just the wrapper. With a cube those were the same
        // object; with the cardboard model the mesh hangs underneath, so
        // setting the layer on the wrapper alone left every box on the default
        // layer - which the panel camera does not draw and the game camera
        // excludes. The result was captions floating over an empty slate.
        SetLayer(go, YardLayer);

        // A collider here, unlike on the bed: these are what the pointer hits
        // - and it is deliberately larger than the crate it wraps. The crates
        // turn, so their silhouette shrinks and grows as they spin, and a hit
        // box exactly the size of the mesh means a tap that looked dead centre
        // can miss.
        go.AddComponent<BoxCollider>().size = Vector3.one * 1.5f;

        // Children, not the object itself: a model crate is a wrapper with the
        // mesh underneath it, and asking the wrapper for its MeshRenderer threw
        // the moment the cardboard model was wired up.
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            if (r.sharedMaterial != null) r.sharedMaterial.color = PanelColour(tx);
        }

        float size = CargoBay.CrateSize(tx);
        float t = Mathf.InverseLerp(0.45f, 1.4f, size);

        return new Yarded
        {
            tx = tx,
            crate = go,
            size = size,
            // A small package is light and spins quickly; a big one turns
            // slowly. The motion is the size, told a second way.
            spin = Mathf.Lerp(78f, 20f, t) * (Hash01(tx.txid + "s") < 0.5f ? -1f : 1f),
            axis = new Vector3(Hash01(tx.txid + "x") - 0.5f, 1f,
                               Hash01(tx.txid + "z") - 0.5f).normalized,
            // Small. A crate that rides up far enough to cross the title bar
            // reads as the panel being broken, and a turning box already
            // reaches past its own height at the corners.
            bob = Mathf.Lerp(0.05f, 0.02f, t),
            phase = Hash01(tx.txid + "p") * 6.283f,
        };
    }

    public void Close()
    {
        foreach (var y in _yard) if (y.crate != null) Destroy(y.crate);
        _yard.Clear();
        _reserve.Clear();
        _open = false;
        if (_cam != null) _cam.enabled = false;
        if (_backdrop != null) _backdrop.SetActive(false);
    }

    /// <summary>
    /// Every package gets its own colour, from its txid, so no two crates in
    /// the panel look alike. How bright it is still says what it pays, and a
    /// whale keeps its blue whatever that is.
    /// </summary>
    public static Color PanelColour(MempoolFeed.Tx tx, int index = 0, int total = 1)
    {
        if (tx.Whale) return new Color(0.42f, 0.80f, 1f);

        // Hue spread EVENLY over the panel rather than hashed from the txid.
        // With twenty-one crates on the ramp a hash collides - two packages
        // came out the same colour - and the colour is what tells them apart.
        float hue = total > 1 ? index / (float)total : Hash01(tx.txid);
        float pay = Mathf.Clamp01(tx.FeeRate / 45f);
        return Color.HSVToRGB(Mathf.Repeat(hue, 1f),
                              Mathf.Lerp(0.40f, 0.90f, pay), Mathf.Lerp(0.50f, 1f, pay));
    }

    /// <summary>Re-tint every crate for its place on the ramp.</summary>
    void Recolour()
    {
        for (int i = 0; i < _yard.Count; i++)
        {
            if (_yard[i].crate == null) continue;
            var colour = PanelColour(_yard[i].tx, i, _yard.Count);
            foreach (var r in _yard[i].crate.GetComponentsInChildren<Renderer>(true))
                if (r.sharedMaterial != null) r.sharedMaterial.color = colour;
        }
    }

    static float Hash01(string s)
    {
        unchecked
        {
            int h = 17;
            foreach (char c in s ?? "") h = h * 31 + c;
            return Mathf.Abs(h % 10007) / 10007f;
        }
    }

    /// <summary>
    /// Where the panel is on screen, in GUI pixels.
    ///
    /// ONE rectangle decides everything: the backdrop is sized to it, the
    /// crates are laid out inside it, and the frame and title are drawn round
    /// it. Deriving the two independently is what put the crates outside the
    /// slate they were supposed to be sitting on.
    /// </summary>
    public Rect PanelRect(int w, int h)
    {
        float x = w * panelInset;
        return new Rect(x, h * panelTop, w - x * 2f, h * (panelBottom - panelTop));
    }

    /// <summary>The working area: inside the frame, below the title.</summary>
    public Rect WorkArea(int w, int h)
    {
        var panel = PanelRect(w, h);
        float titleH = panel.height * titleBar;
        return new Rect(panel.x + panel.width * 0.02f, panel.y + titleH, panel.width * 0.96f, panel.height - titleH - panel.height * 0.04f);
    }

    /// <summary>The bar across the top of the panel, where the title goes.</summary>
    public Rect TitleRect(int w, int h)
    {
        var r = PanelRect(w, h);
        return new Rect(r.x, r.y, r.width, r.height * titleBar);
    }

    /// <summary>A point on screen, on the plane the crates sit on.</summary>
    Vector3 FromScreen(float px, float py, float atDepth)
    {
        float vh = 2f * atDepth * Mathf.Tan(_cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float vw = vh * Mathf.Max(0.5f, _cam.aspect);
        return new Vector3((px / Screen.width - 0.5f) * vw,
                           (0.5f - py / Screen.height) * vh,
                           atDepth);
    }

    /// <summary>
    /// Lay the crates out INSIDE the panel rectangle, under its title bar.
    /// </summary>
    void Layout()
    {
        if (_yard.Count == 0 || _cam == null) return;

        int sw = Screen.width, sh = Screen.height;
        var panel = PanelRect(sw, sh);
        var area = WorkArea(sw, sh);

        // THE GRID FOR THIS SCREEN: its columns, and every row the same height whether full or not
        int cols = Mathf.Min(Grid(sw, sh).cols, _yard.Count);
        int rows = Mathf.Max(Mathf.CeilToInt(_yard.Count / (float)cols), Mathf.Min(Grid(sw, sh).rows, Mathf.CeilToInt(ShowNow / (float)cols)));

        float cellW = area.width / cols;
        float cellH = area.height / rows;

        // Sized against the BIGGEST on the ramp, so the differences are real.
        float biggest = 0f;
        foreach (var y in _yard) biggest = Mathf.Max(biggest, y.size);

        // The cell in world units.
        var o = FromScreen(0f, 0f, depth);
        var e = FromScreen(cellW, cellH, depth);
        float cellWorldW = Mathf.Abs(e.x - o.x), cellWorldH = Mathf.Abs(e.y - o.y);

        // A cell holds a crate AND its caption. Reserving nothing for the
        // caption is what let one row's numbers land on the next row's box,
        // and what pushed the last row out through the bottom of the panel.
        float captionShare = Mathf.Clamp01(captionFraction);
        float crateBand = cellWorldH * (1f - captionShare);

        // A TURNING box reaches out to half its DIAGONAL, not half its height.
        // For the parcel shape below that is 0.90 of the base size, so the base
        // has to be small enough that twice the reach still fits the band.
        const float shapeX = 1.25f, shapeY = 0.80f, shapeZ = 1.0f;
        float reachPerUnit = 0.5f * Mathf.Sqrt(shapeX * shapeX + shapeY * shapeY + shapeZ * shapeZ);

        float areaTopWorld = FromScreen(0f, area.y, depth).y;

        for (int i = 0; i < _yard.Count; i++)
        {
            int row = i / cols, col = i % cols;
            int inRow = Mathf.Min(cols, _yard.Count - row * cols);

            float rel = Mathf.Clamp(biggest > 0f ? _yard[i].size / biggest : 1f, 0.45f, 1f);
            float room = Mathf.Min(cellWorldW * 0.78f / (shapeX * 1.15f),
                                   crateBand * 0.92f / (reachPerUnit * 2f)) * rel;

            var scale = new Vector3(room * shapeX, room * shapeY, room * shapeZ);
            _yard[i].crate.transform.localScale = scale;

            float reach = room * reachPerUnit + _yard[i].bob;
            _yard[i].reach = reach;

            float px = area.x + area.width * 0.5f
                     + (col - (inRow - 1) * 0.5f) * cellW;
            float rowTop = areaTopWorld - row * cellWorldH;
            float wy = rowTop - reach - cellWorldH * 0.04f;

            // THE CAPTION'S PLACE: the bottom of its own cell, the cell's width - one baseline a row, never past the next cell
            float cellTop = area.y + row * cellH;
            _yard[i].label = new Rect(px - cellW * 0.48f, cellTop + cellH * (1f - captionShare), cellW * 0.96f, cellH * captionShare);

            var resting = FromScreen(px, 0f, depth);
            _yard[i].resting = new Vector3(resting.x, wy, depth);
            _yard[i].crate.transform.localPosition = _yard[i].resting;

            // A resting angle, set once, when the crates do not turn.
            //
            // Static must not mean twenty-one identical boxes squared up to
            // the camera - that reads as a spreadsheet, not a cargo yard. The
            // angle comes off the txid, so it is stable across a reopen: a
            // crate that jumped to a new pose every time the panel opened
            // would be its own kind of flicker.
            if (!animateCrates)
                _yard[i].crate.transform.localRotation =
                    Quaternion.AngleAxis(Hash01(_yard[i].tx.txid + "r") * 360f, _yard[i].axis);
        }

        // The slate, sized to the panel rectangle exactly. It used to be
        // positioned from its own numbers, which is why the crates ended up
        // floating outside it.
        var tl = FromScreen(panel.x, panel.y, depth + 3.2f);
        var br = FromScreen(panel.xMax, panel.yMax, depth + 3.2f);
        _backdrop.transform.localPosition =
            new Vector3((tl.x + br.x) * 0.5f, (tl.y + br.y) * 0.5f, depth + 3.2f);
        _backdrop.transform.localScale =
            new Vector3(Mathf.Abs(br.x - tl.x), Mathf.Abs(br.y - tl.y), 1f);
    }

    /// <summary>A crate as the HUD needs it: what it is and where it is drawn.</summary>
    public struct Caption
    {
        public MempoolFeed.Tx tx;
        public Vector2 screen;      // centre of the crate, in screen pixels
        public float radius;        // roughly half its drawn size, in pixels
        public bool loaded;
        public Rect label;          // where its words go: the bottom of its own cell, the cell's width
    }

    /// <summary>
    /// Where to write the numbers. The crates say size by their size and value
    /// by their colour, but "300 vB at 12 sat/vB" is not a thing a cube can
    /// say, and picking freight blind is not a choice.
    /// </summary>
    public List<Caption> Captions()
    {
        var list = new List<Caption>();
        if (_cam == null) return list;

        foreach (var y in _yard)
        {
            if (y.crate == null || !y.crate.activeSelf) continue;
            bool loaded = bay != null && bay.Contains(y.tx.txid);
            var p = _cam.WorldToScreenPoint(y.crate.transform.position);
            if (p.z <= 0f) continue;

            // The reach, not half the height: a turning box sticks out further
            // than it is tall, and a caption placed off its height slid under
            // the crate it belonged to.
            var edge = _cam.WorldToScreenPoint(
                y.crate.transform.position + _cam.transform.up * y.reach);

            list.Add(new Caption
            {
                tx = y.tx,
                // GUI counts down from the top, the camera counts up
                screen = new Vector2(p.x, Screen.height - p.y),
                radius = Mathf.Abs(edge.y - p.y),
                loaded = loaded,
                label = y.label,
            });
        }
        return list;
    }

    /// <summary>
    /// Lay the panel out again. Public so a test can check the layout at a
    /// browser's aspect ratio rather than only at the one the test runner
    /// happens to use - the crates are limited by cell WIDTH in a narrow
    /// window and by cell HEIGHT in a wide one, so a check that only ever saw
    /// 4:3 could pass while a widescreen browser overlapped.
    /// </summary>
    public void Relayout() => Layout();

    /// <summary>Pick up or put back. False when there was no room.</summary>
    public bool Toggle(MempoolFeed.Tx tx)
    {
        if (bay.Contains(tx.txid))
        {
            bay.Remove(tx.txid);
            Return(tx);
            Sound(false);
            return true;
        }
        if (!bay.TryAdd(tx))
        {
            RefusedAt = Time.unscaledTime;
            return false;
        }
        Take(tx);
        Sound(true);
        return true;
    }

    GameAudio _audio;

    void Sound(bool taken)
    {
        if (_audio == null) _audio = FindFirstObjectByType<GameAudio>();
        if (_audio != null) _audio.Pickup(taken);
    }

    /// <summary>Take a crate off the ramp because it is on the bed now.</summary>
    public void Hide(MempoolFeed.Tx tx) => Take(tx);

    /// <summary>
    /// Off the ramp, and the next one forward.
    ///
    /// The ramp used to hold exactly what was first offered, so loading all of
    /// it left an empty panel and a bed two thirds full, with no way to finish
    /// the job. It is a conveyor now: what is taken is replaced by the best
    /// thing still waiting.
    /// </summary>
    void Take(MempoolFeed.Tx tx)
    {
        for (int i = 0; i < _yard.Count; i++)
        {
            if (_yard[i].tx.txid != tx.txid) continue;
            if (_yard[i].crate != null) Destroy(_yard[i].crate);
            _yard.RemoveAt(i);
            break;
        }
        Refill();
    }

    /// <summary>Put one back on the ramp, making room if it is full.</summary>
    void Return(MempoolFeed.Tx tx)
    {
        if (_yard.Count >= ShowNow)
        {
            // the least valuable one on the ramp steps back into the queue
            int worst = 0;
            for (int i = 1; i < _yard.Count; i++)
                if (_yard[i].tx.feeSats < _yard[worst].tx.feeSats) worst = i;
            _reserve.Insert(0, _yard[worst].tx);
            if (_yard[worst].crate != null) Destroy(_yard[worst].crate);
            _yard.RemoveAt(worst);
        }
        _yard.Add(Build(tx));
        Sort();
        Recolour();
        Layout();
    }

    void Refill()
    {
        while (_yard.Count < ShowNow && _reserve.Count > 0)
        {
            var next = _reserve[0];
            _reserve.RemoveAt(0);
            if (bay != null && bay.Contains(next.txid)) continue;
            _yard.Add(Build(next));
        }
        Sort();
        Recolour();
        Layout();
    }

    /// <summary>
    /// Keep at least one thing on the ramp that will still go on the bed.
    ///
    /// The conveyor only moved when something was taken, so once the bed was
    /// down to its last stretch and the five on the ramp were all too big,
    /// nothing came forward and the load stopped two thirds full with a queue
    /// of small packages behind it that would have fitted.
    /// </summary>
    void KeepSomethingThatFits()
    {
        if (bay == null || _yard.Count == 0 || _reserve.Count == 0) return;

        foreach (var y in _yard)
            if (!bay.Contains(y.tx.txid) && bay.Fits(y.tx)) return;   // fine as it is

        // best thing in the queue that does fit
        int pick = -1;
        for (int i = 0; i < _reserve.Count; i++)
            if (bay.Fits(_reserve[i])) { pick = i; break; }
        if (pick < 0) return;                       // nothing anywhere fits; that is the end

        // the biggest thing on the ramp goes to the back of the queue for it
        int biggest = 0;
        for (int i = 1; i < _yard.Count; i++)
            if (_yard[i].size > _yard[biggest].size) biggest = i;

        var wanted = _reserve[pick];
        _reserve.RemoveAt(pick);
        _reserve.Add(_yard[biggest].tx);
        if (_yard[biggest].crate != null) Destroy(_yard[biggest].crate);
        _yard.RemoveAt(biggest);

        _yard.Add(Build(wanted));
        Sort();
        Recolour();
        Layout();
    }

    /// <summary>Largest first, the best paying within a size (RampOrder), so the ramp always reads the same way.</summary>
    void Sort() => _yard.Sort((a, b) => RampOrder(a.tx, b.tx));

    public List<MempoolFeed.Tx> Remaining()
    {
        var list = new List<MempoolFeed.Tx>();
        foreach (var y in _yard) if (!bay.Contains(y.tx.txid)) list.Add(y.tx);
        return list;
    }

    static string Signature(IEnumerable<MempoolFeed.Tx> offers)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var t in offers) sb.Append(t.txid).Append(',');
        return sb.ToString();
    }

    /// <summary>The crate the pointer is resting on, or null.</summary>
    public MempoolFeed.Tx Hovered { get; private set; }

    void Update()
    {
        if (!_open) return;

        // The bay opens the moment the truck spawns, which is before the first
        // mempool fetch has landed - so the panel was built from an empty list
        // and stayed empty, with nothing to pick and no way to leave. Rebuild
        // when the offers change, but never once something has been loaded:
        // that would take the panel away from under the player.
        if (feed != null && bay != null && bay.Count == 0)
        {
            string now = Signature(feed.Offers);
            if (now != _showing) { Open(feed.Offers); return; }
        }

        KeepSomethingThatFits();

        // the panel is laid out in screen space, so a resized window has to
        // rebuild it - in a browser that happens whenever the tab is resized
        if (_laidOutFor.x != Screen.width || _laidOutFor.y != Screen.height)
        {
            _laidOutFor = new Vector2Int(Screen.width, Screen.height);
            Layout();
        }

        Spin();

        Hovered = PickAt(PointerPosition());

        if (Pressed(out var at))
        {
            var tx = PickAt(at);
            if (tx != null) Toggle(tx);
        }
    }

    /// <summary>
    /// Unscaled: the panel keeps turning at the same rate whatever the game is
    /// doing, and the death sequence puts the world in slow motion.
    /// </summary>
    void Spin()
    {
        if (!animateCrates) return;

        float t = Time.unscaledTime;
        foreach (var y in _yard)
        {
            if (y.crate == null || !y.crate.activeSelf) continue;
            y.crate.transform.Rotate(y.axis, y.spin * Time.unscaledDeltaTime, Space.Self);
            y.crate.transform.localPosition =
                y.resting + Vector3.up * (Mathf.Sin(t * 1.6f + y.phase) * y.bob);
        }
    }

    /// <summary>
    /// Which crate a tap at this screen point means, or null.
    ///
    /// A ray first, then the nearest crate on screen as a fallback. A turning
    /// cube presents a different silhouette every frame, so a ray that goes
    /// exactly where the player pointed can still slip past a corner - and a
    /// tap that does nothing reads as broken. Public so a test can press
    /// where a crate is drawn and check the right one is picked up, which is
    /// the thing that was reported as not working.
    /// </summary>
    public MempoolFeed.Tx PickAt(Vector2 screen)
    {
        if (_cam == null) return null;

        var ray = _cam.ScreenPointToRay(screen);
        if (Physics.Raycast(ray, out var hit, 60f, 1 << YardLayer))
            foreach (var y in _yard)
                if (y.crate != null && y.crate.activeSelf &&
                    hit.collider != null && hit.collider.gameObject == y.crate)
                    return y.tx;

        // nearest crate whose drawn footprint the tap is within
        MempoolFeed.Tx best = null;
        float bestD = float.MaxValue;
        foreach (var c in Captions())
        {
            float d = Vector2.Distance(c.screen, new Vector2(screen.x, Screen.height - screen.y));
            if (d < c.radius * 1.35f && d < bestD) { bestD = d; best = c.tx; }
        }
        return best;
    }

    static Vector2 PointerPosition()
    {
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (touch != null && touch.primaryTouch.press.isPressed)
            return touch.primaryTouch.position.ReadValue();
        var mouse = UnityEngine.InputSystem.Mouse.current;
        return mouse != null ? mouse.position.ReadValue() : new Vector2(-999f, -999f);
    }

    /// <summary>A click or a tap that went DOWN this frame.</summary>
    static bool Pressed(out Vector2 at)
    {
        at = Vector2.zero;
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (touch != null && touch.primaryTouch.press.wasPressedThisFrame)
        {
            at = touch.primaryTouch.position.ReadValue();
            return true;
        }
        var mouse = UnityEngine.InputSystem.Mouse.current;
        if (mouse != null && mouse.leftButton.wasPressedThisFrame)
        {
            at = mouse.position.ReadValue();
            return true;
        }
        return false;
    }
}
