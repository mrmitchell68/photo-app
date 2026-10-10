# Photo Studio (PWA)

Mobile-first photo editor that runs entirely in the browser. No backend and no keys required.

* Capture one photo or a burst (1/3/5 per tap), front/back camera, or import many from the gallery.
* Edit each photo on its own: crop/rotate/flip, adjustments, filters, auto-enhance, spot-heal/erase brush.
* Background: on-device removal (MediaPipe for people, IMG.LY ISNet "Precise" for any subject), then solid colour, gradient, blur, your own photo, or transparent.
* Stamps (emoji, stickers, your own image) and text (fonts, colours, outline, shadow, label box). Drag, pinch/handles to resize and rotate, layer order, duplicate, delete.
* Undo/redo, full-resolution JPEG/PNG export, Save / Share (Web Share API) for one or all photos.
* Optional AI: one-tap Magic actions (no key) + an AI Assistant using your own OpenAI-compatible key (xAI Grok by default, or OpenAI), stored only in localStorage.
* Installable PWA with offline support.

Serve the folder over HTTPS (camera and share need it), e.g. GitHub Pages. Locally: `python3 -m http.server` then open http://localhost:8000.
