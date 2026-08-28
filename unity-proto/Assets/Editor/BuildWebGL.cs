using System;
using UnityEditor;
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

    [MenuItem("Tools/BTC Logistics/Build WebGL")]
    public static void Run()
    {
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

        if (s.result != BuildResult.Succeeded)
        {
            foreach (var step in report.steps)
                foreach (var msg in step.messages)
                    if (msg.type == LogType.Error || msg.type == LogType.Exception)
                        Debug.LogError($"[BuildWebGL] {step.name}: {msg.content}");
            EditorApplication.Exit(1);
        }
        EditorApplication.Exit(0);
    }
}
