using UnityEngine;

/// <summary>
/// Keeps the truck's start mark on the ground the ground actually is.
///
/// The scene is assembled in one pass at boot, and at that moment the terrain
/// is still the flat stand-in it builds from before the first fee histogram
/// lands - 2.7 m up. The truck was parked against that, its start mark taken
/// from where it stood, and seconds later the real mempool arrived and raised
/// the ground under it to 9 m. From then on the truck was five metres inside
/// the hill: it fell through the collider, sank, and every respawn put it back
/// under the map - which is why it appeared to be parked beneath its own
/// loading dock while the post office stood correctly on top of it.
///
/// So the mark is not a position taken once. It is a question asked of the
/// building, re-asked whenever MempoolTerrain says the ground has been rebuilt,
/// which is the same watch the roads and the two megastructures keep.
/// </summary>
public class SpawnMark : MonoBehaviour
{
    public MempoolTerrain terrain;
    public PostOffice post;
    public TruckController truck;
    public LoadoutPanel loadout;

    [Tooltip("How far from the old mark the truck may be and still count as " +
             "standing in its bay.")]
    public float parkedWithin = 12f;

    int _seen = -1;

    void LateUpdate()
    {
        if (terrain == null || truck == null || post == null || !post.HasBay) return;
        if (terrain.Version == _seen) return;
        _seen = terrain.Version;

        var was = truck.spawnPosition;
        var mark = post.BayFor(PostOffice.SoloBay);
        truck.spawnPosition = mark;

        // Only set down again a truck that has not been let go yet.
        //
        // Being NEAR the bay is not enough, and assuming it was cost three
        // driving tests: the terrain is rebuilt on every mempool poll, so a
        // truck that had just pulled off the apron was picked up and put back
        // in its bay every twenty seconds. Whether the player has been
        // released is a fact the loading bay already knows - so ask it, and
        // leave a truck that is under way alone with a stale mark until it
        // comes back.
        bool held = truck.controlsLocked || (loadout != null && loadout.IsOpen);
        bool parked = held && Vector3.Distance(truck.transform.position, was) < parkedWithin;

        // WHAT THIS DECIDED, AND ON WHICH DISTANCE (the owner 2026-09-16 08:17).
        //
        // `parked` is a THREE-dimensional distance against a mark whose height moves with the ground.
        // The core's own rule is two-dimensional - `BlwpCore.Teleport` takes x and z and drops y,
        // because the core recomputes height from its own surface. So on the rebuild this component
        // exists for, where the stand-in terrain at 2.7 m is replaced by real relief at 9 m, the
        // vertical change alone spends 6.3 m of the 12 m budget without the truck having moved an inch
        // across the ground. Both distances are printed side by side so the difference is a measured
        // number rather than an argument, and nothing here changes which one is used.
        var at = truck.transform.position;
        float d3 = Vector3.Distance(at, was);
        float d2 = Vector2.Distance(new Vector2(at.x, at.z), new Vector2(was.x, was.z));
        Debug.Log($"[spawnmark] terrain v{terrain.Version}: mark {was.x:F2},{was.y:F2},{was.z:F2} "
                  + $"-> {mark.x:F2},{mark.y:F2},{mark.z:F2}; truck at {at.x:F2},{at.y:F2},{at.z:F2}; "
                  + $"2-D {d2:F2} m, 3-D {d3:F2} m, of {parkedWithin:F1} m; held {held}, parked {parked}, "
                  + $"externallyDriven {truck.externallyDriven}");

        if (parked) truck.Respawn();
    }
}
