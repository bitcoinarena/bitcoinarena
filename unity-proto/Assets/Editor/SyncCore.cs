#if UNITY_EDITOR
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Rebuilds the deterministic core's bundle and its C# layout, then copies the
/// bundle into the WebGL template.
///
/// Three files have to move together or the build is quietly wrong: the bundle
/// the page loads, the layout C# indexes the state buffer by, and the state.js
/// both are generated from. Doing it by hand is how a truck ends up rendering
/// its health as its heading, so it is one menu item.
///
/// Menu: Tools > BTC Logistics > Sync Deterministic Core
/// </summary>
public static class SyncCore
{
    const string CoreDir = "../packages/core";

    [MenuItem("Tools/BTC Logistics/Sync Deterministic Core")]
    public static void Run()
    {
        string root = Path.GetFullPath(Path.Combine(Application.dataPath, "..", CoreDir));
        if (!Directory.Exists(root))
        {
            UnityEngine.Debug.LogError("[SyncCore] no core at " + root);
            return;
        }

        if (!Node(root, "tools/bundle.js", out string bundleOut)) return;
        UnityEngine.Debug.Log("[SyncCore] " + bundleOut.Trim());

        if (!Node(root, "tools/gen-unity-layout.js", out string layout)) return;
        string layoutPath = Path.Combine(Application.dataPath, "Scripts/Blwp/BlwpLayout.cs");
        File.WriteAllText(layoutPath, layout);
        UnityEngine.Debug.Log("[SyncCore] wrote " + layoutPath);

        string from = Path.Combine(root, "dist/blwp-core.js");
        string to = Path.Combine(Application.dataPath, "WebGLTemplates/BtcLogistics/blwp-core.js");
        File.Copy(from, to, true);
        UnityEngine.Debug.Log($"[SyncCore] copied bundle ({new FileInfo(to).Length / 1024} KB) into the template");

        AssetDatabase.Refresh();
    }

    static bool Node(string cwd, string script, out string stdout)
    {
        var p = new Process
        {
            StartInfo = new ProcessStartInfo("/usr/bin/env", "node " + script)
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }
        };
        p.Start();
        stdout = p.StandardOutput.ReadToEnd();
        string err = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            UnityEngine.Debug.LogError("[SyncCore] " + script + " failed:\n" + err);
            return false;
        }
        return true;
    }
}
#endif
