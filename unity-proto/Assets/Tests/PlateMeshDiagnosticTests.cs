// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Text;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// WHAT EVERY LETTERED PLATE IS ACTUALLY HOLDING (2026-09-18 22:16 close-out).
///
/// The whitepaper was fitted to the wrong box twice - once because static batching had swapped the plate's mesh for
/// the whole building, once because the face was read as a world-axis box and a portrait plate came back landscape.
/// Both faults are invisible from the names: the plate answered with a size, and the size was of something else.
///
/// So this prints, for every TextMesh in the built world, what the code is holding rather than what it is called:
/// the plate's name, whether its renderer is in a static batch, the mesh it is drawing, that mesh's own size at the
/// scale it is drawn, the world-axis box round it, and the lettering measured both ways. A plate whose mesh size and
/// world box disagree wildly is on a swapped mesh; a plate whose local and world text sizes disagree is being
/// measured in a space it is not drawn in.
///
/// It asserts the two things the letter is about - no lettered plate is batched, and none is drawing a mesh far
/// bigger than the plate itself - and prints the table either way.
/// </summary>
public class PlateMeshDiagnosticTests
{
    [UnitySetUp]
    public IEnumerator SetUp()
    {
        LogAssert.ignoreFailingMessages = true;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        for (float t = 0f; t < 30f && GameObject.Find("MempoolPostOffice") == null; t += Time.deltaTime)
            yield return null;
        yield return new WaitForSeconds(3f);          // the fits run on the frames after the mesh exists
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown() { Time.timeScale = 1f; yield return null; }

    static Vector3 Scaled(Vector3 size, Vector3 lossy) =>
        new Vector3(size.x * Mathf.Abs(lossy.x), size.y * Mathf.Abs(lossy.y), size.z * Mathf.Abs(lossy.z));

    [UnityTest]
    public IEnumerator EveryLetteredPlateDrawsItsOwnMesh()
    {
        yield return null;

        var table = new StringBuilder("\n[plates] plate | batched | mesh | mesh size x scale | world box | text local | text world\n");
        var batched = new System.Collections.Generic.List<string>();
        var swapped = new System.Collections.Generic.List<string>();
        int seen = 0;

        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            var plate = tm.transform.parent;
            if (plate == null) continue;
            var plateR = plate.GetComponent<MeshRenderer>();
            var plateF = plate.GetComponent<MeshFilter>();
            var textR = tm.GetComponent<MeshRenderer>();
            if (plateR == null || textR == null) continue;
            seen++;

            var mesh = plateF != null ? plateF.sharedMesh : null;
            Vector3 meshSize = mesh != null ? Scaled(mesh.bounds.size, plate.lossyScale) : Vector3.zero;
            Vector3 worldBox = plateR.bounds.size;
            Vector3 textLocal = Scaled(textR.localBounds.size, tm.transform.lossyScale);
            Vector3 textWorld = textR.bounds.size;

            table.Append($"[plates] {plate.name} | {(plateR.isPartOfStaticBatch ? "BATCHED" : "own")} | ")
                 .Append($"{(mesh != null ? mesh.name : "none")} | ")
                 .Append($"{meshSize.x:F1}x{meshSize.y:F1}x{meshSize.z:F1} | ")
                 .Append($"{worldBox.x:F1}x{worldBox.y:F1}x{worldBox.z:F1} | ")
                 .Append($"{textLocal.x:F1}x{textLocal.y:F1} | {textWorld.x:F1}x{textWorld.y:F1}\n");

            if (plateR.isPartOfStaticBatch) batched.Add(plate.name);

            // A plate drawing a mesh several times its own world box is drawing somebody else's geometry - that is
            // what "the plate reported the building" looked like in numbers.
            float biggestMesh = Mathf.Max(meshSize.x, Mathf.Max(meshSize.y, meshSize.z));
            float biggestBox = Mathf.Max(worldBox.x, Mathf.Max(worldBox.y, worldBox.z));
            if (mesh != null && biggestBox > 0.01f && biggestMesh > biggestBox * 2f)
                swapped.Add($"{plate.name} draws a {biggestMesh:F1} m mesh in a {biggestBox:F1} m box");
        }

        Debug.Log(table.ToString());
        Assert.Greater(seen, 12, $"only {seen} lettered plates found - the building did not stream in");
        Assert.IsEmpty(batched, "lettered plates inside a static batch, so their mesh is the combined one: "
                                + string.Join(", ", batched));
        Assert.IsEmpty(swapped, "lettered plates drawing a mesh that is not theirs: " + string.Join("; ", swapped));
    }
}
