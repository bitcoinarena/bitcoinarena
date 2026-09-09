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
    const string ClientDir = "../packages/blwp-client";

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

        // AND THE CLIENT, for the same reason and in the same breath.
        //
        // The page loads two bundles: the core it draws from and the client it
        // commits through. They are built from one tree and have to move
        // together - a page holding a client that signs a state hash a
        // different core produced is the exact fault this menu item exists to
        // prevent, one layer out.
        string clientRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ClientDir));
        if (Directory.Exists(clientRoot))
        {
            if (!Node(clientRoot, "tools/bundle.js", out string clientOut)) return;
            UnityEngine.Debug.Log("[SyncCore] " + clientOut.Trim());
            string cFrom = Path.Combine(clientRoot, "dist/blwp-client.js");
            string cTo = Path.Combine(Application.dataPath,
                                      "WebGLTemplates/BtcLogistics/blwp-client.js");
            File.Copy(cFrom, cTo, true);
            UnityEngine.Debug.Log(
                $"[SyncCore] copied client ({new FileInfo(cTo).Length / 1024} KB) into the template");
            if (!Node(clientRoot, "tools/bundle-curve.js", out string curveOut)) return;
            UnityEngine.Debug.Log("[SyncCore] " + curveOut.Trim());
            File.Copy(Path.Combine(clientRoot, "dist/blwp-curve.js"),
                      Path.Combine(Application.dataPath,
                                   "WebGLTemplates/BtcLogistics/blwp-curve.js"), true);
        }

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
