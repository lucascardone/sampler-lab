# Modelos de separación y sus licencias

Última revisión: 2026-11-08.

## Qué usa la app hoy

| Modo en la app | Modelo | Stems | Descarga | Licencia del código | Licencia de los pesos |
|---|---|---|---|---|---|
| Rápido | `htdemucs` | voz, batería, bajo, otros | ~84 MB | MIT | **No clara** (ver abajo) |
| Mejor calidad | `htdemucs_ft` (4 modelos) | voz, batería, bajo, otros | ~336 MB | MIT | **No clara** |
| Guitarra / Piano | `htdemucs_6s` | + guitarra, piano | ~55 MB | MIT | **Probablemente CC BY-NC (no comercial)** |

- Código: [`demucs` 4.1.x](https://github.com/adefossez/demucs) (fork mantenido por el autor
  original; el repo de facebookresearch está archivado). Licencia MIT.
- Pesos: se descargan **en la computadora del usuario la primera vez que se usan**, desde
  Hugging Face (`adefossez/HTDemucs`, `HTDemucs-ft`, `HTDemucs-6s`), a la carpeta de datos de
  la app (`%APPDATA%\com.samplerlab.app\models`). **La app no redistribuye los pesos.**

## El problema de licencia de los pesos

El README oficial de Demucs dice textualmente:

> Demucs code is released under the MIT license [...]. The license of the weights is not
> clear: MusDB contains some data that were only usable for research purpose. [...] The 6
> source variant of htdemucs was trained only on Meta internal dataset, which likely means
> CC-NC-BY license is applicable, as it was the case for all models released by FAIR.

Las tarjetas de los modelos en Hugging Face no declaran licencia.

### Qué significa en la práctica

- **Uso personal o para producir tu música**: el riesgo es bajo. Es como usar cualquier
  separador basado en Demucs, que es lo que hace la mayoría de las herramientas del mercado.
- **Distribuir Sampler Lab como producto** (gratis o pago): no conviene **empaquetar** los
  pesos con el instalador. Por eso hoy se descargan aparte desde la fuente original. Antes de
  un lanzamiento comercial conviene una consulta legal.
- **`htdemucs_6s` (guitarra/piano)**: tratarlo como **no comercial** hasta que se aclare.
  Si la app se vende, ese modo debería ser opcional y mostrar un aviso.

## Alternativas a evaluar (se pueden enchufar en `SeparationBackend`)

| Opción | Calidad | Licencia | Nota |
|---|---|---|---|
| RoFormer (BS/Mel) de la comunidad | Mejor que Demucs en voz | Varía por checkpoint; muchos sin licencia | Revisar uno por uno antes de usar |
| Entrenar/afinar pesos propios con datos con licencia | — | Propia | Caro, pero elimina el riesgo |
| API en la nube con licencia comercial | Buena | Contrato del proveedor | Costo por uso, sale de "todo local" |

## Cómo se agrega un modelo nuevo

1. Implementar `SeparationBackend` (`engine/sampler_engine/separation/backend.py`).
2. Registrar qué stems produce y cuánto tarda (`separation/stems.py`).
3. Agregar una fila a la tabla de arriba **con la licencia verificada** y el enlace a la fuente.
