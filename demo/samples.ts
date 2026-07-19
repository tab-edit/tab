// Sample tabs for first demo users (Stan 2026-07-13): 2 per instrument
// type + a 16th-century lute piece, all byte-exact copies from the ast
// benchmark corpus (provenance: ast/tests/benchmark/tabs/README.md).
/// <reference types="vite/client" />
import anonSeIo from "./samples/anon-se-io.txt?raw";
import satie from "./samples/satie-gnossienne.txt?raw";
import redBarchetta from "./samples/red-barchetta-guitar.txt?raw";
import backbeatBass from "./samples/backbeat-bass.txt?raw";
import yyzBass from "./samples/yyz-bass.txt?raw";
import tomSawyer from "./samples/tom-sawyer-drums.txt?raw";
import airTonight from "./samples/in-the-air-tonight.txt?raw";
import leveeBreaks from "./samples/when-the-levee-breaks.txt?raw";
import rosanna from "./samples/rosanna-shuffle.txt?raw";
import funkyDrummer from "./samples/funky-drummer.txt?raw";
import wipeOut from "./samples/wipe-out.txt?raw";
import amenBreak from "./samples/amen-break.txt?raw";
import hotrs from "./samples/house-of-the-rising-sun.txt?raw";
import canon from "./samples/pachelbel-canon-in-d.txt?raw";

export interface SampleGroup {
  readonly group: string;
  readonly items: readonly { readonly label: string; readonly text: string }[];
}

export const SAMPLES: readonly SampleGroup[] = [
  {
    group: "Guitar",
    items: [
      { label: "Gnossienne No. 1 (Satie)", text: satie },
      { label: "Red Barchetta (Rush)", text: redBarchetta },
      { label: "House of the Rising Sun (trad.)", text: hotrs },
      { label: "Canon in D (Pachelbel)", text: canon },
    ],
  },
  {
    group: "Bass",
    items: [
      { label: "Backbeat Study", text: backbeatBass },
      { label: "YYZ (Rush)", text: yyzBass },
    ],
  },
  {
    // Recognizable, groove-forward showcases (Stan 2026-07-19) — authored
    // pattern transcriptions "after" the famous recordings, with Tempo
    // directives so playback sits at the right feel. Tom Sawyer stays as
    // the wild-transcription stress piece (RTP dialect, full song).
    group: "Drums",
    items: [
      { label: "In the Air Tonight (the fill)", text: airTonight },
      { label: "When the Levee Breaks (Bonham)", text: leveeBreaks },
      { label: "Rosanna (Porcaro shuffle)", text: rosanna },
      { label: "Funky Drummer (Stubblefield)", text: funkyDrummer },
      { label: "Wipe Out (the roll)", text: wipeOut },
      { label: "Amen Break (The Winstons)", text: amenBreak },
      { label: "Tom Sawyer (Rush, wild transcription)", text: tomSawyer },
    ],
  },
  {
    group: "Lute",
    items: [{ label: "Se io m'accorgo (anon., 16th c.)", text: anonSeIo }],
  },
];
