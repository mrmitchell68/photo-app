# Photo Studio (PWA)

Mobile-first photo editor that runs entirely in the browser. No backend and no keys required.

* Capture one photo or a burst (1/3/5 per tap), front/back camera, or import many from the gallery.
* Edit each photo on its own: crop/rotate/flip, adjustments, filters, auto-enhance, spot-heal/erase brush.
* Background: on-device removal (MediaPipe for people, IMG.LY ISNet "Precise" for any subject), then solid colour, gradient, blur, your own photo, or transparent.
* Stamps (emoji, stickers, your own image) and text (fonts, colours, outline, shadow, label box). Drag, pinch/handles to resize and rotate, layer order, duplicate, delete.
* Undo/redo, full-resolution JPEG/PNG export, Save / Share (Web Share API) for one or all photos.
* Optional AI: one-tap Magic actions (no key) + an AI Assistant using your own OpenAI-compatible key, stored only in localStorage. Free presets: Google Gemini (default for new users; key at https://aistudio.google.com/apikey) and Groq (https://console.groq.com/keys). Paid: xAI Grok, OpenAI (these also support AI-generated backgrounds; free presets fall back to gradients). Each provider keeps its own key; the active provider only changes when you tap "Switch to …".
* Installable PWA with offline support.

Serve the folder over HTTPS (camera and share need it), e.g. GitHub Pages. Locally: `python3 -m http.server` then open http://localhost:8000.
