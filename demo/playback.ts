// In-app playback (Stan 2026-07-13): ONE selection-aware surface — the
// whole doc, or just the sounds a selection touches. Pure Web Audio, no
// deps: a triangle oscillator per pitched note, a filtered noise burst per
// percussion hit. Demo-quality on purpose ("hear your ASCII tab" is the
// point, fidelity is not).
//
// Data comes from the documentMidi prop (absolute ticks @960 PPQ); each
// event carries its source sound's absolute span (plugins 122116c), so
// selection playback is a range filter over the absolute-tick stream.
import type { EditorState, SelectionRange } from "@codemirror/state";
import { documentMidi, tempo, type SmfNote } from "@tab-edit/plugins";
import type { TabNode } from "@tab-edit/ast";
import { readTabProp, tabTree } from "../src/index.js";

const PPQ = 960;

export interface PlaybackHandle {
  readonly stop: () => void;
  readonly totalSec: number;
  readonly events: number;
}

declare global {
  // eslint-disable-next-line no-var — driver-inspectable playback evidence
  var __lastPlayback: { events: number; totalSec: number } | undefined;
}

let ctx: AudioContext | null = null;

function bpmOf(state: EditorState): number {
  const tree = tabTree(state);
  if (!tree) return 120;
  const sections = tree.topNode.getChildren("Section");
  const firstMusic = sections.find((s: TabNode) =>
    s.getChildren("Block").some((b: TabNode) => b.getChildren("Measure").length > 0)
  );
  return firstMusic ? readTabProp(state, tempo, firstMusic).bpm : 120;
}

export function play(
  state: EditorState,
  ranges: readonly SelectionRange[],
  onEnded: () => void
): PlaybackHandle | null {
  const tree = tabTree(state);
  if (!tree) return null;
  let events = readTabProp(state, documentMidi, tree.topNode);
  const selecting = ranges.some((r) => !r.empty);
  if (selecting) {
    events = events.filter((e: SmfNote) =>
      ranges.some(
        (r) => !r.empty && (e.sourceFrom ?? 0) < r.to && r.from < (e.sourceTo ?? 0)
      )
    );
  }
  if (events.length === 0) return null;
  const baseTick = Math.min(...events.map((e: SmfNote) => e.tick));
  const secPerTick = 60 / (bpmOf(state) * PPQ);

  ctx ??= new AudioContext();
  void ctx.resume();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  let totalSec = 0;

  for (const e of events) {
    const at = t0 + (e.tick - baseTick) * secPerTick;
    const dur = Math.max(0.05, e.durationTicks * secPerTick);
    totalSec = Math.max(totalSec, (e.tick - baseTick) * secPerTick + dur);
    if (e.percussion) {
      // Noise burst, bandpassed by GM key so kick/snare/hats differ.
      const len = Math.min(0.12, dur);
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 150 + (e.midi % 24) * 180; // kick low → hats high
      band.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.6, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + len);
      src.connect(band).connect(gain).connect(master);
      src.start(at);
    } else {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 440 * 2 ** ((e.midi - 69) / 12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.15, at + 0.01);
      gain.gain.setValueAtTime(0.15, at + dur * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }

  globalThis.__lastPlayback = { events: events.length, totalSec };
  const timer = setTimeout(onEnded, (totalSec + 0.15) * 1000);
  return {
    totalSec,
    events: events.length,
    stop: () => {
      clearTimeout(timer);
      master.disconnect();
    },
  };
}
