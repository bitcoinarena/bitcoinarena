// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    public const string BombKey = "model/bomb";
    public const string MinerKey = "model/miner";
    public const string PostKey = "model/postoffice";
    public const string BomberKey = "model/bomber";
    public const string BomberBearKey = "model/bomber-bear";
    public const string MushroomKey = "model/mushroom";
    public const string BomberBullKey = "model/bomber-bull";

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
        /// <summary>Fraction of this model's bundle transferred, 0..1.</summary>
        public float progress;
        /// <summary>Bundle size in MB, or 0 once it is cached and costs nothing.</summary>
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
        Items.Add(new Item { label = "Soldiers", key = SoldierKey });
        Items.Add(new Item { label = "Tanks", key = TankKey });

        // The truck rides in the build - the scene references it directly, so
        // it is there before anything is streamed. Asking for it as well was
        // reported as "Truck failed", which it was: there is nothing to fetch.
        if (bootstrap == null || bootstrap.truckModel == null)
            Items.Add(new Item { label = "Truck", key = TruckKey });

        // THE STRIKE SET COMES EARLY NOW, and the reason is a photograph:
        // the owner's iPhone showed a liquidation with stacked primitives for the
        // cloud and the plain olive airframe, because the models a strike
        // needs were at the BACK of the queue behind 22.3 MB of scenery.
        // Measured, in bundle megabytes as downloaded:
        //
        //   bomb 0.07  bomber 0.06  bomber-bull 1.37  mushroom 4.74
        //   soldier 0.56  tank 2.80  truck 0.15  helicopter 0.34
        //   miner 1.99  postoffice 4.02  bomber-bear 12.30
        //
        // The old order reached the mushroom only after 22.3 of the 28.4 MB.
        // This reaches it after 9.8, and everything a strike draws except the
        // bear skin after 5.0. On a desktop line the mushroom was in place at
        // 30.1 s; on a phone that tail is minutes, and a liquidation does not
        // wait for it.
        Items.Add(new Item { label = "Bombs", key = BombKey });
        Items.Add(new Item { label = "Bomber", key = BomberKey });
        Items.Add(new Item { label = "Bomber (bull)", key = BomberBullKey });
        Items.Add(new Item { label = "Mushroom cloud", key = MushroomKey });
        Items.Add(new Item { label = "Helicopter", key = HelicopterKey });
        Items.Add(new Item { label = "Miner", key = MinerKey });
        Items.Add(new Item { label = "Post Office", key = PostKey });
        // Last on purpose: 12.30 MB, the largest single asset here by three
        // times. Until it lands a bear strike flies the plain airframe, which
        // is the fallback that already exists.
        Items.Add(new Item { label = "Bomber (bear)", key = BomberBearKey });
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
        if (bootstrap == null || bootstrap.truckModel == null)
            yield return Fetch(TruckKey, go =>
            {
                if (bootstrap != null) bootstrap.SwapTruckModel(go);
            });
        // THE STRIKE SET FIRST, and cheapest first inside it. A liquidation
        // can land at any moment - the silent-market clock fires one after
        // ninety seconds - and the picture it draws must not be waiting behind
        // the scenery. Bomb, plain airframe and bull skin cost 1.50 MB
        // between them; the cloud is 4.74.
        yield return Fetch(BombKey, go =>
        {
            if (army != null) army.SetBombPrefab(go);
            // The same shape the gunships drop, so the one the bomber lets go
            // of is a bomb the player has already seen rather than a capsule.
            var strike = FindFirstObjectByType<Arena.StrikeTheatre>();
            if (strike != null) strike.SetBombModel(go);
        });
        yield return Fetch(BomberKey, go =>
        {
            var strike = FindFirstObjectByType<Arena.StrikeTheatre>();
            if (strike != null) strike.SetAirframe(go);
        });

        // The bull skin EXISTS now - bomber-bull.glb, 1.37 MB as a bundle - so
        // it is asked for like everything else and has a line in the panel. It
        // used to go through `Optional`, quietly and last, on the grounds that
        // the asset had not been made yet; that comment outlived the asset,
        // and the cost was a bull liquidation flying the plain airframe with
        // nothing in the HUD to say why.
        yield return Fetch(BomberBullKey, go =>
        {
            var strike = FindFirstObjectByType<Arena.StrikeTheatre>();
            if (strike != null) strike.SetBullAirframe(go);
        });
        yield return Fetch(MushroomKey, go =>
        {
            var strike = FindFirstObjectByType<Arena.StrikeTheatre>();
            if (strike != null) strike.SetMushroom(go);
        });

        yield return Fetch(HelicopterKey, go =>
        {
            if (army != null) army.SetHelicopterPrefab(go);
        });

        // The miner is far away - the player spends the first part of a run
        // driving towards it - and the collision that makes it a wall is
        // already in place.
        yield return Fetch(MinerKey, go =>
        {
            var gate = FindFirstObjectByType<DeliveryGate>();
            if (gate != null) gate.ShowMiner(go);
        });

        // The post office is behind the player at the start, so it can wait:
        // the bay they are parked in is arithmetic and does not need it.
        yield return Fetch(PostKey, go =>
        {
            var strike = FindFirstObjectByType<PostOffice>();
            if (strike != null) strike.Show(go);
        });

        // LAST, and it is the one asset worth waiting for: 12.30 MB, three
        // times the next largest. Until it lands a bear strike flies the plain
        // airframe rather than holding up the cloud behind it.
        yield return Fetch(BomberBearKey, go =>
        {
            var strike = FindFirstObjectByType<Arena.StrikeTheatre>();
            if (strike != null) strike.SetBearAirframe(go);
        });

        Debug.Log($"[ModelStreamer] done: {Loaded} loaded, {Failed} failed");
    }

    /// <summary>
    /// Ask for a key that may simply not be there.
    ///
    /// `Fetch` counts a missing key as a failure and shows it, which is right
    /// for a model the game needs and wrong for one that has not been made yet.
    /// </summary>
    IEnumerator Optional(string key, System.Action<GameObject> apply)
    {
        var locations = Addressables.LoadResourceLocationsAsync(key);
        yield return locations;
        bool there = locations.Status == AsyncOperationStatus.Succeeded
                  && locations.Result != null && locations.Result.Count > 0;
        Addressables.Release(locations);
        if (!there) { Debug.Log($"[ModelStreamer] {key} is not in this build - skipped"); yield break; }
        Items.Add(new Item { label = key, key = key });
        yield return Fetch(key, apply);
    }

    IEnumerator Fetch(string key, System.Action<GameObject> apply)
    {
        var item = Items.Find(i => i.key == key);
        if (item != null) item.state = State.Loading;

        // Ask whether the key resolves BEFORE asking for the asset.
        //
        // Addressables logs an InvalidKeyException at Error level from inside
        // LoadAssetAsync and GetDownloadSizeAsync when a key has no location,
        // and it does so before the handle reports failure - so the graceful
        // handling further down never gets the chance to keep it quiet. One
        // absent model therefore fails every PlayMode test in the project,
        // because the test framework fails a test on any unhandled error log.
        //
        // A missing model is a degraded scene, not a broken one: the code-built
        // proxy stays where the detailed mesh would have gone.
        var locations = Addressables.LoadResourceLocationsAsync(key);
        yield return locations;
        bool missing = locations.Status != AsyncOperationStatus.Succeeded
                       || locations.Result == null || locations.Result.Count == 0;
        Addressables.Release(locations);

        if (missing)
        {
            Failed++;
            if (item != null) item.state = State.Failed;
            Debug.LogWarning($"[ModelStreamer] {key} is not in the catalog - keeping the proxy");
            yield break;
        }

        // How much this one actually costs. Reported as zero once it is in the
        // browser's cache, which is worth showing: a second visit is nearly
        // free and the panel should say so rather than repeating the first
        // visit's figures.
        var size = Addressables.GetDownloadSizeAsync(key);
        yield return size;
        if (item != null && size.Status == AsyncOperationStatus.Succeeded)
            item.sizeMb = size.Result / (1024f * 1024f);
        Addressables.Release(size);

        var handle = Addressables.LoadAssetAsync<GameObject>(key);
        while (!handle.IsDone)
        {
            // PercentComplete covers the whole chain including the download, so
            // it is the only honest progress figure available per model
            if (item != null) item.progress = handle.PercentComplete;
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
