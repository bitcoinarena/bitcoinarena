using System;
using System.IO;
using UnityEditor;
using System.Linq;
using UnityEditor.Build.Reporting;
using UnityEngine;

/// <summary>
/// Headless WebGL build.
///
/// Batch mode: -buildTarget WebGL -executeMethod BuildWebGL.Run
/// Output path can be overridden with -buildOutput &lt;dir&gt;.
/// </summary>
public static class BuildWebGL
{
    const string DefaultOutput = "/Users/arena/code/btc-logistics-war/unity-proto/build/webgl";
    const string ScenePath = "Assets/Scenes/Prototype.unity";

    /// <summary>
    /// Write the real download size into the page.
    ///
    /// The template cannot know it: it is shipped alongside files that do not
    /// exist when it is written. A percentage on its own does not tell someone
    /// whether they are waiting ten seconds or two minutes, and at this size
    /// that is the difference between waiting and giving up.
    /// </summary>
    static void StampDownloadSize(string output)
    {
        string page = Path.Combine(output, "index.html");
        string buildDir = Path.Combine(output, "Build");
        if (!File.Exists(page) || !Directory.Exists(buildDir)) return;

        long bytes = 0;
        foreach (var f in Directory.GetFiles(buildDir)) bytes += new FileInfo(f).Length;
        string mb = (bytes / (1024f * 1024f)).ToString("0.#",
            System.Globalization.CultureInfo.InvariantCulture);

        string html = File.ReadAllText(page);
        if (!html.Contains("__TOTAL_MB__"))
        {
            Debug.LogWarning("[BuildWebGL] template has no __TOTAL_MB__ placeholder");
            return;
        }
        File.WriteAllText(page, html.Replace("__TOTAL_MB__", mb));
        Debug.Log($"[BuildWebGL] download size stamped into the page: {mb} MB");
    }

    /// <summary>
    /// What is actually IN the build, biggest first.
    ///
    /// Guessing at this wastes effort: the models were streamed out on the
    /// assumption they were the weight, and the payload did not move at all.
    /// The build report knows, so ask it.
    /// </summary>
    static void ReportContents(BuildReport report)
    {
        var byAsset = new System.Collections.Generic.Dictionary<string, ulong>();
        var byKind = new System.Collections.Generic.Dictionary<string, ulong>();
        ulong total = 0;

        foreach (var pack in report.packedAssets)
            foreach (var info in pack.contents)
            {
                string path = info.sourceAssetPath;
                if (string.IsNullOrEmpty(path)) path = "(built in)";
                byAsset.TryGetValue(path, out var had);
                byAsset[path] = had + info.packedSize;

                string kind = info.type != null ? info.type.Name : "unknown";
                byKind.TryGetValue(kind, out var hadKind);
                byKind[kind] = hadKind + info.packedSize;
                total += info.packedSize;
            }

        Debug.Log($"[BuildSize] {total / (1024f * 1024f):0.1} MB packed, by type:");
        foreach (var kv in byKind.OrderByDescending(k => k.Value).Take(12))
            Debug.Log($"[BuildSize]   {kv.Value / (1024f * 1024f),7:0.00} MB  {kv.Key}");

        Debug.Log("[BuildSize] biggest single assets:");
        foreach (var kv in byAsset.OrderByDescending(k => k.Value).Take(25))
            Debug.Log($"[BuildSize]   {kv.Value / (1024f * 1024f),7:0.00} MB  {kv.Key}");
    }

    [MenuItem("Tools/BTC Logistics/Build WebGL")]
    public static void Run()
    {
        // The core is rebuilt and copied into the template HERE, not by hand.
        //
        // It used to be a menu item nobody remembered to run, so the build
        // shipped whatever bundle was last synced. That is not a visible
        // failure - the game loads and drives, it just drives by the OLD
        // rules. A steering fix was measured as correct in Node, built,
        // deployed, and changed nothing at all on the phone, because the page
        // was still loading a bundle from three hours earlier.
        SyncCore.Run();

        string output = DefaultOutput;
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "-buildOutput") output = args[i + 1];

        // Brotli, with the decompression fallback ON.
        //
        // Compression needs the server to send Content-Encoding, and a plain
        // static server does not - which is why this was off. The fallback
        // makes that survivable: where the header is missing the loader
        // decompresses in JavaScript instead of failing outright. Slower to
        // start, but it starts.
        //
        // Measured on this build: wasm 45.4 MB -> 9.9, data 39.3 -> 28.9.
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
        PlayerSettings.WebGL.decompressionFallback = true;
        PlayerSettings.WebGL.dataCaching = false;
        PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.ExplicitlyThrownExceptionsOnly;
        PlayerSettings.runInBackground = true;
        // Unity Personal made this optional in Unity 6, and it is 2.7 MB of
        // texture in a build we are trying to get under thirty.
        PlayerSettings.SplashScreen.show = false;
        // Our own template: the stock one shows a bare grey bar, and at 35 MB
        // the person waiting needs to know it is working and roughly how long.
        PlayerSettings.WebGL.template = "PROJECT:BtcLogistics";
        PlayerSettings.productName = "BTC Logistics War - Prototype";

        var opts = new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = output,
            target = BuildTarget.WebGL,
            options = BuildOptions.None,
        };

        Debug.Log($"[BuildWebGL] building {ScenePath} -> {output}");
        var report = BuildPipeline.BuildPlayer(opts);
        var s = report.summary;
        Debug.Log($"[BuildWebGL] result={s.result} size={s.totalSize / (1024 * 1024)}MB " +
                  $"errors={s.totalErrors} time={s.totalTime}");
        ReportContents(report);
        CopyStreamedContent(output);
        StampDownloadSize(output);

        if (s.result != BuildResult.Succeeded)
        {
            foreach (var step in report.steps)
                foreach (var msg in step.messages)
                    if (msg.type == LogType.Error || msg.type == LogType.Exception)
                        Debug.LogError($"[BuildWebGL] {step.name}: {msg.content}");
            EditorApplication.Exit(1);
        }
        EditorApplication.Exit(0);
    
    /// <summary>
    /// Copies the streamed bundles into the build output.
    ///
    /// They are loaded from ServerData/ at runtime, and NOTHING was putting
    /// them there: the folder in the build output had been copied by hand
    /// once, and every build since shipped whatever was in it. Swapping a
    /// model therefore produced a catalogue asking for a bundle hash that was
    /// not on the server, a 404, and a building that simply did not appear in
    /// the world - with no error anywhere a player could see.
    ///
    /// Mirrored rather than merged, so a bundle that has been replaced does
    /// not linger and get served in place of the one that replaced it.
    /// </summary>
    static void CopyStreamedContent(string output)
    {
        string target = EditorUserBuildSettings.activeBuildTarget.ToString();
        string from = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "ServerData", target));
        if (!Directory.Exists(from))
        {
            Debug.LogWarning("[BuildWebGL] no streamed content at " + from);
            return;
        }

        string to = Path.Combine(output, "ServerData", target);
        if (Directory.Exists(to)) Directory.Delete(to, true);
        Directory.CreateDirectory(to);

        long bytes = 0;
        var files = Directory.GetFiles(from);
        foreach (var f in files)
        {
            File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
            bytes += new FileInfo(f).Length;
        }
        Debug.Log($"[BuildWebGL] copied {files.Length} streamed bundles " +
                  $"({bytes / (1024f * 1024f):0.0} MB) into the build");
    }
}
}
