// Sample tabs for first demo users (Stan 2026-07-13): 2 per instrument
// type + a 16th-century lute piece, all byte-exact copies from the ast
// benchmark corpus (provenance: ast/tests/benchmark/tabs/README.md).
/// <reference types="vite/client" />
import anonSeIo from "./samples/anon-se-io.txt?raw";
import satie from "./samples/satie-gnossienne.txt?raw";
import redBarchetta from "./samples/red-barchetta-guitar.txt?raw";
import backbeatBass from "./samples/backbeat-bass.txt?raw";
import yyzBass from "./samples/yyz-bass.txt?raw";
import backbeatDrums from "./samples/backbeat-drums.txt?raw";
import tomSawyer from "./samples/tom-sawyer-drums.txt?raw";
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
    group: "Drums",
    items: [
      { label: "Backbeat Study", text: backbeatDrums },
      { label: "Tom Sawyer (Rush)", text: tomSawyer },
    ],
  },
  {
    group: "Lute",
    items: [{ label: "Se io m'accorgo (anon., 16th c.)", text: anonSeIo }],
  },
];
