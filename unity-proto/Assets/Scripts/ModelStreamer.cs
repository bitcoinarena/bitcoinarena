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
    public const string HelicopterKey = "model/helicopter";

    public int Loaded { get; private set; }
    public int Failed { get; private set; }
    /// <summary>What the HUD can show while the field is still made of boxes.</summary>
    public string Status { get; private set; } = "Modelle werden geladen …";

    void Awake() => RouteBundlesToThisHost();

    /// <summary>
    /// Turn the relative bundle paths into absolute URLs against whatever host
    /// is serving the page.
    ///
    /// WebGL's bundle provider refuses a bare relative path outright - it does
    /// not even issue the request, it reports "Invalid path in
    /// AssetBundleProvider". But baking an absolute URL in at build time would
    /// pin the build to one host, and this one moves between localhost, a LAN
    /// address and a tunnel. Rewriting the id at load time satisfies both.
    /// </summary>
    void RouteBundlesToThisHost()
    {
        string page = Application.absoluteURL;
        if (string.IsNullOrEmpty(page)) return;          // editor: paths are local anyway

        int cut = page.LastIndexOf('/');
        string baseUrl = cut > 0 ? page.Substring(0, cut + 1) : page;
        int query = baseUrl.IndexOf('?');
        if (query >= 0) baseUrl = baseUrl.Substring(0, query);

        Addressables.ResourceManager.InternalIdTransformFunc = location =>
        {
            string id = location.InternalId;
            if (id.StartsWith("ServerData/", System.StringComparison.Ordinal)) return baseUrl + id;
            return id;
        };
        Debug.Log($"[ModelStreamer] bundles will be fetched from {baseUrl}ServerData/");
    }

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
        yield return Fetch(HelicopterKey, go =>
        {
            if (army != null) army.SetHelicopterPrefab(go);
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
