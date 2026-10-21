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

Tests: EditMode `34/34`, PlayMode `9/10`.

| Test | Ergebnis |
|---|---|
| `SceneBuilds` | ✅ Gelände, Truck, Kamera, 4 WheelCollider |
| `TruckRestsOnTheGroundInsteadOfSinking` | ✅ sackt nicht durch, kommt zur Ruhe |
| `StaysUpright` | ✅ kippt nicht |
| `DrivesUnderPower` | ✅ 12 Einheiten in 3 s |
| `StaysOnTheMapUnderSustainedThrottle` | ✅ 20 s Dauergas, bleibt in der Karte |
| `HandbrakeBreaksTheRearEndLoose` | ❌ offen |

Im Browser gemessen: 56 km/h, 4/4 Räder am Boden, 56 Einheiten zurückgelegt.

## Steuerung

| Taste | Wirkung |
|---|---|
| `W` / `↑` | Gas |
| `S` / `↓` | Bremse, dann Rückwärtsgang |
| `A` `D` / `←` `→` | Lenken |
| `Leertaste` | Handbremse |
| `R` | Truck zurücksetzen |
| `G` oder `Tab` | Übersicht ↔ Verfolgeransicht |

Erst **ins Canvas klicken**, sonst gehen die Tasten an die Seite.

Auf Geräten mit Touchscreen erscheinen zusätzlich Bildschirmtasten: Lenkung
links, Gas und Bremse rechts, Handbremse dazwischen, Ansichtswechsel oben
rechts. Sie sind bewusst *nicht*
mit `GUI.Button` gebaut — das löst immer nur einen Druck gleichzeitig auf, und
Fahren braucht Gas und Lenken zusammen. Stattdessen werden die Fingerpositionen
direkt gegen die Flächen geprüft, also zählt jeder Finger.

Die Pfeile sind als Dreiecke in Texturen gerastert statt als Schriftzeichen:
die geometrischen Unicode-Formen sind in der Standardschrift nicht garantiert
und würden als leere Kästchen erscheinen.

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

## Im Browser aufrufen

```bash
cd unity-proto && python3 serve-unity.py 8900
```

Der Build liegt unter `build/webgl/` (nicht in git, 55 MB).

Neu bauen:

```bash
/Applications/Unity/Hub/Editor/6000.0.82f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -quit -nographics -buildTarget WebGL \
  -projectPath "/Users/arena/My project" \
  -executeMethod BuildWebGL.Run -logFile /tmp/webgl.log
```

Zwei Dinge, die dabei zwingend sind:

- **Kompression aus.** Unity liefert per Default Brotli, was den Server zwingt,
  `Content-Encoding` zu setzen. Ein einfacher Static-Server tut das nicht, und
  der Player lädt dann gar nicht. `serve-unity.py` setzt außerdem die
  MIME-Typen für `.wasm` und `.data`, die Python nicht kennt.
- **Materialien müssen Assets sein.** Unbelegte Material-Slots fallen auf
  Unitys Standardmaterial zurück — Built-in-Shader, im URP-Build nicht
  vorhanden, alles magenta. `BuildPrototypeScene` legt deshalb vier
  URP/Lit-Materialien unter `Assets/Materials/` an und hängt sie an die Szene,
  was sie zugleich vor dem Shader-Stripper schützt.

### Startlast

Gemessen am aktuellen Build:

| | anfangs | jetzt |
|---|---|---|
| `webgl.wasm` (Code) | 45,4 MB | **8,2 MB** |
| `webgl.data` (Inhalte) | 39,3 MB | **11,3 MB** |
| **Start gesamt** | 85 MB | **19,6 MB** |

Dazu kommen ~14 MB Modell-Pakete, die **nach** dem Start geladen werden.

Zwei Schritte dahin, und der zweite war der wichtige:

1. **Brotli** (85 → 35,5 MB). Der Code komprimiert fünffach, die Daten kaum.
2. **Texturgrößen begrenzt** (35,5 → 19,6 MB). Der Build-Report zeigte 68 MB
   Texturen, allein acht Panzer-Maps in 2048² für 42 MB davon. Auf einer
   260-Meter-Karte ist ein Panzer wenige Pixel hoch. Gedeckelt auf 512 für
   Fahrzeuge und Figuren, 1024 für Boden und Straße.

Die Begrenzung sitzt im **Import**, nicht in den Dateien — die Originale bleiben
unangetastet, ein höheres Limit kostet einen Reimport.

Brotli ist aktiv, mit `decompressionFallback`. Ohne den bräuchte der Server
zwingend `Content-Encoding`-Header und der Player lädt sonst gar nicht; mit ihm
packt der Loader notfalls in JavaScript aus — langsamer, aber es startet.

Zum Vergleich lädt das three.js-Spiel **1,6 MB** bis zum ersten Bild
(three.js + Spielcode); seine 15 MB Assets kommen asynchron nach.

Der Code-Anteil ist der Sockel: er schrumpft nicht, wenn man Inhalte
auslagert.

## Tests ausführen

```bash
/Applications/Unity/Hub/Editor/6000.0.82f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -runTests -testPlatform PlayMode \
  -projectPath "/Users/arena/My project" \
  -testResults /tmp/results.xml -logFile /tmp/tests.log
```

## Assets

Gescannte CC0-Oberflächen von [Poly Haven](https://polyhaven.com), 2k JPG,
unter `Assets/Textures/`. Keine Installation nötig, keine Namensnennung
verlangt (CC0), Nutzung auch kommerziell frei.

| Datei | Quelle | Verwendung |
|---|---|---|
| `ground/aerial_ground_rock_*` | polyhaven.com/a/aerial_ground_rock | Gelände-Detail |
| `road/asphalt_02_*` | polyhaven.com/a/asphalt_02 | Straßenbelag |

Sie hängen in den **Detail**-Slots von URP/Lit, nicht in der Base Map. Die ist
beim Gelände schon belegt: dort liegt die Territoriumstextur, die die ganze
Welt mit 0..1 abdeckt, damit die Frontlinie genau einmal erscheint. Eine
gekachelte Fotografie kann dort nicht hin. Die Detail-Maps haben eine eigene
Kachelung — weltweite Farbe unten, gescanntes Korn und Relief darüber.

## Effekt-Assets

Der [VFX Particles: Fireball Pack](https://assetstore.unity.com/packages/vfx/particles/fire-explosions/free-asset-vfx-particles-fireball-pack-263814)
(kostenlos, URP) liefert seine Effekte als **Visual Effect Graph**. Das läuft in
WebGL nicht: VFX Graph braucht Compute-Shader, die WebGL 2 nicht hat — die
`.vfx`-Prefabs sähen im Editor richtig aus und würden im Build nichts zeichnen.

Verwendet werden deshalb die **Flipbook-Texturen** des Packs
(`FireBall01_8x8.exr`) in einem klassischen Partikelsystem, das dort läuft. Die
Kunst überlebt, der Effektgraph nicht.

## Streaming der Modelle

Die vier Modelle (Soldat, Panzer, Truck, Helikopter) liegen nicht im Player,
sondern in Addressables-Paketen unter `build/webgl/ServerData/`. Das Spiel
startet auf Quader-Platzhaltern und tauscht jedes Modell ein, sobald sein Paket
da ist.

Zwei Fallen dabei, beide nur im Build sichtbar:

- **Die Szene darf die Modelle nicht referenzieren.** Was eine Szene
  referenziert, landet im Player — genau das Gewicht, das Streaming entfernen
  soll.
- **WebGL braucht absolute URLs.** Ein relativer Pfad wird vom
  `AssetBundleProvider` abgelehnt (`Invalid path`), die Anfrage wird gar nicht
  gestellt. Eine absolute URL zur Build-Zeit würde den Build aber an einen Host
  binden. `ModelStreamer` schreibt die Pfade deshalb beim Laden um, gegen die
  URL der Seite.

Neu bauen: erst `SetupAddressables.BuildContent`, dann `BuildWebGL.Run`, dann
`ServerData/` neben den Build kopieren.

### Das Streaming braucht einen sicheren Kontext

Über `http://<LAN-IP>:8900/` lädt Addressables **seinen eigenen Katalog nicht**
— die Anfrage an `StreamingAssets/aa/settings.json` wird nicht einmal gestellt,
die Initialisierung meldet „Unable to load runtime data", und jeder Schlüssel
scheitert danach mit „No Location found".

Derselbe Build über `http://127.0.0.1:8900/` oder über HTTPS lädt alles. Der
Unterschied ist der sichere Kontext: `localhost` gilt dem Browser als
vertrauenswürdig, eine LAN-IP über einfaches HTTP nicht.

`serve-unity.py` liefert deshalb über **HTTPS** aus, mit einem selbst
ausgestellten Zertifikat aus `certs/`. Es ist auf die LAN-IP ausgestellt, und
zwar im `subjectAltName` — moderne Browser ignorieren den `CN` vollständig, ein
Zertifikat ohne SAN wird rundheraus abgelehnt.

Neu ausstellen, wenn sich die IP ändert:

```bash
cd unity-proto && IP=$(ipconfig getifaddr en0)
sed -i '' "s/CN = .*/CN = $IP/; s/IP:[0-9.]*,/IP:$IP,/" certs/openssl.cnf
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/server.key -out certs/server.crt -config certs/openssl.cnf
```

Der Browser warnt einmal pro Gerät, weil das Zertifikat selbst ausgestellt ist.
Das ist der ganze Preis dafür, den Verkehr im eigenen Netz zu halten statt ihn
durch einen Tunnel zu schicken.
