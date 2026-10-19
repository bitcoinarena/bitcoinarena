// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// SETTLE ON CORE GROUND (no test named SettleOnCoreGround.cs). Something held at a point and a lift is set
/// down at the ground's height there plus that lift whenever the drawn terrain rebuilds (`MempoolTerrain.Version`).
/// In EditMode no deterministic core answers (`ArenaCore.HasSurface` false), so the ground is the terrain's own analytic
/// relief, `SampleWorld` - the same one Bootstrap.BuildBoundary placed the walls from.
/// </summary>
public class SettleOnCoreGroundTests
{
    GameObject _ground, _settle, _thing;

    // EditMode runs no Awake or Update for a behaviour that does not run in edit mode (and refuses SendMessage to it):
    // the behaviour's own methods are called by name
    static void Call(object o, string method) =>
        o.GetType().GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Invoke(o, null);

    [TearDown]
    public void Clear()
    {
        foreach (var g in new[] { _ground, _settle, _thing }) if (g != null) Object.DestroyImmediate(g);
    }

    MempoolTerrain Terrain()
    {
        _ground = new GameObject("terrain");
        _ground.AddComponent<MeshFilter>();
        _ground.AddComponent<MeshRenderer>();
        var t = _ground.AddComponent<MempoolTerrain>();
        Call(t, "Awake");                                 // its own start: a flat profile, built once (Version 1)
        return t;
    }

    [Test]
    public void AHeldThingIsSetDownAtTheGroundsHeightPlusItsLift()
    {
        Assert.IsFalse(Arena.ArenaCore.HasSurface, "a core answers in EditMode: not the case this test names");
        var terrain = Terrain();
        Assert.Greater(terrain.Version, 0, "the terrain did not build");
        _settle = new GameObject("settle");
        var settle = _settle.AddComponent<Arena.SettleOnCoreGround>();
        settle.terrain = terrain;
        _thing = new GameObject("wall");
        _thing.transform.position = new Vector3(0f, 999f, 0f);
        const float x = 37.5f, z = -12.25f, lift = 1.5f;
        settle.Hold(_thing.transform, x, z, lift);
        Call(settle, "Update");
        float ground = terrain.SampleWorld(x, z);
        Assert.AreEqual(ground, settle.Surface(x, z), 1e-5f, "the surface is not the terrain's own relief");
        Assert.AreEqual(new Vector3(x, ground + lift, z), _thing.transform.position, "not at the ground's height plus its lift");
    }

    [Test]
    public void ItMovesOnlyWhenTheTerrainRebuilds()
    {
        var terrain = Terrain();
        _settle = new GameObject("settle");
        var settle = _settle.AddComponent<Arena.SettleOnCoreGround>();
        settle.terrain = terrain;
        _thing = new GameObject("wall");
        settle.Hold(_thing.transform, 5f, 5f, 0.5f);
        Call(settle, "Update");
        var placed = _thing.transform.position;
        _thing.transform.position = placed + Vector3.up * 3f;    // moved by something else since
        Call(settle, "Update");                           // same Version: left alone
        Assert.AreEqual(placed + Vector3.up * 3f, _thing.transform.position);
        terrain.Build();                                         // a rebuild (Version + 1): set down again
        Call(settle, "Update");
        Assert.AreEqual(placed, _thing.transform.position);
    }

    [Test]
    public void WithNoTerrainNothingIsMovedAndTheSurfaceIsZero()
    {
        _settle = new GameObject("settle");
        var settle = _settle.AddComponent<Arena.SettleOnCoreGround>();
        _thing = new GameObject("wall");
        _thing.transform.position = new Vector3(1f, 2f, 3f);
        settle.Hold(_thing.transform, 1f, 3f, 0.5f);
        settle.Hold(null, 0f, 0f, 0f);                           // a null is not held
        Call(settle, "Update");
        Assert.AreEqual(new Vector3(1f, 2f, 3f), _thing.transform.position);
        Assert.AreEqual(0f, settle.Surface(1f, 3f));
    }
}
