// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    /// <summary>
    /// Writes the commit this build was made at into `Resources/build.txt`,
    /// so the loading screen can say which build is on the screen.
    ///
    /// Twice in one session a measured fix "changed nothing on the phone" and
    /// both times the page was serving an older build than the one being
    /// argued about. A number on the splash makes that a glance instead of an
    /// argument. Read back by `BuildStamp`.
    /// </summary>
    static void StampTheBuild()
    {
        // 0.0.<commits on this branch>. Asked for in that shape by the owner
        // 2026-09-07 07:39, and it is a number that goes up by one per commit
        // rather than a hash nobody can order: 0.0.551 is one build after
        // 0.0.550, and `git rev-list --count` maps it back to the commit.
        string count = Git("rev-list --count HEAD");
        string version = "0.0." + (string.IsNullOrWhiteSpace(count) ? "0" : count);

        string dir = Path.Combine(Application.dataPath, "Resources");
        Directory.CreateDirectory(dir);
        // The SPLASH reads this file. The LOADING SCREEN reads the player
        // version through the template's {{{ PRODUCT_VERSION }}}, so both are
        // set from the one number here and cannot drift apart.
        File.WriteAllText(Path.Combine(dir, "build.txt"), version);
        PlayerSettings.bundleVersion = version;
        AssetDatabase.Refresh();
        UnityEngine.Debug.Log($"[build] stamped {version} ({Git("rev-parse --short HEAD")})");
    }

    /// <summary>One git command, or an empty string if git will not answer.</summary>
    static string Git(string args)
    {
        try
        {
            var p = new System.Diagnostics.Process
            {
                StartInfo = new System.Diagnostics.ProcessStartInfo("git", args)
                {
                    WorkingDirectory = Application.dataPath,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }
            };
            p.Start();
            string outp = p.StandardOutput.ReadToEnd().Trim();
            p.WaitForExit(4000);
            return outp;
        }
        catch (Exception e)
        {
            UnityEngine.Debug.LogWarning($"[build] no git stamp: {e.Message}");
            return "";
        }
    }

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
        StampTheBuild();

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
        // FUNCTION NAMES IN THE WASM, FOR A PROFILE ONLY: ARENA_WEBGL_SYMBOLS=1 embeds the name section, so a CPU
        // profile names Unity's hot functions instead of wasm-function[643]. Off by default: a shipped build stays as it was.
        PlayerSettings.WebGL.debugSymbolMode = System.Environment.GetEnvironmentVariable("ARENA_WEBGL_SYMBOLS") == "1"
            ? WebGLDebugSymbolMode.Embedded : WebGLDebugSymbolMode.Off;
        // TEXTURES A PHONE CAN USE (measured 2026-10-08): left at Unity's default the WebGL textures are DXT, which
        // most Android GPUs and iPhones lack - Unity then decompresses all 33 on the CPU ("DXT5|BC3 UNorm format is not supported,
        // decompressing texture"), 20 of them before 100 %. ARENA_WEBGL_SUBTARGET (DXT, ASTC, ETC2) builds the textures - the data
        // file and the streamed bundles - in that format; one format per build. Unset: the editor's own setting, as before.
        var subtarget = System.Environment.GetEnvironmentVariable("ARENA_WEBGL_SUBTARGET");
        if (!string.IsNullOrEmpty(subtarget))
        {
            // a list ("ASTC,DXT") builds the player data in every format named, first preferred; the bundles take the first
            var names = subtarget.Split(',');
            EditorUserBuildSettings.webGLBuildSubtarget = (WebGLTextureSubtarget)System.Enum.Parse(typeof(WebGLTextureSubtarget), names[0].Trim());
            Debug.Log($"[BuildWebGL] WebGL texture subtarget: {EditorUserBuildSettings.webGLBuildSubtarget}");
            // AND THE PLAYER'S OWN DATA: measured on 0.0.2881, the subtarget (and a reimport) made the streamed bundles ASTC but the
            // first scene's 20 textures stayed DXT - the player data follows the Web player setting "texture compression formats"
            // (m_BuildTargetDefaultTextureCompressionFormat), whose setter Unity 6 keeps internal for the Web. Set by reflection.
            var fmts = System.Array.ConvertAll(names, n => n.Trim().ToUpperInvariant() == "DXT" ? TextureCompressionFormat.DXTC
                    : (TextureCompressionFormat)System.Enum.Parse(typeof(TextureCompressionFormat), n.Trim()));
            bool set = false;
            foreach (var m in typeof(PlayerSettings).GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
            {
                if (m.Name.IndexOf("TextureCompressionFormat", System.StringComparison.Ordinal) < 0) continue;
                var ps = m.GetParameters();
                Debug.Log($"[BuildWebGL] PlayerSettings.{m.Name}({string.Join(", ", System.Array.ConvertAll(ps, x => x.ParameterType.FullName))})");
                if (m.Name != "SetTextureCompressionFormats" && m.Name != "SetTextureCompressionFormatsImpl") continue;
                if (ps.Length != 2 || ps[1].ParameterType != typeof(TextureCompressionFormat[])) continue;
                object target = ps[0].ParameterType == typeof(BuildTargetGroup) ? (object)BuildTargetGroup.WebGL
                              : ps[0].ParameterType == typeof(BuildTarget) ? (object)BuildTarget.WebGL
                              : ps[0].ParameterType == typeof(UnityEditor.Build.NamedBuildTarget) ? (object)UnityEditor.Build.NamedBuildTarget.WebGL : null;
                if (target == null) continue;
                m.Invoke(null, new object[] { target, fmts });
                set = true;
                Debug.Log($"[BuildWebGL] Web texture compression formats set to {string.Join(", ", fmts)} ({ps[0].ParameterType.Name} overload)");
                break;
            }
            if (!set) Debug.LogWarning("[BuildWebGL] no SetTextureCompressionFormats(target, formats[]) found: the player data keeps its format");
            // THE SCENE'S TEXTURES TOO: setting the subtarget from a script does not reimport what the Library already holds,
            // so measured on 0.0.2880 the streamed bundles came out ASTC and the 20 textures of the first scene stayed DXT.
            // Every texture is imported again under the new subtarget before the player is built.
            var guids = AssetDatabase.FindAssets("t:Texture", new[] { "Assets" });
            AssetDatabase.StartAssetEditing();
            try { foreach (var g in guids) AssetDatabase.ImportAsset(AssetDatabase.GUIDToAssetPath(g), ImportAssetOptions.ForceUpdate); }
            finally { AssetDatabase.StopAssetEditing(); }
            Debug.Log($"[BuildWebGL] {guids.Length} textures imported again for {EditorUserBuildSettings.webGLBuildSubtarget}");
        }
        // Unity Personal made this optional in Unity 6, and it is 2.7 MB of
        // texture in a build we are trying to get under thirty.
        PlayerSettings.SplashScreen.show = false;
        // Our own template: the stock one shows a bare grey bar, and at 35 MB
        // the person waiting needs to know it is working and roughly how long.
        PlayerSettings.WebGL.template = "PROJECT:NextBlock";
        PlayerSettings.productName = "Tick Tock, Next Block";
        PlayerSettings.companyName = "Bitcoin Arena";

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
        // THE NUMBER TRAVELS WITH THE BUILD (2026-09-29: "It's 17xx now but was 2200ish before"): the loading screen's
        // version is filled by tools/fill-template.mjs at every deploy, and it read the committed ProjectSettings - 0.0.1791,
        // since the builds bump bundleVersion only locally - so a page-only redeploy showed 17xx under a 22xx lobby. The
        // build's own number is left beside it, and fill-template takes it from here.
        if (s.result == BuildResult.Succeeded)
            File.WriteAllText(Path.Combine(output, "build.txt"), PlayerSettings.bundleVersion);

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
