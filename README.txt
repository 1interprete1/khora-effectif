KHORA · EFFECTIF v0.8.0 — ESTADÍSTICAS Y OBSERVABILIDAD

ALCANCE ACTUAL
- Auto-Answer mediante el único clic permitido: Connect, tras validar el diálogo.
- Detección de llamadas OPI/VRI, estados Online/Offline, llamadas perdidas y rutas.
- Conteo local de llamadas, segundos y minutos, sin abrir Statistics.
- Ganancias: OPI US$0.20/min y VRI US$0.25/min, prorrateadas por segundo.
- Overlay opcional en USD/MXN, actualizado cada 50 ms.
- Cotejo de Statistics únicamente cuando esa pantalla ya es visible.
- Observabilidad persistente y exportable.

OBSERVABILIDAD PERSISTENTE
- IndexedDB con permiso unlimitedStorage; sobrevive cierres y reinicios del navegador.
- Migración automática del historial corto de versiones anteriores.
- Retención predeterminada: 180 días, máximo 250,000 eventos; ambos configurables.
- Registra estados, rutas, rendimiento, recursos, salud del DOM, errores, ciclo de vida,
  interacciones sin valores escritos y metadatos de red sin cuerpos ni parámetros.
- Guarda snapshots visibles de la plataforma y un buffer corto para el popup.
- Exportación JSON completa con eventos, snapshots, estado y configuración censurada.

POLÍTICA DE CERO INVASIVIDAD
- No llama APIs privadas de Effectif.
- No lee cuerpos de solicitudes ni respuestas de red.
- No registra contraseñas, cookies, tokens, claves ni valores escritos en formularios.
- No solicita micrófono, no usa tabCapture y no modifica audio, pistas o dispositivos.
- No altera controles de la plataforma, salvo el clic validado de Connect de Auto-Answer.
- El overlay vive en un Shadow DOM aislado de la interfaz de Effectif.

TRANSCRIPCIÓN
- No está disponible, expuesta ni activable en v0.8.0.
- No se instala ni se inicia el worker local y se retiraron panel, controles y permisos.
- Los archivos experimentales se conservan dormidos para evaluación futura; no se borraron.

INSTALACIÓN / ACTUALIZACIÓN SIN PERDER DATOS
1. Conserva la misma entrada de la extensión en chrome://extensions/.
2. Sustituye los archivos de su carpeta actual por los de v0.8.0.
3. Pulsa Recargar en esa misma entrada; no la elimines y vuelvas a crear.
4. Recarga las pestañas abiertas de Effectif.
5. Abre el popup y confirma que Observabilidad persistente muestra el historial.

La identidad de la extensión determina su IndexedDB. Actualizar la misma entrada conserva
el historial; crear una extensión distinta produce una base independiente.
