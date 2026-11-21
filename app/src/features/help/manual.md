# En la PC

## Qué es Sampler Lab

Sampler Lab sirve para sacar pedacitos de canciones (samples) y armar música con ellos.

Tiene dos pestañas, arriba a la izquierda:

- **Samples**: abrís o grabás audio, cortás las partes que te gustan, les ponés efectos y separás instrumentos.
- **Estudio**: combinás esos samples con una batería y un sintetizador para hacer beats y canciones.

Todo se guarda solo. Si cerrás la ventana, la app sigue en la bandeja de Windows (al lado del reloj); para salir de verdad: clic derecho en el ícono → Salir.

## Conseguir audio

Hay dos formas:

1. **Abrir un archivo**: arrastrá un MP3, WAV, FLAC, etc. a la ventana, o tocá **Abrir archivo**.
2. **Grabar lo que suena en la PC** (YouTube, Spotify, lo que sea): tocá **Grabar audio** arriba a la derecha, poné la canción, y volvé a tocar para parar. También se puede desde el ícono de la bandeja: un clic empieza, otro clic para.

Las grabaciones quedan en `Música\Sampler Lab` y aparecen en la lista **Grabaciones**. Un clic en una la abre.

## Renombrar y borrar

Todo lo que está en una lista (grabaciones, samples, y los samples de la biblioteca del Estudio) tiene un botón **⋯** a la derecha con **Renombrar** y **Borrar**. También podés hacer **doble clic en el nombre** para renombrar.

- Al renombrar, escribís el nombre nuevo y **Enter** (o clic afuera). **Esc** cancela.
- **Renombrar una grabación** cambia el nombre del archivo en la carpeta. Los samples que cortaste de ella siguen funcionando.
- **Borrar una grabación** la manda a la **papelera de reciclaje**: si te arrepentís, la recuperás desde ahí. Si cortaste samples de ella, la app te avisa antes, porque esos samples dejan de sonar.
- **Borrar un sample** no se puede deshacer. Desde el Estudio podés borrar samples de cualquier sesión, aunque no sea la que tenés abierta. Si tu canción lo usa, te avisa: ese sonido queda mudo.
- **Renombrar un sample** en el Estudio también cambia el nombre del sonido en tu canción (si no le habías puesto otro).

## Cortar un sample

1. Con el audio abierto, **arrastrá sobre la onda** para marcar la parte que querés.
2. Tocá **Guardar como sample** (o Enter).
3. Repetí con todas las partes que quieras: quedan en la lista **Samples** de la izquierda.

**Espacio** reproduce o para. **Repetir** hace que la selección suene en loop, útil para afinar el corte. **Cortes sin clics** acomoda los bordes para que no hagan ruido.

## Efectos de un sample

Elegí un sample en la lista y usá los botones de abajo de la onda:

- **Recortar**, **Fade in**, **Fade out**, **Normalizar** (subir el volumen al máximo sin saturar), **Invertir** (al revés) y **Volumen**.
- Si marcás una parte de la onda, el efecto se aplica solo ahí; si no, a todo el sample.

A la derecha está la lista de efectos: con la tilde los apagás, con las flechas cambiás el orden, con la cruz los quitás. **Ctrl+Z** deshace.

Arriba del sample ves lo que la app detectó: su **tempo (BPM)**, su **tonalidad** y su **nota**. Si aparece en gris punteado es porque no está muy segura.

## Separar instrumentos

Con un sample elegido, tocá **Separar instrumentos**, elegí qué querés (voz, batería, bajo, guitarra, piano u otros) y **Separar**.

La primera vez hay que **preparar el separador**, una sola vez. La app se fija qué tiene tu PC y te ofrece lo que conviene:

- **Con placa de video NVIDIA**: baja unos 3 GB y separa en segundos. Si preferís bajar menos, está la **versión liviana** (250 MB), que usa el procesador.
- **Sin placa NVIDIA**: baja unos 250 MB y usa el procesador. Anda bien con samples cortos (unos segundos cada uno); con una canción entera puede tardar varios minutos. Si no lo vas a usar, tocá **Ahora no**: el resto de la app funciona igual.

Después funciona sin internet. Si cambiás de idea, **Cambiar versión** (arriba del panel) te deja elegir la otra.

Cuando termina, escuchás cada parte con solo y mute, y **Guardar como sample** la suma a tu lista.

## Exportar samples

**Exportar WAV** guarda el sample elegido (o solo la parte marcada). **Exportar todos** guarda todos los samples en una carpeta. El formato recomendado es WAV PCM 24 bit; mono sirve para bombos, bajos y voces.

## La pantalla del Estudio

- **Izquierda, la barra de paneles**: tres botones fijos. **Sonidos** muestra la biblioteca, **Patrones** la lista de patrones de la canción (con cuántos hay), y **Ocultar** esconde el panel para que el editor tenga más lugar (**Mostrar** lo vuelve a abrir). Tocar el botón del panel que ya está abierto también lo oculta. La app se acuerda de cómo lo dejaste.
- **Panel Sonidos, la biblioteca**: la batería incluida, el sintetizador, tus samples y tus paquetes, en carpetas que se abren y cierran con un clic (la flechita). Un clic en un nombre lo escucha; **+** lo agrega como sonido; el otro botón lo pone directo en la canción; **⋯** lo renombra o lo borra.
  - **Buscar sonidos** (arriba de todo): escribí parte del nombre ("kick", "tuba", "piano") y ves lo que coincide en toda la biblioteca, agrupado por de dónde viene. Borrá el texto (o tocá Esc) para volver a las carpetas.
  - Los paquetes empiezan cerrados. Los grandes se ordenan solos en carpetas: **Instrumentos** primero y después una carpeta por tipo de sonido (Baterías, Bajos, Efectos…) o por las carpetas que trae el paquete. Al abrir un paquete ves su licencia y su autor.
  - Las listas largas muestran 40 sonidos y un botón **Mostrar más**.
  - El botón de las dos flechitas (al lado de Actualizar) **cierra todas las carpetas**. La app se acuerda de qué dejaste abierto.
- **Arriba, transporte**: reproducir/parar, la pantalla con la posición y el **BPM** (escribís el número y Enter), modo **Patrón** o **Canción**, swing, metrónomo y deshacer.
- **Panel Patrones**: todos tus patrones, uno abajo del otro, con su color y su largo. Un clic elige cuál editar (queda resaltado); un puntito verde marca los que están sonando y el ícono de canción, los que ya pusiste en la canción. **Nuevo patrón** crea uno; **⋯** lo duplica, lo pone en la canción, lo renombra o lo borra.
- **Centro, editor**: arriba dice qué patrón estás editando (el menú con su color: también sirve para cambiar de patrón con el panel oculto) y abajo la grilla de pasos (o el piano roll).
- **Abajo, canción**: la línea de tiempo donde ordenás los patrones. La línea entre el editor y la canción se arrastra para darle más lugar a uno u otro.
- **Derecha, inspector**: las opciones de lo que tengas elegido. Un clic en el nombre de un sonido muestra sus opciones; un clic en un clip de la canción, las del clip; **Esc** vuelve al master.

Cada sonido tiene un color, y lo mantiene en todos lados.

## Hacer un beat

1. Tocá los cuadraditos de la grilla para poner golpes. Arrastrá para pintar varios. **Clic derecho** cambia la intensidad.
2. **Espacio** para escuchar. Cambiá el BPM y el swing mientras suena.
3. **M** silencia un sonido, **S** lo deja solo. El deslizador es su volumen en este patrón.
4. Para usar tus samples, agregalos desde la biblioteca con **+**: aparecen como una fila más.
5. **+** al lado del patrón (o **Nuevo patrón** en el panel Patrones) crea uno nuevo; el botón de copiar lo duplica para hacer una variación. **Largo** (botones 1, 2, 4, 8) cambia la cantidad de compases. Un patrón nuevo arranca con el mismo volumen y paneo que el que estabas editando, pero sin efectos; uno duplicado se lleva todo.

## Melodías y acordes

1. Elegí un sonido (clic en su nombre) y tocá **Piano roll**.
2. **Clic** pone una nota, **arrastrar** la mueve, el borde derecho la alarga y **clic derecho** la borra. Clic en el teclado de la izquierda la escucha.
3. **Tonalidad** (por ejemplo "La menor"): abre un tecladito para elegir la nota y la lista de escalas, cada una con cómo suena (alegre, triste, rockera…). Las notas que combinan quedan resaltadas. Con la herramienta **Acorde**, un clic pone un acorde entero que combina; al lado elegís **Tríada** o **Con séptima** y la inversión. **Largo** abre los largos de nota (de 1/16 a 2 compases), cada uno explicado.
4. El menú **Acordes y arpegios** inserta progresiones listas (por ejemplo Am F C G), las convierte en arpegios o las sube y baja de octava.
5. **Deslizar** (la tercera herramienta, al lado de Nota y Acorde): clic en una nota y llega deslizándose desde la nota anterior, como un bajo de sinte o un tobogán. Otro clic se lo saca. Clic en un lugar vacío pone una nota que ya se desliza. En **Llega** elegís cuánto tarda: **Rápido** (1/16), **Medio** (1/8), **Lento** (1/4) o **Toda la nota**. Las notas se ven como tubos de luz: cuando una se desliza, el tubo se curva desde la nota anterior, con un punto blanco donde arranca el deslizamiento.
6. El menú **Transformar** cambia todas las notas del sonido en este patrón con un clic. Si no te gusta, **Deshacer** (Ctrl+Z).

Lo que trae **Transformar**:

- Deslizar: **Deslizar todas**, **Glissando** (llega a cada nota corriendo por la escala, nota por nota) y **Quitar deslizamientos**.
- Ritmo y largo: **Unir notas** (cada una dura hasta la siguiente), **Notas cortas**, **Picar** (las largas se repiten en 1/16), **Doble de rápido**, **Mitad de rápido** y **Al revés**.
- Notas: **Ajustar a la escala** (las que desafinan pasan a la más cercana), **Espejo** (lo que subía baja) y **Mezclar notas** (mismo ritmo, notas cambiadas de lugar).
- Fuerza: **Crecer**, **Apagarse** y **Humanizar** (cambia un poco la fuerza de cada nota).

El deslizamiento suena en la app y en el WAV exportado; el archivo MIDI exportado lleva las notas sin deslizar.

Tus samples también se tocan en distintas notas, como en un sampler. Para que queden afinados, en el inspector revisá **Nota del sample** (abre un tecladito con la octava arriba) o tocá **Detectar**.

## Armar la canción

- **Poner en la canción** (arriba del editor) agrega el patrón actual al final.
- **Doble clic** en una pista pega lo elegido en **Pegar**: un patrón o un sample tal cual.
- Los clips se **arrastran** para moverlos, se **estiran** desde el borde derecho (un patrón estirado se repite) y se borran con **clic derecho** o **Supr**.
- Clic en la regla de arriba pone la marca **▼**: desde ahí arranca la reproducción.
- Pasá a modo **Canción** para escuchar el tema entero.
- Cada pista tiene **M** (silenciarla) y **S** (escuchar solo esa). Lo que está en una pista silenciada se ve apagado.
- Para varias a la vez: marcá el cuadradito de cada pista (o el de **Pistas**, arriba, para todas). Aparece una barra con **Silenciar**, **Solo estas** y **Quitar selección**. **Que suene todo** saca el silencio y el solo de todas las pistas.
- **⋯** al lado de una pista la renombra o la borra.

## Volumen y fades de un clip

Clic en un clip de la canción y en el inspector ajustás:

- **Volumen** del clip (0 a 150%).
- **Fade de entrada** y **fade de salida**: el volumen sube o baja de a poco. También se arrastran desde las esquinas de arriba del clip.
- **Silenciar clip**.

Sobre el clip se dibuja la curva de volumen.

## Efectos y mezcla

Elegí un sonido y en el inspector, sección **Efectos**.

**Cada patrón tiene su propia mezcla.** El volumen, el paneo y los efectos de un sonido valen solo en un patrón: si le ponés reverb al bombo en el estribillo, el bombo de la intro sigue seco. Arriba del inspector, en **Volumen y efectos**, **En el patrón** dice cuál estás cambiando (de entrada, el que estás editando; podés elegir otro). **Usar en todos los patrones** copia el volumen, el paneo y los efectos de ese patrón a todos los demás. Si el sonido está puesto directo en la línea de tiempo, la opción **Clips de audio** tiene su propia mezcla. **Silenciar**, **Solo** y **Tono** (en **Todo el instrumento**) valen en todos los patrones.

**Preset**: la forma más rápida. Tocá el botón y elegí uno (cada uno dice cómo suena) (Lo-fi, Radio vieja, Bajo gordo, Voz con aire, Espacial, Sucio, Wobble, Fase, Brillante, Bombeo con el bombo) y el sonido cambia de una. **Sin efectos** vuelve todo a cero. Si llegaste a un sonido que te gusta, **Guardar como preset** y lo tenés en la lista para cualquier sonido. Los presets cambian solo los efectos, nunca el volumen ni el paneo.

Lo básico, siempre a la vista:

- **Graves, Medios, Agudos**: el ecualizador.
- **Compresión**: empareja el volumen.
- **Reverb** y **Delay**: cuánto ambiente y eco le das. El delay va al tempo.

Abrí **Más efectos** para el resto. Cada uno se prende eligiendo un tipo:

- **Distorsión**: ensucia el sonido. *Saturación* es cálida, *Distorsión* es agresiva, *Crujido digital* suena a sampler viejo. El volumen se compensa solo.
- **Filtro**: *pasa-bajos* quita agudos (suena oscuro, como detrás de una pared); *pasa-altos* quita graves (más finito). **Corte** dice dónde corta y **Resonancia** remarca esa zona.
- **Movimiento**: el filtro se abre y se cierra solo, al tempo. **Velocidad** elige cada cuánto (de un octavo a cuatro compases).
- **Modulación**: *Chorus* lo hace más grueso y ancho, *Flanger* le da un "whoosh" de avión, *Phaser* un remolino.
- **Ancho**: qué tan abierto suena entre izquierda y derecha (0 = mono). Un sonido mono necesita un chorus antes para abrirse.
- **Bombeo**: el sonido se agacha cada vez que suena otro. El clásico: el bajo con el bombo, para que no se pisen.

Un puntito al lado de **Más efectos** te avisa si hay alguno prendido.

**Volver al valor normal**: cuando movés un control (Tono, volumen, un efecto…), a su derecha aparece una flechita curva. Tocala y ese control vuelve a como estaba de entrada: Tono a 0, volumen a 80 %, efecto a cero. Para sacar todos los efectos de una, **Sacar todos** (arriba de Efectos). También podés hacer doble clic en el deslizador, o Ctrl+Z para deshacer.

Sin nada elegido (Esc), el inspector muestra el **master**: volumen general, limitador (evita que sature), el tiempo del delay, **Delay ping-pong** (los ecos rebotan de un lado al otro) y el **Tamaño de la reverb** (Sala, Salón o Enorme).

## Conseguir más sonidos

En la biblioteca del Estudio (a la izquierda), sección **Paquetes**:

- **Importar carpeta**: elegí una carpeta con tus sonidos (WAV, FLAC, OGG, MP3, AIFF o instrumentos `.sfz`). Se copian a la app, así que si después movés la carpeta tus canciones siguen andando.
- **Conseguir más sonidos**: abre una ventana con tres pestañas:
  - **Instrumentos**: cerca de cien instrumentos gratis y legales (pianos, bajos, guitarras, baterías, vientos…) de catálogos que mantiene la comunidad: FreePats, sfzinstruments y Open Audio Stack. Escribí en **Buscar** (por ejemplo "piano", "bajo" o "batería") o tocá una categoría. Cada uno muestra cuánto pesa; los marcados **pesado** tardan en bajar. Tocá **Descargar** y aparece en la biblioteca. La lista se actualiza sola una vez por día; **Actualizar lista** la trae de nuevo ya.
  - **Sonidos sueltos**: buscá un sonido (bombo, caja, aplauso, voces, efectos) en internet. Escribí qué buscás (en inglés hay más resultados: kick, snare, clap) o tocá uno de los botones de **Rápido**. Elegí **Golpes cortos** o **Loops y más largos**. **Escuchar** lo reproduce sin bajarlo; **Agregar** lo guarda en el paquete **Sonidos de internet**, con su autor y su licencia. Hay un límite de unas 200 búsquedas por día.
  - **Mis paquetes**: lo que ya tenés, para escuchar o borrar.

Cada paquete muestra quién lo hizo y qué podés hacer con él: **Libre** (lo usás para lo que quieras), **Nombrar al autor** (si publicás el tema, tenés que darle crédito) o **Solo uso personal** (no lo uses en temas que vendas). **Sonidos de internet** dice **Varias licencias**: cada sonido guarda la suya y aparece en los créditos. De internet solo se muestran sonidos e instrumentos con licencia libre.

Los **instrumentos** (ícono de piano) suenan naturales en todas las notas: usalos con el piano roll. Los sonidos sueltos se usan como la batería.

Con el **⋯** de cada paquete lo renombrás o lo borrás (va a la papelera). Si tu canción usaba ese paquete, te avisa antes.

**Créditos**: si tu canción usa sonidos de paquetes, en **Exportar** aparece **Créditos (.txt)** con la lista de autores, lista para pegar en la descripción del tema.

¿Y SoundCloud, YouTube o Spotify? No se puede bajar de ahí: sus condiciones lo prohíben. Si el artista habilitó la descarga, bajá el archivo y abrilo; o grabá lo que suena en tu PC.

## Samples al tempo de la canción

Si un loop está a otro BPM que tu canción, elegí su sonido y en el inspector, sección **Tempo del sample**:

- Tildá **Seguir el tempo de la canción**: se estira o acorta sin cambiar el tono.
- O tocá **Usar … BPM en la canción** para que la canción tome el tempo del sample.

## Tocar en vivo

- **Teclado o controlador MIDI**: enchufalo por USB y se conecta solo (aunque la app ya esté abierta). El botón **MIDI** de arriba, al lado del metrónomo, muestra cuántos hay conectados. Con un piano roll abierto toca ese sonido; si no, las teclas o pads desde C2 disparan los sonidos en orden, como pads.
- **Ruedas y pedal**: la rueda de pitch dobla la nota hasta 2 semitonos, la de modulación le da vibrato y el pedal de sustain sostiene las notas.
- **Play, Stop y Grabar** del aparato manejan la app, si los manda (la mayoría de los controladores lo hacen).
- **Sin teclado MIDI**: con un piano roll abierto, las teclas A W S E D F T G Y H U J K de la compu son un piano. Z y X cambian de octava.
- **Grabar notas** (en el piano roll): con el patrón sonando, lo que tocás queda escrito.

## Perillas del controlador MIDI

Tocá el botón **MIDI** (arriba) para abrir **Teclado y controles MIDI**:

- **Aparatos**: los que están enchufados. Destildá uno para no usarlo. Si dice «No se pudo abrir», cerrá el otro programa que lo esté usando y tocá **Buscar de nuevo**.
- **Perillas y botones**: en **Manejar** elegí qué querés mover (Tempo, Swing, Volumen general, Play / Stop, Grabar, o el volumen, la reverb o el delay de un sonido). Tocá **Asignar** y mové la perilla, el fader o el botón del aparato. Listo: queda guardado en esta compu.
- El volumen, la reverb y el delay de un sonido cambian en el patrón que estás editando, como en el panel de la derecha.
- Para sacar una perilla, tocá el tachito al lado. Cada vuelta de perilla se deshace de una vez con Ctrl+Z.

## Tocar con amigos

Con **Tocar juntos** (arriba) hacen música entre varios, cada uno en su PC con Sampler Lab, conectados al **mismo Wi-Fi**. Es una sola canción: todos la escuchan a la vez, cada uno en sus parlantes, y cualquiera puede cambiar pasos, notas, efectos, silenciar o cambiar el tempo mientras suena.

1. Uno toca **Tocar juntos → Abrir una sala**. Aparece un **código de 4 números**. Su canción pasa a ser la de todos.
2. Los demás tocan **Tocar juntos → Unirme a una sala**, eligen **Sala de …** en la lista y ponen el código. Si la sala no aparece, tocan **No aparece: escribir la dirección** y ponen la que muestra la PC que abrió la sala.
3. Cualquiera toca **Reproducir**: arranca en todas las PCs juntas. **Parar** lo para para todos.

Mientras están en la sala:

- Arriba del Estudio queda la **barra de la sala**: de quién es, el código y quién está, cada uno con **su color**.
- Un **puntito de color** al lado de un sonido o de un patrón dice que otra persona lo está tocando en ese momento.
- **Los cambios entran al compás.** Mientras suena, lo que cambia cualquiera (vos incluido) se ve enseguida, pero se escucha desde el **comienzo del compás siguiente**, en todas las PCs a la vez. Así nadie pierde el ritmo. Cambiar el tempo, Reproducir y Parar van al instante.
- **Silenciar a alguien solo en tu PC.** En la barra de la sala, tocá el nombre de un amigo: dejás de escuchar **los sonidos que agregó esa persona** (aparece **silenciado**, y en sus filas dice **no lo escuchás**). Los demás lo siguen escuchando, y tus cambios llegan igual. Tocalo otra vez para volver a escucharlo. **Solo lo mío** deja sonar en tu PC únicamente los sonidos que agregaste vos. Sirve para armar tu parte tranquilo y después escucharla junto con la de los demás. Los sonidos que ya estaban cuando se abrió la sala cuentan como de quien la abrió.
- Cada uno puede mirar un patrón distinto. Si en la sala suena otro, aparece **Que suene este**: lo hace sonar para todos sin perder el ritmo. **Patrón / Canción** también cambia para todos.
- **Deshacer** (Ctrl+Z) deshace solo lo tuyo, no lo de tus amigos.
- Los sonidos de la biblioteca y los paquetes de la PC que abrió la sala les llegan solos a los demás (la primera vez tardan un poco). En la biblioteca dice **Sonidos de la sala de …**.
- **Traer un sonido mío** (en la barra) lleva un archivo tuyo a la sala: queda en el paquete **Sonidos de la sala** y se agrega como sonido.
- **Más → Retraso de mis parlantes**: si en tu PC el ritmo suena atrasado (pasa con parlantes o auriculares Bluetooth), subilo de a poco hasta que suenen juntas.
- **Salir de la sala** te devuelve a tu propia canción, tal cual la dejaste. **Cerrar la sala** (quien la abrió) termina la sala para todos; la canción queda guardada en esa PC.

Lo que suena para todos es la canción: tocar pads o un teclado se escucha solo en tu PC.

## Tocar desde distintas casas

Si cada uno está en su casa, no hace falta instalar nada más: alcanza con Sampler Lab y una **invitación**.

1. **El que abre la sala**: **Tocar juntos → Abrir una sala**. En **Amigos en otra casa**, tocá **Invitar a alguien de otra casa**. En unos segundos aparece una invitación larga que empieza con **SL-**.
2. Tocá **Copiar la invitación** y mandásela a tus amigos (por WhatsApp, por ejemplo). Ya lleva el código adentro.
3. **Los amigos**: **Tocar juntos → Unirme a una sala → Me mandaron una invitación (otra casa)**, la pegan y tocan **Entrar**.

La invitación sirve mientras la sala esté abierta; si la cerrás y abrís otra, hay que mandar una nueva. Las PCs se conectan directo entre ellas y todo va cifrado. Si el router de alguna casa no deja la conexión directa, pasa por un servidor gratis de iroh (la tecnología que usa Sampler Lab para esto), que no puede ver lo que mandan. Hasta que tocás **Invitar a alguien de otra casa**, la sala no se conecta a internet.

Por internet todo tarda un poco más: Reproducir puede arrancar un instante después en algunas PCs, y los cambios entran al compás (a veces uno después). Si la otra PC suena corrida, usá **Más → Retraso de mis parlantes**. Los sonidos de la sala tardan más en llegar la primera vez, según la conexión.

**Otra forma (si ya usan Tailscale):** con **Tailscale** prendido en las dos PCs y la PC de la sala compartida con tus amigos (en la página de Tailscale, **⋯ → Share**), al abrir la sala aparece **Amigos en otra casa (con Tailscale)** con una dirección que empieza con **100.** Tus amigos la escriben en **No aparece: escribir la dirección**, junto con el código.

## Exportar la música

**Exportar** (arriba a la derecha) abre las opciones:

- **Mezcla en WAV**: un archivo con todo.
- **Stems**: un archivo por sonido, para seguir en otro programa.
- **MIDI**: las notas, para usar otros instrumentos.

En modo **Patrón** se exporta el patrón; en modo **Canción**, el tema entero. **Con cola** deja sonar el final; **Largo exacto** corta justo, ideal para loops.

## Atajos de teclado

- **Espacio**: reproducir / parar.
- **Enter**: guardar la selección como sample.
- **Ctrl+Z / Ctrl+Y**: deshacer / rehacer.
- **Esc**: quitar la selección (también la de pistas de la canción).
- **Supr**: borrar el clip elegido de la canción.
- **A W S E D F T G Y H U J K**, **Z / X**: piano con el teclado (piano roll abierto).

## Si algo no funciona

- **No se grabó nada**: tiene que estar sonando algo en la PC. Algunos videos protegidos (Netflix) se graban en silencio.
- **Un sonido tiene un triángulo de aviso**: se movió o borró el archivo original de ese sample.
- **La exportación dice que saturó**: bajá el volumen general o el de algún sonido.
- **El celu no conecta**: mirá la sección del celu de este manual.
- **No aparece la sala de tu amigo**: estén en el mismo Wi-Fi (los Wi-Fi de invitados o de hoteles a veces no dejan que las PCs se vean). La primera vez, en la PC que abre la sala, Windows pregunta por el firewall: permití el acceso en **redes privadas**. También podés escribir la dirección a mano.
- **En la sala suena desfasado**: en la PC atrasada, **Más → Retraso de mis parlantes**.
- **En la sala no escucho un sonido**: fijate si en su fila dice **no lo escuchás** (silenciaste a esa persona o tenés **Solo lo mío**), o si está en M (silenciado para todos). Si recién lo cambiaste, se escucha cuando empieza el compás siguiente.
- **La invitación no entra**: fijate que sea la última que te mandaron y que la sala siga abierta. Copiala entera (empieza con **SL-**). Si sigue sin entrar, puede ser la conexión de alguna de las dos casas: probá de nuevo en un rato.
- **Con Tailscale no entra**: Tailscale tiene que estar prendido en las dos PCs, y la PC de la sala compartida con tu amigo (**Share**). Probá escribir la dirección **100.…** de nuevo. Si Windows preguntó por el firewall, tiene que estar permitido en **redes privadas**.
- **Se cortó la sala**: volvés a tu canción. Tocá **Reconectar** cuando la otra PC esté de nuevo.
- **La preparación del separador se cortó**: tocá **Reintentar**. Sigue desde donde quedó, no baja todo de nuevo.
- **El separador no arranca**: tocá **Reintentar**. Si sigue fallando, **Reinstalar el separador**.

# En el celu

## Conectarse

1. En la PC, abrí Sampler Lab y tocá **Celular** (arriba) → **Activar**.
2. Conectá el celu al **mismo Wi-Fi** que la PC.
3. Escaneá el código QR con la cámara del celu. Se abre el estudio en el navegador.

El sonido sale del **celu** (podés usar auriculares). Tus samples se toman de la PC. La canción es la misma en los dos lados: lo que hagas en el celu aparece en la PC y al revés.

Arriba ves la posición, el BPM y un punto: **verde** es que está conectado a la PC.

## Tocar con los pads

Cada cuadrado de la pestaña **Pads** es un sonido de tu canción, con su color.

- **Tocá un pad** para escucharlo.
- Con play, **los pads se iluminan** cuando el beat los toca: así ves qué está sonando.

## Grabar lo que tocás

1. Tocá **Grabar**: empieza a sonar el patrón.
2. Tocá los pads al ritmo. Cada golpe queda escrito en el patrón, acomodado a la grilla.
3. Tocá **Grabar** otra vez (o stop) para terminar.

Si te equivocaste, **deshacer** (la flecha de arriba) borra lo último.

## Editar pasos

En la pestaña **Pasos**:

1. Arriba elegí un sonido (cada uno con su color).
2. Los 16 cuadros son un compás: cada fila es un tiempo (1, 2, 3, 4). Tocá un cuadro para poner o sacar un golpe.
3. Si el patrón tiene más de un compás, elegí cuál abajo.
4. **Escuchar** reproduce el sonido, **Borrar** saca todos sus golpes de este patrón, **Silenciar** lo calla y el deslizador es su volumen en este patrón.

Los sonidos con melodía (piano roll) se editan en la PC; en **Pasos** el celu te muestra un dibujo de sus notas, con los deslizamientos.

## Agregar sonidos

En la pestaña **Sonidos** están la batería incluida, el sintetizador, tus samples y los paquetes de sonidos de la PC. Los paquetes se bajan o importan desde la PC.

- Tocá el **nombre** para escucharlo.
- Tocá **Agregar** para sumarlo a tus pads.

## Patrones y tempo

- Los botones de arriba (**Patrón 1**, **Patrón 2**…) cambian el patrón que suena y editás. **+** crea uno nuevo.
- El **BPM** se cambia con **−** y **+**, o tocando el número.

## Si algo no funciona

- **El punto de arriba está rojo** o aparece "Sin conexión": revisá que Sampler Lab esté abierto en la PC con **Celular** activado y que el celu esté en el mismo Wi-Fi.
- **No suena**: subí el volumen del celu y sacalo del modo silencio. La primera vez el navegador puede necesitar que toques play.
- **Dice "Falta el código"**: volvé a escanear el QR (cada vez que se desactiva, el código cambia).
- **Windows preguntó por el firewall** en la PC: permití el acceso en redes privadas.
