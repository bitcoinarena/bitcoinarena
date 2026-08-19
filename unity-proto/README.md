# Bitcoin Logistics War — Unity-Prototyp

Grafik-Prototyp zum Vergleich gegen den three.js-Build im Elternverzeichnis.
Er beantwortet genau eine Frage: **sieht dasselbe Spiel in Unity besser aus?**

Umfang: Mempool-Gelände aus Live-Daten, eine kurvige Straße, der fahrbare
Truck auf echter Fahrzeugphysik, volles Licht-Setup. Kein Kampf, keine
Block-Runden, kein HUD — die kommen erst, wenn der Vergleich dafür spricht.

## Einrichtung

Unity Hub und Unity 6 LTS (6000.0.82f1) mit WebGL-Modul sind bereits
installiert. Es fehlt der Schritt, den nur du machen kannst:

1. **Unity Hub öffnen und mit deiner Unity-ID anmelden.** Ohne Anmeldung gibt
   es keine Lizenz, und ohne Lizenz startet der Editor nicht. Unity Personal
   ist kostenlos (Grenze: unter 200.000 USD Umsatz und Finanzierung in
   12 Monaten).
2. Im Hub unter *Installs* prüfen, dass `6000.0.82f1` mit dem Modul
   **WebGL Build Support** gelistet ist.
3. **Neues Projekt** anlegen: Template **Universal 3D** (URP), Name
   `btc-logistics-war-unity`, Speicherort beliebig.
4. Den Ordner `Assets/Scripts` aus diesem Verzeichnis in das neue Projekt
   kopieren.
5. Leere Szene, ein leeres GameObject anlegen, `Bootstrap` daraufziehen,
   Play drücken. Es fährt sofort — mit Platzhalter-Quadern.

## Modelle

Der verlinkte Panzer (Asset Store 225955, *Isle of Assets*) ist kostenlos, aber
**nur Built-in Pipeline**. In einem URP-Projekt sind die Materialien erst
pink. Reparatur: `Window → Rendering → Render Pipeline Converter`,
*Built-in to URP*, `Material Upgrade` ausführen. Custom-Shader überleben das
nicht, Standard-Shader schon.

Assets importieren: im Editor angemeldet über `Window → Package Manager →
My Assets`. Über die Kommandozeile geht das nicht, die Downloads hängen am
Konto.

Danach im `Bootstrap`-Inspector `truckModel` und `wheelModel` zuweisen — die
Platzhalter verschwinden automatisch.

Für den fotorealen Teil (Boden, Asphalt, Umgebung) bleibt Poly Haven die beste
CC0-Quelle: 850 Texturen und 521 gescannte Modelle, dieselbe Quelle wie im
three.js-Build. Material anlegen als URP/Lit, Maps zuweisen:
`diff` → Base Map, `nor_gl` → Normal Map, `arm` → Mask Map (AO/Rough/Metal).

## Was in Unity WebGL anders läuft

Zwei Fallen, die den Port betreffen und die im Browser-Build kein Thema waren:

- **`System.Net.WebSockets` funktioniert in WebGL nicht.** Binance- und
  mempool.space-Streams brauchen eine JS-Bridge. Fertig und MIT-lizenziert:
  [NativeWebSocket](https://github.com/endel/NativeWebSocket).
  `UnityWebRequest` (REST) funktioniert dagegen normal — deshalb holt
  `MempoolTerrain` das Fee-Histogramm per REST und nicht per Stream.
- **HDRP gibt es für WebGL nicht.** URP ist die Obergrenze, das WebGPU-Backend
  ist in Unity 6 noch Preview.

## Dateien

| Datei | Zweck |
|---|---|
| `Bootstrap.cs` | Baut die komplette Szene im Code — keine `.unity`-YAML mit GUID-Referenzen |
| `MempoolTerrain.cs` | Gelände aus dem Live-Fee-Histogramm; Höhe = Gebührenrate, Entfernung = Warteschlangentiefe |
| `TruckController.cs` | Fahrzeugphysik auf `WheelCollider`: Federung, Lastwechsel, Reifenschlupf, Handbremsen-Drift |
| `ChaseCamera.cs` | Verfolgt die Fahrtrichtung statt der Schnauze, damit ein Drift als Drift lesbar ist |

## Status

Kompiliert und läuft. Projekt liegt unter `/Users/arena/My project`,
Szene `Assets/Scenes/Prototype.unity` ist als Build-Szene 0 gesetzt.

PlayMode-Tests: `4 von 5 bestanden`.

| Test | Ergebnis |
|---|---|
| `SceneBuilds` | ✅ Gelände, Truck, Kamera, 4 WheelCollider |
| `TruckRestsOnTheGroundInsteadOfSinking` | ✅ sackt nicht durch, kommt zur Ruhe |
| `StaysUpright` | ✅ kippt nicht |
| `DrivesUnderPower` | ✅ 12 Einheiten in 3 s, Vorwärtstempo 3,1 → 8,0 m/s |
| `HandbrakeBreaksTheRearEndLoose` | ❌ offen |

Der Drift-Test scheitert nicht am Handbremscode, sondern am Tempo: nach 6 s
Gas und 1 s Volleinschlag sind es nur noch **4,1 m/s** (bei 3 s waren es 8,0),
alle vier Räder am Boden. Der Truck klettert das Fee-Relief hoch und der
Lenkeinschlag schrubbt den Rest weg — bei 4 m/s driftet nichts.

Mehr Drehmoment ist *nicht* die Lösung: mit 4800 Nm statt 2600 fuhr er
2,6 statt 12 Einheiten, weil die Reifen nur durchdrehen. Der Rig ist
traktions-, nicht leistungsbegrenzt. Die Stellschrauben sind die
Reifen-Friktionskurven, die Fahrzeugmasse und die Höhe des Reliefs
(`MempoolTerrain.feeHeight` / `baseRelief`) — alles Dinge, die man mit einer
Kamera davor einstellt, nicht über einen Schwellwert im Test.

Der Test bleibt bewusst rot stehen, statt ihn passend zu machen.

## Tests ausführen

```bash
/Applications/Unity/Hub/Editor/6000.0.82f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -runTests -testPlatform PlayMode \
  -projectPath "/Users/arena/My project" \
  -testResults /tmp/results.xml -logFile /tmp/tests.log
```
