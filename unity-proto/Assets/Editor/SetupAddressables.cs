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

        settings.BuildRemoteCatalog = true;
        settings.RemoteCatalogBuildPath.SetVariableByName(settings, AddressableAssetSettings.kRemoteBuildPath);
        settings.RemoteCatalogLoadPath.SetVariableByName(settings, AddressableAssetSettings.kRemoteLoadPath);
        EditorUtility.SetDirty(settings);
        AssetDatabase.SaveAssets();

        Debug.Log($"[SetupAddressables] {marked} models marked for streaming into '{GroupName}'");
    }

    /// <summary>Find a model by name and give it a stable address.</summary>
    static int Mark(AddressableAssetSettings settings, AddressableAssetGroup group,
                    string key, params string[] words)
    {
        string found = null;
        foreach (var guid in AssetDatabase.FindAssets("t:GameObject"))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.ToLowerInvariant().Contains("/animation")) continue;
            string name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            if (!words.Any(w => name.Contains(w))) continue;

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

    /// <summary>Build the bundles. Must run before the player build.</summary>
    public static void BuildContent()
    {
        Run();
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
