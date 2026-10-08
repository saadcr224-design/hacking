# HACKER//FACE

A webcam effect for the browser. Animated hacker code fills the background, your face shows faintly inside it, and a neon low-poly mask tracks your face. **Clap** (or slap a hand fast across your face) and the mask shatters toward the screen. Clap again and it flies back together in a new color palette.

It's plain HTML and JS with no build step. It uses MediaPipe Tasks Vision (Face Landmarker + Hand Landmarker) from a CDN and the Web Audio API for clap detection.

## Run

Camera and microphone access only work on `localhost` or HTTPS, so opening `index.html` directly as a file won't work. Serve the folder with either command:

```bash
# from this folder
npx serve .                 # then open the URL it prints (usually http://localhost:3000)
# or
python3 -m http.server 8000 # then open http://localhost:8000
```

Open the page in Chrome, click **[ START ]**, and allow camera and microphone access. The first load downloads about 10 MB of models, so give it a few seconds.

## Controls

| Key | Action |
|---|---|
| `SPACE` | Trigger (same as a clap) |
| `F` | Fullscreen |
| `D` | Debug view: mic level meter, threshold line, face and hand landmarks |
| `S` | Settings panel: clap sensitivity, ghost opacity, particle count, code speed, toggles for each trigger source |

Settings are saved in your browser's localStorage.

## States

`MASKED` → (trigger) → `SHATTER` → `UNMASKED` → (trigger) → `REASSEMBLE` (new palette) → `MASKED` → …

There are 7 palettes: Cyber pink/blue, Toxic green, Fire, Ice, Purple/gold, Rainbow, Synthwave. The ghost-face tint follows the current palette.

## Tuning clap sensitivity

Press **D** to open the meter. The green line is the mic level, the dashed red line is the trigger threshold, and the dim dashed line is the rolling noise floor. Red tick marks are detected claps. Yellow marks are sounds that crossed the threshold but lasted too long to be a clap (speech or music) and were rejected.

A clap counts when all of these are true:
1. The high-passed (>1.2 kHz) level jumps above the threshold. The threshold is the noise floor times a ratio, with a minimum level.
2. The waveform is spiky. Peak/RMS is shown as "CREST" in the meter.
3. The sound dies back down within 200 ms.
4. At least 600 ms have passed since the last clap.

**It triggers too easily** (talking, typing, music):
- Press **S** and lower **Clap sensitivity** (try 3, or 2 in a noisy room). Lower values raise the threshold and need a spikier sound.
- Move the mic away from the keyboard and speakers, or turn the music down.

**It never triggers:**
- Press **D** and clap. If the green line doesn't reach the red dashed line, raise **Clap sensitivity** (try 7–9).
- If the meter is flat or shows `MIC UNAVAILABLE`, check Chrome's site permissions (the camera/mic icon in the address bar) and that Chrome is using the right microphone.
- Clap sharply with flat palms, about an arm's length from the laptop.
- Some OS "voice enhancement" or noise-cancelling features (Windows mic enhancements, Krisp, NVIDIA Broadcast, AirPods) filter claps out. Pick the raw built-in mic.

For finer control, the constants are at the top of `app.js`. The `clapParams()` function in section 5 maps sensitivity to the threshold `ratio`, `absMin` and `crestMin`. `CLAP_MAX_MS` and `TRIGGER_COOLDOWN_MS` set the timing.

**Slap trigger:** the hand has to move faster than `SLAP_SPEED` (4 face-widths per second) within `SLAP_RADIUS` (1.4 face-widths) of your face. Debug view shows each hand's speed and the speed needed. You can turn the slap trigger off in Settings.

## Files

- `index.html` contains the layout, CSS (scanlines, vignette, panels), the start overlay and the settings panel.
- `app.js` contains everything else, in commented sections: settings, palettes, canvas, camera, face and hand tracking, audio trigger, state machine, particle system, rendering, HUD, UI, main loop.

## Notes

- Target is 30+ FPS. If it's slow, lower **Particle count** and make sure Chrome hardware acceleration is on. The tracker uses the GPU and falls back to CPU if that fails.
- Everything runs locally in the browser. No video or audio is sent anywhere.
