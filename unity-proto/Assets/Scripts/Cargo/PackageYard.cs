using System.Collections.Generic;
using UnityEngine;

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

    public MempoolFeed feed;
    public CargoBay bay;
    public Transform truck;
    public Material crateMaterial;

    [Header("Panel")]
    public int perRow = 5;
    public float fieldOfView = 42f;

    [Tooltip("How far down the panel sits, as a fraction of its height. " +
             "Positive lifts it, leaving the truck bed in view below.")]
    public float lift = 0.28f;

    [Tooltip("Distance from the yard camera to the crates.")]
    public float depth = 7f;

    /// <summary>Set when a pick was refused for want of room, for the HUD.</summary>
    public float RefusedAt { get; private set; } = -99f;

    class Yarded
    {
        public MempoolFeed.Tx tx;
        public GameObject crate;
        public Vector3 seat;         // where it floats, in the rig's space
        public Vector3 axis;         // what it turns about
        public float spin, bob, phase, size;
    }

    readonly List<Yarded> _yard = new List<Yarded>();
    Camera _cam;
    Transform _rig;
    GameObject _backdrop;
    bool _open;
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
        _cam.clearFlags = CameraClearFlags.Depth;      // the game stays behind it
        _cam.cullingMask = 1 << YardLayer;
        _cam.fieldOfView = fieldOfView;
        _cam.nearClipPlane = 0.1f;
        _cam.farClipPlane = 60f;
        _cam.depth = 50f;                              // on top of the chase camera
        _cam.enabled = false;

        _backdrop = GameObject.CreatePrimitive(PrimitiveType.Quad);
        _backdrop.name = "YardBackdrop";
        var col = _backdrop.GetComponent<Collider>();
        if (col != null) Destroy(col);
        _backdrop.transform.SetParent(_rig, false);
        _backdrop.layer = YardLayer;
        _backdrop.SetActive(false);

        var mr = _backdrop.GetComponent<MeshRenderer>();
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        mr.receiveShadows = false;
        if (crateMaterial != null)
            mr.sharedMaterial = new Material(crateMaterial) { color = new Color(0.04f, 0.05f, 0.07f) };
    }

    public void Open(IEnumerable<MempoolFeed.Tx> offers)
    {
        Close();
        _open = true;
        _showing = Signature(offers);

        int i = 0;
        foreach (var tx in offers)
        {
            var go = bay.MakeCrate(tx);
            go.name = "YardPackage";
            go.transform.SetParent(_rig, false);
            go.layer = YardLayer;

            // a collider here, unlike on the bed: these are what the pointer hits
            go.AddComponent<BoxCollider>().size = Vector3.one;

            var mr = go.GetComponent<MeshRenderer>();
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            if (mr.sharedMaterial != null)
                mr.sharedMaterial.color = PanelColour(tx);

            float size = CargoBay.CrateSize(tx);
            float t = Mathf.InverseLerp(0.45f, 1.4f, size);

            _yard.Add(new Yarded
            {
                tx = tx,
                crate = go,
                size = size,
                // A small package is light and spins quickly; a big one turns
                // slowly. The motion is the size, told a second way.
                spin = Mathf.Lerp(78f, 20f, t) * (Hash01(tx.txid + "s") < 0.5f ? -1f : 1f),
                axis = new Vector3(Hash01(tx.txid + "x") - 0.5f,
                                   1f,
                                   Hash01(tx.txid + "z") - 0.5f).normalized,
                bob = Mathf.Lerp(0.13f, 0.05f, t),
                phase = Hash01(tx.txid + "p") * 6.283f,
            });
            i++;
        }
        Layout();
        _cam.enabled = true;
        _backdrop.SetActive(true);
    }

    public void Close()
    {
        foreach (var y in _yard) if (y.crate != null) Destroy(y.crate);
        _yard.Clear();
        _open = false;
        if (_cam != null) _cam.enabled = false;
        if (_backdrop != null) _backdrop.SetActive(false);
    }

    /// <summary>
    /// Every package gets its own colour, from its txid, so no two crates in
    /// the panel look alike. How bright it is still says what it pays, and a
    /// whale keeps its blue whatever that is.
    /// </summary>
    public static Color PanelColour(MempoolFeed.Tx tx)
    {
        if (tx.Whale) return new Color(0.42f, 0.80f, 1f);
        float hue = Hash01(tx.txid);
        float pay = Mathf.Clamp01(tx.FeeRate / 45f);
        return Color.HSVToRGB(hue, Mathf.Lerp(0.35f, 0.85f, pay), Mathf.Lerp(0.45f, 1f, pay));
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

    /// <summary>Spread the crates over the panel, in the rig's own space.</summary>
    void Layout()
    {
        if (_yard.Count == 0) return;

        float h = 2f * depth * Mathf.Tan(_cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float w = h * Mathf.Max(0.5f, _cam.aspect);

        int cols = Mathf.Min(perRow, _yard.Count);
        int rows = Mathf.CeilToInt(_yard.Count / (float)cols);

        float cw = w * 0.82f / cols;
        float ch = h * 0.42f / Mathf.Max(1, rows);
        float top = h * lift;

        for (int i = 0; i < _yard.Count; i++)
        {
            int row = i / cols, col = i % cols;
            int inRow = Mathf.Min(cols, _yard.Count - row * cols);
            float x = (col - (inRow - 1) * 0.5f) * cw;
            float y = top - row * ch;
            _yard[i].seat = new Vector3(x, y, depth);
            _yard[i].crate.transform.localPosition = _yard[i].seat;
            _yard[i].crate.transform.localScale = Vector3.one * Mathf.Min(_yard[i].size, cw * 0.62f);
        }

        // the panel behind them, covering the grid with a margin
        _backdrop.transform.localPosition = new Vector3(0f, top - (rows - 1) * ch * 0.5f, depth + 3.2f);
        _backdrop.transform.localScale = new Vector3(w * 0.95f, ch * rows + h * 0.30f, 1f);
    }

    /// <summary>Pick up or put back. False when there was no room.</summary>
    public bool Toggle(MempoolFeed.Tx tx)
    {
        if (bay.Contains(tx.txid))
        {
            bay.Remove(tx.txid);
            Show(tx, true);
            return true;
        }
        if (!bay.TryAdd(tx))
        {
            RefusedAt = Time.unscaledTime;
            return false;
        }
        Show(tx, false);          // it is on the bed now, so it leaves the panel
        return true;
    }

    /// <summary>Take a crate out of the panel because it is on the bed now.</summary>
    public void Hide(MempoolFeed.Tx tx) => Show(tx, false);

    void Show(MempoolFeed.Tx tx, bool visible)
    {
        foreach (var y in _yard)
            if (y.tx.txid == tx.txid && y.crate != null) y.crate.SetActive(visible);
    }

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

        Spin();

        if (Pressed(out var at))
        {
            var tx = Pick(at);
            if (tx != null) Toggle(tx);
        }
    }

    /// <summary>
    /// Unscaled: the panel keeps turning at the same rate whatever the game is
    /// doing, and the death sequence puts the world in slow motion.
    /// </summary>
    void Spin()
    {
        float t = Time.unscaledTime;
        foreach (var y in _yard)
        {
            if (y.crate == null || !y.crate.activeSelf) continue;
            y.crate.transform.Rotate(y.axis, y.spin * Time.unscaledDeltaTime, Space.Self);
            y.crate.transform.localPosition =
                y.seat + Vector3.up * (Mathf.Sin(t * 1.6f + y.phase) * y.bob);
        }
    }

    MempoolFeed.Tx Pick(Vector2 screen)
    {
        if (_cam == null) return null;
        var ray = _cam.ScreenPointToRay(screen);
        if (!Physics.Raycast(ray, out var hit, 60f, 1 << YardLayer)) return null;
        foreach (var y in _yard)
            if (y.crate != null && hit.collider != null && hit.collider.gameObject == y.crate)
                return y.tx;
        return null;
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
