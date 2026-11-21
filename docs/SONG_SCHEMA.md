# Formato de la canción (Estudio)

La canción se guarda como JSON en `<datos de la app>/songs/current.json`
(Windows: `%APPDATA%\com.samplerlab.app\songs\current.json`). El núcleo en Rust solo la
guarda: el formato lo define `app/src/features/studio/song.ts`, que también la valida al
cargarla (`normalizeSong`: completa campos faltantes, acota rangos y descarta referencias
rotas).

```jsonc
{
  "version": 8,
  "bpm": 120,                 // 20–300
  "swing": 0,                 // 0 = recto, 1 = tresillo (atrasa cada segunda semicorchea 1/3 de paso)
  "masterVolume": 0.8,        // ganancia lineal 0–1.25
  "key": 9,                   // tonalidad: 0 = C (Do) … 11 = B (Si)
  "scale": "minor",           // major | minor | harmonicMinor | dorian | mixolydian
  "channels": [
    {
      "id": "ch1",
      "name": "Bombo",
      // Sonido: batería incluida (sintetizada) o un sample de la biblioteca.
      "sound": { "kind": "builtin", "id": "kick" },   // kick | snare | clap | hat | openHat | rim
      // "sound": { "kind": "sample", "sessionId": "1762611234567", "sampleId": "smp3" },
      // "sound": { "kind": "synth", "preset": "pad" },   // sub | bass | pad | keys | pluck | lead
      // volume / pan / fx del canal: valen para sus clips de audio (el sonido puesto
      // directo en la línea de tiempo). Dentro de un patrón vale el `mix` del patrón (v8).
      "volume": 0.8,          // 0–1.25
      "pan": 0,               // -1 (izq) – 1 (der)
      "pitch": 0,             // semitonos, -24–24 (cambia velocidad y tono, como un sampler)
      "rootNote": 60,         // nota MIDI en la que el sonido suena tal cual (60 = C4)
      "gate": true,           // las notas del piano roll cortan el sonido al terminar
      // Efectos: EQ en dB (-12–12), compresión y envíos 0–1, y los de "Más
      // efectos" (v6). Los tipos "off" apagan el bloque; sus cantidades se guardan igual.
      "fx": {
        "low": 0, "mid": 0, "high": 0, "comp": 0, "reverb": 0, "delay": 0,
        "drive": "off",        // off | soft (saturación) | hard (distorsión) | crush (crujido digital)
        "driveAmount": 0.5,    // 0–1
        "filter": "off",       // off | low (pasa-bajos) | high (pasa-altos)
        "cutoff": 0.6,         // 0–1 → 40 Hz – 18 kHz (exponencial)
        "resonance": 0.2,      // 0–1 → Q 0,7–12
        "move": 0,             // 0–1: "Movimiento", vaivén del corte al tempo (hasta ±2 octavas)
        "moveRate": 16,        // largo de un vaivén en pasos: 2, 4, 8, 16, 32 o 64
        "mod": "off",          // off | chorus | flanger | phaser
        "modAmount": 0.5,      // 0–1
        "width": 1,            // 0 (mono) – 1 (tal cual) – 2 (muy abierto)
        "duckBy": null,        // "Bombeo": id del canal que lo hace agacharse, o null
        "duckAmount": 0.6      // 0–1
      },
      // Seguir el tempo de la canción: el sample (que va a `bpm`) se estira o acorta sin
      // cambiar el tono. Solo para samples. bpm 0 = desconocido.
      "warp": { "on": false, "bpm": 0 },
      "mute": false,
      "solo": false           // si algún canal tiene solo, suenan solo esos
    }
  ],
  "patterns": [
    {
      "id": "pat7",
      "name": "Patrón 1",
      "steps": 16,            // 16 pasos = 1 compás de 4/4 en semicorcheas
      // Por canal: una intensidad por paso. 0 = apagado, (0, 1] = intensidad.
      "rows": { "ch1": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
      // Piano roll por canal. Un canal usa pasos O notas en cada patrón.
      // start/length en pasos (semicorcheas), pitch = nota MIDI.
      // glide (opcional, pasos): la nota arranca en la altura de la nota anterior y se
      // desliza hasta la suya en ese tiempo (como mucho, lo que dura la nota).
      "notes": { "ch8": [{ "start": 0, "length": 16, "pitch": 57, "velocity": 0.8 },
                         { "start": 16, "length": 8, "pitch": 60, "velocity": 0.8, "glide": 2 }] },
      // Volumen, paneo y efectos de cada canal EN ESTE PATRÓN (v8): el bombo de un patrón
      // puede tener reverb y el de otro no. `fx` tiene la misma forma que el de los canales.
      // Canal sin entrada = volumen 0.8, centro, sin efectos.
      "mix": { "ch1": { "volume": 0.8, "pan": 0, "fx": { "reverb": 0.3, "...": "…" } } }
    }
  ],
  // Línea de tiempo (modo Canción): pistas y clips. Tiempos en pasos (16 = 1 compás).
  // mute / solo: silenciar la pista o dejarla sola (solo gana sobre mute; solo en modo Canción).
  "tracks": [{ "id": "trk2", "name": "Pista 1", "mute": false, "solo": false }],
  "clips": [
    // Un patrón; si el clip es más largo que el patrón, el patrón se repite.
    // gain 0–1.5, fadeIn/fadeOut en pasos (lineales), muted.
    { "id": "clip6", "trackId": "trk2", "start": 0, "length": 64, "kind": "pattern", "patternId": "pat7",
      "gain": 1, "fadeIn": 0, "fadeOut": 16, "muted": false },
    // Un clip de audio: el sonido de un canal tal cual (velocidad original), cortado al
    // final del clip. Usa el volumen, el paneo y los efectos propios del canal.
    { "id": "clip9", "trackId": "trk3", "start": 16, "length": 32, "kind": "audio", "channelId": "ch10" }
  ],
  // Efectos compartidos: delay sincronizado (en pasos; 3 = corchea con puntillo), ping-pong,
  // tamaño de la reverb (room 0,8 s | hall 2,4 s | huge 5 s) y limitador del master.
  "fx": { "delaySteps": 3, "delayFeedback": 0.35, "delayPingPong": false, "reverbSize": "hall", "limiter": true },
  "currentPatternId": "pat7",                // patrón que se está editando
  "nextId": 9                                // contador de ids (nunca se reutilizan)
}
```

**Ids en "Tocar juntos":** en una sala, cada invitado agrega una letra al final de los ids
que crea (`ch12b`, `pat14c`), para que dos personas que agregan algo al mismo tiempo no
choquen. Quien abre la sala no agrega nada. Una canción con esos ids es una canción común:
el número sigue contando para `nextId` y no hace falta cambiar de versión.
`currentPatternId` y `nextId` son de cada persona y no se comparten en la sala.

## Samples de la biblioteca

Un canal con `"kind": "sample"` **referencia** el sample (sesión + id), no lo copia. Si
editás sus efectos en la pestaña Samples, la canción suena con la versión nueva. El audio
lo prepara `library_sample_audio` (Rust), que lo renderiza a un WAV en la caché de la app
con nombre `<sesión>-<sample>-<hash>.wav`. El hash cubre el archivo de origen, el rango y la
cadena de efectos, así que solo se recalcula cuando algo cambió.

Si el sample o su archivo original ya no existen, el canal queda en silencio y muestra ⚠.

## Cómo suena una nota

- **Sample o batería:** se toca más rápido o más lento según la distancia a `rootNote`.
  Una nota 12 semitonos arriba suena una octava más aguda y dura la mitad, como un
  sampler clásico. Con `gate` el sonido se corta al terminar la nota; sin `gate` suena
  entero. Un paso de la grilla toca `rootNote` y siempre suena entero.
- **Sintetizador:** genera la nota con osciladores. La duración es la de la nota (un paso
  de la grilla dura 0,25 s).
- `pitch` del canal se suma siempre (transpone todo el canal).
- **Deslizar (`glide`):** la nota "anterior" es la de la entrada de notas previa (las que
  empiezan juntas cuentan como una) con la altura más cercana; la primera del patrón usa la
  última, porque el patrón se repite. Si la nota está sola, sube desde un tono abajo. El
  sinte mueve la frecuencia de sus osciladores; un sample o instrumento cambia la velocidad
  de reproducción. El MIDI exportado no lleva el deslizamiento (solo las notas).

## Historial de versiones

- **1** (4.1): pasos, patrones, canción.
- **2** (4.2): `notes`, `rootNote`, `gate`, `key`, `scale` y sonidos `synth`. Una canción
  v1 se carga con valores por defecto: La menor, raíz C4, `gate` apagado para la batería
  y prendido para los samples.
- **3** (4.3): `tracks`, `clips`, `fx` (canal y canción). La lista `arrangement` de la v2
  se convierte en clips, uno detrás de otro en la pista 1.
- **4** (4.4): `warp` por canal (por defecto apagado).
- **5**: `gain`, `fadeIn`, `fadeOut`, `muted` por clip (por defecto 1, 0, 0, false). El
  nivel de un clip en una posición es `gain × rampa de entrada × rampa de salida`. Sin
  fade de salida, los sonidos siguen sonando después del final del clip, como siempre.
- **7** (Fase 4): sonidos de paquetes, `{"kind":"pack","packId","itemId"}` (un sonido suelto, suena entero como la batería) y `{"kind":"instrument",…}` (instrumento SFZ: cada nota usa su grabación). Formato en [PACK_SCHEMA.md](PACK_SCHEMA.md). Al cargar se valida el tipo de cada sonido: un canal con un sonido desconocido se descarta.
- **6** (Fase 3): efectos nuevos por canal (`drive*`, `filter`, `cutoff`, `resonance`,
  `move*`, `mod*`, `width`, `duck*`) y de la canción (`delayPingPong`, `reverbSize`). Todo
  apagado por defecto: una canción v5 suena igual. `duckBy` que apunta a un canal que no
  existe (o a sí mismo) se descarta; al borrar un canal, los que se agachaban con él dejan
  de hacerlo.
- **7, sin cambio de versión** (nov. 2026): `mute` y `solo` por pista (por defecto `false`).
  Una canción guardada antes carga con todas las pistas sonando; una versión vieja de la
  app ignora los campos.
- **8** (nov. 2026): `mix` por patrón — volumen, paneo y efectos de cada canal en ese
  patrón. Al cargar una canción v7 (patrones sin `mix`), cada patrón recibe una copia del
  volumen, paneo y efectos que tenía el canal, así que suena igual. `volume`/`pan`/`fx` del
  canal quedan para sus clips de audio. Un patrón nuevo copia volumen y paneo del patrón
  que se estaba editando y arranca sin efectos; uno duplicado copia todo. `mute`, `solo`,
  `pitch` y el resto del canal siguen valiendo para todos los patrones. Una versión vieja
  de la app ignora `mix` (y usaría los efectos del canal).
- **8, sin cambio de versión** (nov. 2026): `glide` opcional por nota del piano roll (pasos,
  0–128). Las notas sin el campo suenan derechas como siempre; una versión vieja de la app
  ignora el campo.

## Time-stretch

Con `warp.on`, el núcleo renderiza el sample estirado al factor `warp.bpm / bpm de la
canción` (comando `library_sample_audio` con `stretch`, algoritmo WSOLA en
`audio/stretch.rs`) y lo guarda en caché por factor. Al cambiar el BPM de la canción sigue
sonando la versión anterior hasta que la nueva está lista.

## Mezcla

```
voces → [distorsión] → EQ (200 Hz / 1 kHz / 5 kHz) → [filtro + movimiento] → [modulación]
      → compresor → volumen → bombeo → [ancho] → paneo ─┬→ master → limitador
                                          envío reverb ←──┤
                                          envío delay  ←──┘ (normal o ping-pong)
```

Los bloques entre [corchetes] solo existen mientras están encendidos. El orden es fijo.
Hay una tira así por canal (para sus clips de audio) y otra por cada canal en cada patrón
que lo usa (`mixStrips` en `song.ts`): si dos patrones suenan a la vez en modo Canción,
el mismo bombo pasa por dos tiras distintas. El bombeo de una tira responde a cada golpe
del canal `duckBy`, venga del patrón que venga.
El bombeo es automatización programada: cada golpe del canal `duckBy` baja el volumen del
canal (a `1 − 0,9 × duckAmount`) y lo deja volver en ~200 ms; pasa igual al exportar y en
los stems, aunque el canal que dispara esté silenciado.

La reverb y el delay son únicos y compartidos: cada canal decide cuánto les manda. Al
exportar, el limitador es de verdad (con anticipación), así que el archivo nunca pasa de
-0,2 dBFS. Los stems se exportan sin limitador, para que sumados den la mezcla.

Cada cambio incompatible sube `version`, y `normalizeSong` migra las versiones anteriores.
