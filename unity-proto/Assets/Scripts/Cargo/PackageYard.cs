using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The sorting yard beside the ramp: the waiting transactions as real crates
/// on the ground, picked up by clicking or tapping them.
///
/// A list in a popup told the player nothing about what they were loading. As
/// crates the size is the transaction's size and the colour is what it pays,
/// so the choice is visible before it is made - and the load appears on the
/// bed as it is picked, so "will this fit" is answered by looking at the
/// truck rather than by reading a number.
/// </summary>
public class PackageYard : MonoBehaviour
{
    public MempoolFeed feed;
    public CargoBay bay;
    public Transform truck;
    public MempoolTerrain terrain;
    public RoadNetwork roads;
    public Material crateMaterial;
    public Camera view;

    [Tooltip("Crates per row across the truck's nose.")]
    public int perRow = 5;
    public float spacing = 2.9f;

    [Tooltip("How far in front of the truck the first row stands.")]
    public float standoff = 9f;

    [Tooltip("Yard crates are drawn larger than they ride, so they can be " +
             "seen and tapped from the chase camera.")]
    public float yardScale = 1.9f;

    /// <summary>The crate the pointer is over, for the highlight.</summary>
    public MempoolFeed.Tx Hovered { get; private set; }

    /// <summary>Set when a pick was refused for want of room, for the HUD.</summary>
    public float RefusedAt { get; private set; } = -99f;

    class Yarded
    {
        public MempoolFeed.Tx tx;
        public GameObject crate;
        public Vector3 home;
    }

    readonly List<Yarded> _yard = new List<Yarded>();
    bool _open;
    string _showing = "";

    public bool IsOpen => _open;

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
            go.transform.SetParent(transform, false);

            // a collider here, unlike on the bed: these are what the pointer hits
            var box = go.AddComponent<BoxCollider>();
            box.size = Vector3.one;

            float size = CargoBay.CrateSize(tx) * yardScale;
            go.transform.localScale = Vector3.one * size;

            var at = Spot(i, size);
            go.transform.position = at;
            _yard.Add(new Yarded { tx = tx, crate = go, home = at });
            i++;
        }
    }

    public void Close()
    {
        foreach (var y in _yard) if (y.crate != null) Destroy(y.crate);
        _yard.Clear();
        _open = false;
        Hovered = null;
    }

    /// <summary>
    /// Laid out IN FRONT of the truck, across its nose.
    ///
    /// The first version put the yard behind and to one side in world axes.
    /// The crates were built, lit and active - and every one of them was
    /// behind the chase camera, so the yard looked empty.
    /// </summary>
    Vector3 Spot(int i, float size)
    {
        if (truck == null) return Vector3.zero;

        int row = i / perRow, col = i % perRow;
        float ahead = standoff + row * spacing;
        float across = (col - (perRow - 1) * 0.5f) * spacing;

        var p = truck.position + truck.forward * ahead + truck.right * across;
        float ground = roads != null ? roads.SurfaceHeight(p.x, p.z)
                     : terrain != null ? terrain.SampleSurface(p.x, p.z) : 0f;
        return new Vector3(p.x, ground + size * 0.5f, p.z);
    }

    /// <summary>Pick up or put back. Returns false when there was no room.</summary>
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
        Show(tx, false);          // it is on the bed now, so it leaves the yard
        return true;
    }

    /// <summary>Take a crate out of the yard because it is on the bed now.</summary>
    public void Hide(MempoolFeed.Tx tx) => Show(tx, false);

    void Show(MempoolFeed.Tx tx, bool visible)
    {
        foreach (var y in _yard)
            if (y.tx.txid == tx.txid && y.crate != null) y.crate.SetActive(visible);
    }

    /// <summary>Everything still standing in the yard.</summary>
    public List<MempoolFeed.Tx> Remaining()
    {
        var list = new List<MempoolFeed.Tx>();
        foreach (var y in _yard) if (!bay.Contains(y.tx.txid)) list.Add(y.tx);
        return list;
    }

    /// <summary>
    /// Identity of a set of offers, so a changed mempool can be noticed.
    /// </summary>
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
        // mempool fetch has landed - so the yard was built from an empty list
        // and stayed empty, with nothing to pick and no way to leave. Rebuild
        // when the offers change, but never while the player has already
        // loaded something: that would yank the yard out from under them.
        if (feed != null && bay != null && bay.Count == 0)
        {
            string now = Signature(feed.Offers);
            if (now != _showing) Open(feed.Offers);
        }

        if (view == null) view = Camera.main;
        if (view == null) return;

        // The yard sits on the ground and does not move, but the terrain under
        // it is rebuilt from live mempool data, so the crates have to be
        // re-seated or they end up buried - the same thing wrecks and tanks
        // needed.
        foreach (var y in _yard)
        {
            if (y.crate == null || !y.crate.activeSelf) continue;
            var p = y.crate.transform.position;
            float size = y.crate.transform.localScale.y;
            float g = roads != null ? roads.SurfaceHeight(p.x, p.z)
                    : terrain != null ? terrain.SampleSurface(p.x, p.z) : 0f;
            y.crate.transform.position = new Vector3(p.x, g + size * 0.5f, p.z);
        }

        Hovered = Pick(PointerPosition(), out _);
        if (Pressed(out var at))
        {
            var tx = Pick(at, out _);
            if (tx != null) Toggle(tx);
        }
    }

    MempoolFeed.Tx Pick(Vector2 screen, out RaycastHit hit)
    {
        hit = default;
        var ray = view.ScreenPointToRay(screen);
        if (!Physics.Raycast(ray, out hit, 400f)) return null;
        foreach (var y in _yard)
            if (y.crate != null && hit.collider != null && hit.collider.gameObject == y.crate)
                return y.tx;
        return null;
    }

    static Vector2 PointerPosition()
    {
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (touch != null && touch.primaryTouch.press.isPressed)
            return touch.primaryTouch.position.ReadValue();
        var mouse = UnityEngine.InputSystem.Mouse.current;
        return mouse != null ? mouse.position.ReadValue() : Vector2.zero;
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
