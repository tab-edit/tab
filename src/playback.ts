// In-app playback (Stan 2026-07-13): selection-aware, with a native-style
// transport — pause, seek, progress + the current sound's text span for
// follow-the-playhead. Pure Web Audio, no deps: Karplus-Strong pluck or
// oscillator per pitched note, bandpassed noise per percussion hit.
//
// ENGINE-FREE (ADR-003 M-R2): the inputs are the two wire VALUES — the
// midiEvents query ({bpm, ppq, events} with each event's source span) and
// the snapshot sound map (span → the sound's per-line ranges). Local mode
// passes the same values from in-process reads. That is the whole reason
// playback works identically in the remote product app and offline: this
// module never sees a tree.
import type { Text } from "@codemirror/state";
import type { MidiEvents, PlaybackEvent } from "./facade.js";
import type { SemanticSnapshot } from "./snapshot-model.js";

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface TimedEvent {
  readonly atSec: number;
  readonly durSec: number;
  readonly midi: number;
  /** Note-on velocity 0-127 (technique dynamics: hammered/pulled notes and
   *  ghosts arrive softer from the midi pack). */
  readonly velocity: number;
  /** Pitch curve (bends/releases), offsets FROM THE NOTE'S OWN START — the
   *  same shared model the SMF encoder renders as channel pitch-bend (Q22).
   *  Note-relative on purpose: it survives the start-normalization shift
   *  and selection filtering because it rides the note. */
  readonly bend?: readonly { atSec: number; semitones: number }[];
  readonly percussion: boolean;
  /** The source Sound's ranges, one per line (a chord is a column slice —
   *  its flat from..to would span whole lines of everything in between). */
  readonly spans: readonly Span[];
}

export type Timbre = "plucked" | "tone" | "soft";

export interface PlaybackProgress {
  readonly sec: number;
  readonly totalSec: number;
  /** Per-line ranges of the sound at the playhead (undefined between
   *  sounds while playing; while paused, falls forward to the NEXT sound
   *  so scrubbing always has a target). */
  readonly spans?: readonly Span[];
  readonly ended: boolean;
}

export interface Player {
  readonly totalSec: number;
  readonly events: number;
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  seek(sec: number): void;
  /** text → time: onset of the sound at `pos`, or the next sound on the
   *  SAME line (columns are time within a system); undefined off this
   *  timeline (prose, or outside a selection-scoped playback). */
  secAt(pos: number): number | undefined;
  /** time → SCORE time: whole-note fraction from the piece's notated start
   *  (drives notation cursors — OSMD timestamps are the same unit). */
  scoreTimeAt(sec: number): number;
  /** Called ~30×/s with the playhead; final call has ended=true. */
  progress(sec?: undefined): PlaybackProgress;
  stop(): void;
}

declare global {
  // Driver-inspectable playback evidence (headless audio is inaudible).
  var __lastPlayback: { events: number; totalSec: number; timbre: string } | undefined;
}

let ctx: AudioContext | null = null;

// Output chains are CACHED per timbre on the (equally cached) context —
// the 2026-07-18 leak diagnosis made real: building a fresh
// DynamicsCompressor per play and never disconnecting it stacked a live
// compressor chain onto `destination` for every play of the session, and
// the render-thread cost of the pile eventually broke ALL audio. One
// limiter (+ one plucked shaping chain) per context, ever, by construction.
const sinkCache = new Map<Timbre, AudioNode>();
function sinkFor(audio: AudioContext, timbre: Timbre): AudioNode {
  const hit = sinkCache.get(timbre);
  if (hit) return hit;
  // Safety limiter: NOTHING reaches the ears unclamped (polyphony sums and
  // any future synth bug hit this before the destination).
  const limiter = audio.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 6;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  limiter.connect(audio.destination);
  // Plucked tone shaping (a dry Karplus-Strong string sounds like plastic):
  // a gentle top-end rolloff tames the remaining fizz and a low-mid peak
  // stands in for the guitar body's air resonance.
  let sink: AudioNode = limiter;
  if (timbre === "plucked") {
    const top = audio.createBiquadFilter();
    top.type = "lowpass";
    top.frequency.value = 4200;
    top.Q.value = 0.4;
    const body = audio.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = 170;
    body.gain.value = 3;
    body.Q.value = 0.9;
    top.connect(body).connect(limiter);
    // BODY RESONANCE (Stan 2026-07-19: "doesn't really sound like a
    // guitar"): the missing ingredient is the BOX — a real guitar's top
    // plate + air cavity ring at modal frequencies and smear every note
    // with a short wooden reverberation. A tiny generated impulse response
    // (modal sines + fast-decaying air noise, ~120 ms) convolved in
    // PARALLEL does what no EQ peak can: the dry string stays articulate,
    // the wet path adds the box around it. Mix and mode table are
    // ear-tunable constants.
    const convolver = audio.createConvolver();
    convolver.buffer = guitarBodyIR(audio);
    const wet = audio.createGain();
    wet.gain.value = 0.35; // body amount — the "how much box" knob
    convolver.connect(wet).connect(limiter);
    top.connect(convolver);
    sink = top;
  }
  sinkCache.set(timbre, sink);
  return sink;
}

/** Generated guitar-body impulse response: the dominant modes of a steel-
 *  string flat-top (Helmholtz air ~100 Hz, top plate ~200 Hz, back/higher
 *  plate modes ~400/650 Hz) as decaying sines, plus a few ms of filtered
 *  noise for the woody attack reflections. Deterministic, cached — one
 *  buffer per context lifetime. */
let bodyIRCache: AudioBuffer | null = null;
function guitarBodyIR(audio: AudioContext): AudioBuffer {
  if (bodyIRCache) return bodyIRCache;
  const rate = audio.sampleRate;
  const length = Math.ceil(rate * 0.12);
  const buffer = audio.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  // mode: [frequency Hz, relative level, decay seconds]
  const MODES: readonly [number, number, number][] = [
    [98, 1.0, 0.09], // Helmholtz air resonance — the "boom"
    [196, 0.7, 0.07], // top-plate fundamental — the "wood"
    [402, 0.35, 0.05],
    [655, 0.2, 0.04],
  ];
  for (const [hz, level, decay] of MODES) {
    const w = 2 * Math.PI * hz;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      data[i] += level * Math.sin(w * t) * Math.exp(-t / decay);
    }
  }
  // Early wooden reflections: 8 ms of lowpassed noise at the front.
  let lp = 0;
  const early = Math.ceil(rate * 0.008);
  for (let i = 0; i < early; i++) {
    lp = 0.85 * lp + 0.15 * (Math.random() * 2 - 1);
    data[i] += 0.4 * lp * (1 - i / early);
  }
  // Normalize to keep the wet path's loudness independent of sample rate.
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < length; i++) data[i] /= peak;
  bodyIRCache = buffer;
  return buffer;
}

// White noise is white noise: one cached buffer per decay length, not one
// fresh multi-hundred-KB allocation PER DRUM HIT (a full-song drum score
// allocated hundreds of MB of throwaway buffers).
const noiseCache = new Map<number, AudioBuffer>();
function noiseBuffer(audio: AudioContext, decaySec: number): AudioBuffer {
  const length = Math.ceil(audio.sampleRate * decaySec);
  const hit = noiseCache.get(length);
  if (hit) return hit;
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseCache.set(length, buffer);
  return buffer;
}

/** Everything playback needs about a document, all of it wire values:
 *  the midiEvents query result, the overlay snapshot (its sound map turns
 *  a flat source span back into per-line ranges), and the text (line
 *  geometry for selection voices). Local and remote modes differ only in
 *  where these three come from. */
export interface PlaybackSource {
  readonly midi: MidiEvents;
  readonly snapshot: SemanticSnapshot | null;
  readonly doc: Text;
}

/** Selection ranges as plain geometry (a CM SelectionRange satisfies it). */
export interface PlaybackRange {
  readonly from: number;
  readonly to: number;
}

/** Playback seconds → SCORE TIME in whole-note fractions — the join key
 *  between the audio clock and notation renderers (OSMD cursor timestamps
 *  are whole-note fractions over the SAME exported durations, so this is
 *  arithmetic, not matching). `baseSec` restores what start-normalization
 *  removed. */
export function secToWholeNotes(absSec: number, bpm: number): number {
  return (absSec * bpm) / 240; // whole note = 4 quarters = 240/bpm seconds
}

export function buildTimeline(
  source: PlaybackSource,
  ranges: readonly PlaybackRange[]
): { events: TimedEvent[]; baseSec: number } {
  const { midi, snapshot, doc } = source;
  // MIDI is 7-bit: anything outside 0..127 is junk data upstream (e.g.
  // prose years like "1866" parsing as frets — audit F5, gate pending) and
  // maps to a non-finite oscillator frequency that kills Web Audio.
  const NONE = { events: [] as TimedEvent[], baseSec: 0 };
  const all = midi.events;
  const events = all.filter((e: PlaybackEvent) => e.midi >= 0 && e.midi <= 127);
  if (events.length < all.length) {
    console.warn(`playback: skipped ${all.length - events.length} out-of-range midi events`);
  }
  if (events.length === 0) return NONE;
  // sourceFrom/sourceTo is the Sound's FLAT extent (first range start ..
  // last range end); for a chord that spans lines, selecting it grabs whole
  // lines. Resolve back to the sound's per-line ranges once per distinct
  // span (a chord emits several midi events off one Sound) — the SNAPSHOT
  // sound map is exactly this lookup table, pre-order and disjoint, so the
  // entry whose first range starts at `from` is the one (identical rule to
  // the old caret probe over the tree, minus the tree).
  const spanCache = new Map<string, readonly Span[]>();
  const byStart = new Map<number, readonly Span[]>();
  for (const entry of snapshot?.sounds ?? []) {
    const first = entry.ranges[0];
    if (first && !byStart.has(first.from)) {
      byStart.set(
        first.from,
        entry.ranges.map((r) => ({ from: r.from, to: r.to }))
      );
    }
  }
  const soundSpans = (from: number, to: number): readonly Span[] => {
    const key = `${from}:${to}`;
    const hit = spanCache.get(key);
    if (hit) return hit;
    // flat fallback when no sound starts there (no snapshot yet, or an
    // event whose source span isn't a sound start).
    const spans: readonly Span[] = byStart.get(from) ?? [{ from, to }];
    spanCache.set(key, spans);
    return spans;
  };
  const secPerTick = 60 / (midi.bpm * midi.ppq);
  let timed: TimedEvent[] = events.map((e: PlaybackEvent) => ({
    atSec: e.tick * secPerTick,
    durSec: Math.max(0.05, e.durationTicks * secPerTick),
    midi: e.midi,
    velocity: e.velocity ?? 0x60,
    ...(e.bend && e.bend.length > 0
      ? { bend: e.bend.map((b) => ({ atSec: b.tick * secPerTick, semitones: b.semitones })) }
      : {}),
    percussion: e.percussion === true,
    spans: soundSpans(e.sourceFrom ?? 0, e.sourceTo ?? 0),
  }));
  // A selection is a region of the tab GRID (x = time, y = voice), NOT the
  // set of glyphs the highlight staircase touched: window = earliest→latest
  // moment of the covered sounds; voices = the tab lines the selection
  // touches; play EVERY touched-voice sound inside the window. A rough drag
  // over a drum block therefore plays the full groove for that stretch (a
  // groove minus its kick is a DIFFERENT groove — glyph-subset playback was
  // musically meaningless); a drag along one line deliberately SOLOS that
  // voice (exact for drums, one sound per line; a guitar chord is one Sound
  // across lines and plays whole — the atomic unit is the Sound). Lines
  // with no sounds (annotations like "|--repeat 8x--|") add no voices.
  const sel = ranges.filter((r) => r.to > r.from);
  if (sel.length > 0) {
    const covered = timed.filter((e) =>
      e.spans.some((s) => sel.some((r) => s.from < r.to && r.from < s.to))
    );
    if (covered.length === 0) return NONE;
    const t0 = Math.min(...covered.map((e) => e.atSec));
    const t1 = Math.max(...covered.map((e) => e.atSec + e.durSec));
    const voiceLines = new Set<number>();
    for (const r of sel) {
      const lastLine = doc.lineAt(Math.min(r.to, doc.length)).number;
      for (let n = doc.lineAt(Math.min(r.from, doc.length)).number; n <= lastLine; n++) {
        voiceLines.add(n);
      }
    }
    timed = timed.filter(
      (e) =>
        e.atSec >= t0 &&
        e.atSec < t1 &&
        e.spans.some((s) => voiceLines.has(doc.lineAt(Math.min(s.from, doc.length)).number))
    );
  }
  if (timed.length === 0) return { events: [], baseSec: 0 };
  const base = Math.min(...timed.map((e) => e.atSec));
  return {
    events: timed.map((e) => ({ ...e, atSec: e.atSec - base })).sort((a, b) => a.atSec - b.atSec),
    baseSec: base,
  };
}

/** Karplus-Strong plucked string, COMPUTED into a buffer (sample-accurate).
 *  A live feedback-delay loop is the classic implementation but Web Audio
 *  adds a mandatory 128-sample render quantum to every cycle — every note
 *  plays flat and anything above ~344 Hz can't form its period at all
 *  (found the hard way: "plucked sounds very wrong"). Synthesizing the
 *  string in JS is one average per sample; buffers are cached per note. */
const pluckCache = new Map<string, AudioBuffer>();
function pluckBuffer(audio: AudioContext, freq: number, durSec: number): AudioBuffer {
  const rate = audio.sampleRate;
  const key = `${Math.round(freq * 10)}:${Math.ceil(durSec * 4)}`;
  const hit = pluckCache.get(key);
  if (hit) return hit;
  const period = Math.max(2, Math.round(rate / freq));
  const length = Math.ceil(rate * (durSec + 0.4));
  const buffer = audio.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  // Soft pick: RAW white noise is the harshness — every partial at full
  // blast reads as a metal edge on steel. Two one-pole lowpass passes over
  // the excitation (~2.5 kHz) round it into a fingertip-on-nylon attack.
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < period; i++) {
    lp1 = 0.7 * lp1 + 0.3 * (Math.random() * 2 - 1);
    lp2 = 0.7 * lp2 + 0.3 * lp1;
    data[i] = lp2;
  }
  // Pick-position comb: subtracting a delayed copy of the excitation puts
  // the "picked partway up the string" notch in the spectrum. /5 (not /7):
  // farther from the bridge = warmer.
  const pick = Math.max(1, Math.round(period / 5));
  for (let i = period - 1; i >= pick; i--) data[i] -= 0.5 * data[i - pick];
  // Lowpassing costs energy — renormalize so every note speaks evenly.
  let peak = 0;
  for (let i = 0; i < period; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < period; i++) data[i] /= peak;
  // Low strings ring longer than high ones (real-instrument decay).
  const decay = freq < 150 ? 0.9992 : freq < 330 ? 0.9985 : 0.997;
  for (let i = period; i < length; i++) {
    data[i] = decay * 0.5 * (data[i - period] + data[i - period + 1]);
  }
  pluckCache.set(key, buffer);
  return buffer;
}

/** Render the shared pitch curve onto an AudioParam: exponential ramps in
 *  value = linear in semitones — the audibly correct glide for bends. */
function applyBend(
  param: AudioParam,
  base: number,
  points: readonly { when: number; semitones: number }[] | undefined
): void {
  if (!points || points.length === 0) return;
  const value = (s: number) => Math.max(1e-3, base * 2 ** (s / 12));
  param.setValueAtTime(value(points[0].semitones), points[0].when);
  for (let i = 1; i < points.length; i++) {
    param.exponentialRampToValueAtTime(value(points[i].semitones), points[i].when);
  }
}

function pluck(
  audio: AudioContext,
  master: GainNode,
  at: number,
  freq: number,
  dur: number,
  level: number,
  bend?: readonly { when: number; semitones: number }[]
): void {
  const src = audio.createBufferSource();
  src.buffer = pluckBuffer(audio, freq, dur);
  applyBend(src.playbackRate, 1, bend);
  const out = audio.createGain();
  // 6 ms fade-in kills the digital click at sample 0; the long exponential
  // release lets the string ring past the notated duration like a real one
  // (nothing hard-gates a vibrating string at the next note's onset).
  const peak = 0.25 * level;
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(peak, at + 0.006);
  out.gain.setValueAtTime(peak, at + dur * 0.7);
  out.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.35);
  src.connect(out).connect(master);
  src.start(at);
  // Pick-contact knock (realism pass 2026-07-19): the instant a finger or
  // pick releases a string, the guitar TOP gets a percussive tap — a low
  // "knock" every recording has and pure string synthesis lacks. 25 ms
  // sine drop, quiet, gated by the same velocity level.
  const knock = audio.createOscillator();
  knock.type = "sine";
  knock.frequency.setValueAtTime(110, at);
  knock.frequency.exponentialRampToValueAtTime(78, at + 0.025);
  const knockGain = audio.createGain();
  knockGain.gain.setValueAtTime(0.1 * level, at);
  knockGain.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
  knock.connect(knockGain).connect(master);
  knock.start(at);
  knock.stop(at + 0.04);
}

/** One GM percussion key's synthesis recipe — DATA, like the engine's
 *  voice maps: the table is the in-app "soundfont", overridable per key
 *  without touching the renderer. `tone` = pitched body (kick thump, tom
 *  pitch, cowbell ring); `noise` = filtered burst (snare rattle, hats,
 *  cymbal wash); either may be absent. */
export interface DrumRecipe {
  readonly tone?: {
    readonly startHz: number;
    /** Pitch glide target (the kick/tom drop); defaults to startHz. */
    readonly endHz?: number;
    readonly decaySec: number;
    readonly type?: OscillatorType;
    readonly level?: number;
  };
  readonly noise?: {
    readonly filter: "highpass" | "bandpass";
    readonly hz: number;
    readonly decaySec: number;
    readonly level?: number;
    readonly q?: number;
  };
}

const KICK_R: DrumRecipe = { tone: { startHz: 120, endHz: 48, decaySec: 0.22, type: "sine", level: 1.0 } };
const SNARE_R: DrumRecipe = {
  tone: { startHz: 185, endHz: 150, decaySec: 0.08, type: "triangle", level: 0.4 },
  noise: { filter: "highpass", hz: 1600, decaySec: 0.16, level: 0.55 },
};
const SIDESTICK_R: DrumRecipe = { noise: { filter: "bandpass", hz: 2400, decaySec: 0.04, level: 0.5, q: 4 } };
const HAT_CLOSED_R: DrumRecipe = { noise: { filter: "highpass", hz: 7000, decaySec: 0.05, level: 0.35 } };
const HAT_OPEN_R: DrumRecipe = { noise: { filter: "highpass", hz: 6500, decaySec: 0.4, level: 0.35 } };
const HAT_PEDAL_R: DrumRecipe = { noise: { filter: "highpass", hz: 6000, decaySec: 0.07, level: 0.28 } };
const CRASH_R: DrumRecipe = { noise: { filter: "highpass", hz: 4500, decaySec: 1.3, level: 0.5 } };
const RIDE_R: DrumRecipe = { noise: { filter: "highpass", hz: 8000, decaySec: 0.7, level: 0.3 } };
const RIDE_BELL_R: DrumRecipe = {
  tone: { startHz: 1050, decaySec: 0.5, type: "square", level: 0.2 },
  noise: { filter: "highpass", hz: 8000, decaySec: 0.3, level: 0.15 },
};
const tomR = (hz: number): DrumRecipe => ({
  tone: { startHz: hz * 1.35, endHz: hz, decaySec: 0.3, type: "sine", level: 0.85 },
});
const COWBELL_R: DrumRecipe = { tone: { startHz: 540, decaySec: 0.25, type: "square", level: 0.35 } };
const BLOCK_R: DrumRecipe = { tone: { startHz: 900, decaySec: 0.07, type: "sine", level: 0.6 } };

/** The GM drum map, keyed by MIDI note (channel-10 semantics — the same
 *  keys the exports emit, so in-app playback and a DAW agree per part).
 *  This is the PLAYER-side extension point (engine packs are pure-value by
 *  design — they decide what a glyph MEANS; a SOUND PACK registers here to
 *  decide what a GM key sounds like, or to replace a builtin recipe). */
const DRUM_RECIPE_REGISTRY: Map<number, DrumRecipe> = new Map([
  [35, KICK_R], [36, KICK_R],
  [37, SIDESTICK_R], [38, SNARE_R], [40, SNARE_R],
  [39, SIDESTICK_R],
  [42, HAT_CLOSED_R], [44, HAT_PEDAL_R], [46, HAT_OPEN_R],
  [41, tomR(85)], [43, tomR(100)], [45, tomR(120)], [47, tomR(140)], [48, tomR(165)], [50, tomR(195)],
  [49, CRASH_R], [55, CRASH_R], [52, CRASH_R], [57, CRASH_R],
  [51, RIDE_R], [59, RIDE_R], [53, RIDE_BELL_R],
  [56, COWBELL_R],
  [65, tomR(300)], [66, tomR(240)],
  [76, BLOCK_R], [77, { tone: { startHz: 620, decaySec: 0.07, type: "sine", level: 0.6 } }],
]);

const DEFAULT_DRUM_R: DrumRecipe = { noise: { filter: "bandpass", hz: 900, decaySec: 0.12, level: 0.5, q: 1 } };

/** Register (or replace) the synthesis recipe for a GM percussion key —
 *  the sound-pack surface. Returns an undo handle so hosts can offer
 *  toggleable sound packs (same idiom as CM compartments). */
export function registerDrumSound(midi: number, recipe: DrumRecipe): () => void {
  const previous = DRUM_RECIPE_REGISTRY.get(midi);
  DRUM_RECIPE_REGISTRY.set(midi, recipe);
  return () => {
    if (previous) DRUM_RECIPE_REGISTRY.set(midi, previous);
    else DRUM_RECIPE_REGISTRY.delete(midi);
  };
}

/** Read-only view of the active drum map (Inspector/plugin-manager UIs). */
export function drumSounds(): ReadonlyMap<number, DrumRecipe> {
  return DRUM_RECIPE_REGISTRY;
}

function drumHit(audio: AudioContext, master: GainNode, at: number, midi: number, level: number): void {
  const recipe = DRUM_RECIPE_REGISTRY.get(midi) ?? DEFAULT_DRUM_R;
  if (recipe.tone) {
    const t = recipe.tone;
    const osc = audio.createOscillator();
    osc.type = t.type ?? "sine";
    osc.frequency.setValueAtTime(t.startHz, at);
    if (t.endHz !== undefined && t.endHz !== t.startHz) {
      osc.frequency.exponentialRampToValueAtTime(t.endHz, at + t.decaySec * 0.6);
    }
    const gain = audio.createGain();
    gain.gain.setValueAtTime((t.level ?? 0.8) * level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + t.decaySec);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + t.decaySec + 0.05);
  }
  if (recipe.noise) {
    const n = recipe.noise;
    const src = audio.createBufferSource();
    src.buffer = noiseBuffer(audio, n.decaySec);
    const filter = audio.createBiquadFilter();
    filter.type = n.filter;
    filter.frequency.value = n.hz;
    filter.Q.value = n.q ?? 0.8;
    const gain = audio.createGain();
    gain.gain.setValueAtTime((n.level ?? 0.5) * level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + n.decaySec);
    src.connect(filter).connect(gain).connect(master);
    src.start(at);
  }
}

// —— Windowed scheduling (2026-07-19 audio-breakup fix). Scheduling a whole
// piece up front puts EVERY note's node chain in the render graph at once —
// fine for an 8-bar riff, fatal for the pulled full-song scores (Painkiller
// = 1,829 events ≈ 7,000+ live nodes: the render thread starves and ALL
// audio crackles, whatever the instrument). The player now pumps a short
// lookahead window on a timer; live nodes scale with polyphony, never piece
// length. The two cursor functions are the pure, headless-tested core.

/** First index ≥ cursor whose event starts AFTER the horizon (events sorted
 *  by atSec): everything in [cursor, result) is due for scheduling. */
export function schedulableThrough(
  events: readonly { atSec: number }[],
  cursor: number,
  horizonSec: number
): number {
  let i = cursor;
  while (i < events.length && events[i].atSec <= horizonSec) i++;
  return i;
}

/** Seek cursor: the first event still SOUNDING at (or starting after) the
 *  offset — long notes already ringing at a seek point must replay. */
export function cursorAt(
  events: readonly { atSec: number; durSec: number }[],
  offsetSec: number
): number {
  let i = 0;
  while (i < events.length && events[i].atSec + events[i].durSec <= offsetSec) i++;
  return i;
}

/** Caret → playback time: the pure core of "play from HERE" (third
 *  headless-tested function; the closure below is a thin binding).
 *
 *  Containment first — a caret on a fret digit IS that sound. A miss (the
 *  caret is on a DASH) snaps FORWARD to the next onset, and the whole
 *  subtlety is what "next" is allowed to mean. Document offsets only order
 *  by time WITHIN a line: across strings they order line-major, so an
 *  offset comparison can never reach the note one string down. That is why
 *  a caret on a silent string, or past the last note of its own line, used
 *  to answer `undefined` and the app fell back to the top of the score.
 *
 *  The tab grid's x axis is the COLUMN, and the sibling set at a moment is
 *  the caret's MEASURE — which the snapshot already carries as one range
 *  per line of its system, in score order. So: the next onset at column ≥
 *  the caret's, anywhere in that measure, else anywhere in a later one.
 *  Earliest atSec wins rather than smallest column, because time is the
 *  question being asked (columns misalign in hand-written tab).
 *
 *  A caret OUTSIDE the grid — the tuning label, a prose or annotation line
 *  between systems — falls to the start of the next measure. With no
 *  measure map at all (snapshot not in yet) it degrades to the old
 *  line-local scan. `undefined` now means only "nothing left to play". */
export function secAtPos(
  events: readonly TimedEvent[],
  doc: Text,
  measures: readonly { readonly ranges: readonly Span[] }[],
  pos: number
): number | undefined {
  for (const e of events) {
    for (const s of e.spans) {
      // Both ends inclusive so a caret on either edge of a digit counts;
      // events are atSec-sorted, so an earlier sound wins a shared edge.
      if (s.from <= pos && pos <= s.to) return e.atSec;
    }
  }
  // Flat [from, to) → measure index, sorted for binary search: one build per
  // click, then O(log n) per span (full scores run 1,800+ events).
  const cells: { from: number; to: number; mi: number }[] = [];
  measures.forEach((m, mi) => {
    for (const r of m.ranges) cells.push({ from: r.from, to: r.to, mi });
  });
  cells.sort((a, b) => a.from - b.from);
  const cellAt = (off: number): { from: number; to: number; mi: number } | undefined => {
    let lo = 0;
    let hi = cells.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (off < cells[mid].from) hi = mid - 1;
      else if (off >= cells[mid].to) lo = mid + 1;
      else return cells[mid];
    }
    return undefined;
  };
  const colOf = (off: number): number => off - doc.lineAt(Math.min(off, doc.length)).from;

  const here = cellAt(pos);
  let measure: number;
  let colGate: number;
  if (here) {
    measure = here.mi;
    colGate = colOf(pos);
  } else {
    // Off the grid: the next measure to begin, from its own start.
    const after = cells.find((c) => c.from > pos);
    if (!after) return lineLocalNext(events, doc, pos);
    measure = after.mi;
    colGate = 0;
  }
  let best: number | undefined;
  for (const e of events) {
    if (best !== undefined && e.atSec >= best) continue;
    for (const s of e.spans) {
      const cell = cellAt(s.from);
      if (!cell) continue;
      if (cell.mi > measure || (cell.mi === measure && colOf(s.from) >= colGate)) {
        best = e.atSec;
        break;
      }
    }
  }
  return best;
}

/** The pre-measure-map behavior, kept as the degraded path: next onset on
 *  the caret's own line. */
function lineLocalNext(
  events: readonly TimedEvent[],
  doc: Text,
  pos: number
): number | undefined {
  const line = doc.lineAt(Math.min(pos, doc.length));
  let next: number | undefined;
  let nextFrom = Infinity;
  for (const e of events) {
    for (const s of e.spans) {
      if (s.from > pos && s.from <= line.to && s.from < nextFrom) {
        nextFrom = s.from;
        next = e.atSec;
      }
    }
  }
  return next;
}

/** How far ahead of the playhead the pump schedules, and how often it runs.
 *  1.2s/250ms is the standard Web Audio lookahead pattern: deep enough that
 *  a busy main thread never gaps the audio, shallow enough that a full song
 *  keeps only a handful of node chains alive. */
const LOOKAHEAD_SEC = 1.2;
const PUMP_MS = 250;

function scheduleOne(
  audio: AudioContext,
  master: GainNode,
  e: TimedEvent,
  offsetSec: number,
  t0: number,
  timbre: Timbre
): void {
  {
    const at = t0 + Math.max(0, e.atSec - offsetSec);
    const dur = e.durSec;
    // Velocity → gain, normalized so the pack default (0x60) keeps the
    // tuned levels. SQUARED on purpose: linear amplitude reads as barely
    // -3 dB for a hammer-on (0x43) — squaring matches the velocity curve
    // real synths use, so technique dynamics are actually audible
    // (hammer ≈ half power, ghost ≈ quarter).
    const level = (e.velocity / 0x60) ** 2;
    // Bend points on the audio clock: note-relative offsets ride the
    // note's own scheduled start.
    const bendPts = e.bend?.map((b) => ({
      when: at + b.atSec,
      semitones: b.semitones,
    }));
    if (e.percussion) {
      drumHit(audio, master, at, e.midi, level);
    } else if (timbre === "plucked") {
      pluck(audio, master, at, 440 * 2 ** ((e.midi - 69) / 12), dur, level, bendPts);
    } else {
      const osc = audio.createOscillator();
      osc.type = timbre === "soft" ? "sine" : "triangle";
      const freq = 440 * 2 ** ((e.midi - 69) / 12);
      osc.frequency.value = freq;
      applyBend(osc.frequency, freq, bendPts);
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.15 * level, at + 0.01);
      gain.gain.setValueAtTime(0.15 * level, at + dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }
}

export function createPlayer(
  source: PlaybackSource,
  ranges: readonly PlaybackRange[],
  timbre: Timbre = "plucked"
): Player | null {
  const { events, baseSec } = buildTimeline(source, ranges);
  if (events.length === 0) return null;
  const doc = source.doc;
  const totalSec = Math.max(...events.map((e) => e.atSec + e.durSec));
  const bpm = source.midi.bpm;

  ctx ??= new AudioContext();
  const audio = ctx;
  void audio.resume();
  const sink = sinkFor(audio, timbre);
  let master = audio.createGain();
  master.gain.value = 0.45;
  master.connect(sink);

  let startedAt = audio.currentTime + 0.05; // ctx-time of playback origin
  let offset = 0; // seconds into the piece at `startedAt`
  let paused = false;

  // The pump: schedule only what starts inside the lookahead window, on a
  // steady timer. Cursor state lives here; the math is the pure functions
  // above. A (re)build resets the cursor via cursorAt so long notes still
  // sounding at a seek point replay from their attack (same audible
  // behavior the bulk scheduler had).
  let cursor = cursorAt(events, 0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const pump = (): void => {
    const horizon = offset + (audio.currentTime - startedAt) + LOOKAHEAD_SEC;
    const through = schedulableThrough(events, cursor, horizon);
    for (; cursor < through; cursor++) {
      scheduleOne(audio, master, events[cursor], offset, startedAt, timbre);
    }
    if (cursor >= events.length && timer !== null) {
      clearInterval(timer); // piece fully scheduled; nodes drain on their own
      timer = null;
    }
  };
  const startPump = (): void => {
    pump();
    if (cursor < events.length) timer = setInterval(pump, PUMP_MS);
  };
  const stopPump = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  startPump();
  globalThis.__lastPlayback = { events: events.length, totalSec, timbre };

  const now = (): number =>
    paused ? offset : Math.max(0, Math.min(totalSec, offset + (audio.currentTime - startedAt)));

  const rebuild = (fromSec: number): void => {
    stopPump();
    master.disconnect(); // silences already-scheduled nodes; they self-end
    master = audio.createGain();
    master.gain.value = 0.45;
    master.connect(sink);
    startedAt = audio.currentTime + 0.02;
    offset = fromSec;
    cursor = cursorAt(events, fromSec);
    startPump();
  };

  return {
    totalSec,
    events: events.length,
    scoreTimeAt: (sec: number) => secToWholeNotes(baseSec + sec, bpm),
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return;
      offset = now();
      paused = true;
      stopPump();
      master.disconnect(); // hard-mute; resume reschedules from the offset
    },
    resume() {
      if (!paused) return;
      paused = false;
      rebuild(offset);
    },
    seek(sec: number) {
      const clamped = Math.max(0, Math.min(totalSec, sec));
      if (paused) offset = clamped;
      else rebuild(clamped);
    },
    secAt(pos: number): number | undefined {
      return secAtPos(events, doc, source.snapshot?.measures ?? [], pos);
    },
    progress(): PlaybackProgress {
      const sec = now();
      // Playing: only a sound actually under the playhead. Paused: fall
      // forward to the next sound so scrubbing between sounds still gives
      // the follow-jump a target (what WILL play on resume).
      const current =
        events.find((e) => e.atSec <= sec && sec < e.atSec + e.durSec) ??
        (paused ? events.find((e) => e.atSec >= sec) : undefined);
      return {
        sec,
        totalSec,
        spans: current?.spans,
        ended: !paused && sec >= totalSec,
      };
    },
    stop() {
      stopPump();
      master.disconnect();
    },
  };
}
