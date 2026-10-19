// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.AddressableAssets;
using UnityEditor.AddressableAssets.Settings;
using UnityEditor.AddressableAssets.Settings.GroupSchemas;
using UnityEngine;

/// <summary>
/// Moves the heavy models out of the player and into bundles fetched after the
/// game is already running.
///
/// This only pays off for CONTENT. The wasm is compiled code and stays in the
/// initial download whatever happens, so the floor is about 8 MB - what this
/// buys is the 27 MB of models and textures arriving while the player is
/// already driving boxes around, rather than before he sees anything.
///
/// Menu: Tools > BTC Logistics > Set Up Streaming
/// Batch: -executeMethod SetupAddressables.Run
/// </summary>
public static class SetupAddressables
{
    public const string GroupName = "HighDetail";

    /// <summary>Keys the runtime asks for. Kept here so both sides cannot drift.</summary>
    public const string SoldierKey = "model/soldier";
    public const string TankKey = "model/tank";
    public const string TruckKey = "model/truck";
    public const string HelicopterKey = "model/helicopter";
    public const string BombKey = "model/bomb";
    public const string MinerKey = "model/miner";
    public const string PostKey = "model/postoffice";
    public const string BomberKey = "model/bomber";
    public const string BomberBearKey = "model/bomber-bear";
    public const string BomberBullKey = "model/bomber-bull";
    public const string MushroomKey = "model/mushroom";

    [MenuItem("Tools/BTC Logistics/Set Up Streaming")]
    public static void Run()
    {
        var settings = AddressableAssetSettingsDefaultObject.Settings
                    ?? AddressableAssetSettingsDefaultObject.GetSettings(true);

        // Bundles are fetched from a path relative to wherever the build is
        // served. Anything absolute would pin them to one host, and this build
        // moves between a LAN address and a tunnel.
        var profiles = settings.profileSettings;
        string profile = settings.activeProfileId;
        profiles.SetValue(profile, AddressableAssetSettings.kRemoteBuildPath, "ServerData/[BuildTarget]");
        profiles.SetValue(profile, AddressableAssetSettings.kRemoteLoadPath, "ServerData/[BuildTarget]");

        var group = settings.FindGroup(GroupName)
                 ?? settings.CreateGroup(GroupName, false, false, true, null,
                        typeof(BundledAssetGroupSchema), typeof(ContentUpdateGroupSchema));

        var schema = group.GetSchema<BundledAssetGroupSchema>();
        schema.BuildPath.SetVariableByName(settings, AddressableAssetSettings.kRemoteBuildPath);
        schema.LoadPath.SetVariableByName(settings, AddressableAssetSettings.kRemoteLoadPath);
        // one bundle per model, so a slow one does not hold up the others
        schema.BundleMode = BundledAssetGroupSchema.BundlePackingMode.PackSeparately;
        schema.Compression = BundledAssetGroupSchema.BundleCompressionMode.LZ4;
        schema.UseAssetBundleCache = true;
        schema.UseAssetBundleCrc = false;
        EditorUtility.SetDirty(schema);

        int marked = 0;
        marked += Mark(settings, group, SoldierKey, "soldier", "infantry", "trooper");
        marked += Mark(settings, group, TankKey, "leopard", "tank", "panzer");
        marked += Mark(settings, group, TruckKey, "smalltruck", "industrialsmalltruck", "truck", "lorry", "van");
        marked += Mark(settings, group, HelicopterKey, "gunship", "helicopter", "hellicopter", "chopper");
        // RMB_23 by name, because the pack numbers its forty models and the
        // numbers say nothing. Measured, they fall into two families: length
        // over thickness around 2 at ten units long - a stubby body with a wide
        // tail, i.e. a free-fall bomb - and around 5 at thirty units, i.e.
        // rockets. This is the most detailed of the bombs at 1154 triangles.
        // "bomber" CONTAINS "bomb", and Mark matches on substrings, so the
        // bomber's airframe would answer to the bomb's key - and whichever of
        // the two was marked last would win the asset. Named exclusion rather
        // than ordering, because ordering is the kind of thing a later edit
        // quietly reverses.
        marked += MarkExcept(settings, group, BombKey, new[] { "bomber" }, "rmb_23", "bomb");
        // The skinned variants live beside it - bomber-bear.glb and, in time,
        // a bull - and every one of them contains "bomber". Without the
        // exclusion this key binds to whichever the asset database happens to
        // return last, which is not a thing to leave to chance.
        marked += MarkExcept(settings, group, BomberKey, new[] { "-bear", "-bull" }, "bomber");
        marked += Mark(settings, group, BomberBearKey, "bomber-bear");
        // The cloud the strike leaves. It was three primitives - a cylinder,
        // a sphere and a flatter sphere - which is a stand-in and reads as
        // one. The mesh is 5.5 MB and 248k triangles, so it is streamed like
        // every other model rather than carried in the player.
        marked += Mark(settings, group, MushroomKey, "mushroom-cloud", "mushroom");
        // No bull model exists yet. Marking it costs nothing when the asset is
        // absent - Mark says so and returns zero - and the moment a
        // bomber-bull.glb lands beside the bear it is streamed without another
        // edit here.
        marked += Mark(settings, group, BomberBullKey, "bomber-bull");
        marked += Mark(settings, group, MinerKey, "megastructure", "bitcoin_miner");
        marked += Mark(settings, group, PostKey, "post_office", "mempool_post");

        // The catalog ships INSIDE the player, and only the bundles are remote.
        //
        // A remote catalog has to be found before anything else can be, and
        // finding it is exactly the step that failed: over localhost it fetched,
        // over a LAN address it silently did not, and every key then reported
        // "No Location found". A catalog that travels with the build cannot go
        // missing, and it still points at remote bundles - which is the part
        // worth streaming.
        settings.BuildRemoteCatalog = false;
        EditorUtility.SetDirty(settings);
        AssetDatabase.SaveAssets();

        Debug.Log($"[SetupAddressables] {marked} models marked for streaming into '{GroupName}'");
    }

    /// <summary>Find a model by name and give it a stable address.</summary>
    static int Mark(AddressableAssetSettings settings, AddressableAssetGroup group,
                    string key, params string[] words)
        => MarkExcept(settings, group, key, System.Array.Empty<string>(), words);

    static int MarkExcept(AddressableAssetSettings settings, AddressableAssetGroup group,
                          string key, string[] not, params string[] words)
    {
        string found = null;
        foreach (var guid in AssetDatabase.FindAssets("t:GameObject"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.ToLowerInvariant().Contains("/animation")) continue;
            string name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            if (!words.Any(w => name.Contains(w))) continue;
            if (not.Any(w => name.Contains(w))) continue;

            var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (go == null) continue;
            bool hasMesh = go.GetComponentInChildren<MeshRenderer>(true) != null
                        || go.GetComponentInChildren<SkinnedMeshRenderer>(true) != null;
            if (!hasMesh) continue;

            found = path;
            if (path.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase)) break;
        }
        if (found == null) { Debug.Log($"[SetupAddressables] no model for '{key}'"); return 0; }

        var entry = settings.CreateOrMoveEntry(AssetDatabase.AssetPathToGUID(found), group);
        entry.address = key;
        Debug.Log($"[SetupAddressables] {key} -> {found}");
        return 1;
    }

    /// <summary>
    /// Empty the folder the bundles are written into, before writing them.
    ///
    /// `BuildPlayerContent` is incremental and names every bundle by a hash of
    /// its contents, so changing a model writes a NEW name and leaves the old
    /// one where it was. Nothing else removes it: `BuildWebGL` mirrors the
    /// build OUTPUT - it deletes and re-copies - but the source this copies
    /// FROM had no such rule, and it is the source that grows.
    ///
    /// The failure it guards against is the one `CopyStreamedContent` already
    /// describes from the other side: a catalogue asking for a hash the server
    /// does not have is a 404 and a building that never appears, with nothing
    /// a player can see. A stale twin is the same fault wearing the other
    /// shoe - the server has a bundle nobody asks for, and it ships in every
    /// deploy.
    ///
    /// The path is EVALUATED from the profile rather than assembled here, so
    /// this cleans exactly where the build is about to write even if
    /// `kRemoteBuildPath` is changed above.
    ///
    /// It costs a full rebuild of the bundles on every run instead of an
    /// incremental one. That is the price of the folder being what the
    /// catalogue says it is.
    /// </summary>
    static void ClearRemoteBuildPath()
    {
        var settings = AddressableAssetSettingsDefaultObject.Settings;
        if (settings == null) return;

        string raw = settings.profileSettings.GetValueByName(
            settings.activeProfileId, AddressableAssetSettings.kRemoteBuildPath);
        if (string.IsNullOrEmpty(raw)) return;

        string path = settings.profileSettings.EvaluateString(settings.activeProfileId, raw);
        if (string.IsNullOrEmpty(path)) return;

        string full = Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(Application.dataPath) ?? ".", path));
        if (!Directory.Exists(full))
        {
            Debug.Log($"[SetupAddressables] nothing to clear at {full}");
            return;
        }

        int had = Directory.GetFiles(full).Length;
        long bytes = Directory.GetFiles(full).Sum(f => new FileInfo(f).Length);
        Directory.Delete(full, true);
        Directory.CreateDirectory(full);
        Debug.Log($"[SetupAddressables] cleared {had} files " +
                  $"({bytes / (1024f * 1024f):0.0} MB) from {full} before building");
    }

    /// <summary>Build the bundles. Must run before the player build.</summary>
    public static void BuildContent()
    {
        Run();
        ClearRemoteBuildPath();
        UnityEditor.AddressableAssets.Settings.AddressableAssetSettings.BuildPlayerContent(out var result);
        if (!string.IsNullOrEmpty(result.Error))
        {
            Debug.LogError($"[SetupAddressables] content build failed: {result.Error}");
            EditorApplication.Exit(1);
        }
        Debug.Log($"[SetupAddressables] content built in {result.Duration:0.0}s -> {result.OutputPath}");
        EditorApplication.Exit(0);
    }
}
