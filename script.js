'use strict';

// ── Worklet source (dedicated audio thread — no hiccups when it works) ────
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
let ctx       = null;
let noiseNode = null;
let gainNode  = null;
let wakeLock  = null;
let playing   = false;
let useWorklet = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
const btn       = document.getElementById('toggleBtn');
const btnLabel  = document.getElementById('btnLabel');
const statusEl  = document.getElementById('status');
const barsEl    = document.getElementById('bars');
const volSlider = document.getElementById('volume');

// ── Bootstrap (lazy, runs once on first tap) ──────────────────────────────
async function boot() {
  if (ctx) return;

  ctx = new (window.AudioContext || window['webkitAudioContext'])();

  gainNode = ctx.createGain();
  gainNode.gain.value = 0; // silent until play() fades in
  gainNode.connect(ctx.destination);

  // Try AudioWorklet first; fall back to ScriptProcessor if it fails
  // (blob: URL can be blocked by some CSPs or older Safari)
  if (ctx.audioWorklet) {
    try {
      const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      useWorklet = true;
    } catch (err) {
      console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:', err);
    }
  }
}

// ── Noise node factory ────────────────────────────────────────────────────
function createNoiseNode() {
  if (useWorklet) {
    return new AudioWorkletNode(ctx, 'brown-noise');
  }

  // ScriptProcessorNode fallback (deprecated but universally supported)
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
    await boot();
    if (ctx.state === 'suspended') await ctx.resume();

    noiseNode = createNoiseNode();
    noiseNode.connect(gainNode);

    // 300 ms fade-in to prevent click/pop
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

  // 300 ms fade-out then disconnect
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
  } catch { /* permission denied or unsupported */ }
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

btn.addEventListener('click', () => {
  if (playing) pause();
  else         play();
});

volSlider.addEventListener('input', () => {
  if (gainNode && playing) {
    gainNode.gain.setTargetAtTime(+volSlider.value, ctx.currentTime, 0.05);
  }
});
