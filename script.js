'use strict';

// ── Worklet source (dedicated audio thread — no hiccups when supported) ───
const WORKLET_SRC = `
class BrownNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._lastOut = 0.0;
  }
  process(_inputs, outputs) {
    const ch = outputs[0][0];
    for (let i = 0; i < ch.length; i++) {
      const white = Math.random() * 2 - 1;
      // Leaky integrator → Brownian (1/f²) spectrum; amplitude stays ~±0.18
      this._lastOut = (this._lastOut + 0.02 * white) / 1.02;
      ch[i] = this._lastOut * 3.5;
    }
    return true;
  }
}
registerProcessor('brown-noise', BrownNoiseProcessor);
`;

// ── State ─────────────────────────────────────────────────────────────────
let ctx            = null;
let noiseNode      = null;
let gainNode       = null;
let wakeLock       = null;
let playing        = false;
let useWorklet     = false;
let workletReady   = false;  // true once addModule resolves or fails
let workletPromise = null;   // cached so we only call addModule once

// ── DOM refs ──────────────────────────────────────────────────────────────
const btn       = document.getElementById('toggleBtn');
const btnLabel  = document.getElementById('btnLabel');
const statusEl  = document.getElementById('status');
const barsEl    = document.getElementById('bars');
const volSlider = document.getElementById('volume');

// ── AudioContext init ─────────────────────────────────────────────────────
// Called SYNCHRONOUSLY inside the click handler — iOS requires AudioContext
// creation and resume() to happen within the user-gesture call stack.
// Any await before these calls breaks audio on iOS Safari.
function initCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window['webkitAudioContext'])();
  gainNode = ctx.createGain();
  gainNode.gain.value = 0; // silent until play() fades in
  gainNode.connect(ctx.destination);
}

// ── Worklet loader ────────────────────────────────────────────────────────
// Async is fine here — worklet loading doesn't need gesture context.
// iOS Safari may block blob: URLs for AudioWorklet; the catch() falls back
// to ScriptProcessorNode automatically.
async function loadWorklet() {
  if (workletReady) return;
  if (workletPromise) return workletPromise;

  workletPromise = (async () => {
    if (!ctx.audioWorklet) { workletReady = true; return; }
    try {
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      useWorklet = true;
    } catch (err) {
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
    } finally {
      workletReady = true;
    }
  })();

  return workletPromise;
}

// ── Noise node factory ────────────────────────────────────────────────────
function createNoiseNode() {
  if (useWorklet) {
    return new AudioWorkletNode(ctx, 'brown-noise');
  }
  // ScriptProcessorNode fallback — works on all iOS Safari versions
  let lastOut = 0;
  const proc  = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      out[i]  = lastOut * 3.5;
    }
  };
  return proc;
}

// ── Play / Pause ──────────────────────────────────────────────────────────
async function play() {
  try {
    await loadWorklet(); // ctx already exists; just ensure worklet is ready

    noiseNode = createNoiseNode();
    noiseNode.connect(gainNode);

    // Smooth 300 ms fade-in to avoid click/pop
    gainNode.gain.cancelScheduledValues(ctx.currentTime);
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(+volSlider.value, ctx.currentTime + 0.3);

    playing = true;
    render(true);
    grabWakeLock();
  } catch (err) {
    console.error('Audio start failed:', err);
    statusEl.textContent = 'Could not start audio — see console for details';
  }
}

function pause() {
  if (!noiseNode) return;

  const t = ctx.currentTime;
  gainNode.gain.cancelScheduledValues(t);
  gainNode.gain.setValueAtTime(gainNode.gain.value, t);
  gainNode.gain.linearRampToValueAtTime(0, t + 0.3);

  const dying = noiseNode;
  setTimeout(() => { dying.disconnect(); }, 350);
  noiseNode = null;

  playing = false;
  render(false);
  dropWakeLock();
}

// ── Wake Lock ─────────────────────────────────────────────────────────────
async function grabWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* unsupported or denied — silent fail */ }
}

function dropWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing) grabWakeLock();
});

// ── UI ────────────────────────────────────────────────────────────────────
function render(on) {
  btn.classList.toggle('on', on);
  btnLabel.textContent = on ? 'Stop' : 'Start';
  statusEl.textContent = on ? 'Playing brown noise\u2026' : 'Tap to begin';
  barsEl.classList.toggle('active', on);
}

// ── Events ────────────────────────────────────────────────────────────────
btn.addEventListener('click', () => {
  // These two calls MUST be synchronous (no await before them).
  // iOS Safari revokes audio permission after the first async yield.
  initCtx();
  ctx.resume(); // fire-and-forget is fine; the call itself unlocks audio

  if (playing) pause();
  else         play(); // async worklet loading is safe inside play()
});

volSlider.addEventListener('input', () => {
  if (gainNode && playing) {
    gainNode.gain.setTargetAtTime(+volSlider.value, ctx.currentTime, 0.05);
  }
});
