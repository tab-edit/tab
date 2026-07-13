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

interface TimedEvent {
  readonly atSec: number;
  readonly durSec: number;
  readonly midi: number;
  readonly percussion: boolean;
  readonly sourceFrom: number;
  readonly sourceTo: number;
}

export type Timbre = "plucked" | "tone" | "soft";

export interface PlaybackProgress {
  readonly sec: number;
  readonly totalSec: number;
  /** Text span of the sound at the playhead (undefined between sounds). */
  readonly span?: { readonly from: number; readonly to: number };
  readonly ended: boolean;
}

export interface Player {
  readonly totalSec: number;
  readonly events: number;
  readonly paused: boolean;
  pause(): void;
  resume(): void;
  seek(sec: number): void;
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
  const selecting = ranges.some((r) => !r.empty);
  if (selecting) {
    events = events.filter((e: SmfNote) =>
      ranges.some(
        (r) => !r.empty && (e.sourceFrom ?? 0) < r.to && r.from < (e.sourceTo ?? 0)
      )
    );
  }
  // MIDI is 7-bit: anything outside 0..127 is junk data upstream (e.g.
  // prose years like "1866" parsing as frets — audit F5, gate pending) and
  // maps to a non-finite oscillator frequency that kills Web Audio.
  const playable = events.filter((e: SmfNote) => e.midi >= 0 && e.midi <= 127);
  if (playable.length < events.length) {
    console.warn(`playback: skipped ${events.length - playable.length} out-of-range midi events`);
  }
  events = playable;
  if (events.length === 0) return [];
  const secPerTick = 60 / (bpmOf(state) * PPQ);
  const baseTick = Math.min(...events.map((e: SmfNote) => e.tick));
  return events
    .map((e: SmfNote) => ({
      atSec: (e.tick - baseTick) * secPerTick,
      durSec: Math.max(0.05, e.durationTicks * secPerTick),
      midi: e.midi,
      percussion: e.percussion === true,
      sourceFrom: e.sourceFrom ?? 0,
      sourceTo: e.sourceTo ?? 0,
    }))
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
  const length = Math.ceil(rate * (durSec + 0.15));
  const buffer = audio.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < period; i++) data[i] = Math.random() * 2 - 1;
  // Pick-position comb: subtracting a delayed copy of the excitation puts
  // the "pick near the bridge" notch in the spectrum — the guitar attack.
  const pick = Math.max(1, Math.round(period / 7));
  for (let i = period - 1; i >= pick; i--) data[i] -= 0.5 * data[i - pick];
  // Low strings ring longer than high ones (real-instrument decay).
  const decay = freq < 150 ? 0.999 : freq < 330 ? 0.998 : 0.9965;
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
  out.gain.setValueAtTime(0.3, at);
  out.gain.setValueAtTime(0.3, at + dur * 0.7);
  out.gain.exponentialRampToValueAtTime(0.001, at + dur + 0.1);
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
  let master = audio.createGain();
  master.gain.value = 0.5;
  master.connect(limiter);

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
    master.gain.value = 0.5;
    master.connect(limiter);
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
    progress(): PlaybackProgress {
      const sec = now();
      const current = events.find((e) => e.atSec <= sec && sec < e.atSec + e.durSec);
      return {
        sec,
        totalSec,
        span: current ? { from: current.sourceFrom, to: current.sourceTo } : undefined,
        ended: !paused && sec >= totalSec,
      };
    },
    stop() {
      master.disconnect();
    },
  };
}
