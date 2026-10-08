using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// THE RENDER COSTS, ONE SWITCH EACH, SET BY THE PAGE WHILE IT RUNS (kanban #266, the owner 2026-10-08: "Auf dem iPhone 16 Pro sind
/// es 25-35 fps. Können wir die FPS noch besser optimieren?" and "measure it alone and display the data you need in the fps
/// line"). A phone's GPU cannot be profiled from here, so the page's frame-rate test (index.html, arenaBench) switches these
/// one at a time on the player's own phone and writes the frame rate of each into the FPS line:
///   post     bloom, tonemapping, colour adjustments, vignette and FXAA (every camera)
///   shadows  the main light's shadow map (URP shadow distance)
///   hdr      the HDR colour target
///   cascades shadow cascades (1-4; 0 = as built), shadowres the shadow map's size (0 = as built), shadowdist its reach in
///            metres (0 = as built) - the iPhone 16 Pro's BENCHMARK (the owner 2026-10-08) doubled without shadows, 31 -> 60 fps,
///            so the test measures which part of the shadow map that is before a phone default is chosen
/// SendMessage("GfxSwitches", "Set", "post=0;shadows=1;hdr=1"); a key left out keeps its state. Nothing is off until the page asks.
/// </summary>
public class GfxSwitches : MonoBehaviour
{
    float _shadowDistance = -1f;
    bool _hdr = true;
    int _cascadesWas, _resWas;
    int _cascades, _res, _dist;
    readonly Dictionary<UniversalAdditionalCameraData, (bool post, AntialiasingMode aa)> _was = new Dictionary<UniversalAdditionalCameraData, (bool, AntialiasingMode)>();
    bool _post = true, _shadows = true, _hdrOn = true;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Make()
    {
        if (FindFirstObjectByType<GfxSwitches>() != null) return;
        var go = new GameObject("GfxSwitches");
        DontDestroyOnLoad(go);
        go.AddComponent<GfxSwitches>();
    }

    public void Set(string spec)
    {
        foreach (var part in (spec ?? "").Split(';'))
        {
            var kv = part.Split('=');
            if (kv.Length != 2) continue;
            bool on = kv[1].Trim() != "0";
            int.TryParse(kv[1].Trim(), out int num);
            switch (kv[0].Trim())
            {
                case "post": _post = on; break; case "shadows": _shadows = on; break; case "hdr": _hdrOn = on; break;
                case "cascades": _cascades = Mathf.Clamp(num, 0, 4); break;
                case "shadowres": _res = num; break;
                case "shadowdist": _dist = Mathf.Max(0, num); break;
            }
        }
        Apply();
        Debug.Log($"[gfx] post={(_post ? "on" : "off")} shadows={(_shadows ? "on" : "off")} hdr={(_hdrOn ? "on" : "off")} " +
                  $"cascades={(_cascades == 0 ? "as built" : _cascades.ToString())} shadowres={(_res == 0 ? "as built" : _res.ToString())} " +
                  $"shadowdist={(_dist == 0 ? "as built" : _dist.ToString())}");
    }

    // A CAMERA MADE LATER (spectate's) GETS THE SAME STATE: applied again each second while anything is off
    float _next;
    void Update()
    {
        if (_post && _shadows && _hdrOn && _cascades == 0 && _res == 0 && _dist == 0) return;
        if (Time.unscaledTime < _next) return;
        _next = Time.unscaledTime + 1f;
        Apply();
    }

    void Apply()
    {
        if (GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp)
        {
            if (_shadowDistance < 0f) { _shadowDistance = urp.shadowDistance; _hdr = urp.supportsHDR; _cascadesWas = urp.shadowCascadeCount; _resWas = urp.mainLightShadowmapResolution; }
            urp.shadowDistance = _shadows ? (_dist > 0 ? _dist : _shadowDistance) : 0f;
            urp.shadowCascadeCount = _cascades > 0 ? _cascades : _cascadesWas;
            urp.mainLightShadowmapResolution = _res > 0 ? _res : _resWas;
            urp.supportsHDR = _hdrOn && _hdr;
        }
        foreach (var cam in Camera.allCameras)
        {
            var data = cam.GetComponent<UniversalAdditionalCameraData>();
            if (data == null) continue;
            // EACH CAMERA BACK TO ITS OWN STATE: what it had when first seen here
            if (!_was.TryGetValue(data, out var was)) _was[data] = was = (data.renderPostProcessing, data.antialiasing);
            data.renderPostProcessing = _post && was.post;
            data.antialiasing = _post ? was.aa : AntialiasingMode.None;
        }
    }
}
