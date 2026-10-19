// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.TestTools;

/// <summary>
/// SPECTATE, FLOWN WITH A MOUSE (2026-09-18 21:52, photographed: "I can press it with the mouse but it won't do
/// anything ... and only on spectate").
///
/// The pad under his pointer was drawn HELD - TouchControls reads the mouse - while the camera stood still, because
/// this mode collected its pointers from the touchscreen alone. On a desktop that list is always empty. These press a
/// real mouse device on the pads' own rectangles and ask the camera where it went.
/// </summary>
public class SpectatePadsTests
{
    SpectatorCamera _spec;
    GameObject _go;
    Mouse _mouse;
    InputSettings.BackgroundBehavior _focus;
    InputSettings.EditorInputBehaviorInPlayMode _editorFocus;

    [SetUp]
    public void Watching()
    {
        _go = new GameObject("spectator", typeof(Camera));
        _spec = _go.AddComponent<SpectatorCamera>();
        _spec.Enter();

        // A batchmode editor has no game view to focus, and the editor routes pointer input to whichever window has
        // it. Both are put back in TearDown; the camera is not changed to suit them.
        _focus = InputSystem.settings.backgroundBehavior;
        _editorFocus = InputSystem.settings.editorInputBehaviorInPlayMode;
        InputSystem.settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
        InputSystem.settings.editorInputBehaviorInPlayMode =
            InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
        _mouse = InputSystem.AddDevice<Mouse>();
    }

    [TearDown]
    public void Away()
    {
        if (_mouse != null) InputSystem.RemoveDevice(_mouse);
        InputSystem.settings.backgroundBehavior = _focus;
        InputSystem.settings.editorInputBehaviorInPlayMode = _editorFocus;
        if (_go != null) Object.DestroyImmediate(_go);
    }

    /// <summary>Hold the left button on a pad for a second of frames, and say how far the camera moved.</summary>
    IEnumerator Hold(TouchPad.Pad pad, System.Action<Vector3, Vector3> then)
    {
        var centre = TouchPad.RectFor(pad, Screen.width, Screen.height).center;
        var at = new Vector2(centre.x, Screen.height - centre.y);   // GUI space is y down, input space is y up
        Vector3 from = _spec.transform.position;
        for (float t = 0f; t < 1f; t += Time.unscaledDeltaTime)
        {
            InputSystem.QueueStateEvent(_mouse, new MouseState { position = at }.WithButton(MouseButton.Left));
            InputSystem.Update();
            yield return null;
        }
        then(from, _spec.transform.position);
    }

    [UnityTest]
    public IEnumerator TheForwardPadFliesTheCameraWithAMouse()
    {
        var facing = _spec.transform.forward;
        yield return Hold(TouchPad.Pad.Up, (from, to) =>
        {
            float travelled = Vector3.Distance(from, to);
            Assert.Greater(travelled, 1f, $"the mouse on the forward pad moved the camera {travelled:0.00} units");
            Assert.Greater(Vector3.Dot((to - from).normalized, facing), 0.7f, "it did not fly the way it was looking");
        });
    }

    [UnityTest]
    public IEnumerator TheSidePadsFlySidewaysWithAMouse()
    {
        var right = _spec.transform.right;
        yield return Hold(TouchPad.Pad.Right, (from, to) =>
            Assert.Greater(Vector3.Dot((to - from).normalized, right), 0.7f,
                           "the right pad did not fly the camera to its right"));
    }

    /// <summary>A press ON a pad flies; it must not also drag the view round, or the camera spins as it moves.</summary>
    [UnityTest]
    public IEnumerator PressingAPadDoesNotAlsoTurnTheCamera()
    {
        var facing = _spec.transform.rotation;
        yield return Hold(TouchPad.Pad.Up, (_, __) =>
            Assert.Less(Quaternion.Angle(facing, _spec.transform.rotation), 0.5f,
                        "pressing the forward pad turned the camera as well as moving it"));
    }
}
