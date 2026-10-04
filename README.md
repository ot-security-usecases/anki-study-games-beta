# StudyPlay Beta

PWA móvil inspirada en Anki/Duolingo para estudiar el mismo contenido con varios juegos.

## Beta actual

- Responsive para celular/PC.
- Progreso persistente con IndexedDB.
- Importación local de `.apkg`, `.colpkg` y `.txt`.
- Soporte para `collection.anki21b` (Anki moderno/Zstandard) y SQLite clásico.
- Lectura heurística de campos comunes: Front/Back, Key_Phrase, Synonyms, Suggestion, Example, Sound e imágenes.
- Conserva decks/subdecks y datos básicos del historial de cada tarjeta.
- Juegos: Flashcards, Quiz, Unir, Memorama, Verdadero/Falso, Escribir, Ordenar, Listening, Reto rápido y Supervivencia.
- Sesión mixta.
- PWA instalable y caché offline después de la primera carga.

## Ejecutar localmente

Sirve la carpeta con cualquier servidor HTTP estático. Ejemplo:

```bash
python -m http.server 8080
```

Luego abre `http://localhost:8080`.

> No abras `index.html` con `file://`: Service Worker, WASM y algunas APIs del navegador necesitan HTTP/HTTPS.

## Privacidad

Los archivos Anki se procesan en el navegador. La beta no sube el `.apkg` a un servidor.
