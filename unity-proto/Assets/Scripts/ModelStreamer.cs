using System.Collections;
using System.Collections.Generic;
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

    public enum State { Waiting, Loading, Loaded, Failed }

    /// <summary>
    /// One line per model, for the HUD.
    ///
    /// Streaming is invisible by design - the game starts on boxes and quietly
    /// improves - and invisible is indistinguishable from broken. It was
    /// reported as "the models are not loading" while all four were in fact
    /// arriving, because nothing on screen said so.
    /// </summary>
    public class Item
    {
        public string label;
        public string key;
        public State state = State.Waiting;
        public float sizeMb;
    }

    public readonly List<Item> Items = new List<Item>();

    public int Loaded { get; private set; }
    public int Failed { get; private set; }
    /// <summary>Seconds since the last one finished, so the panel can retire itself.</summary>
    public float SinceDone { get; private set; } = -1f;
    public bool AllDone => Items.Count > 0 && Loaded + Failed >= Items.Count;

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
    static bool _routed;

    static void RouteBundlesToThisHost()
    {
        if (_routed) return;
        string page = Application.absoluteURL;
        if (string.IsNullOrEmpty(page)) return;          // editor: paths are local anyway
        _routed = true;

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

    void Start()
    {
        Items.Add(new Item { label = "Soldaten", key = SoldierKey });
        Items.Add(new Item { label = "Panzer", key = TankKey });
        Items.Add(new Item { label = "Truck", key = TruckKey });
        Items.Add(new Item { label = "Helikopter", key = HelicopterKey });
        StartCoroutine(Stream());
    }

    void Update()
    {
        if (AllDone && SinceDone < 0f) SinceDone = 0f;
        else if (SinceDone >= 0f) SinceDone += Time.deltaTime;
    }

    IEnumerator Stream()
    {
        // Initialise FIRST, and wait for it.
        //
        // Touching Addressables.ResourceManager before initialisation throws a
        // NullReferenceException inside Addressables' own startup, which then
        // reports "Unable to load runtime data" and leaves the catalog unloaded
        // - so every key afterwards fails with "No Location found". Four failed
        // models, one line run too early.
        Debug.Log($"[ModelStreamer] absoluteURL={Application.absoluteURL} " +
                  $"streamingAssets={Application.streamingAssetsPath} " +
                  $"runtimePath={Addressables.RuntimePath}");
        var init = Addressables.InitializeAsync(false);
        yield return init;
        if (init.Status != AsyncOperationStatus.Succeeded)
            Debug.LogWarning($"[ModelStreamer] Addressables init failed: {init.OperationException?.Message}");
        Addressables.Release(init);

        RouteBundlesToThisHost();

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

        Debug.Log($"[ModelStreamer] done: {Loaded} loaded, {Failed} failed");
    }

    IEnumerator Fetch(string key, System.Action<GameObject> apply)
    {
        var item = Items.Find(i => i.key == key);
        if (item != null) item.state = State.Loading;

        var handle = Addressables.LoadAssetAsync<GameObject>(key);
        while (!handle.IsDone)
        {
            // PercentComplete covers the whole chain including the download, so
            // it is the only honest progress figure available per model
            if (item != null) item.sizeMb = handle.PercentComplete;
            yield return null;
        }

        if (handle.Status == AsyncOperationStatus.Succeeded && handle.Result != null)
        {
            apply(handle.Result);
            Loaded++;
            if (item != null) item.state = State.Loaded;
            Debug.Log($"[ModelStreamer] {key} in place");
        }
        else
        {
            // Not fatal, by design: a missing bundle leaves the proxy standing
            // rather than leaving a hole where a soldier should be.
            Failed++;
            if (item != null) item.state = State.Failed;
            Debug.LogWarning($"[ModelStreamer] {key} failed: {handle.OperationException?.Message}");
        }
    }
}
