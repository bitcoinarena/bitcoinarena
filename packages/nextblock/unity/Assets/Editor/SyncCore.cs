// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    const string CoreDir = "../packages/nextblock";
    const string ClientDir = "../packages/arena-client";

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
        string layoutPath = Path.Combine(Application.dataPath, "Scripts/Arena/ArenaLayout.cs");
        File.WriteAllText(layoutPath, layout);
        UnityEngine.Debug.Log("[SyncCore] wrote " + layoutPath);

        string from = Path.Combine(root, "dist/blwp-core.js");
        string to = Path.Combine(Application.dataPath, "WebGLTemplates/NextBlock/blwp-core.js");
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
            string cFrom = Path.Combine(clientRoot, "dist/arena-client.js");
            string cTo = Path.Combine(Application.dataPath,
                                      "WebGLTemplates/NextBlock/arena-client.js");
            File.Copy(cFrom, cTo, true);
            ToArenaUi(cFrom, "arena-client.js");
            UnityEngine.Debug.Log(
                $"[SyncCore] copied client ({new FileInfo(cTo).Length / 1024} KB) into the template");
            if (!Node(clientRoot, "tools/bundle-curve.js", out string curveOut)) return;
            UnityEngine.Debug.Log("[SyncCore] " + curveOut.Trim());
            File.Copy(Path.Combine(clientRoot, "dist/arena-curve.js"),
                      Path.Combine(Application.dataPath,
                                   "WebGLTemplates/NextBlock/arena-curve.js"), true);
            ToArenaUi(Path.Combine(clientRoot, "dist/arena-curve.js"), "arena-curve.js");
            // AND THE LOCK CLIENT (W1b), which a page joining a lock round loads
            // to make the player's stake lock. Built outside Unity (the stock
            // fedimint crates to wasm) and committed in dist; copied as it is.
            foreach (string lockFile in new[] { "blwp_lock_client.js", "blwp_lock_client_bg.wasm" })
            {
                File.Copy(Path.Combine(clientRoot, "dist", lockFile),
                          Path.Combine(Application.dataPath, "WebGLTemplates/NextBlock", lockFile), true);
                ToArenaUi(Path.Combine(clientRoot, "dist", lockFile), lockFile);
            }
        }

        AssetDatabase.Refresh();
    }

    // THE ARENA UI'S SOURCE IS src/arena-ui (#521); this template is its copy (tools/sync-arena-ui.mjs). A file copied into the
    // template is copied there too, so the two stay equal (packages/arena-client/test/arena-ui-sync.test.js).
    static void ToArenaUi(string from, string name)
    {
        string dir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "src", "arena-ui"));
        if (Directory.Exists(dir)) File.Copy(from, Path.Combine(dir, name), true);
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
