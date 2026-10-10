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


## AI-only mode (default)
The editor shows only the photo, the AI Assistant and the Magic buttons. The manual tools (Crop, Adjust, Filters, Clean, Background, Stamps, Text, Layers, plus dragging objects) are still in the code. To bring them back on a device, open the app once with `?manual=1` (or set localStorage `photoapp.manualTools` to `1`). Use `?manual=0` to hide them again.

## Background removal
Default engine for the Magic button, AI commands and batch: IMG.LY ISNet fp16 (about 80 MB, downloaded once and then cached by the service worker), with edge refinement (speck removal, small-hole fill, matte firming, light non-eroding feather). Fallbacks: the ISNet 8-bit model, then the MediaPipe people model if the precise model can't run.

## Safety checks for background changes (v6)
- Every subject mask is checked before use (coverage 2–98 %, not inverted, not noise, photo not blank). A bad mask is never applied; the photo stays as it was and a plain message explains why.
- Removing the background and setting the new one happen in one step; the subject is always drawn on top.
- AI replies from any provider are normalized first (nested `params`, `replaceBackground`, `background: "image prompt: …"`, setBackground before removeBackground, etc.). Commands can't delete or replace the photo; "reset everything" is ignored unless you asked for it.
- If the phone runs out of canvas memory, rendering retries at a smaller size instead of producing a blank image.
- **Report a problem** (AI settings or the help sheet) copies the last AI commands and mask stats to the clipboard. No API keys or photos are included.

## AI providers
Free: Google Gemini (default), Groq. Paid: xAI Grok, OpenAI (gpt-6-luna), DeepSeek (deepseek-flash, thinking off), Claude (claude-haiku-5-5 via Anthropic's OpenAI-compatible endpoint with the browser-access header). Each provider keeps its own key in localStorage.
