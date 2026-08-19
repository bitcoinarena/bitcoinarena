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

        // Brotli and gzip need the server to send Content-Encoding, and a plain
        // static server does not. Uncompressed is bigger but loads anywhere,
        // which is the point of handing over a LAN URL.
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
        PlayerSettings.WebGL.decompressionFallback = false;
        PlayerSettings.WebGL.dataCaching = false;
        PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.ExplicitlyThrownExceptionsOnly;
        PlayerSettings.runInBackground = true;
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
