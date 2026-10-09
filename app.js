/* =====================================================================
 *  HACKER//FACE — live webcam "hacker face" effect
 *
 *  Layers (back -> front):
 *    1. Camera            (<video>)       crisp mirrored webcam, optional palette tint
 *    2. Code panel        (#code canvas)  matrix rain + fake typing terminals on one side
 *    3. Mask + beams      (#fx canvas)    468-pt face mesh mask (4 designs), data beams
 *                                         from the code panel to your fingertips, bloom
 *    4. HUD               (#fx canvas + CSS scanlines/vignette)
 *
 *  Sections:
 *    0. Settings & constants      6. State machine
 *    1. Palettes & color utils    7. Particle system (shatter / reassemble)
 *    2. Canvas setup              8. Rendering (code, mask, hands)
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

const SETTINGS_KEY = 'hackerface.settings.v2';
const DEFAULTS = {
  sensitivity: 5,      // 1 (deaf) .. 10 (very sensitive)
  camTint: 0,          // percent of palette color washed over the camera (0 = clear)
  codeWidth: 36,       // code panel width, percent of screen
  codeRight: false,    // code panel on the right instead of the left
  robot: true,         // hand-controlled robot that punches the screen on a clap
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
].map((p) => ({ ...p, glow: p.colors[3], rgb: p.colors.map(hexToRgb), tintRgb: hexToRgb(p.tint), edgeRgb: hexToRgb(p.edge) }));

let paletteIdx = 0;                                // State A starts with palette #1
const camTintRgb = [...PALETTES[0].tintRgb];       // eased toward the current palette tint

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
const tintEl = document.getElementById('tint');
const cctx = codeCanvas.getContext('2d');
const fctx = fxCanvas.getContext('2d');

let W = 0, H = 0, DPR = 1;
let CW = 0;               // code panel width (CSS px)
let edgeX = 0;            // x of the panel's inner edge, where the hand beams start
let camL = 0, camR = 0;   // the camera area not covered by the panel (HUD lives here)

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);   // cap for performance
  W = window.innerWidth; H = window.innerHeight;

  // Code panel on one side, fading into the camera at its inner edge.
  const right = settings.codeRight;
  CW = Math.round(clamp(W * settings.codeWidth / 100, Math.min(240, W * 0.5), W * 0.7));
  edgeX = right ? W - CW : CW;
  camL = right ? 0 : CW; camR = right ? W - CW : W;
  codeCanvas.style.width = `${CW}px`;
  codeCanvas.style.left = right ? `${W - CW}px` : '0px';
  const fade = `linear-gradient(${right ? 'to left' : 'to right'}, #000 82%, transparent 100%)`;
  codeCanvas.style.maskImage = fade; codeCanvas.style.webkitMaskImage = fade;
  codeCanvas.width = Math.max(1, Math.round(CW * DPR)); codeCanvas.height = Math.round(H * DPR);
  cctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  fxCanvas.width = Math.round(W * DPR); fxCanvas.height = Math.round(H * DPR);
  fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  initCodeBackground();
  initBloom();
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
  const videoC = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: 'user' };  // HD = clear picture
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
let FACE_OVAL = [];                  // face outline (glowing rim)
let VERT_EDGES = [];                 // vertex -> indices of its edges (energy pulses walk these)
let HAND_CONNECTIONS = [];

const hands = { list: [], lastSlap: -1e9 };   // list: {pts, rx, ry, t, speed, alpha, seen}
let glyphTrail = [];                           // code glyphs shed by fast hand motion
let lastVideoTime = -1;
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
  VERT_EDGES = Array.from({ length: N_LM }, () => []);
  for (let e = 0; e < EDGES.length / 2; e++) { VERT_EDGES[EDGES[e * 2]].push(e); VERT_EDGES[EDGES[e * 2 + 1]].push(e); }
  FACE_OVAL = mp.FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
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
  initPulses();
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

  // Hands every frame: they drive the data beams as well as the slap trigger.
  if (handLandmarker) processHands(handLandmarker.detectForVideo(video, now), now);
}

/** A hand is a fist when at least 3 fingertips are curled back toward the wrist. */
function isFist(p) {
  const d = (a, b) => Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]);
  let curled = 0;
  for (const [tip, knuckle] of [[8, 5], [12, 9], [16, 13], [20, 17]]) if (d(tip, 0) < d(knuckle, 0) * 1.25) curled++;
  return curled >= 3;
}

/** Track hands (smoothed, for the beams) and detect the slap gesture: a hand moving fast near the face. */
function processHands(res, now) {
  for (const h of hands.list) h.seen = false;
  for (const lms of res.landmarks || []) {
    const raw = lms.map((l) => [toScreenX(l.x), toScreenY(l.y)]);
    let x = 0, y = 0;
    for (const k of [0, 5, 9, 13, 17]) { x += raw[k][0]; y += raw[k][1]; }   // palm center
    x /= 5; y /= 5;

    // Match with the nearest hand from the previous detection.
    let prev = null, bd = Infinity;
    for (const h of hands.list) {
      if (h.seen) continue;
      const d = Math.hypot(h.rx - x, h.ry - y);
      if (d < bd) { bd = d; prev = h; }
    }
    if (!prev || bd > Math.max(W, H) * 0.35) {
      hands.list.push({ pts: raw, rx: x, ry: y, t: now, speed: 0, alpha: 0, seen: true, fist: isFist(raw) });
      continue;
    }
    const dt = (now - prev.t) / 1000;
    const speed = dt > 0.001 && dt < 0.3 ? bd / dt : 0;

    const faceRecent = face.has && now - face.lastSeen < 800;   // a hand over the face can hide it briefly
    if (settings.slapTrigger && faceRecent && speed > 0) {
      const fw = face.w, r = fw * SLAP_RADIUS;
      const near = Math.hypot(x - face.cx, y - face.cy) < r || Math.hypot(prev.rx - face.cx, prev.ry - face.cy) < r;
      if (near && speed > fw * SLAP_SPEED && now - hands.lastSlap > SLAP_COOLDOWN_MS) {
        hands.lastSlap = now;
        trigger('SLAP');
      }
    }

    // Fast motion sheds code glyphs from the fingertips.
    if (speed > (face.has ? face.w * 1.5 : W * 0.5) && glyphTrail.length < 400) {
      for (const k of [4, 8, 12, 16, 20]) {
        glyphTrail.push({ x: raw[k][0], y: raw[k][1], vx: rand(-40, 40), vy: rand(-40, 40), life: 0, max: rand(0.5, 1.1),
          ch: BEAM_CHARS[(Math.random() * BEAM_CHARS.length) | 0], cyan: Math.random() < 0.4 });
      }
    }

    // Light smoothing so the beams don't jitter.
    for (let k = 0; k < raw.length; k++) {
      prev.pts[k][0] += (raw[k][0] - prev.pts[k][0]) * 0.65;
      prev.pts[k][1] += (raw[k][1] - prev.pts[k][1]) * 0.65;
    }
    prev.rx = x; prev.ry = y; prev.t = now; prev.speed = lerp(prev.speed, speed, 0.5); prev.seen = true;
    prev.fist = isFist(raw);
  }
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
  if (settings.robot && robot.phase !== 'idle') return;   // robot is mid-punch
  lastTriggerAt = now;
  lastTriggerSrc = source;
  console.debug(`[trigger] ${source} in state ${state}`);
  triggerBanner = 1.0;

  const transition = () => {
    if (state === S.REASSEMBLE) return;
    if (state === S.MASKED) startShatter();
    else startReassemble();                      // UNMASKED, or mid-shatter
  };
  // With the robot on, the mask breaks / rebuilds when its fist hits the glass.
  if (settings.robot) robotPunch(transition);
  else transition();
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
    let rgb = [triRGB[i * 3], triRGB[i * 3 + 1], triRGB[i * 3 + 2]];
    if (rgb[0] + rgb[1] + rgb[2] < 220) rgb = samplePalette(PALETTES[paletteIdx], triJitter[i], [0, 0, 0]);   // dark designs: bright shards
    list.push({ v: [P[a], P[a + 1], P[b], P[b + 1], P[c], P[c + 1]], rgb });
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
  pickNewStyle();
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

// ---- 7c. ROBOT: lives on the side opposite the code panel, driven by your hand.
//      A clap makes it wind up, grow huge and punch the screen: the glass cracks. ----
const robot = {
  x: 0, y: 0, vx: 0, vy: 0,          // body position (spring-follows the target)
  lean: 0,
  fist: 0,                           // 0 = open hand, 1 = closed fist (mirrors your hand)
  reach: { x: 0, y: 0 },             // where the front arm's hand points (screen px)
  phase: 'idle', pt: 0,              // idle | windup | punch | recover
  impact: { x: 0, y: 0 },
  onImpact: null,
};
const PUNCH_WINDUP = 0.32, PUNCH_HIT = 0.2, PUNCH_RECOVER = 0.7;

/** Screen region the robot lives in: the far side of the camera area from the code panel. */
function robotZone() {
  const zw = Math.max(220, (camR - camL) * 0.34);
  return settings.codeRight ? { l: camL, r: camL + zw } : { l: camR - zw, r: camR };
}
const robotUnit = () => Math.max(16, Math.min(H * 0.07, (robotZone().r - robotZone().l) * 0.13));
const robotFacing = () => (settings.codeRight ? 1 : -1);    // +1 = robot faces right (toward screen center)

function controlHand() {
  let best = null;
  for (const h of hands.list) if (h.seen && (!best || h.alpha > best.alpha)) best = h;
  return best;
}

/** Start the punch; `onImpact` runs when the fist hits the glass. Returns false if busy. */
function robotPunch(onImpact) {
  if (robot.phase !== 'idle') return false;
  robot.phase = 'windup'; robot.pt = 0; robot.onImpact = onImpact;
  // punch lands on your face if we have one, else the middle of the camera area
  robot.impact.x = face.present ? face.cx : (camL + camR) / 2;
  robot.impact.y = face.present ? face.cy : H * 0.45;
  return true;
}

function updateRobot(dt) {
  const z = robotZone(), u = robotUnit();
  const h = controlHand();
  // target: your hand's position mapped into the robot's zone
  let tx = (z.l + z.r) / 2, ty = H * 0.55 + Math.sin(clock * 1.6) * u * 0.4;
  if (h) {
    tx = z.l + (h.rx / W) * (z.r - z.l);
    ty = clamp(h.ry, H * 0.3, H - u * 5);
    robot.fist = lerp(robot.fist, h.fist ? 1 : 0, 1 - Math.pow(0.001, dt));
    robot.reach.x = h.pts[9][0]; robot.reach.y = h.pts[9][1];
  } else {
    robot.fist = lerp(robot.fist, 0, 1 - Math.pow(0.05, dt));
    robot.reach.x = (camL + camR) / 2; robot.reach.y = H * 0.5 + Math.sin(clock) * 60;
  }
  if (robot.phase !== 'idle') {                 // during the punch the robot steps toward the target
    tx = lerp((z.l + z.r) / 2, robot.impact.x, 0.25); ty = H * 0.55;
    robot.fist = 1;
  }
  // keep the whole robot on screen, even at its biggest wind-up size
  const half = u * 2.2 * robotScale();
  tx = clamp(tx, Math.min(z.l + half, W / 2), Math.max(z.r - half, W / 2));
  ty = clamp(ty, u * 3.8 * robotScale(), H - u * 3.2 * robotScale());
  if (!robot.x) { robot.x = tx; robot.y = ty; }
  // critically-damped-ish spring
  const k = 60, d = 12;
  robot.vx += ((tx - robot.x) * k - robot.vx * d) * dt;
  robot.vy += ((ty - robot.y) * k - robot.vy * d) * dt;
  robot.x += robot.vx * dt; robot.y += robot.vy * dt;
  robot.lean = lerp(robot.lean, clamp(robot.vx / 900, -0.35, 0.35), 0.2);

  if (robot.phase === 'idle') return;
  robot.pt += dt;
  if (robot.phase === 'windup' && robot.pt >= PUNCH_WINDUP) { robot.phase = 'punch'; robot.pt = 0; }
  else if (robot.phase === 'punch' && robot.pt >= PUNCH_HIT) {
    robot.phase = 'recover'; robot.pt = 0;
    smashGlass(robot.impact.x, robot.impact.y);
    if (robot.onImpact) robot.onImpact();
    robot.onImpact = null;
  } else if (robot.phase === 'recover' && robot.pt >= PUNCH_RECOVER) { robot.phase = 'idle'; robot.pt = 0; }
}

/** Robot body scale: grows during the wind-up, peaks on the hit, shrinks back. */
function robotScale() {
  if (robot.phase === 'windup') return 1 + 0.9 * easeOutCubic(robot.pt / PUNCH_WINDUP);
  if (robot.phase === 'punch') return 1.9 + 0.4 * (robot.pt / PUNCH_HIT);
  if (robot.phase === 'recover') return lerp(2.3, 1, easeOutCubic(robot.pt / PUNCH_RECOVER));
  return 1;
}

function metal(ctx, x0, y0, x1, y1, dark = false) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  if (dark) { g.addColorStop(0, '#5b6572'); g.addColorStop(0.5, '#2a3038'); g.addColorStop(1, '#14181d'); }
  else { g.addColorStop(0, '#f4f8fc'); g.addColorStop(0.45, '#a9b4c2'); g.addColorStop(1, '#3d4550'); }
  return g;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Two-bone IK: elbow position for a shoulder->hand chain. `bend` picks the elbow side. */
function ik(sx, sy, tx, ty, L1, L2, bend) {
  let dx = tx - sx, dy = ty - sy;
  const d = clamp(Math.hypot(dx, dy), 0.01, L1 + L2 - 0.01);
  const a = Math.atan2(dy, dx);
  const off = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const ex = sx + Math.cos(a + bend * off) * L1, ey = sy + Math.sin(a + bend * off) * L1;
  return { ex, ey, hx: sx + Math.cos(a) * d, hy: sy + Math.sin(a) * d };
}

/** A robot hand: closed fist (f=1) or open palm with fingers (f=0), pointing along `ang`. */
function drawRobotHand(ctx, x, y, ang, u, f, glow) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  const s = u * 0.62;
  // fingers (shrink into the fist as f -> 1)
  ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) {
    const len = s * (1.1 - f * 0.75);
    ctx.strokeStyle = metal(ctx, 0, -s, 0, s); ctx.lineWidth = s * 0.34;
    ctx.beginPath(); ctx.moveTo(s * 0.4, i * s * 0.32); ctx.lineTo(s * 0.4 + len, i * s * 0.32 * (1 + (1 - f) * 0.4)); ctx.stroke();
  }
  // palm / fist block
  ctx.fillStyle = metal(ctx, -s, -s, s, s);
  roundRect(ctx, -s * 0.5, -s * 0.62, s * 1.2, s * 1.24, s * 0.3); ctx.fill();
  ctx.strokeStyle = '#1b2026'; ctx.lineWidth = Math.max(1, s * 0.06); ctx.stroke();
  // finger grooves on the fist
  ctx.strokeStyle = `rgba(20,24,30,${0.25 + 0.5 * f})`; ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.beginPath();
  for (const gy of [-0.17, 0.17]) { ctx.moveTo(s * 0.05, gy * s); ctx.lineTo(s * 0.7, gy * s); }
  ctx.stroke();
  // knuckle studs glow
  ctx.fillStyle = glow;
  for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(s * 0.55, i * s * 0.34, s * 0.09, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function drawRobot(ctx) {
  const pal = PALETTES[paletteIdx];
  const glow = pal.glow;
  const fd = robotFacing();
  const sc = robotScale();
  const u = robotUnit() * sc;
  const x = robot.x, y = robot.y;
  const t = clock;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(robot.lean);
  ctx.lineJoin = 'round';

  // hover thruster flame
  const fl = u * (1.2 + Math.sin(t * 40) * 0.15 + Math.random() * 0.2);
  const fg = ctx.createLinearGradient(0, u * 2, 0, u * 2 + fl);
  fg.addColorStop(0, '#ffffff'); fg.addColorStop(0.3, glow); fg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = fg;
  ctx.beginPath(); ctx.moveTo(-u * 0.45, u * 2); ctx.lineTo(u * 0.45, u * 2); ctx.lineTo(0, u * 2 + fl); ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // shoulders (back = away from screen center, front = toward it)
  const backS = { x: -fd * u * 1.35, y: -u * 1.1 }, frontS = { x: fd * u * 1.35, y: -u * 1.1 };
  const L1 = u * 1.25, L2 = u * 1.15;

  // back arm: relaxed, swaying
  const bt = { x: backS.x - fd * u * 0.4, y: backS.y + u * 2.1 + Math.sin(t * 2) * u * 0.15 };
  drawArm(ctx, backS, bt, L1, L2, fd, u, robot.phase === 'idle' ? robot.fist * 0.6 : 1, glow, true);

  // pelvis + torso
  ctx.fillStyle = metal(ctx, -u, u * 1.2, u, u * 2, true);
  roundRect(ctx, -u * 0.75, u * 1.25, u * 1.5, u * 0.75, u * 0.25); ctx.fill();
  ctx.fillStyle = metal(ctx, -u * 1.2, -u * 1.5, u * 1.2, u * 1.3);
  ctx.beginPath();
  ctx.moveTo(-u * 1.25, -u * 1.45); ctx.lineTo(u * 1.25, -u * 1.45);
  ctx.quadraticCurveTo(u * 1.3, u * 0.4, u * 0.8, u * 1.3); ctx.lineTo(-u * 0.8, u * 1.3);
  ctx.quadraticCurveTo(-u * 1.3, u * 0.4, -u * 1.25, -u * 1.45); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#1b2026'; ctx.lineWidth = Math.max(1, u * 0.06); ctx.stroke();
  // panel lines
  ctx.strokeStyle = 'rgba(20,24,30,0.55)'; ctx.lineWidth = Math.max(1, u * 0.04);
  ctx.beginPath(); ctx.moveTo(-u * 0.9, u * 0.55); ctx.lineTo(u * 0.9, u * 0.55); ctx.moveTo(0, u * 0.55); ctx.lineTo(0, u * 1.3); ctx.stroke();
  // chest reactor core (pulses; flares during the punch)
  const pulse = 0.7 + 0.3 * Math.sin(t * 5) + (robot.phase !== 'idle' ? 0.6 : 0);
  const cg = ctx.createRadialGradient(0, -u * 0.4, 0, 0, -u * 0.4, u * 0.75 * pulse);
  cg.addColorStop(0, '#ffffff'); cg.addColorStop(0.35, glow); cg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, -u * 0.4, u * 0.75 * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = '#1b2026'; ctx.lineWidth = Math.max(1, u * 0.08);
  ctx.beginPath(); ctx.arc(0, -u * 0.4, u * 0.42, 0, Math.PI * 2); ctx.stroke();

  // head: neck, helmet, visor with eyes that look at your hand
  ctx.fillStyle = metal(ctx, -u * 0.3, -u * 1.9, u * 0.3, -u * 1.4, true);
  ctx.fillRect(-u * 0.28, -u * 1.85, u * 0.56, u * 0.45);
  ctx.fillStyle = metal(ctx, -u, -u * 3.2, u, -u * 1.8);
  roundRect(ctx, -u * 0.85, -u * 3.05, u * 1.7, u * 1.25, u * 0.4); ctx.fill();
  ctx.strokeStyle = '#1b2026'; ctx.lineWidth = Math.max(1, u * 0.06); ctx.stroke();
  ctx.fillStyle = '#07090c';
  roundRect(ctx, -u * 0.68, -u * 2.7, u * 1.36, u * 0.48, u * 0.2); ctx.fill();
  const lookX = clamp((robot.reach.x - x) / (W * 0.3), -1, 1) * u * 0.18;
  const lookY = clamp((robot.reach.y - (y - u * 2.4)) / (H * 0.4), -1, 1) * u * 0.06;
  const eyeR = robot.phase === 'idle' ? u * 0.11 : u * 0.15;
  ctx.globalCompositeOperation = 'lighter';
  for (const ex of [-u * 0.3, u * 0.3]) {
    const eg = ctx.createRadialGradient(ex + lookX, -u * 2.46 + lookY, 0, ex + lookX, -u * 2.46 + lookY, eyeR * 3);
    eg.addColorStop(0, '#ffffff'); eg.addColorStop(0.3, robot.phase === 'idle' ? glow : '#ff2a2a'); eg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(ex + lookX, -u * 2.46 + lookY, eyeR * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // antenna with blinking light
  ctx.strokeStyle = '#8a95a3'; ctx.lineWidth = Math.max(1, u * 0.07);
  ctx.beginPath(); ctx.moveTo(u * 0.4, -u * 3.0); ctx.lineTo(u * 0.55, -u * 3.55); ctx.stroke();
  ctx.fillStyle = Math.floor(t * 3) % 2 ? glow : '#ffffff';
  ctx.beginPath(); ctx.arc(u * 0.55, -u * 3.6, u * 0.11, 0, Math.PI * 2); ctx.fill();

  // front arm: reaches toward your hand; pulls back on wind-up, thrusts on the punch
  let ft;
  if (robot.phase === 'windup') {
    const k = easeOutCubic(robot.pt / PUNCH_WINDUP);
    ft = { x: frontS.x - fd * u * 1.0 * k, y: frontS.y + u * 0.4 };
  } else if (robot.phase === 'punch') {
    ft = { x: frontS.x + fd * (L1 + L2), y: frontS.y };
  } else {
    // local-space direction toward your hand
    const lx = robot.reach.x - x, ly = robot.reach.y - y;
    const ang = Math.atan2(ly - frontS.y, lx - frontS.x) - robot.lean;
    const r = (L1 + L2) * 0.85;
    ft = { x: frontS.x + Math.cos(ang) * r, y: frontS.y + Math.sin(ang) * r };
  }
  if (robot.phase !== 'punch') drawArm(ctx, frontS, ft, L1, L2, fd, u, robot.fist, glow, false);
  ctx.restore();

  // the punch: a giant fist flies out of the robot toward the viewer
  if (robot.phase === 'punch' || (robot.phase === 'recover' && robot.pt < 0.15)) {
    const p = robot.phase === 'punch' ? robot.pt / PUNCH_HIT : 1;
    const e = p * p;
    const sx = x + fd * u * 2.5, sy = y - u * 1.1;
    const fx = lerp(sx, robot.impact.x, e), fy = lerp(sy, robot.impact.y, e);
    const fu = lerp(u, Math.min(W, H) * 0.35, e);
    // speed lines
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = glow; ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + clock * 3;
      const r0 = fu * 1.2, r1 = fu * (1.6 + Math.random() * 1.2);
      ctx.globalAlpha = 0.5 * p;
      ctx.beginPath(); ctx.moveTo(fx + Math.cos(a) * r0, fy + Math.sin(a) * r0); ctx.lineTo(fx + Math.cos(a) * r1, fy + Math.sin(a) * r1); ctx.stroke();
    }
    ctx.restore();
    // forearm stretching back toward the robot
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = metal(ctx, fx, fy - fu, fx, fy + fu); ctx.lineWidth = fu * 0.7;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.restore();
    // fist faces the viewer (knuckles forward)
    drawRobotHand(ctx, fx, fy, Math.atan2(fy - sy, fx - sx), fu, 1, glow);
  }
}

function drawArm(ctx, S, T, L1, L2, fd, u, fist, glow, back) {
  const bend = back ? fd : -fd;
  const { ex, ey, hx, hy } = ik(S.x, S.y, T.x, T.y, L1, L2, bend);
  ctx.lineCap = 'round';
  ctx.strokeStyle = metal(ctx, S.x, S.y - u * 0.3, S.x, S.y + u * 0.3, back);
  ctx.lineWidth = u * 0.42;
  ctx.beginPath(); ctx.moveTo(S.x, S.y); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.lineWidth = u * 0.36;
  ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
  // joints
  for (const [jx, jy, r] of [[S.x, S.y, u * 0.38], [ex, ey, u * 0.24]]) {
    ctx.fillStyle = metal(ctx, jx - r, jy - r, jx + r, jy + r, back);
    ctx.beginPath(); ctx.arc(jx, jy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(jx, jy, r * 0.3, 0, Math.PI * 2); ctx.fill();
  }
  drawRobotHand(ctx, hx, hy, Math.atan2(hy - ey, hx - ex), u, fist, glow);
}

// ---- 7d. SMASHED GLASS: cracks radiating from the punch, then the glass falls away ----
const glass = { cracks: null, x: 0, y: 0, age: 0, shards: [] };
const GLASS_HOLD = 2.2, GLASS_FADE = 0.6;

function smashGlass(x, y) {
  shake = 45; glitch = 1;
  const R = Math.hypot(W, H) * 0.7;
  const n = 16;
  const rays = [];
  for (let i = 0; i < n; i++) {
    let a = (i / n) * Math.PI * 2 + rand(-0.15, 0.15);
    const len = rand(0.35, 1) * R;
    const pts = [[x, y]];
    let px = x, py = y, dist = 0;
    while (dist < len) {
      const step = rand(18, 55) * (1 + dist / R * 2);
      a += rand(-0.18, 0.18);
      px += Math.cos(a) * step; py += Math.sin(a) * step; dist += step;
      pts.push([px, py]);
    }
    rays.push(pts);
  }
  // concentric rings joining neighbouring rays -> spider-web cracks
  const rings = [];
  for (const rr of [45, 110, 210, 340]) {
    const ring = [];
    for (const ray of rays) {
      let best = null, bd = Infinity;
      for (const p of ray) { const d = Math.abs(Math.hypot(p[0] - x, p[1] - y) - rr * rand(0.85, 1.15)); if (d < bd) { bd = d; best = p; } }
      ring.push(bd < rr * 0.5 ? best : null);
    }
    rings.push(ring);
  }
  glass.cracks = { rays, rings };
  glass.x = x; glass.y = y; glass.age = 0;
  // little glass splinters bursting from the impact right away
  for (let i = 0; i < 40; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(150, 700), s = rand(4, 16);
    glass.shards.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 200, rot: rand(0, 6), vr: rand(-12, 12), life: 0, max: rand(0.6, 1.2),
      pts: [[-s, -s * 0.4], [s, -s * 0.2], [rand(-s, s), s]] });
  }
}

function dropGlass() {
  // break the inner web into falling pieces
  const { rings } = glass.cracks;
  for (let ri = 0; ri < 2; ri++) {
    const inner = ri === 0 ? null : rings[ri - 1], outer = rings[ri];
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const a = inner ? inner[i] : [glass.x, glass.y], b = outer[i], c = outer[j];
      if (!a || !b || !c) continue;
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
      glass.shards.push({ x: cx, y: cy, vx: rand(-60, 60), vy: rand(-80, 20), rot: 0, vr: rand(-3, 3), life: 0, max: 1.6,
        pts: [[a[0] - cx, a[1] - cy], [b[0] - cx, b[1] - cy], [c[0] - cx, c[1] - cy]] });
    }
  }
}

function drawGlass(ctx, dt) {
  if (glass.cracks) {
    const prev = glass.age;
    glass.age += dt;
    if (prev < GLASS_HOLD && glass.age >= GLASS_HOLD) dropGlass();
    const a = glass.age < GLASS_HOLD ? 1 : clamp(1 - (glass.age - GLASS_HOLD) / GLASS_FADE, 0, 1);
    if (a <= 0) { glass.cracks = null; }
    else {
      const { rays, rings } = glass.cracks;
      const path = new Path2D();
      for (const ray of rays) { path.moveTo(ray[0][0], ray[0][1]); for (const p of ray) path.lineTo(p[0], p[1]); }
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          if (!p || !q) continue;
          const mx = (p[0] + q[0]) / 2 + rand(-3, 3), my = (p[1] + q[1]) / 2 + rand(-3, 3);
          path.moveTo(p[0], p[1]); path.lineTo(mx, my); path.lineTo(q[0], q[1]);
        }
      }
      // impact dent
      const dg = ctx.createRadialGradient(glass.x, glass.y, 0, glass.x, glass.y, 90);
      dg.addColorStop(0, `rgba(255,255,255,${0.55 * a})`); dg.addColorStop(0.25, `rgba(180,220,255,${0.25 * a})`); dg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = dg; ctx.beginPath(); ctx.arc(glass.x, glass.y, 90, 0, Math.PI * 2); ctx.fill();
      ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
      ctx.globalAlpha = 0.6 * a; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke(path);
      ctx.globalAlpha = 0.95 * a; ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = 1.3; ctx.stroke(path);
      ctx.globalAlpha = 0.35 * a; ctx.strokeStyle = '#9fd8ff'; ctx.lineWidth = 4; ctx.globalCompositeOperation = 'lighter'; ctx.stroke(path);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  }
  // flying / falling glass pieces
  let n = 0;
  for (const s of glass.shards) {
    s.life += dt;
    if (s.life >= s.max) continue;
    s.vy += 1400 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
    const c = Math.cos(s.rot), sn = Math.sin(s.rot), al = 1 - s.life / s.max;
    ctx.beginPath();
    s.pts.forEach(([px, py], k) => { const X = s.x + px * c - py * sn, Y = s.y + px * sn + py * c; k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.globalAlpha = 0.25 * al; ctx.fillStyle = '#cfeaff'; ctx.fill();
    ctx.globalAlpha = 0.9 * al; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke();
    glass.shards[n++] = s;
  }
  glass.shards.length = n;
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
  code.rain.width = Math.max(1, Math.round(CW * DPR)); code.rain.height = Math.max(1, Math.round(H * DPR));
  const r = code.rctx;
  r.setTransform(DPR, 0, 0, DPR, 0, 0);
  r.clearRect(0, 0, CW, H);
  r.font = code.font; r.textBaseline = 'top';
  cctx.font = code.font;
  code.cw = cctx.measureText('M').width || 8.4;

  const nCols = Math.ceil(CW / code.fs);
  code.cols = Array.from({ length: nCols }, (_, i) => ({
    x: i * code.fs, y: -rand(0, H / code.lh), row: -999, speed: rand(6, 22), cyan: Math.random() < 0.22,
  }));

  const nTerms = clamp(Math.floor(CW / 430), 1, 3);
  const colW = CW / nTerms;
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

  // Matrix rain on its own transparent canvas: fade old glyphs out, draw new heads.
  r.globalCompositeOperation = 'destination-out';
  r.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.9, dt * 60)})`;
  r.fillRect(0, 0, CW, H);
  r.globalCompositeOperation = 'source-over';
  for (const c of code.cols) {
    c.y += c.speed * dt * sp;
    const row = Math.floor(c.y);
    if (row !== c.row) {
      for (let k = Math.max(c.row + 1, row - 3); k <= row; k++) {
        if (k < 0) continue;
        if (k > 0) {   // settle previous head into the trail color
          r.clearRect(c.x, (k - 1) * lh, code.fs, lh);
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

  // Compose the panel: dark glass, rain, then typing terminals.
  const ctx = cctx;
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, CW, H);
  ctx.fillStyle = 'rgba(0,8,4,0.86)';
  ctx.fillRect(0, 0, CW, H);
  ctx.globalAlpha = 0.6;
  ctx.drawImage(code.rain, 0, 0, CW, H);
  ctx.font = code.font; ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const blink = Math.floor(clock * 2.5) % 2 === 0;
  for (const t of code.terms) {
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
    const total = t.lines.length;
    for (let i = 0; i < total; i++) {
      const L = t.lines[i];
      if (!L.text) continue;
      ctx.globalAlpha = 0.3 + 0.55 * (i / t.rows);   // older lines dimmer
      ctx.fillStyle = L.color;
      ctx.fillText(L.text, t.x, 12 + i * lh);
    }
    const y = 12 + total * lh;
    ctx.globalAlpha = 0.95;
    let curText = '';
    if (t.cur) { curText = t.cur.text.slice(0, Math.floor(t.cur.shown)); ctx.fillStyle = t.cur.color; ctx.fillText(curText, t.x, y); }
    if (blink) { ctx.fillStyle = '#39ff88'; ctx.fillRect(t.x + curText.length * code.cw + 1, y + 1, code.cw * 0.8, lh - 4); }
  }
  ctx.globalAlpha = 1;
}

// ---- 8b. Camera: shown crisp by the <video> element itself; optional palette tint overlay ----
let lastTintCss = '';
function updateCameraTint(dt) {
  const target = PALETTES[paletteIdx].tintRgb, k = 1 - Math.pow(0.02, dt);
  for (let i = 0; i < 3; i++) camTintRgb[i] += (target[i] - camTintRgb[i]) * k;
  const bg = rgbStr(camTintRgb[0], camTintRgb[1], camTintRgb[2]);
  const op = String(settings.camTint / 100);
  if (bg + op !== lastTintCss) { tintEl.style.background = bg; tintEl.style.opacity = op; lastTintCss = bg + op; }
}

// ---- 8c. Mask: 4 designs, glowing traces, energy pulses, sparkles, bloom ----
const MASK_STYLES = [
  { name: 'HOLO CRYSTAL', pulses: 36 },
  { name: 'CIRCUIT', pulses: 120 },
  { name: 'NEON TRIBAL', pulses: 24 },
  { name: 'LIQUID CHROME', pulses: 30 },
];
let styleIdx = 0;
function pickNewStyle() {
  let i;
  do { i = Math.floor(Math.random() * MASK_STYLES.length); } while (i === styleIdx);
  styleIdx = i;
  initPulses();
}

const _c = [0, 0, 0];

/** Compute each triangle's color for the current palette + mask style into triRGB. */
function computeTriColors(pal, time) {
  const P = face.pts, fw = face.w, fh = face.h, st = styleIdx;
  // slowly orbiting light -> moving highlights on holo / chrome
  const la = time * 0.7;
  let lx = Math.cos(la) * 0.45, ly = -0.45 + Math.sin(la) * 0.2, lz = 0.8;
  const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
  const hl = Math.hypot(lx, ly, lz + 1), hx = lx / hl, hy = ly / hl, hz = (lz + 1) / hl;   // half vector, viewer at +z
  const band = ((time * 0.45) % 1.8) - 0.4;                                                // holo shimmer sweep
  const midX = P[168 * 3];                                                                  // between the eyes

  for (let i = 0; i < NTRI; i++) {
    const a = TRIS[i * 3] * 3, b = TRIS[i * 3 + 1] * 3, c = TRIS[i * 3 + 2] * 3;
    const mx = (P[a] + P[b] + P[c]) / 3, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    const u = (mx - face.minX) / fw, v = (my - face.minY) / fh;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
    const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 28);
    let r, g, bl;

    if (st === 0) {          // HOLO CRYSTAL: iridescent (hue shifts with facing angle) + bright sweep
      samplePalette(pal, u * 0.35 + v * 0.55 + nx * 0.6 + ny * 0.4 + triJitter[i] * 0.1 + time * 0.12, _c);
      const k = 0.55 + 0.55 * diff;
      const d = (u * 0.6 + v * 0.4) - band, sweep = Math.exp(-d * d / 0.005) * 0.55;
      r = lerp(_c[0] * k, 255, sweep) + 90 * spec; g = lerp(_c[1] * k, 255, sweep) + 90 * spec; bl = lerp(_c[2] * k, 255, sweep) + 90 * spec;
    } else if (st === 1) {   // CIRCUIT: dark glass plates; the light comes from traces + pulses
      samplePalette(pal, v * 0.8 + u * 0.2 + time * 0.05, _c);
      const k = 0.1 + 0.22 * diff + triJitter[i] * 0.07;
      r = _c[0] * k + 70 * spec; g = _c[1] * k + 70 * spec; bl = _c[2] * k + 70 * spec;
    } else if (st === 2) {   // NEON TRIBAL: mirror-symmetric animated stripes over a deep base
      const s = Math.abs(mx - midX) / fw;
      const p = Math.sin(s * 22 - v * 9 + time * 2.2) + Math.sin(v * 16 + s * 6 - time * 1.3) * 0.6;
      let k;
      if (p > 0.55) { samplePalette(pal, 0.5 + v * 0.3 + time * 0.08, _c); k = 0.9 + 0.35 * diff; }
      else { samplePalette(pal, v * 0.4 + time * 0.05, _c); k = 0.18 + 0.25 * diff; }
      r = _c[0] * k; g = _c[1] * k; bl = _c[2] * k;
    } else {                 // LIQUID CHROME: environment reflection by normal + hard specular
      samplePalette(pal, 0.5 + ny * 0.7 + nx * 0.25 + time * 0.04, _c);
      const k = 0.25 + 0.75 * diff;
      r = _c[0] * k * 0.85 + 30 + 255 * spec; g = _c[1] * k * 0.85 + 30 + 255 * spec; bl = _c[2] * k * 0.85 + 30 + 255 * spec;
    }
    triRGB[i * 3] = Math.min(255, r); triRGB[i * 3 + 1] = Math.min(255, g); triRGB[i * 3 + 2] = Math.min(255, bl);
  }
}

function strokeConnections(ctx, conns) {
  const P = face.pts, path = new Path2D();
  for (const { start, end } of conns) { path.moveTo(P[start * 3], P[start * 3 + 1]); path.lineTo(P[end * 3], P[end * 3 + 1]); }
  return path;
}

function drawMask(ctx, pal, partial) {
  const P = face.pts, st = styleIdx;
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
    if (partial && vis >= 1) { edges.moveTo(P[a], P[a + 1]); edges.lineTo(P[b], P[b + 1]); edges.lineTo(P[c], P[c + 1]); edges.closePath(); }
  }
  if (!partial) {
    for (let e = 0; e < EDGES.length; e += 2) {
      const p = EDGES[e] * 3, q = EDGES[e + 1] * 3;
      edges.moveTo(P[p], P[p + 1]); edges.lineTo(P[q], P[q + 1]);
    }
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (st === 2 || st === 3) {     // solid designs: crisp facet lines
    ctx.strokeStyle = st === 2 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.22)';
    ctx.globalAlpha = 1; ctx.lineWidth = 0.6; ctx.stroke(edges);
  } else {                        // glowing wireframe, additive
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = pal.glow;
    ctx.globalAlpha = st === 1 ? 0.25 : 0.1; ctx.lineWidth = 3; ctx.stroke(edges);
    ctx.globalAlpha = st === 1 ? 0.85 : 0.35; ctx.lineWidth = st === 1 ? 0.9 : 0.5; ctx.stroke(edges);
  }

  if (!partial || reassembly.t > reassembly.end) {
    ctx.globalCompositeOperation = 'lighter';
    // glowing rim around the face
    const rim = strokeConnections(ctx, FACE_OVAL);
    ctx.strokeStyle = pal.glow;
    ctx.globalAlpha = 0.3; ctx.lineWidth = 8; ctx.stroke(rim);
    ctx.strokeStyle = pal.edge;
    ctx.globalAlpha = 0.8; ctx.lineWidth = 1.8; ctx.stroke(rim);
    // eyes + lips neon outline
    const feat = strokeConnections(ctx, FEATURE_EDGES);
    ctx.strokeStyle = pal.glow;
    ctx.globalAlpha = 0.45; ctx.lineWidth = 6; ctx.stroke(feat);
    ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.stroke(feat);
    // glowing irises
    const ir = face.w * 0.018;
    for (const k of [468, 473]) {
      ctx.globalAlpha = 0.55; ctx.fillStyle = pal.edge;
      ctx.beginPath(); ctx.arc(P[k * 3], P[k * 3 + 1], ir * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(P[k * 3], P[k * 3 + 1], ir, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// Energy pulses that run along the mesh edges like current through a circuit.
let pulses = [];
function initPulses() {
  if (!EDGES.length) { pulses = []; return; }
  const ne = EDGES.length / 2;
  pulses = Array.from({ length: MASK_STYLES[styleIdx].pulses }, () => ({
    e: (Math.random() * ne) | 0, fwd: Math.random() < 0.5, t: Math.random(), speed: rand(3, 7),
  }));
}

function drawPulses(ctx, pal, dt) {
  if (!pulses.length) return;
  const P = face.pts;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.strokeStyle = pal.glow; ctx.fillStyle = '#ffffff';
  for (const p of pulses) {
    p.t += p.speed * dt;
    while (p.t >= 1) {   // hop onto a random edge connected to the vertex we reached
      p.t -= 1;
      const v = p.fwd ? EDGES[p.e * 2 + 1] : EDGES[p.e * 2];
      const opts = VERT_EDGES[v];
      let ne = opts[(Math.random() * opts.length) | 0];
      if (ne === p.e && opts.length > 1) ne = opts[(opts.indexOf(ne) + 1) % opts.length];
      p.e = ne; p.fwd = EDGES[ne * 2] === v;
    }
    const a = (p.fwd ? EDGES[p.e * 2] : EDGES[p.e * 2 + 1]) * 3, b = (p.fwd ? EDGES[p.e * 2 + 1] : EDGES[p.e * 2]) * 3;
    const hx = lerp(P[a], P[b], p.t), hy = lerp(P[a + 1], P[b + 1], p.t);
    const tt = Math.max(0, p.t - 0.7), tx = lerp(P[a], P[b], tt), ty = lerp(P[a + 1], P[b + 1], tt);
    ctx.globalAlpha = 0.55; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// Little star sparkles that drift off the mask.
let sparkles = [];
function drawSparkles(ctx, pal, dt, spawn) {
  if (spawn && NTRI) {
    for (let k = 0; k < 3; k++) {
      const vi = TRIS[(Math.random() * TRIS.length) | 0] * 3;
      const x = face.pts[vi], y = face.pts[vi + 1];
      sparkles.push({ x, y, vx: (x - face.cx) * 0.5, vy: (y - face.cy) * 0.5 - 20, life: 0, max: rand(0.4, 0.9), size: rand(1.5, 3.5) });
    }
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = pal.edge; ctx.fillStyle = '#fff'; ctx.lineWidth = 1;
  let n = 0;
  for (const s of sparkles) {
    s.life += dt;
    if (s.life >= s.max) continue;
    s.x += s.vx * dt; s.y += s.vy * dt;
    const f = 1 - s.life / s.max, L = s.size * 3 * f;
    ctx.globalAlpha = f;
    ctx.beginPath(); ctx.moveTo(s.x - L, s.y); ctx.lineTo(s.x + L, s.y); ctx.moveTo(s.x, s.y - L); ctx.lineTo(s.x, s.y + L); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 0.5 * f + 0.4, 0, Math.PI * 2); ctx.fill();
    sparkles[n++] = s;
  }
  sparkles.length = n;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// ---- 8d. Hands: data beams from the code panel to every fingertip ----
const TIPS = [4, 8, 12, 16, 20];
const BEAM_CHARS = '01アイウ{}<>#$%&ABCDEF0x';
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };

function drawHands(ctx, dt) {
  const pal = PALETTES[paletteIdx];
  const dir = settings.codeRight ? -1 : 1;           // beams leave the panel toward the camera area
  for (const h of hands.list) h.alpha = clamp(h.alpha + (h.seen ? 1 : -1) * dt * 5, 0, 1);
  hands.list = hands.list.filter((h) => h.seen || h.alpha > 0);

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px Consolas, Menlo, "DejaVu Sans Mono", monospace';
  let hi = 0;
  for (const h of hands.list) {
    const A = h.alpha, energy = clamp(0.6 + h.speed / (W * 0.6), 0.6, 2.2);
    for (let k = 0; k < 5; k++) {
      const tip = h.pts[TIPS[k]];
      const ox = edgeX, oy = H * (0.16 + 0.17 * k) + hi * 22;
      const dx = Math.abs(tip[0] - ox);
      const c1x = ox + dir * dx * 0.45, c1y = oy, c2x = tip[0] - dir * dx * 0.35, c2y = tip[1];
      samplePalette(pal, k / 5 + clock * 0.1, _c);
      const col = rgbStr(_c[0], _c[1], _c[2]);
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tip[0], tip[1]);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.14 * A; ctx.lineWidth = 8; ctx.stroke();
      ctx.globalAlpha = 0.5 * A; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.setLineDash([4, 16]); ctx.lineDashOffset = -clock * 240 * energy;     // data flowing to the finger
      ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.85 * A; ctx.lineWidth = 2; ctx.stroke();
      ctx.setLineDash([]);
      // code glyphs riding the beam
      ctx.fillStyle = col;
      for (let g = 0; g < 4; g++) {
        const t = (clock * 0.5 * energy + g / 4 + k * 0.17) % 1;
        ctx.globalAlpha = A * Math.sin(t * Math.PI);
        ctx.fillText(BEAM_CHARS[(g * 7 + k * 3 + Math.floor(clock * 8)) % BEAM_CHARS.length], bez(ox, c1x, c2x, tip[0], t), bez(oy, c1y, c2y, tip[1], t) - 8);
      }
      // port on the panel edge + glowing fingertip
      ctx.globalAlpha = A; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(ox, oy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.6 * A;
      ctx.beginPath(); ctx.arc(tip[0], tip[1], 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = A; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(tip[0], tip[1], 2.5, 0, Math.PI * 2); ctx.fill();
    }
    // neon hand skeleton
    ctx.strokeStyle = pal.edge; ctx.globalAlpha = 0.45 * A; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const { start, end } of HAND_CONNECTIONS) { ctx.moveTo(h.pts[start][0], h.pts[start][1]); ctx.lineTo(h.pts[end][0], h.pts[end][1]); }
    ctx.stroke();
    hi++;
  }

  // code glyphs left behind by fast hand motion
  let n = 0;
  for (const g of glyphTrail) {
    g.life += dt;
    if (g.life >= g.max) continue;
    g.x += g.vx * dt; g.y += g.vy * dt;
    ctx.globalAlpha = 1 - g.life / g.max;
    ctx.fillStyle = g.cyan ? '#5ff6ff' : '#5dff9d';
    ctx.fillText(g.ch, g.x, g.y);
    glyphTrail[n++] = g;
  }
  glyphTrail.length = n;

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

// ---- 8e. Bloom: blurred quarter-res copy of mask/beams/shards added back on top ----
const bloom = document.createElement('canvas');
const bctx = bloom.getContext('2d');
function initBloom() {
  bloom.width = Math.max(1, Math.round(W / 4));
  bloom.height = Math.max(1, Math.round(H / 4));
}
function applyBloom() {
  bctx.clearRect(0, 0, bloom.width, bloom.height);
  bctx.filter = 'blur(3px)';
  bctx.drawImage(fxCanvas, 0, 0, bloom.width, bloom.height);
  bctx.filter = 'none';
  fctx.globalCompositeOperation = 'lighter';
  fctx.globalAlpha = 0.5;
  fctx.drawImage(bloom, 0, 0, W, H);
  fctx.globalCompositeOperation = 'source-over';
  fctx.globalAlpha = 1;
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

function drawHUD(ctx) {
  const pal = PALETTES[paletteIdx];
  const accent = pal.edge;
  const m = 18, lh = 16;
  const L0 = camL + m, R0 = camR - m, CX = (camL + camR) / 2;   // HUD lives in the camera area
  ctx.globalAlpha = 0.9;
  ctx.shadowColor = '#39ff88'; ctx.shadowBlur = 6;

  // glowing panel edge
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.5, accent); grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.strokeStyle = grad; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(edgeX, 0); ctx.lineTo(edgeX, H); ctx.stroke();
  hudText(ctx, '// DATA UPLINK', settings.codeRight ? edgeX - 8 : edgeX + 8, H / 2 - 30, settings.codeRight ? 'right' : 'left', accent, 11);

  // corner brackets of the camera area
  ctx.strokeStyle = 'rgba(57,255,136,0.6)'; ctx.lineWidth = 1.5;
  const B = 26, l = camL + 8, r = camR - 8;
  ctx.beginPath();
  ctx.moveTo(l, 8 + B); ctx.lineTo(l, 8); ctx.lineTo(l + B, 8);
  ctx.moveTo(r - B, 8); ctx.lineTo(r, 8); ctx.lineTo(r, 8 + B);
  ctx.moveTo(l, H - 8 - B); ctx.lineTo(l, H - 8); ctx.lineTo(l + B, H - 8);
  ctx.moveTo(r - B, H - 8); ctx.lineTo(r, H - 8); ctx.lineTo(r, H - 8 - B);
  ctx.stroke();

  const blink = Math.floor(clock * 2) % 2 === 0;
  const t = new Date();
  hudText(ctx, `> SYSTEM ONLINE${blink ? '_' : ''}`, L0, m);
  hudText(ctx, `> NEURAL MESH v5.0 // ${NTRI || '---'} TRI`, L0, m + lh, 'left', '#1fd1a5');
  hudText(ctx, `> ${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`, L0, m + lh * 2, 'left', '#1fd1a5');

  hudText(ctx, `FPS ${fps.toFixed(0).padStart(3, ' ')}`, R0, m, 'right', fps >= 30 ? '#39ff88' : '#ffcc00');
  hudText(ctx, `TRACK ${trackHz.toFixed(0)} Hz  HANDS ${hands.list.filter((h) => h.seen).length}`, R0, m + lh, 'right', '#1fd1a5');
  const lvl = micAvailable ? clamp((20 * Math.log10(audio.rms + 1e-9) + 60) / 60, 0, 1) : 0;
  hudText(ctx, micAvailable ? `MIC [${'|'.repeat(Math.round(lvl * 10)).padEnd(10, '.')}]` : 'MIC [OFFLINE]', R0, m + lh * 2, 'right', '#1fd1a5');

  hudText(ctx, `STATE: ${state}`, L0, H - m - lh * 4, 'left', accent);
  hudText(ctx, `MASK: ${MASK_STYLES[styleIdx].name}`, L0, H - m - lh * 3, 'left', accent);
  hudText(ctx, `PALETTE: ${pal.name}`, L0, H - m - lh * 2, 'left', accent);
  hudText(ctx, `LAST TRIGGER: ${lastTriggerSrc}`, L0, H - m - lh, 'left', '#1fd1a5');
  if (settings.robot) {
    const ch = controlHand();
    const rs = robot.phase !== 'idle' ? 'PUNCH!!' : ch ? `HAND CONTROL ${ch.fist ? '[FIST]' : '[OPEN]'}` : 'IDLE - SHOW A HAND';
    hudText(ctx, `ROBOT: ${rs}`, L0, H - m - lh * 5, 'left', robot.phase !== 'idle' ? '#ff3b6b' : accent);
  }

  const locked = face.present;
  hudText(ctx, locked ? 'FACE LOCKED' : (blink ? 'SCANNING FOR TARGET...' : 'SCANNING FOR TARGET'), R0, H - m - lh * 2, 'right', locked ? '#39ff88' : '#ff3b6b');
  hudText(ctx, '[SPACE] TRIGGER  [M] MASK  [S] SETTINGS  [D] DEBUG  [F] FULL', R0, H - m - lh, 'right', '#1d8f55', 11);

  if (locked) {   // target brackets around the face
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

  const status = modelStatus || (!camReady ? 'AWAITING AUTHORIZATION' : '');
  if (status) {
    hudText(ctx, status, CX, H / 2 - 8, 'center', '#00e5ff', 18);
  } else if (!locked) {
    const R = Math.min(camR - camL, H) * 0.2, a = clock * 3;
    ctx.strokeStyle = 'rgba(57,255,136,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(CX, H / 2, R, a, a + 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(CX, H / 2, R * 0.7, -a * 1.3, -a * 1.3 + 0.8); ctx.stroke();
    if (blink) hudText(ctx, 'SCANNING FOR TARGET...', CX, H / 2 - 10, 'center', '#ff3b6b', 20);
  }

  if (triggerBanner > 0) {
    ctx.globalAlpha = clamp(triggerBanner * 2, 0, 1);
    hudText(ctx, `◢ ${lastTriggerSrc} DETECTED ◣`, CX, 56, 'center', accent, 22);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/** Horizontal slice displacement + color flash, in place on a canvas `cw` CSS px wide. */
function applyGlitch(ctx, canvas, cw, g, flashColor) {
  if (g <= 0.01) return;
  const slices = 3 + Math.floor(g * 10);
  for (let i = 0; i < slices; i++) {
    const y = Math.random() * H, h = rand(3, 40) * (0.4 + g);
    ctx.drawImage(canvas, 0, y * DPR, canvas.width, h * DPR, rand(-60, 60) * g, y, cw, h);
  }
  if (flashColor) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.pow(g, 2) * 0.55;
    ctx.fillStyle = flashColor;
    ctx.fillRect(0, 0, cw, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

function drawDebug(ctx) {
  if (face.has) {
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < N_LM; i++) ctx.fillRect(face.pts[i * 3] - 0.75, face.pts[i * 3 + 1] - 0.75, 1.5, 1.5);
  }
  for (const h of hands.list) {
    const need = face.w * SLAP_SPEED;
    hudText(ctx, `hand ${h.speed.toFixed(0)} px/s (slap > ${need.toFixed(0)})`, h.rx + 14, h.ry, 'left', h.speed > need ? '#ff3b6b' : '#ffcc00', 12);
  }

  // mic meter (dBFS scale)
  const w = Math.min(460, camR - camL - 32), hgt = 100, x = (camL + camR - w) / 2, y = H - hgt - 80;
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
    statusEl.textContent = 'getUserMedia unavailable. Serve over http://localhost or https (not file://).';
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
    case 'm': pickNewStyle(); triggerBanner = 0; break;
  }
});

function bindSettings() {
  const pct = (v) => `${v}%`;
  const fmt = { sensitivity: (v) => v, camTint: pct, codeWidth: pct, particleCount: (v) => v, codeSpeed: (v) => `${Number(v).toFixed(1)}x` };
  const LAYOUT_KEYS = ['codeWidth', 'codeRight'];
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
      if (LAYOUT_KEYS.includes(k)) resize();
    });
  }
  document.getElementById('resetSettings').addEventListener('click', (e) => {
    Object.assign(settings, DEFAULTS); sync(); saveSettings(); resize(); e.target.blur();
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

  fpsFrames++;
  if (now - fpsT > 500) {
    fps = (fpsFrames * 1000) / (now - fpsT);
    trackHz = (trackCount * 1000) / (now - fpsT);
    fpsFrames = 0; trackCount = 0; fpsT = now;
  }

  // --- inputs (audio runs on its own timer) ---
  if (camReady) { updateView(); try { track(now); } catch (err) { console.error(err); } }

  // --- simulation ---
  updateState(dt);
  updateShards(dt);
  updateReassembly(dt);
  updateRobot(dt);
  shake *= Math.pow(0.004, dt);
  glitch = Math.max(0, glitch - dt * 2.2);
  triggerBanner = Math.max(0, triggerBanner - dt);
  idleGlitchT -= dt;
  if (idleGlitchT <= 0) { idleGlitchT = rand(3, 8); glitch = Math.max(glitch, 0.18); }

  // --- layer 1: crisp camera (video element) + optional tint ---
  updateCameraTint(dt);
  // --- layer 2: code panel on one side ---
  renderCode(dt);

  // --- layer 3: mask, beams, particles (all bloomed) ---
  const ctx = fctx;
  ctx.clearRect(0, 0, W, H);
  const pal = PALETTES[paletteIdx];
  const maskOn = face.present && NTRI && state === S.MASKED;
  if (face.present && NTRI && (state === S.MASKED || state === S.REASSEMBLE)) {
    computeTriColors(pal, clock);
    drawMask(ctx, pal, state === S.REASSEMBLE);
  } else if (state === S.REASSEMBLE && face.has && NTRI) {
    computeTriColors(pal, clock);              // face briefly lost: keep flying to last known pose
  }
  if (maskOn) drawPulses(ctx, pal, dt);
  drawSparkles(ctx, pal, dt, maskOn);
  if (state === S.REASSEMBLE) drawIncoming(ctx);
  if (shards.length) drawShards(ctx);
  drawHands(ctx, dt);
  applyBloom();
  if (settings.robot && camReady) drawRobot(ctx);
  drawGlass(ctx, dt);

  if (glitch > 0.01) {
    applyGlitch(cctx, codeCanvas, CW, glitch, null);
    applyGlitch(ctx, fxCanvas, W, glitch, glitch > 0.3 ? (glitch > 0.85 ? '#ffffff' : pal.edge) : null);
  }

  // --- layer 4: HUD ---
  drawHUD(ctx);
  if (debug) drawDebug(ctx);

  stageEl.style.transform = shake > 0.3 ? `translate(${rand(-shake, shake).toFixed(1)}px, ${rand(-shake, shake).toFixed(1)}px)` : '';

  requestAnimationFrame(frame);
}

// Boot: the code panel runs immediately, even before Start is pressed.
bindSettings();
resize();
requestAnimationFrame(frame);

// Handy for console testing: hackerFace.trigger()
window.hackerFace = { trigger: () => trigger('KEY'), settings, audio, face, hands, audioTick: updateAudio, robot, setStyle: (i) => { styleIdx = i; initPulses(); }, get state() { return state; } };
