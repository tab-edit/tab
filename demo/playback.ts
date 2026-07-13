// In-app playback (Stan 2026-07-13): selection-aware, with a native-style
// transport — pause (AudioContext.suspend), seek, progress + the current
// sound's text span for follow-the-playhead. Pure Web Audio, no deps:
// triangle oscillator per pitched note, bandpassed noise per percussion
// hit. Demo-quality sound on purpose.
//
// Data: the documentMidi prop (absolute ticks @960 PPQ); every event
// carries its source sound's absolute doc span (plugins 122116c), so
// selection playback AND the playhead are range lookups over one stream.
import type { EditorState, SelectionRange } from "@codemirror/state";
import { documentMidi, tempo, type SmfNote } from "@tab-edit/plugins";
import type { TabNode } from "@tab-edit/ast";
import { readTabProp, tabTree } from "../src/index.js";

const PPQ = 960;

export interface Span {
  readonly from: number;
  readonly to: number;
}

interface TimedEvent {
  readonly atSec: number;
  readonly durSec: number;
  readonly midi: number;
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
  /** Called ~30×/s with the playhead; final call has ended=true. */
  progress(sec?: undefined): PlaybackProgress;
  stop(): void;
}

declare global {
  // Driver-inspectable playback evidence (headless audio is inaudible).
  var __lastPlayback: { events: number; totalSec: number; timbre: string } | undefined;
}

let ctx: AudioContext | null = null;

function bpmOf(state: EditorState): number {
  const tree = tabTree(state);
  if (!tree) return 120;
  const firstMusic = tree.topNode
    .getChildren("Section")
    .find((s: TabNode) =>
      s.getChildren("Block").some((b: TabNode) => b.getChildren("Measure").length > 0)
    );
  return firstMusic ? readTabProp(state, tempo, firstMusic).bpm : 120;
}

/** Resolve the playable timeline for a state + selection (pure). */
export function timeline(
  state: EditorState,
  ranges: readonly SelectionRange[]
): TimedEvent[] {
  const tree = tabTree(state);
  if (!tree) return [];
  let events = readTabProp(state, documentMidi, tree.topNode);
  // MIDI is 7-bit: anything outside 0..127 is junk data upstream (e.g.
  // prose years like "1866" parsing as frets — audit F5, gate pending) and
  // maps to a non-finite oscillator frequency that kills Web Audio.
  const playable = events.filter((e: SmfNote) => e.midi >= 0 && e.midi <= 127);
  if (playable.length < events.length) {
    console.warn(`playback: skipped ${events.length - playable.length} out-of-range midi events`);
  }
  events = playable;
  if (events.length === 0) return [];
  // sourceFrom/sourceTo is the Sound's FLAT extent (rangeFrom(0)..rangeTo(last));
  // for a chord that spans lines, selecting it grabs whole lines. Resolve back
  // to the Sound node's per-line ranges once per distinct span (a chord emits
  // several midi events off one Sound). Caret probe at sourceFrom: Sound
  // ranges are disjoint, so the probe pins the one starting there.
  const spanCache = new Map<string, readonly Span[]>();
  const soundSpans = (from: number, to: number): readonly Span[] => {
    const key = `${from}:${to}`;
    const hit = spanCache.get(key);
    if (hit) return hit;
    const sounds = tree.nodesInRanges([{ from, to: from }], "Sound");
    const sound = sounds.find((s: TabNode) => s.rangeFrom(0) === from) ?? sounds[0];
    let spans: Span[];
    if (sound) {
      spans = [];
      for (let i = 0; i < sound.rangeCount; i++) {
        spans.push({ from: sound.rangeFrom(i), to: sound.rangeTo(i) });
      }
    } else {
      spans = [{ from, to }]; // flat fallback (no Sound at this span)
    }
    spanCache.set(key, spans);
    return spans;
  };
  const secPerTick = 60 / (bpmOf(state) * PPQ);
  let timed: TimedEvent[] = events.map((e: SmfNote) => ({
    atSec: e.tick * secPerTick,
    durSec: Math.max(0.05, e.durationTicks * secPerTick),
    midi: e.midi,
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
  const sel = ranges.filter((r) => !r.empty);
  if (sel.length > 0) {
    const covered = timed.filter((e) =>
      e.spans.some((s) => sel.some((r) => s.from < r.to && r.from < s.to))
    );
    if (covered.length === 0) return [];
    const t0 = Math.min(...covered.map((e) => e.atSec));
    const t1 = Math.max(...covered.map((e) => e.atSec + e.durSec));
    const voiceLines = new Set<number>();
    for (const r of sel) {
      const lastLine = state.doc.lineAt(Math.min(r.to, state.doc.length)).number;
      for (let n = state.doc.lineAt(r.from).number; n <= lastLine; n++) voiceLines.add(n);
    }
    timed = timed.filter(
      (e) =>
        e.atSec >= t0 &&
        e.atSec < t1 &&
        e.spans.some((s) => voiceLines.has(state.doc.lineAt(s.from).number))
    );
  }
  if (timed.length === 0) return [];
  const base = Math.min(...timed.map((e) => e.atSec));
  return timed
    .map((e) => ({ ...e, atSec: e.atSec - base }))
    .sort((a, b) => a.atSec - b.atSec);
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

function pluck(audio: AudioContext, master: GainNode, at: number, freq: number, dur: number): void {
  const src = audio.createBufferSource();
  src.buffer = pluckBuffer(audio, freq, dur);
  const out = audio.createGain();
  // 6 ms fade-in kills the digital click at sample 0; the long exponential
  // release lets the string ring past the notated duration like a real one
  // (nothing hard-gates a vibrating string at the next note's onset).
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(0.25, at + 0.006);
  out.gain.setValueAtTime(0.25, at + dur * 0.7);
  out.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.35);
  src.connect(out).connect(master);
  src.start(at);
}

function scheduleFrom(
  audio: AudioContext,
  master: GainNode,
  events: readonly TimedEvent[],
  offsetSec: number,
  t0: number,
  timbre: Timbre
): void {
  for (const e of events) {
    if (e.atSec + e.durSec <= offsetSec) continue;
    const at = t0 + Math.max(0, e.atSec - offsetSec);
    const dur = e.durSec;
    if (e.percussion) {
      const len = Math.min(0.12, dur);
      const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * len), audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = audio.createBufferSource();
      src.buffer = buffer;
      const band = audio.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 150 + (e.midi % 24) * 180;
      band.Q.value = 0.8;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.6, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + len);
      src.connect(band).connect(gain).connect(master);
      src.start(at);
    } else if (timbre === "plucked") {
      pluck(audio, master, at, 440 * 2 ** ((e.midi - 69) / 12), dur);
    } else {
      const osc = audio.createOscillator();
      osc.type = timbre === "soft" ? "sine" : "triangle";
      osc.frequency.value = 440 * 2 ** ((e.midi - 69) / 12);
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.15, at + 0.01);
      gain.gain.setValueAtTime(0.15, at + dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }
}

export function createPlayer(
  state: EditorState,
  ranges: readonly SelectionRange[],
  timbre: Timbre = "plucked"
): Player | null {
  const events = timeline(state, ranges);
  if (events.length === 0) return null;
  const totalSec = Math.max(...events.map((e) => e.atSec + e.durSec));

  ctx ??= new AudioContext();
  const audio = ctx;
  void audio.resume();
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
  // stands in for the guitar body's air resonance. `sink` is what every
  // master gain connects to — rebuild() must route through the same chain.
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
    sink = top;
  }
  let master = audio.createGain();
  master.gain.value = 0.45;
  master.connect(sink);

  let startedAt = audio.currentTime + 0.05; // ctx-time of playback origin
  let offset = 0; // seconds into the piece at `startedAt`
  let paused = false;
  scheduleFrom(audio, master, events, 0, startedAt, timbre);
  globalThis.__lastPlayback = { events: events.length, totalSec, timbre };

  const now = (): number =>
    paused ? offset : Math.max(0, Math.min(totalSec, offset + (audio.currentTime - startedAt)));

  const rebuild = (fromSec: number): void => {
    master.disconnect();
    master = audio.createGain();
    master.gain.value = 0.45;
    master.connect(sink);
    startedAt = audio.currentTime + 0.02;
    offset = fromSec;
    scheduleFrom(audio, master, events, fromSec, startedAt, timbre);
  };

  return {
    totalSec,
    events: events.length,
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return;
      offset = now();
      paused = true;
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
      // Containment first (spans are per-line and disjoint between sounds;
      // both ends inclusive so a caret on either edge of a fret digit
      // counts, earlier sound winning a shared boundary). A miss — caret
      // on a dash — snaps FORWARD to the next onset on the same line.
      const line = state.doc.lineAt(Math.min(pos, state.doc.length));
      let next: number | undefined;
      let nextFrom = Infinity;
      for (const e of events) {
        for (const s of e.spans) {
          if (s.from <= pos && pos <= s.to) return e.atSec;
          if (s.from > pos && s.from <= line.to && s.from < nextFrom) {
            nextFrom = s.from;
            next = e.atSec;
          }
        }
      }
      return next;
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
      master.disconnect();
    },
  };
}
