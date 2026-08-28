using System.Collections;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.ResourceManagement.AsyncOperations;

/// <summary>
/// Fetches the detailed models after the game is already running, and swaps
/// them in as each arrives.
///
/// The whole point is that nobody waits for them: the scene starts on the box
/// proxies it has always had as a fallback, and upgrades in place. That only
/// works because every model reference in this project was already optional -
/// had they been required, this would be a rewrite rather than a loader.
/// </summary>
public class ModelStreamer : MonoBehaviour
{
    public Bootstrap bootstrap;
    public ArmyRenderer army;
    public CombatFx fx;

    /// <summary>Addresses, matching SetupAddressables. Kept as constants on both sides.</summary>
    public const string SoldierKey = "model/soldier";
    public const string TankKey = "model/tank";
    public const string TruckKey = "model/truck";

    public int Loaded { get; private set; }
    public int Failed { get; private set; }
    /// <summary>What the HUD can show while the field is still made of boxes.</summary>
    public string Status { get; private set; } = "Modelle werden geladen …";

    void Start() => StartCoroutine(Stream());

    IEnumerator Stream()
    {
        // Deliberately sequential. Three bundles at once on a phone connection
        // means all three arrive late; one at a time means the field starts
        // improving almost immediately.
        yield return Fetch(SoldierKey, go =>
        {
            if (army != null) army.SetSoldierPrefab(go);
            if (fx != null) fx.bodyPrefab = go;
        });
        yield return Fetch(TankKey, go =>
        {
            if (army != null) army.SetTankPrefab(go);
            if (fx != null) fx.wreckPrefab = go;
        });
        yield return Fetch(TruckKey, go =>
        {
            if (bootstrap != null) bootstrap.SwapTruckModel(go);
        });

        Status = Failed == 0 ? null : $"{Failed} Modell(e) nicht geladen - Platzhalter bleiben";
    }

    IEnumerator Fetch(string key, System.Action<GameObject> apply)
    {
        var handle = Addressables.LoadAssetAsync<GameObject>(key);
        yield return handle;

        if (handle.Status == AsyncOperationStatus.Succeeded && handle.Result != null)
        {
            apply(handle.Result);
            Loaded++;
            Debug.Log($"[ModelStreamer] {key} in place");
        }
        else
        {
            // Not fatal, by design: a missing bundle leaves the proxy standing
            // rather than leaving a hole where a soldier should be.
            Failed++;
            Debug.LogWarning($"[ModelStreamer] {key} failed: {handle.OperationException?.Message}");
        }
        Status = $"Modelle: {Loaded} geladen";
    }
}
