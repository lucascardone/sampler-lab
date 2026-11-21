# Formato de los paquetes de sonidos

Cada paquete instalado vive en `%APPDATA%\com.samplerlab.app\packs\<id>\` con un `pack.json`
que dice qué trae y con qué licencia. Lo lee y escribe `app/src-tauri/src/packs.rs`; la
interfaz usa los tipos de `app/src/lib/api.ts` (`PackInfo`, `PackItem`).

```jsonc
{
  "version": 1,
  "id": "vcsl-keys",                 // = nombre de la carpeta: letras, números, - y _
  "name": "Pianos y teclados",
  "author": "Versilian Studios",
  "license": "CC0-1.0",              // CC0-1.0 | CC-BY-3.0 | CC-BY-4.0 | CC-BY-NC-… | own (tuyo)
  "licenseUrl": "https://…",         // opcional
  "sourceUrl": "https://…",          // opcional
  "origin": "folder",                // folder | catalog | zip | freesound | online
  "installedAt": "2026-11-12T20:00:00",
  "plan": 2,                         // cómo se armó la lista de ítems (ver abajo)
  "items": [
    { "id": "kick-01", "name": "Kick 01", "kind": "oneshot", "file": "Kicks/kick01.wav", "category": "drums" },
    { "id": "grand", "name": "Grand", "kind": "instrument", "sfz": "grand.sfz", "category": "keys" },
    { "id": "fs-12345", "name": "Lluvia", "kind": "oneshot", "file": "12345.ogg", "category": "fx",
      "credit": { "author": "ana", "license": "CC-BY-4.0", "url": "https://freesound.org/s/12345/" } }
  ]
}
```

- `file` y `sfz` son relativos a la carpeta del paquete, con `/`. Nunca salen de ella
  (`packs::safe_relative`).
- `category`: drums | bass | keys | strings | winds | synth | fx | vocals | other (adivinada
  por el nombre al importar).
- `credit` va por sonido cuando el autor o la licencia no son los del paquete.
- Cada `.sfz` que ningún otro `.sfz` incluye (`#include`) es un instrumento; los incluidos
  son partes de él. Los audios que usa un instrumento no se listan como sonidos sueltos.
- `plan` (desde plan 2): los paquetes instalados antes (sin `plan`) se rearman una vez al
  listarlos (`packs::replan`). Los ítems que sobran quedan con `"hidden": true`: la
  biblioteca no los muestra, pero una canción que ya los usaba los sigue encontrando. Los
  `id` y nombres de los demás no cambian.
- Un paquete solo guarda audio (WAV, FLAC, OGG, MP3, M4A, AIFF), instrumentos `.sfz` y
  textos de licencia. Nada se ejecuta.

## Instrumentos (SFZ)

Lector en `app/src/features/studio/sfz.ts`. Subconjunto soportado: `<control> default_path`,
herencia `<global>/<master>/<group>/<region>`, `sample`, `lokey`, `hikey`, `key`,
`pitch_keycenter`, `lovel`, `hivel`, `tune`, `transpose`, `volume`, `ampeg_release`,
`#define`, `#include` (rutas relativas al `.sfz` principal, como sfizz) y keyswitches (suena
solo la articulación por defecto: `sw_default`, si no la `sw_last` más baja). Se saltean las
regiones `trigger=release` y las ondas internas (`sample=*sine`). Lo demás se ignora. Se carga una sola capa de velocidad por rango de teclas (la
del medio). Cada nota usa la zona que la contiene y se afina desde su `pitch_keycenter`.

## En la canción (v7)

```jsonc
"sound": { "kind": "pack", "packId": "mis-sonidos", "itemId": "kick-01" }        // un sonido suelto
"sound": { "kind": "instrument", "packId": "vcsl-keys", "itemId": "grand" }      // instrumento
```

Si el paquete no está instalado, la canción abre igual y ese sonido aparece como faltante.

## Catálogo

`app/src-tauri/catalog.json` (viene con la app; `CATALOG_URL` en `catalog.rs` puede apuntar a
una copia publicada). Cada entrada: `id, name, description, category, author,
license, licenseUrl, attribution?, sourceUrl, downloadUrl (https, .zip), sizeBytes, sha256`.
Instalar: descarga con tope de tamaño → SHA-256 → descompresión que rechaza rutas peligrosas
(`..`, absolutas, unidades, symlinks) → `packs/<id>` en un solo paso.

## Paquete "Sonidos de internet"

Los sonidos sueltos agregados desde la búsqueda en línea (Openverse) van todos a un mismo
paquete con id `sonidos-de-internet`, `origin: "online"` y `license: "mixed"`. La licencia
real está en el `credit` de cada ítem (`author`, `license` CC0-1.0 / CC-BY-x.y / PDM, y `url` =
la página del sonido en su origen). El id del ítem es `ov-` + el comienzo del id de Openverse,
así que agregar el mismo sonido dos veces no lo duplica.

## Catálogo en línea

`catalog_fetch` devuelve `{ entries, onlineOk }`. Cada entrada tiene `source`:
`curated` (`catalog.json`, siempre con `sha256`), `oas` (registro de Open Audio Stack, con
`sha256`) o `github` (zip del repo de `sfzinstruments`/`freepats`, `sha256` vacío y
`sizeBytes` estimado). Un catálogo propio publicado (`CATALOG_URL`) debe fijar `sha256` en
todas las entradas: las que no lo tienen se descartan.
