/* =====================================================================
 *  HACKER//FACE — live webcam "hacker face" effect
 *
 *  Layers (back -> front):
 *    1. Code background   (#code canvas)  matrix rain + fake typing terminals
 *    2. Ghost face        (#fx canvas)    tinted webcam image at 30% opacity
 *    3. Color mask        (#fx canvas)    468-pt face mesh filled with neon triangles
 *    4. HUD               (#fx canvas + CSS scanlines/vignette)
 *
 *  Sections:
 *    0. Settings & constants      6. State machine
 *    1. Palettes & color utils    7. Particle system (shatter / reassemble)
 *    2. Canvas setup              8. Rendering (code bg, ghost, mask)
 *    3. Camera                    9. HUD + glitch + debug
 *    4. Face & hand tracking     10. UI: start button, keyboard, settings
 *    5. Audio (clap) trigger     11. Main loop
 * ===================================================================== */

// =====================================================================
// 0. SETTINGS & CONSTANTS
// =====================================================================
const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const TRIGGER_COOLDOWN_MS = 600;   // one clap = one trigger
const SLAP_COOLDOWN_MS = 900;
const SLAP_SPEED = 4.0;            // hand speed needed for a slap, in face-widths per second
const SLAP_RADIUS = 1.4;           // hand must be within this many face-widths of the face center
const FACE_LOST_MS = 250;          // face considered gone after this long without a detection

const SETTINGS_KEY = 'hackerface.settings.v1';
const DEFAULTS = {
  sensitivity: 5,      // 1 (deaf) .. 10 (very sensitive)
  ghostOpacity: 30,    // percent
  particleCount: 900,  // shards on shatter (mesh has 852 triangles; more = subdivided)
  codeSpeed: 1,
  micTrigger: true,
  slapTrigger: true,
};
const settings = loadSettings();

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// =====================================================================
// 1. PALETTES & COLOR UTILS
// =====================================================================
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const PALETTES = [
  { name: 'CYBER PINK/BLUE', colors: ['#ff2bd6', '#ff6ec7', '#b44cff', '#2de2ff', '#0077ff'], edge: '#e6f9ff', tint: '#ff4fd8' },
  { name: 'TOXIC GREEN',     colors: ['#39ff14', '#b6ff00', '#00ff9c', '#0aff6c', '#e4ff1a'], edge: '#efffd9', tint: '#5dff3a' },
  { name: 'FIRE',            colors: ['#ffea00', '#ff9500', '#ff4d00', '#ff1744', '#c3002f'], edge: '#fff3c4', tint: '#ff6a00' },
  { name: 'ICE',             colors: ['#e8ffff', '#9ae6ff', '#4cc9f0', '#4895ef', '#b8f2ff'], edge: '#ffffff', tint: '#6fd8ff' },
  { name: 'PURPLE/GOLD',     colors: ['#ffd700', '#ffb300', '#9d4edd', '#7b2cbf', '#e0aaff'], edge: '#fff4cc', tint: '#b26bff' },
  { name: 'RAINBOW',         colors: ['#ff0040', '#ff8c00', '#ffee00', '#00ff6a', '#00b3ff', '#8a2be2'], edge: '#ffffff', tint: '#ff66cc' },
  { name: 'SYNTHWAVE',       colors: ['#f72585', '#b5179e', '#7209b7', '#3a0ca3', '#4cc9f0'], edge: '#ffd6f5', tint: '#f72585' },
].map((p) => ({ ...p, rgb: p.colors.map(hexToRgb), tintRgb: hexToRgb(p.tint), edgeRgb: hexToRgb(p.edge) }));

let paletteIdx = 0;                                // State A starts with palette #1
const ghostTint = [...PALETTES[0].tintRgb];        // eased toward the current palette tint

/** Sample a palette as a cyclic gradient at t (any real), write rgb into out. */
function samplePalette(pal, t, out) {
  const c = pal.rgb, n = c.length;
  t -= Math.floor(t);
  const f = t * n, i = Math.floor(f), k = f - i;
  const s = k * k * (3 - 2 * k);                   // smoothstep between stops
  const a = c[i], b = c[(i + 1) % n];
  out[0] = a[0] + (b[0] - a[0]) * s;
  out[1] = a[1] + (b[1] - a[1]) * s;
  out[2] = a[2] + (b[2] - a[2]) * s;
  return out;
}
const rgbStr = (r, g, b) => `rgb(${r | 0},${g | 0},${b | 0})`;
const rgbaStr = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function pickNewPalette() {
  let i;
  do { i = Math.floor(Math.random() * PALETTES.length); } while (i === paletteIdx);
  paletteIdx = i;
}

// =====================================================================
// 2. CANVAS SETUP
// =====================================================================
const stageEl = document.getElementById('stage');
const codeCanvas = document.getElementById('code');
const fxCanvas = document.getElementById('fx');
const cctx = codeCanvas.getContext('2d', { alpha: false });
const fctx = fxCanvas.getContext('2d');

let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);   // cap for performance
  W = window.innerWidth; H = window.innerHeight;
  for (const [c, ctx] of [[codeCanvas, cctx], [fxCanvas, fctx]]) {
    c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  initCodeBackground();
  initGhost();
}
window.addEventListener('resize', resize);

// =====================================================================
// 3. CAMERA
// =====================================================================
const video = document.getElementById('cam');
let camReady = false;
let micAvailable = false;

/** Cover-fit rect of the video on screen (CSS px). */
const view = { dx: 0, dy: 0, dw: 1, dh: 1 };

async function startCamera() {
  const videoC = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
  // Disable browser voice processing: noise suppression / AGC destroy clap transients.
  const audioC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoC, audio: audioC });
  } catch (err) {
    console.warn('Camera+mic request failed, retrying camera only:', err);
    stream = await navigator.mediaDevices.getUserMedia({ video: videoC });
  }
  video.srcObject = stream;
  await video.play();
  camReady = true;
  return stream;
}

function updateView() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(W / vw, H / vh);
  view.dw = vw * s; view.dh = vh * s;
  view.dx = (W - view.dw) / 2; view.dy = (H - view.dh) / 2;
}

/** Normalized landmark -> mirrored (selfie) screen coords. */
const toScreenX = (x) => W - (view.dx + x * view.dw);
const toScreenY = (y) => view.dy + y * view.dh;

// =====================================================================
// 4. FACE & HAND TRACKING (MediaPipe Tasks Vision)
// =====================================================================
let MP = null;                 // the dynamically imported tasks-vision module
let faceLandmarker = null;
let handLandmarker = null;
let modelStatus = 'AWAITING AUTHORIZATION';

const N_LM = 478;              // 468 mesh points + 10 iris points
const face = {
  pts: new Float32Array(N_LM * 3),   // smoothed screen x, y, z (z in px, + = toward viewer)
  has: false,                        // ever detected (pts are valid)
  present: false,                    // currently tracked
  lastSeen: -1e9,
  cx: 0, cy: 0, w: 1, h: 1, minX: 0, minY: 0,
};
let TRIS = new Uint16Array(0);       // triangle vertex indices (a,b,c)*n
let EDGES = new Uint16Array(0);      // unique edges for the glowing wireframe
let NTRI = 0;
let FEATURE_EDGES = [];              // eyes + lips contours (extra glow)
let HAND_CONNECTIONS = [];

const hands = { list: [], lastSlap: -1e9 };
let lastVideoTime = -1;
let trackFrame = 0;
let trackCount = 0, trackHz = 0;

async function createTask(Cls, fileset, modelAssetPath, extra) {
  const make = (delegate) => Cls.createFromOptions(fileset, {
    baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', ...extra,
  });
  try { return await make('GPU'); }
  catch (err) { console.warn('GPU delegate failed, using CPU:', err); return make('CPU'); }
}

async function loadModels() {
  modelStatus = 'LOADING NEURAL MODELS...';
  try {
    MP = await import(`${MP_BASE}/vision_bundle.mjs`);
    buildMeshTopology(MP);
    const fileset = await MP.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    faceLandmarker = await createTask(MP.FaceLandmarker, fileset, FACE_MODEL, {
      numFaces: 1, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    modelStatus = '';
    try {
      handLandmarker = await createTask(MP.HandLandmarker, fileset, HAND_MODEL, {
        numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    } catch (err) { console.warn('Hand landmarker unavailable (slap trigger disabled):', err); }
  } catch (err) {
    console.error(err);
    modelStatus = 'MODEL LOAD FAILED - CHECK NETWORK / CONSOLE';
  }
}

/** Build triangle list from MediaPipe's tesselation (stored as edge triples a-b, b-c, c-a). */
function buildMeshTopology(mp) {
  const T = mp.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  let tris = [];
  let ok = true;
  for (let i = 0; i + 2 < T.length; i += 3) {
    const a = T[i], b = T[i + 1], c = T[i + 2];
    if (a.end !== b.start || b.end !== c.start || c.end !== a.start) { ok = false; break; }
    tris.push(a.start, b.start, c.start);
  }
  if (!ok) tris = trianglesFromEdges(T);   // safety net if the library ever reorders edges

  TRIS = Uint16Array.from(tris);
  NTRI = TRIS.length / 3;
  const seen = new Set(), edges = [];
  for (let i = 0; i < TRIS.length; i += 3) {
    for (const [p, q] of [[TRIS[i], TRIS[i + 1]], [TRIS[i + 1], TRIS[i + 2]], [TRIS[i + 2], TRIS[i]]]) {
      const key = p < q ? p * 1000 + q : q * 1000 + p;
      if (!seen.has(key)) { seen.add(key); edges.push(p, q); }
    }
  }
  EDGES = Uint16Array.from(edges);
  FEATURE_EDGES = [
    ...mp.FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    ...mp.FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    ...mp.FaceLandmarker.FACE_LANDMARKS_LIPS,
  ];
  HAND_CONNECTIONS = mp.HandLandmarker.HAND_CONNECTIONS;
  triJitter = new Float32Array(NTRI).map(() => Math.random());
  triRGB = new Float32Array(NTRI * 3);
  triVis = new Float32Array(NTRI).fill(1);
  triFlash = new Float32Array(NTRI);
}

/** Fallback: every 3-clique in the edge graph is a triangle. */
function trianglesFromEdges(conns) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const { start, end } of conns) { add(start, end); add(end, start); }
  const out = [];
  for (const [a, na] of adj) for (const b of na) if (b > a) for (const c of adj.get(b)) if (c > b && na.has(c)) out.push(a, b, c);
  return out;
}

function track(now) {
  if (!faceLandmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  trackCount++;

  const res = faceLandmarker.detectForVideo(video, now);
  const lms = res.faceLandmarks && res.faceLandmarks[0];
  if (lms) {
    const P = face.pts;
    const fresh = !face.has || now - face.lastSeen > 400;
    const fw = Math.max(face.w, 1);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const n = Math.min(lms.length, N_LM);
    for (let i = 0; i < n; i++) {
      const l = lms[i], j = i * 3;
      const x = toScreenX(l.x), y = toScreenY(l.y), z = -l.z * view.dw;
      if (fresh) { P[j] = x; P[j + 1] = y; P[j + 2] = z; }
      else {
        // Adaptive smoothing: kill sub-pixel jitter, follow fast motion (blinks, mouth) instantly.
        const d = Math.hypot(x - P[j], y - P[j + 1]);
        const a = Math.min(1, 0.45 + d / (fw * 0.03 + 1));
        P[j] += (x - P[j]) * a; P[j + 1] += (y - P[j + 1]) * a; P[j + 2] += (z - P[j + 2]) * a;
      }
      if (i < 468) {
        if (P[j] < minX) minX = P[j]; if (P[j] > maxX) maxX = P[j];
        if (P[j + 1] < minY) minY = P[j + 1]; if (P[j + 1] > maxY) maxY = P[j + 1];
      }
    }
    face.minX = minX; face.minY = minY;
    face.w = Math.max(1, maxX - minX); face.h = Math.max(1, maxY - minY);
    face.cx = (minX + maxX) / 2; face.cy = (minY + maxY) / 2;
    face.has = true; face.present = true; face.lastSeen = now;
  } else if (now - face.lastSeen > FACE_LOST_MS) {
    face.present = false;
  }

  // Hands every other frame: they are only the backup trigger.
  if (handLandmarker && (trackFrame++ & 1) === 0) processHands(handLandmarker.detectForVideo(video, now), now);
}

/** Slap gesture: a hand moving fast near the face. */
function processHands(res, now) {
  const out = [];
  for (const lms of res.landmarks || []) {
    const pts = lms.map((l) => [toScreenX(l.x), toScreenY(l.y)]);
    let x = 0, y = 0;
    for (const k of [0, 5, 9, 13, 17]) { x += pts[k][0]; y += pts[k][1]; }   // palm center
    x /= 5; y /= 5;

    // Match with the nearest hand from the previous detection to get velocity.
    let prev = null, bd = Infinity;
    for (const p of hands.list) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; prev = p; } }
    let speed = 0;
    if (prev) { const dt = (now - prev.t) / 1000; if (dt > 0.001 && dt < 0.3) speed = bd / dt; }
    out.push({ x, y, t: now, speed, pts });

    const faceRecent = face.has && now - face.lastSeen < 800;   // a hand over the face can hide it briefly
    if (settings.slapTrigger && faceRecent && prev && speed > 0) {
      const fw = face.w, r = fw * SLAP_RADIUS;
      const near = Math.hypot(x - face.cx, y - face.cy) < r || Math.hypot(prev.x - face.cx, prev.y - face.cy) < r;
      if (near && speed > fw * SLAP_SPEED && now - hands.lastSlap > SLAP_COOLDOWN_MS) {
        hands.lastSlap = now;
        trigger('SLAP');
      }
    }
  }
  hands.list = out;
}

// =====================================================================
// 5. AUDIO (CLAP) TRIGGER — Web Audio API
// =====================================================================
const HIST = 220;
const audio = {
  ctx: null, analyser: null, buf: null,
  rms: 0, peak: 0, crest: 0, floor: 0.005, thr: 0, prevRms: 0,
  lastClap: -1e9, cand: null, rejected: 0,
  hist: new Float32Array(HIST), histTrig: new Uint8Array(HIST), histI: 0,
};

/** Map the 1..10 sensitivity slider to detector parameters. */
function clapParams() {
  const s = clamp((settings.sensitivity - 1) / 9, 0, 1);
  return {
    ratio: lerp(12, 2.5, s),       // how far above the rolling noise floor RMS must jump
    absMin: lerp(0.10, 0.012, s),  // absolute minimum RMS (0..1 full scale)
    crestMin: lerp(3.2, 1.8, s),   // peak/RMS: claps are spiky, voices/hums are not
  };
}

function initAudio(stream) {
  if (!audio.ctx || !stream.getAudioTracks().length) return;
  const src = audio.ctx.createMediaStreamSource(stream);
  // High-pass: claps are broadband with lots of energy above 1 kHz; voice/bumps live lower.
  const hp = audio.ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 1200; hp.Q.value = 0.7;
  const an = audio.ctx.createAnalyser();
  an.fftSize = 2048; an.smoothingTimeConstant = 0;
  src.connect(hp); hp.connect(an);              // not connected to destination: no feedback
  audio.analyser = an;
  audio.buf = new Float32Array(an.fftSize);
  micAvailable = true;
  setInterval(updateAudio, 16);
}

/**
 * Clap detector, run every ~16 ms on its own timer (independent of render FPS).
 *  1. Onset: high-passed RMS crosses up through the threshold (noise floor x ratio),
 *     and the waveform is spiky (peak/RMS crest factor).
 *  2. Confirm: the sound must die down to 30% of its peak within CLAP_MAX_MS.
 *     Claps are ~20-80 ms; speech, music, whistles and beeps last longer and get rejected.
 *  3. Cooldown: TRIGGER_COOLDOWN_MS between claps, so one clap = one trigger.
 */
const CLAP_MAX_MS = 200;
function updateAudio() {
  if (!audio.analyser) return;
  const now = performance.now();
  audio.analyser.getFloatTimeDomainData(audio.buf);
  const b = audio.buf;
  let sum = 0, pk = 0;
  for (let i = 0; i < b.length; i++) { const v = b[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
  const rms = Math.sqrt(sum / b.length);
  const { ratio, absMin, crestMin } = clapParams();
  const thr = Math.max(audio.floor * ratio, absMin);
  const crest = pk / (rms + 1e-9);

  let mark = 0;   // history marker: 1 = clap, 2 = rejected (too long)
  if (audio.cand) {
    const c = audio.cand;
    c.max = Math.max(c.max, rms);
    if (rms < c.max * 0.3) {                         // decayed fast: it's a clap
      audio.cand = null; audio.lastClap = now; mark = 1;
      if (settings.micTrigger) trigger('CLAP');
    } else if (now - c.t > CLAP_MAX_MS) {            // still loud: speech/music, ignore
      audio.cand = null; audio.rejected++; mark = 2;
    }
  } else if (rms > thr && audio.prevRms <= thr && crest > crestMin && now - audio.lastClap > TRIGGER_COOLDOWN_MS) {
    audio.cand = { t: now, max: rms };
  }

  // Rolling noise floor: falls fast, rises slowly, frozen around candidates/claps.
  if (!audio.cand && !mark && now - audio.lastClap > 300 && rms < thr) {
    audio.floor += (rms - audio.floor) * (rms > audio.floor ? 0.01 : 0.08);
    audio.floor = Math.max(audio.floor, 0.0005);
  }

  audio.rms = rms; audio.peak = pk; audio.crest = crest; audio.thr = thr; audio.prevRms = rms;
  audio.hist[audio.histI] = rms; audio.histTrig[audio.histI] = mark;
  audio.histI = (audio.histI + 1) % HIST;
}

// =====================================================================
// 6. STATE MACHINE
// =====================================================================
const S = { MASKED: 'MASKED', SHATTER: 'SHATTER', BARE: 'UNMASKED', REASSEMBLE: 'REASSEMBLE' };
let state = S.MASKED;
let stateTime = 0;               // seconds since entering state
let lastTriggerAt = -1e9;
let lastTriggerSrc = '-';
let triggerBanner = 0;           // seconds left to show the trigger banner

function setState(s) { state = s; stateTime = 0; }

/** Single entry point for every trigger source (clap, slap, keyboard). */
function trigger(source) {
  const now = performance.now();
  if (now - lastTriggerAt < TRIGGER_COOLDOWN_MS) return;
  if (state === S.REASSEMBLE) return;            // let the mask finish snapping together
  lastTriggerAt = now;
  lastTriggerSrc = source;
  console.debug(`[trigger] ${source} in state ${state}`);
  triggerBanner = 1.0;

  if (state === S.MASKED) {
    startShatter();
  } else {                                       // UNMASKED, or mid-shatter
    startReassemble();
  }
}

function updateState(dt) {
  stateTime += dt;
  if (state === S.SHATTER && shards.length === 0 && stateTime > 0.3) setState(S.BARE);
  if (state === S.REASSEMBLE && reassembly.done) setState(S.MASKED);
}

// =====================================================================
// 7. PARTICLE SYSTEM
// =====================================================================
let triJitter = new Float32Array(0);  // per-triangle color offset (faceted look)
let triRGB = new Float32Array(0);     // current shaded mask color per triangle
let triVis = new Float32Array(0);     // per-triangle visibility (reassembly)
let triFlash = new Float32Array(0);   // per-triangle white snap flash (reassembly)

// ---- effects shared by both transitions ----
let shake = 0;          // px amplitude
let glitch = 0;         // 0..1 intensity

// ---- 7a. SHATTER: triangles fly out toward the viewer ----
let shards = [];
const shatterVP = { x: 0, y: 0 };

function startShatter() {
  setState(S.SHATTER);
  shake = 26; glitch = 1;
  shards = [];
  if (!face.present || NTRI === 0) return;      // nothing on screen to break

  computeTriColors(PALETTES[paletteIdx], clock);
  shatterVP.x = face.cx; shatterVP.y = face.cy;
  const P = face.pts;

  // Collect triangles in screen space.
  let list = [];
  for (let i = 0; i < NTRI; i++) {
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    list.push({ v: [P[a], P[a + 1], P[b], P[b + 1], P[c], P[c + 1]], rgb: [triRGB[i * 3], triRGB[i * 3 + 1], triRGB[i * 3 + 2]] });
  }
  // Match the particle-count setting: drop random triangles, or split the biggest ones.
  const target = Math.round(settings.particleCount);
  if (target < list.length) {
    for (let i = list.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [list[i], list[j]] = [list[j], list[i]]; }
    list.length = target;
  } else if (target > list.length) {
    list = subdivide(list, target);
  }

  const fw = face.w;
  for (const t of list) {
    const v = t.v;
    const cx = (v[0] + v[2] + v[4]) / 3, cy = (v[1] + v[3] + v[5]) / 3;
    const lv = new Float32Array([v[0] - cx, v[1] - cy, v[2] - cx, v[3] - cy, v[4] - cx, v[5] - cy]);
    let dx = cx - face.cx, dy = cy - face.cy;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy / d, dx / d) + rand(-0.5, 0.5);
    const sp = fw * rand(0.6, 2.2);
    shards.push({
      x: cx, y: cy,                                  // world pos (== screen at z = 0)
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - fw * rand(0, 0.5),
      z: 0, vz: rand(0.12, 0.45),                    // z -> 1 means "at the viewer's eye"
      rot: 0, vrot: rand(-8, 8), flip: 0, vflip: rand(-10, 10),
      lv, rad: Math.max(Math.hypot(lv[0], lv[1]), Math.hypot(lv[2], lv[3]), Math.hypot(lv[4], lv[5])),
      rgb: t.rgb, age: -rand(0, 0.08), px: cx, py: cy, ps: 1,
    });
  }
}

/** Split largest triangles at the midpoint of their longest edge until we reach `target`. */
function subdivide(list, target) {
  const area = (v) => Math.abs((v[2] - v[0]) * (v[5] - v[1]) - (v[4] - v[0]) * (v[3] - v[1]));
  const queue = list.slice().sort((a, b) => area(b.v) - area(a.v));
  const out = [];
  let need = target - list.length, qi = 0;
  while (qi < queue.length) {
    const t = queue[qi++];
    if (need <= 0) { out.push(t); continue; }
    const v = t.v;
    const L = [Math.hypot(v[2] - v[0], v[3] - v[1]), Math.hypot(v[4] - v[2], v[5] - v[3]), Math.hypot(v[0] - v[4], v[1] - v[5])];
    const e = L.indexOf(Math.max(...L));
    const p = [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]]];
    const A = p[e], B = p[(e + 1) % 3], C = p[(e + 2) % 3];
    const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const shade = (k) => t.rgb.map((c) => clamp(c * k, 0, 255));
    queue.push({ v: [A[0], A[1], M[0], M[1], C[0], C[1]], rgb: shade(rand(0.9, 1.1)) });
    queue.push({ v: [M[0], M[1], B[0], B[1], C[0], C[1]], rgb: shade(rand(0.9, 1.1)) });
    need--;
  }
  return out;
}

function updateShards(dt) {
  const g = face.w * 1.3;              // gravity in world px/s^2
  let n = 0;
  for (const s of shards) {
    s.px = s.sx ?? s.x; s.py = s.sy ?? s.y; s.ps = s.s ?? 1;   // previous projected pose (motion blur)
    s.age += dt;
    if (s.age > 0) {
      s.vy += g * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.vz += 0.7 * dt; s.z += s.vz * dt;
      s.rot += s.vrot * dt; s.flip += s.vflip * dt;
    }
    // Perspective projection around the face center: scale grows as z -> 1.
    s.s = 1 / (1 - Math.min(s.z, 0.95));
    s.sx = shatterVP.x + (s.x - shatterVP.x) * s.s;
    s.sy = shatterVP.y + (s.y - shatterVP.y) * s.s;
    const m = s.rad * s.s;
    const off = s.sx < -m || s.sx > W + m || s.sy < -m || s.sy > H + m;
    if (!off && s.z < 0.93 && s.age < 3.5) shards[n++] = s;
  }
  shards.length = n;
}

function drawShards(ctx) {
  ctx.lineJoin = 'round';
  for (const s of shards) {
    const fadeZ = s.z < 0.55 ? 1 : clamp(1 - (s.z - 0.55) / 0.38, 0, 1);
    const alpha = fadeZ * clamp(1 - (s.age - 2.5), 0, 1);
    if (alpha <= 0.01) continue;
    const lit = 0.45 + 0.55 * Math.abs(Math.cos(s.flip));      // fake 3D tumble shading
    const hot = clamp(1 - s.age / 0.18, 0, 1);                  // white-hot right after impact
    const r = lerp(s.rgb[0] * lit, 255, hot), gg = lerp(s.rgb[1] * lit, 255, hot), b = lerp(s.rgb[2] * lit, 255, hot);
    const col = rgbStr(r, gg, b);
    // Motion blur: two faded copies between last frame's pose and this one.
    for (const k of [0.33, 0.66]) {
      drawTri(ctx, lerp(s.px, s.sx, k), lerp(s.py, s.sy, k), lerp(s.ps, s.s, k), s.rot - s.vrot * 0.016 * (1 - k), s.flip, s.lv, col, alpha * 0.22 * k);
    }
    drawTri(ctx, s.sx, s.sy, s.s, s.rot, s.flip, s.lv, col, alpha);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha * 0.6;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
}

/** Fill a triangle given in local coords, at (px,py) with scale/rotation/flip. Leaves the path set. */
function drawTri(ctx, px, py, s, rot, flip, lv, color, alpha) {
  const c = Math.cos(rot) * s, sn = Math.sin(rot) * s, fx = Math.cos(flip);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const x = lv[k * 2] * fx, y = lv[k * 2 + 1];
    const X = px + x * c - y * sn, Y = py + x * sn + y * c;
    k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  }
  ctx.closePath();
  ctx.fill();
}

// ---- 7b. REASSEMBLE: new triangles fly in from off-screen and snap onto the live mesh ----
const reassembly = { parts: [], t: 0, end: 0, done: true };

function startReassemble() {
  pickNewPalette();
  triJitter = triJitter.map(() => Math.random());
  setState(S.REASSEMBLE);
  glitch = 0.6; shake = 8;
  reassembly.parts = []; reassembly.t = 0; reassembly.done = false;
  if (!face.has || NTRI === 0) { reassembly.done = true; return; }

  const P = face.pts;
  const diag = Math.hypot(W, H);
  const flyCount = Math.min(NTRI, Math.round(settings.particleCount));
  const order = [...Array(NTRI).keys()].sort(() => Math.random() - 0.5);
  const flying = new Set(order.slice(0, flyCount));
  let end = 0;
  for (let i = 0; i < NTRI; i++) {
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const ang = Math.atan2(cy - face.cy, cx - face.cx) + rand(-0.6, 0.6);
    const R = diag * rand(0.7, 1.0);
    const part = {
      i, fly: flying.has(i),
      sx: face.cx + Math.cos(ang) * R, sy: face.cy + Math.sin(ang) * R,
      s0: rand(3, 7),                      // start big = close to the viewer, then shrink onto the face
      rot0: rand(-6, 6), flip0: rand(-5, 5),
      delay: rand(0, 0.55), dur: rand(0.65, 1.0), landed: -1,
    };
    end = Math.max(end, part.delay + part.dur);
    reassembly.parts.push(part);
    triVis[i] = 0; triFlash[i] = 0;
  }
  reassembly.end = end;
}

function updateReassembly(dt) {
  if (reassembly.done) return;
  const R = reassembly;
  R.t += dt;
  const fadeStart = R.end * 0.6;
  for (const p of R.parts) {
    if (p.fly) {
      const prog = (R.t - p.delay) / p.dur;
      if (prog >= 1 && p.landed < 0) p.landed = R.t;
      triVis[p.i] = p.landed >= 0 ? 1 : 0;
      triFlash[p.i] = p.landed >= 0 ? clamp(1 - (R.t - p.landed) / 0.25, 0, 1) : 0;
    } else {
      triVis[p.i] = clamp((R.t - fadeStart) / (R.end - fadeStart + 0.01), 0, 1);
    }
  }
  if (R.t > R.end + 0.3) {
    R.done = true;
    triVis.fill(1); triFlash.fill(0);
  }
}

function drawIncoming(ctx) {
  if (reassembly.done || !face.has) return;
  const P = face.pts, R = reassembly;
  const lv = new Float32Array(6);
  for (const p of R.parts) {
    if (!p.fly || p.landed >= 0) continue;
    const prog = (R.t - p.delay) / p.dur;
    if (prog <= 0) continue;
    const i = p.i;
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;  // live target
    lv[0] = P[a] - cx; lv[1] = P[a + 1] - cy; lv[2] = P[b] - cx; lv[3] = P[b + 1] - cy; lv[4] = P[c] - cx; lv[5] = P[c + 1] - cy;
    const col = rgbStr(triRGB[i * 3], triRGB[i * 3 + 1], triRGB[i * 3 + 2]);
    // trail copy slightly back in time = motion blur
    for (const [dp, al] of [[-0.06, 0.25], [0, 1]]) {
      const e = easeOutCubic(clamp(prog + dp, 0, 1));
      drawTri(ctx, lerp(p.sx, cx, e), lerp(p.sy, cy, e), lerp(p.s0, 1, e), p.rot0 * (1 - e), p.flip0 * (1 - e), lv, col, Math.min(1, prog * 3) * al);
    }
  }
  ctx.globalAlpha = 1;
}

// =====================================================================
// 8. RENDERING
// =====================================================================

// ---- 8a. Code background (purely decorative text, nothing is executed) ----
const code = {
  rain: document.createElement('canvas'), rctx: null,
  cols: [], terms: [], fs: 14, lh: 17, cw: 8.4,
  font: '14px Consolas, Menlo, "DejaVu Sans Mono", monospace',
};
code.rctx = code.rain.getContext('2d');
const RAIN_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF<>/{}[]=+*#$%&';

const SNIPPETS = {
  py: [
    ['import socket, hashlib, struct', '', 'def handshake(host, port=443):', '    s = socket.create_connection((host, port))', '    nonce = struct.pack(">Q", 0xDEADBEEF)', '    s.send(b"\\x16\\x03\\x01" + nonce)', '    return hashlib.sha256(s.recv(4096)).hexdigest()'],
    ['class NeuralMesh:', '    def __init__(self, points=468):', '        self.points = points', '        self.weights = np.random.randn(points, 3)', '', '    def lock(self, frame):', '        # project landmarks into target space', '        return self.weights @ frame.T'],
    ['for i, block in enumerate(cipher.blocks):', '    key = derive_key(seed ^ i, rounds=4096)', '    plain = xor(block, key)', '    if plain.startswith(b"ROOT"):', '        print(f"[+] block {i:04x} cracked")', '        break'],
    ['async def scan(subnet):', '    tasks = [probe(f"{subnet}.{h}") for h in range(1, 255)]', '    for host in await asyncio.gather(*tasks):', '        if host.open_ports:', '            log.info("target %s %s", host.ip, host.open_ports)'],
  ],
  js: [
    ['const ws = new WebSocket("wss://node-7.grid/uplink");', 'ws.onmessage = ({ data }) => {', '  const pkt = decode(new Uint8Array(data));', '  if (pkt.type === 0x1f) inject(pkt.payload);', '};'],
    ['function decrypt(buf, key) {', '  const out = new Uint8Array(buf.length);', '  for (let i = 0; i < buf.length; i++)', '    out[i] = buf[i] ^ key[i % key.length];', '  return out;', '}'],
    ['export async function trace(target) {', '  const hops = await traceroute(target, { ttl: 64 });', '  return hops.map(h => `${h.ip} ${h.rtt.toFixed(2)}ms`);', '}'],
    ['// face mesh uplink', 'const mesh = landmarks.map(({ x, y, z }) => [x * W, y * H, z]);', 'mesh.forEach((p, i) => grid.set(i, p));', 'emit("LOCK", { id: target.id, conf: 0.997 });'],
  ],
  sh: [
    ['$ nmap -sS -T4 10.0.13.0/24', 'Starting scan ...', 'PORT     STATE SERVICE', '22/tcp   open  ssh', '443/tcp  open  https', '8080/tcp open  http-proxy'],
    ['$ ssh -i ~/.keys/ghost root@10.0.13.37', 'Authenticating with public key "ghost"', 'Welcome to Mainframe OS 9.4 (GNU/Linux)', 'root@mainframe:~#'],
    ['$ ./decrypt --rounds 4096 vault.bin', 'loading keyspace .......... ok', 'brute forcing segment 3/8', 'match found: 0x7f3a99c2'],
    ['$ tail -f /var/log/uplink.log', 'uplink: handshake ok (aes-256-gcm)', 'uplink: streaming biometric frames', 'uplink: face mesh 468/468 locked'],
  ],
};
const hex = (n, w) => n.toString(16).padStart(w, '0');
const randHex = (w) => Array.from({ length: w }, () => '0123456789abcdef'[(Math.random() * 16) | 0]).join('');

function nextCodeBlock() {
  const r = Math.random();
  const typed = (lines, color, speed) => lines.map((t) => ({
    text: t, speed: speed * rand(0.7, 1.3), pause: rand(0, 0.15),
    color: /^\s*(#|\/\/)/.test(t) ? '#1d8f55' : color,
  }));
  if (r < 0.28) return typed(SNIPPETS.py[(Math.random() * SNIPPETS.py.length) | 0], '#39ff88', 70);
  if (r < 0.52) return typed(SNIPPETS.js[(Math.random() * SNIPPETS.js.length) | 0], '#5cffc8', 70);
  if (r < 0.70) {   // shell: command typed, output appears instantly
    return SNIPPETS.sh[(Math.random() * SNIPPETS.sh.length) | 0].map((t, i) => ({
      text: t, color: i === 0 ? '#00e5ff' : '#8dffbe', speed: i === 0 ? 45 : 0, pause: i === 0 ? 0.4 : 0.06,
    }));
  }
  if (r < 0.86) {   // hex dump
    const base = (Math.random() * 0xffff0) | 0;
    return Array.from({ length: 4 + ((Math.random() * 6) | 0) }, (_, i) => {
      const bytes = Array.from({ length: 16 }, () => randHex(2));
      const ascii = bytes.map((h) => { const c = parseInt(h, 16); return c > 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('');
      return { text: `${hex(base + i * 16, 8)}  ${bytes.slice(0, 8).join(' ')}  ${bytes.slice(8).join(' ')}  |${ascii}|`, color: '#1fd1a5', speed: 0, pause: 0.03 };
    });
  }
  // status spam
  const pct = (Math.random() * 100) | 0;
  const bar = '#'.repeat((pct / 10) | 0).padEnd(10, '-');
  return [
    { text: `[*] probing 10.0.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}:${[22, 80, 443, 3389, 8080][(Math.random() * 5) | 0]} ... OPEN`, color: '#8dffbe', speed: 0, pause: 0.12 },
    { text: `[${bar}] ${pct}% decrypting block 0x${randHex(6)}`, color: '#00e5ff', speed: 0, pause: 0.12 },
    { text: `sha256: ${randHex(48)}`, color: '#1d8f55', speed: 0, pause: 0.12 },
  ];
}

function initCodeBackground() {
  code.rain.width = Math.round(W * DPR); code.rain.height = Math.round(H * DPR);
  const r = code.rctx;
  r.setTransform(DPR, 0, 0, DPR, 0, 0);
  r.fillStyle = '#000'; r.fillRect(0, 0, W, H);
  r.font = code.font; r.textBaseline = 'top';
  cctx.font = code.font;
  code.cw = cctx.measureText('M').width || 8.4;

  const nCols = Math.ceil(W / code.fs);
  code.cols = Array.from({ length: nCols }, (_, i) => ({
    x: i * code.fs, y: -rand(0, H / code.lh), row: -999, speed: rand(6, 22), cyan: Math.random() < 0.22,
  }));

  const nTerms = clamp(Math.floor(W / 470), 1, 4);
  const colW = W / nTerms;
  const rows = Math.max(4, Math.floor((H - 24) / code.lh));
  code.terms = Array.from({ length: nTerms }, (_, i) => {
    const t = { x: i * colW + 14, maxChars: Math.max(10, Math.floor((colW - 28) / code.cw)), rows, lines: [], queue: [], cur: null, wait: rand(0, 1) };
    for (let k = 0, n = (rows * rand(0.3, 0.8)) | 0; k < n; k++) t.lines.push(nextLine(t));
    return t;
  });
}

function nextLine(t) {
  if (!t.queue.length) { t.queue = nextCodeBlock(); t.queue.push({ text: '', color: '#000', speed: 0, pause: rand(0.1, 0.6) }); }
  const L = t.queue.shift();
  L.text = L.text.slice(0, t.maxChars);
  L.shown = L.speed ? 0 : L.text.length;
  return L;
}

function renderCode(dt) {
  const sp = settings.codeSpeed;
  const r = code.rctx, lh = code.lh;

  // Matrix rain on its own persistent canvas: fade old glyphs, draw new heads.
  r.globalAlpha = 1;
  r.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.9, dt * 60)})`;
  r.fillRect(0, 0, W, H);
  for (const c of code.cols) {
    c.y += c.speed * dt * sp;
    const row = Math.floor(c.y);
    if (row !== c.row) {
      for (let k = Math.max(c.row + 1, row - 3); k <= row; k++) {
        if (k < 0) continue;
        if (k > 0) {   // settle previous head into the trail color
          r.fillStyle = '#000'; r.fillRect(c.x, (k - 1) * lh, code.fs, lh);
          r.fillStyle = c.cyan ? '#00c8e0' : '#14d36a';
          r.fillText(RAIN_CHARS[(Math.random() * RAIN_CHARS.length) | 0], c.x, (k - 1) * lh);
        }
        r.fillStyle = c.cyan ? '#d8fbff' : '#d8ffe6';
        r.fillText(RAIN_CHARS[(Math.random() * RAIN_CHARS.length) | 0], c.x, k * lh);
      }
      c.row = row;
    }
    if (c.row * lh > H && Math.random() < 0.03 * dt * 60) {
      c.y = -rand(0, 12); c.row = Math.floor(c.y); c.speed = rand(6, 22);
    }
  }

  // Compose: black, rain, then typing terminals.
  const ctx = cctx;
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.55;
  ctx.drawImage(code.rain, 0, 0, W, H);
  ctx.font = code.font; ctx.textBaseline = 'top';

  const blink = Math.floor(clock * 2.5) % 2 === 0;
  for (const t of code.terms) {
    // typing
    t.wait -= dt * sp;
    if (t.wait <= 0) {
      if (!t.cur) t.cur = nextLine(t);
      const L = t.cur;
      L.shown = L.speed ? L.shown + L.speed * dt * sp : L.text.length;
      if (L.shown >= L.text.length) {
        L.shown = L.text.length;
        t.lines.push(L);
        if (t.lines.length > t.rows - 1) t.lines.splice(0, t.lines.length - (t.rows - 1));
        t.cur = null; t.wait = L.pause || 0;
      }
    }
    // draw (older lines dimmer)
    const total = t.lines.length;
    for (let i = 0; i < total; i++) {
      const L = t.lines[i];
      if (!L.text) continue;
      ctx.globalAlpha = 0.25 + 0.5 * (i / t.rows);
      ctx.fillStyle = L.color;
      ctx.fillText(L.text, t.x, 12 + i * lh);
    }
    const y = 12 + total * lh;
    ctx.globalAlpha = 0.9;
    let curText = '';
    if (t.cur) { curText = t.cur.text.slice(0, Math.floor(t.cur.shown)); ctx.fillStyle = t.cur.color; ctx.fillText(curText, t.x, y); }
    if (blink) { ctx.fillStyle = '#39ff88'; ctx.fillRect(t.x + curText.length * code.cw + 1, y + 1, code.cw * 0.8, lh - 4); }
  }
  ctx.globalAlpha = 1;
}

// ---- 8b. Ghost face: tinted webcam, composited at settings.ghostOpacity (default 30%) ----
const ghost = document.createElement('canvas');
const gctx = ghost.getContext('2d');
const GHOST_SCALE = 0.5;   // half resolution is plenty for a 30% ghost

function initGhost() {
  ghost.width = Math.max(1, Math.round(W * GHOST_SCALE));
  ghost.height = Math.max(1, Math.round(H * GHOST_SCALE));
}

function drawGhost(ctx, dt) {
  if (!camReady || video.readyState < 2) return;
  // ease tint toward the current palette
  const target = PALETTES[paletteIdx].tintRgb, k = 1 - Math.pow(0.02, dt);
  for (let i = 0; i < 3; i++) ghostTint[i] += (target[i] - ghostTint[i]) * k;

  const gs = GHOST_SCALE;
  gctx.globalCompositeOperation = 'source-over';
  gctx.filter = 'grayscale(1) contrast(1.4) brightness(1.2)';
  gctx.save();
  gctx.translate(ghost.width, 0); gctx.scale(-1, 1);            // selfie mirror
  gctx.drawImage(video, view.dx * gs, view.dy * gs, view.dw * gs, view.dh * gs);
  gctx.restore();
  gctx.filter = 'none';
  gctx.globalCompositeOperation = 'multiply';                   // grayscale x tint = tinted
  gctx.fillStyle = rgbStr(ghostTint[0], ghostTint[1], ghostTint[2]);
  gctx.fillRect(0, 0, ghost.width, ghost.height);
  gctx.globalCompositeOperation = 'source-over';

  ctx.globalAlpha = settings.ghostOpacity / 100;
  ctx.drawImage(ghost, 0, 0, W, H);
  ctx.globalAlpha = 1;
}

// ---- 8c. Color mask: filled mesh triangles with low-poly shading + glowing edges ----
const _c = [0, 0, 0];
const LIGHT = (() => { const l = [-0.35, -0.45, 0.82], n = Math.hypot(...l); return l.map((v) => v / n); })();

/** Compute each triangle's shaded neon color for the given palette into triRGB. */
function computeTriColors(pal, time) {
  const P = face.pts, fw = face.w, fh = face.h;
  for (let i = 0; i < NTRI; i++) {
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    const mx = (P[a] + P[b] + P[c]) / 3, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    // spatial gradient across the face + per-triangle jitter + slow flow over time
    const t = ((my - face.minY) / fh) * 0.75 + ((mx - face.minX) / fw) * 0.35 + triJitter[i] * 0.18 + time * 0.06;
    samplePalette(pal, t, _c);
    // flat shading from the 3D triangle normal
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }              // always face the viewer
    const len = Math.hypot(nx, ny, nz) || 1;
    const shade = 0.4 + 0.8 * Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / len);
    triRGB[i * 3] = Math.min(255, _c[0] * shade);
    triRGB[i * 3 + 1] = Math.min(255, _c[1] * shade);
    triRGB[i * 3 + 2] = Math.min(255, _c[2] * shade);
  }
}

function drawMask(ctx, pal, partial) {
  const P = face.pts;
  ctx.globalCompositeOperation = 'source-over';
  const edges = new Path2D();
  for (let i = 0; i < NTRI; i++) {
    const vis = partial ? triVis[i] : 1;
    if (vis <= 0) continue;
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    let r = triRGB[i * 3], g = triRGB[i * 3 + 1], bl = triRGB[i * 3 + 2];
    if (partial && triFlash[i] > 0) { const f = triFlash[i]; r = lerp(r, 255, f); g = lerp(g, 255, f); bl = lerp(bl, 255, f); }
    ctx.globalAlpha = vis;
    ctx.fillStyle = rgbStr(r, g, bl);
    ctx.beginPath();
    ctx.moveTo(P[a], P[a + 1]); ctx.lineTo(P[b], P[b + 1]); ctx.lineTo(P[c], P[c + 1]);
    ctx.closePath();
    ctx.fill();
    if (partial && vis >= 1) {
      edges.moveTo(P[a], P[a + 1]); edges.lineTo(P[b], P[b + 1]); edges.lineTo(P[c], P[c + 1]); edges.closePath();
    }
  }
  if (!partial) {
    for (let e = 0; e < EDGES.length; e += 2) {
      const p = EDGES[e] * 3, q = EDGES[e + 1] * 3;
      edges.moveTo(P[p], P[p + 1]); edges.lineTo(P[q], P[q + 1]);
    }
  }
  // Glow = wide faint stroke + thin bright stroke, additive.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = pal.edge; ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.18; ctx.lineWidth = 3; ctx.stroke(edges);
  ctx.globalAlpha = 0.75; ctx.lineWidth = 0.7; ctx.stroke(edges);

  // Eyes + lips contours and glowing irises
  if (!partial || reassembly.t > reassembly.end) {
    const feat = new Path2D();
    for (const { start, end } of FEATURE_EDGES) {
      feat.moveTo(P[start * 3], P[start * 3 + 1]); feat.lineTo(P[end * 3], P[end * 3 + 1]);
    }
    ctx.globalAlpha = 0.35; ctx.lineWidth = 5; ctx.stroke(feat);
    ctx.globalAlpha = 1; ctx.lineWidth = 1.4; ctx.strokeStyle = '#ffffff'; ctx.stroke(feat);
    const ir = face.w * 0.018;
    for (const k of [468, 473]) {
      ctx.globalAlpha = 0.5; ctx.fillStyle = pal.edge;
      ctx.beginPath(); ctx.arc(P[k * 3], P[k * 3 + 1], ir * 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(P[k * 3], P[k * 3 + 1], ir, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// =====================================================================
// 9. HUD + GLITCH + DEBUG
// =====================================================================
let debug = false;
let fps = 0, fpsFrames = 0, fpsT = performance.now();
let idleGlitchT = rand(3, 7);

function hudText(ctx, s, x, y, align = 'left', color = null, size = 12) {
  ctx.font = `${size}px Consolas, Menlo, "DejaVu Sans Mono", monospace`;
  ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillStyle = color || '#39ff88';
  ctx.fillText(s, x, y);
}

function drawHUD(ctx, now) {
  const pal = PALETTES[paletteIdx];
  const accent = pal.edge;
  const m = 18, lh = 16;
  ctx.globalAlpha = 0.9;
  ctx.shadowColor = '#39ff88'; ctx.shadowBlur = 6;

  // corner brackets
  ctx.strokeStyle = 'rgba(57,255,136,0.6)'; ctx.lineWidth = 1.5;
  const L = 26;
  ctx.beginPath();
  ctx.moveTo(8, 8 + L); ctx.lineTo(8, 8); ctx.lineTo(8 + L, 8);
  ctx.moveTo(W - 8 - L, 8); ctx.lineTo(W - 8, 8); ctx.lineTo(W - 8, 8 + L);
  ctx.moveTo(8, H - 8 - L); ctx.lineTo(8, H - 8); ctx.lineTo(8 + L, H - 8);
  ctx.moveTo(W - 8 - L, H - 8); ctx.lineTo(W - 8, H - 8); ctx.lineTo(W - 8, H - 8 - L);
  ctx.stroke();

  const blink = Math.floor(clock * 2) % 2 === 0;
  const t = new Date();
  // top-left
  hudText(ctx, `> SYSTEM ONLINE${blink ? '_' : ''}`, m, m);
  hudText(ctx, `> NEURAL MESH v4.7 // ${NTRI || '---'} TRI`, m, m + lh, 'left', '#1fd1a5');
  hudText(ctx, `> ${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`, m, m + lh * 2, 'left', '#1fd1a5');
  // top-right
  hudText(ctx, `FPS ${fps.toFixed(0).padStart(3, ' ')}`, W - m, m, 'right', fps >= 30 ? '#39ff88' : '#ffcc00');
  hudText(ctx, `TRACK ${trackHz.toFixed(0)} Hz`, W - m, m + lh, 'right', '#1fd1a5');
  const lvl = micAvailable ? clamp((20 * Math.log10(audio.rms + 1e-9) + 60) / 60, 0, 1) : 0;
  const bars = Math.round(lvl * 10);
  hudText(ctx, micAvailable ? `MIC [${'|'.repeat(bars).padEnd(10, '.')}]` : 'MIC [OFFLINE]', W - m, m + lh * 2, 'right', '#1fd1a5');
  // bottom-left
  hudText(ctx, `STATE: ${state}`, m, H - m - lh * 3, 'left', accent);
  hudText(ctx, `PALETTE: ${pal.name}`, m, H - m - lh * 2, 'left', accent);
  hudText(ctx, `LAST TRIGGER: ${lastTriggerSrc}`, m, H - m - lh, 'left', '#1fd1a5');
  // bottom-right
  const locked = face.present;
  hudText(ctx, locked ? 'FACE LOCKED' : (blink ? 'SCANNING FOR TARGET...' : 'SCANNING FOR TARGET'), W - m, H - m - lh * 2, 'right', locked ? '#39ff88' : '#ff3b6b');
  hudText(ctx, '[SPACE] TRIGGER  [S] SETTINGS  [D] DEBUG  [F] FULL', W - m, H - m - lh, 'right', '#1d8f55', 11);

  // target brackets around the face
  if (locked) {
    const pad = face.w * 0.18;
    const x0 = face.minX - pad, y0 = face.minY - pad, x1 = face.minX + face.w + pad, y1 = face.minY + face.h + pad;
    const k = Math.min(30, face.w * 0.15);
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.shadowColor = accent;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + k, y0);
    ctx.moveTo(x1 - k, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + k);
    ctx.moveTo(x0, y1 - k); ctx.lineTo(x0, y1); ctx.lineTo(x0 + k, y1);
    ctx.moveTo(x1 - k, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - k);
    ctx.stroke();
    hudText(ctx, `TARGET LOCKED // ID ${(face.w * 97 | 0).toString(16).toUpperCase().padStart(4, '0')}`, x0, y0 - 16, 'left', accent, 11);
  }

  // center messages
  const status = modelStatus || (!camReady ? 'AWAITING AUTHORIZATION' : '');
  if (status) {
    hudText(ctx, status, W / 2, H / 2 - 8, 'center', '#00e5ff', 18);
  } else if (!locked) {
    // radar sweep + scanning text
    const R = Math.min(W, H) * 0.18, a = clock * 3;
    ctx.strokeStyle = 'rgba(57,255,136,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, R, a, a + 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 0.7, -a * 1.3, -a * 1.3 + 0.8); ctx.stroke();
    if (blink) hudText(ctx, 'SCANNING FOR TARGET...', W / 2, H / 2 - 10, 'center', '#ff3b6b', 20);
  }

  // trigger banner
  if (triggerBanner > 0) {
    ctx.globalAlpha = clamp(triggerBanner * 2, 0, 1);
    hudText(ctx, `◢ ${lastTriggerSrc} DETECTED ◣`, W / 2, 56, 'center', accent, 22);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/** Horizontal slice displacement + color flash. Works on any canvas, in place. */
function applyGlitch(ctx, canvas, g, flashColor) {
  if (g <= 0.01) return;
  const slices = 3 + Math.floor(g * 10);
  for (let i = 0; i < slices; i++) {
    const y = Math.random() * H, h = rand(3, 40) * (0.4 + g);
    const dx = rand(-60, 60) * g;
    ctx.drawImage(canvas, 0, y * DPR, canvas.width, h * DPR, dx, y, W, h);
  }
  if (flashColor) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.pow(g, 2) * 0.55;
    ctx.fillStyle = flashColor;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

function drawDebug(ctx) {
  // landmarks
  if (face.has) {
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < N_LM; i++) ctx.fillRect(face.pts[i * 3] - 0.75, face.pts[i * 3 + 1] - 0.75, 1.5, 1.5);
  }
  for (const h of hands.list) {
    ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const { start, end } of HAND_CONNECTIONS) { ctx.moveTo(h.pts[start][0], h.pts[start][1]); ctx.lineTo(h.pts[end][0], h.pts[end][1]); }
    ctx.stroke();
    const need = face.w * SLAP_SPEED;
    hudText(ctx, `hand ${h.speed.toFixed(0)} px/s (slap > ${need.toFixed(0)})`, h.x + 12, h.y, 'left', h.speed > need ? '#ff3b6b' : '#ffcc00', 12);
  }

  // mic meter (dBFS scale)
  const w = Math.min(460, W - 32), hgt = 100, x = (W - w) / 2, y = H - hgt - 64;
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(x, y, w, hgt);
  ctx.strokeStyle = '#1d8f55'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
  if (!micAvailable) { hudText(ctx, 'MIC UNAVAILABLE', x + w / 2, y + hgt / 2 - 6, 'center', '#ff3b6b'); return; }
  const dbY = (v) => y + hgt - clamp((20 * Math.log10(v + 1e-9) + 60) / 60, 0, 1) * hgt;
  const step = w / HIST;
  ctx.strokeStyle = '#39ff88'; ctx.beginPath();
  for (let k = 0; k < HIST; k++) {
    const idx = (audio.histI + k) % HIST, px = x + k * step, py = dbY(audio.hist[idx]);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    if (audio.histTrig[idx]) { ctx.save(); ctx.fillStyle = audio.histTrig[idx] === 1 ? '#ff3b6b' : '#ffcc00'; ctx.fillRect(px - 1, y, 2, hgt); ctx.restore(); }
  }
  ctx.stroke();
  ctx.strokeStyle = '#ff3b6b'; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(x, dbY(audio.thr)); ctx.lineTo(x + w, dbY(audio.thr)); ctx.stroke();
  ctx.strokeStyle = '#1d8f55';
  ctx.beginPath(); ctx.moveTo(x, dbY(audio.floor)); ctx.lineTo(x + w, dbY(audio.floor)); ctx.stroke();
  ctx.setLineDash([]);
  const db = (v) => (20 * Math.log10(v + 1e-9)).toFixed(1);
  hudText(ctx, `LEVEL ${db(audio.rms)} dB   THR ${db(audio.thr)} dB (red)   FLOOR ${db(audio.floor)} dB`, x + 8, y + 6, 'left', '#b6f5cf', 11);
  hudText(ctx, `CREST ${audio.crest.toFixed(1)} (need > ${clapParams().crestMin.toFixed(1)})   SENSITIVITY ${settings.sensitivity}   REJECTED ${audio.rejected}`, x + 8, y + 20, 'left', '#b6f5cf', 11);
}

// =====================================================================
// 10. UI: START BUTTON, KEYBOARD, SETTINGS PANEL
// =====================================================================
const startEl = document.getElementById('start');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const settingsEl = document.getElementById('settings');

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.blur();
  // The AudioContext must be created/resumed inside the user gesture.
  try { audio.ctx = new (window.AudioContext || window.webkitAudioContext)(); audio.ctx.resume(); }
  catch (err) { console.warn('Web Audio unavailable:', err); }

  if (!navigator.mediaDevices?.getUserMedia) {
    statusEl.textContent = 'getUserMedia unavailable. Serve over http://localhost (not file://).';
    startBtn.disabled = false; return;
  }
  statusEl.textContent = 'REQUESTING CAMERA + MICROPHONE...';
  try {
    const stream = await startCamera();
    initAudio(stream);
  } catch (err) {
    statusEl.textContent = `CAMERA ACCESS FAILED: ${err.name || err}`;
    startBtn.disabled = false; return;
  }
  startEl.classList.add('hidden');
  loadModels();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (e.key === ' ' && (tag === 'INPUT' || tag === 'BUTTON')) return;   // let controls handle space
  if (e.repeat) return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); trigger('KEY'); break;
    case 'f': toggleFullscreen(); break;
    case 'd': debug = !debug; break;
    case 's': settingsEl.classList.toggle('hidden'); break;
  }
});

function bindSettings() {
  const fmt = { sensitivity: (v) => v, ghostOpacity: (v) => `${v}%`, particleCount: (v) => v, codeSpeed: (v) => `${Number(v).toFixed(1)}x` };
  const sync = () => {
    for (const k of Object.keys(DEFAULTS)) {
      const el = document.getElementById(k);
      if (el.type === 'checkbox') el.checked = settings[k];
      else { el.value = settings[k]; document.getElementById(`v-${k}`).textContent = fmt[k](settings[k]); }
    }
  };
  for (const k of Object.keys(DEFAULTS)) {
    const el = document.getElementById(k);
    el.addEventListener('input', () => {
      settings[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
      sync(); saveSettings();
    });
  }
  document.getElementById('resetSettings').addEventListener('click', (e) => {
    Object.assign(settings, DEFAULTS); sync(); saveSettings(); e.target.blur();
  });
  sync();
}

// =====================================================================
// 11. MAIN LOOP
// =====================================================================
let clock = 0;
let lastT = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  clock += dt;

  // FPS / tracking rate
  fpsFrames++;
  if (now - fpsT > 500) {
    fps = (fpsFrames * 1000) / (now - fpsT);
    trackHz = (trackCount * 1000) / (now - fpsT);
    fpsFrames = 0; trackCount = 0; fpsT = now;
  }

  // --- inputs ---
  if (camReady) { updateView(); try { track(now); } catch (err) { console.error(err); } }

  // --- simulation ---
  updateState(dt);
  updateShards(dt);
  updateReassembly(dt);
  shake *= Math.pow(0.004, dt);
  glitch = Math.max(0, glitch - dt * 2.2);
  triggerBanner = Math.max(0, triggerBanner - dt);
  idleGlitchT -= dt;
  if (idleGlitchT <= 0) { idleGlitchT = rand(3, 8); glitch = Math.max(glitch, 0.18); }

  // --- layer 1: code ---
  renderCode(dt);

  // --- layers 2-4 ---
  const ctx = fctx;
  ctx.clearRect(0, 0, W, H);
  drawGhost(ctx, dt);

  const pal = PALETTES[paletteIdx];
  if (face.present && NTRI && (state === S.MASKED || state === S.REASSEMBLE)) {
    computeTriColors(pal, clock);
    drawMask(ctx, pal, state === S.REASSEMBLE);
  } else if (state === S.REASSEMBLE && face.has && NTRI) {
    computeTriColors(pal, clock);              // face briefly lost: keep flying to last known pose
  }
  if (state === S.REASSEMBLE) drawIncoming(ctx);
  if (shards.length) drawShards(ctx);

  // glitch on both canvases (big flash only on real triggers)
  if (glitch > 0.01) {
    applyGlitch(cctx, codeCanvas, glitch, null);
    applyGlitch(ctx, fxCanvas, glitch, glitch > 0.3 ? (glitch > 0.85 ? '#ffffff' : pal.edge) : null);
  }

  drawHUD(ctx, now);
  if (debug) drawDebug(ctx);

  // screen shake (CSS transform on both canvases)
  stageEl.style.transform = shake > 0.3 ? `translate(${rand(-shake, shake).toFixed(1)}px, ${rand(-shake, shake).toFixed(1)}px)` : '';

  requestAnimationFrame(frame);
}

// Boot: the code background runs immediately, even before Start is pressed.
bindSettings();
resize();
requestAnimationFrame(frame);

// Handy for console testing: hackerFace.trigger()
window.hackerFace = { trigger: () => trigger('KEY'), settings, audio, face, audioTick: updateAudio, get state() { return state; } };
