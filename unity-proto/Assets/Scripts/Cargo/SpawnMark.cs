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

    [Tooltip("How far from the old mark the truck may be and still be " +
             "considered parked. Beyond this it is out on the run, and moving " +
             "it would be worse than leaving it on the wrong height.")]
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

        // Only re-seat a truck that has not left yet. A rebuild during a run
        // is common - the ground moves under a driving truck and it drives on
        // - and teleporting the player back to the bay for it would be a far
        // worse bug than the one this fixes.
        bool parked = truck.controlsLocked
                   || (loadout != null && loadout.IsOpen)
                   || Vector3.Distance(truck.transform.position, was) < parkedWithin;
        if (parked) truck.Respawn();
    }
}
