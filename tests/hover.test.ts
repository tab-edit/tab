// HOVER EXPLANATIONS — the copy-selection logic, and the invariant the whole
// feature rests on: the parse tree is a hypothesis, the prop layer is truth.
//
// The pure halves (`instantCopy`, `refinedDetail`) are driven with
// constructed facts/frames — including shapes real data is unlikely to
// produce (a truncated value, a dangling connector end) — and the live half
// (`instantAt` + a real inspection frame) is driven against real CM
// machinery, because the case that matters most (an unresolved glyph is
// still a CHILD of its Sound) is only observable there.

import { EditorState } from "@codemirror/state";
import { tablature } from "../src/index.js";
import {
  instantAt,
  instantCopy,
  pitchName,
  refinedDetail,
  voiceLabel,
  worthRefining,
  type InstantFacts,
} from "../src/hover.js";
import { snapshotOf } from "../src/snapshot-model.js";
import { configureTabHost, localInspectionFrame } from "../src/state-layer.js";
import { forceParsed } from "./force-parse.js";

const facts = (over: Partial<InstantFacts> = {}): InstantFacts => ({
  written: null,
  playing: false,
  withOthers: 0,
  diagnostics: [],
  receded: false,
  ...over,
});

const ERROR = {
  from: 4,
  to: 5,
  severity: "error" as const,
  code: "unresolved-glyph",
  message: 'nothing gives "q" a musical meaning here',
};

// ─── Tier 1: what the synchronous half is allowed to say ─────────────────

describe("instantCopy — silence is the default", () => {
  test("nothing known at the position says nothing", () => {
    expect(instantCopy(facts())).toBeNull();
  });

  test("a dash is not even named: lattice has no entry in the vocabulary", () => {
    expect(instantCopy(facts({ written: "Divider" }))).toBeNull();
    expect(instantCopy(facts({ written: "Multiplier" }))).toBeNull();
    expect(instantCopy(facts({ written: "TimeSignature" }))).toBeNull();
  });

  test("prose and comment lines stay silent even where something resolved", () => {
    expect(instantCopy(facts({ receded: true, playing: true, written: "Fret" }))).toBeNull();
    expect(instantCopy(facts({ receded: true, diagnostics: [ERROR] }))).toBeNull();
  });

  test("a named glyph with NO semantic outcome says nothing — naming is never a claim", () => {
    expect(instantCopy(facts({ written: "Hammer" }))).toBeNull();
    expect(instantCopy(facts({ written: "Fret" }))).toBeNull();
  });
});

describe("instantCopy — the affirmative half", () => {
  test("inside a sound: it plays", () => {
    expect(instantCopy(facts({ written: "Fret", playing: true }))).toEqual({
      kind: "written as a fret number",
      lead: "this plays",
      problems: [],
      detail: null,
    });
  });

  test("a chord counts its companions, and pluralizes", () => {
    expect(instantCopy(facts({ playing: true, withOthers: 2 }))?.lead).toBe(
      "this plays · struck with 2 other notes"
    );
    expect(instantCopy(facts({ playing: true, withOthers: 1 }))?.lead).toBe(
      "this plays · struck with 1 other note"
    );
  });
});

describe("instantCopy — the engine's negative is authoritative", () => {
  test("a diagnostic suppresses every affirmative reading", () => {
    const copy = instantCopy(facts({ written: "Hammer", playing: true, diagnostics: [ERROR] }));
    expect(copy?.lead).toBeNull();
    expect(copy?.problems).toEqual([ERROR]);
  });

  test("THE TEACHING CASE: what it was written as, over what it actually did", () => {
    const copy = instantCopy(facts({ written: "Hammer", diagnostics: [ERROR] }));
    expect(copy?.kind).toBe("written as a hammer-on");
    expect(copy?.problems[0].message).toBe(ERROR.message);
    // …and never a behavioural claim of its own.
    expect(copy?.lead).toBeNull();
    expect(copy?.detail).toBeNull();
  });
});

describe("worthRefining — which silences are worth one ask", () => {
  test("only constructs whose outcome a prop can report", () => {
    expect(worthRefining("Hammer")).toBe(true);
    expect(worthRefining("Fret")).toBe(true);
    expect(worthRefining("Divider")).toBe(false);
    expect(worthRefining("Comment")).toBe(false);
    expect(worthRefining(null)).toBe(false);
  });
});

// ─── Tier 2: reading the frame ───────────────────────────────────────────

const prop = (id: string, value: unknown, over: Record<string, unknown> = {}) => ({
  id,
  evaluated: true,
  internal: false,
  value,
  ...over,
});

const frameOf = (nodeName: string, props: unknown[], extra: unknown[] = []) =>
  ({
    chain: [
      { nodeName, props },
      { nodeName: "TabBlock", props: [prop("core-instrument/lineNames", ["e", "B", "G"]), ...extra] },
    ],
  }) as never;

describe("refinedDetail — notes", () => {
  test("a fretted note names the fret, the string, and the pitch", () => {
    const frame = frameOf("FretNote", [
      prop("core-pitch/noteSound", { kind: "pitched", midi: 43, course: 0, fret: 3 }),
    ]);
    expect(refinedDetail(frame)).toBe("fret 3 on the e string · sounds G2");
  });

  test("a note with no course keeps quiet about the string", () => {
    const frame = frameOf("FretNote", [
      prop("core-pitch/noteSound", { kind: "pitched", midi: 60, fret: 5 }),
    ]);
    expect(refinedDetail(frame)).toBe("fret 5 · sounds C4");
  });

  test("techniques that ACTUALLY applied are appended", () => {
    const frame = frameOf("GhostNote", [
      prop("core-pitch/noteSound", { kind: "pitched", midi: 36, course: 2, fret: 5 }),
      prop("core-articulation/noteTechniques", [
        { kind: "ghost", class: "state" },
        { kind: "hammer", class: "transition", role: "start" },
      ]),
    ]);
    expect(refinedDetail(frame)).toBe(
      "fret 5 on the G string · sounds C2 · ghost note — played quietly · hammers on to the next note"
    );
  });

  test("a dead note is precise about what it is NOT", () => {
    const frame = frameOf("GlyphNote", [
      prop("core-pitch/noteSound", { kind: "dead", midi: 47, course: 1 }),
    ]);
    expect(refinedDetail(frame)).toBe("a dead note on the B string — struck and damped, no pitch");
  });

  test("a percussion voice is named, not spelled", () => {
    const frame = frameOf("GlyphNote", [
      prop("core-pitch/noteSound", { kind: "percussion", voiceId: "hihat-closed", midi: 42 }),
    ]);
    expect(refinedDetail(frame)).toBe("hi-hat closed");
  });

  test("an unpitched glyph gets the negative, asked directly", () => {
    const frame = frameOf("GlyphNote", [
      prop("core-pitch/noteSound", { kind: "unpitched", glyph: "o" }),
    ]);
    expect(refinedDetail(frame)).toMatch(/nothing gives this a musical meaning/);
  });

  test("…but NEVER twice: the engine's own diagnostic is already in the box", () => {
    const frame = frameOf("GlyphNote", [
      prop("core-pitch/noteSound", { kind: "unpitched", glyph: "q" }),
    ]);
    expect(refinedDetail(frame, true)).toBeNull();
  });
});

describe("refinedDetail — connectors read the BINDING, never noteSound", () => {
  test("a resolved hammer says what it does", () => {
    const frame = {
      chain: [
        // The trap this routing exists for: noteSound answers "unpitched" on
        // a connector by construction, which would read as "this means
        // nothing" over a hammer-on that resolved perfectly.
        { nodeName: "Hammer", props: [prop("core-pitch/noteSound", { kind: "unpitched", glyph: "h" })] },
        {
          nodeName: "ConnectorGroup",
          props: [
            prop("core-geometry/connectorBinding", [
              { kind: "hammer", class: "transition", source: { sound: 0, note: 1 }, target: { sound: 2, note: 0 } },
            ]),
          ],
        },
      ],
    } as never;
    expect(refinedDetail(frame)).toBe(
      "hammer-on — the note it lands on sounds without a new pick"
    );
  });

  test("a dangling end states the gap and claims nothing else", () => {
    const frame = {
      chain: [
        { nodeName: "Slide", props: [] },
        {
          nodeName: "ConnectorGroup",
          props: [
            prop("core-geometry/connectorBinding", [
              { kind: "slide", class: "transition", source: { sound: 0, note: 0 } },
            ]),
          ],
        },
      ],
    } as never;
    expect(refinedDetail(frame)).toBe("slide — nothing on the other end of it");
  });

  test("no binding at all → nothing (the percussion refusal)", () => {
    const frame = {
      chain: [
        { nodeName: "Hammer", props: [prop("core-pitch/noteSound", { kind: "unpitched", glyph: "H" })] },
        { nodeName: "ConnectorGroup", props: [prop("core-geometry/connectorBinding", [])] },
      ],
    } as never;
    expect(refinedDetail(frame)).toBeNull();
  });
});

describe("refinedDetail — a value that is not a faithful projection is not data", () => {
  test("truncated, unevaluated, internal or errored props yield nothing", () => {
    for (const over of [
      { valueTruncated: true, value: '{"kind":"pitc' },
      { evaluated: false, value: undefined },
      { internal: true, value: undefined },
      { error: "boom" },
    ]) {
      const frame = frameOf("FretNote", [
        prop("core-pitch/noteSound", { kind: "pitched", midi: 43, course: 0, fret: 3 }, over),
      ]);
      expect(refinedDetail(frame)).toBeNull();
    }
  });

  test("a node family with no reading stays silent", () => {
    expect(refinedDetail(frameOf("Measure", []))).toBeNull();
    expect(refinedDetail({ chain: [] } as never)).toBeNull();
  });
});

describe("small pure helpers", () => {
  test("pitch names are scientific (60 = C4)", () => {
    expect(pitchName(60)).toBe("C4");
    expect(pitchName(43)).toBe("G2");
    expect(pitchName(61)).toBe("C♯4");
  });

  test("voice ids become words", () => {
    expect(voiceLabel("hihat-open")).toBe("hi-hat open");
    expect(voiceLabel("tom-floor")).toBe("tom floor");
    expect(voiceLabel("kick")).toBe("kick");
  });
});

// ─── The live invariant ──────────────────────────────────────────────────

const DOC = [
  "Tempo: 96",
  "",
  "e|---3-------q---|",
  "B|---0h3/5---x---|",
  "G|---(5)-----0---|",
  "",
  "just some prose about the tune",
  "",
].join("\n");

describe("instantAt — against real CM machinery", () => {
  const state = (() => {
    configureTabHost({});
    return forceParsed(EditorState.create({ doc: DOC, extensions: [tablature()] }));
  })();
  const at = (needle: string, offset = 0) => DOC.indexOf(needle) + offset;

  test("THE INVARIANT: an unresolved glyph is a child of its Sound, and must NOT read as playing", () => {
    const pos = at("---q---", 3);
    // PROVE THE TRAP IS REAL first: the snapshot's sound map really does
    // cover this glyph, so a hover keyed on membership alone would confirm
    // the exact case the feature exists to catch.
    const snap = snapshotOf(state)!;
    expect(
      snap.sounds.some((s) => s.ranges.some((r) => r.from <= pos && pos < r.to))
    ).toBe(true);
    const copy = instantAt(state, pos)!;
    expect(copy.lead).toBeNull();
    expect(copy.problems).toHaveLength(1);
    expect(copy.problems[0].code).toBe("unresolved-glyph");
    expect(copy.problems[0].message).toMatch(/dropped from playback and every export/);
    expect(copy.kind).toBe("written as a note glyph");
  });

  test("a real fret reads as playing, and counts only its UNDIAGNOSED companions", () => {
    const copy = instantAt(state, at("---3---", 3))!;
    expect(copy.lead).toMatch(/^this plays/);
    expect(copy.kind).toBe("written as a fret number");
  });

  test("the fret sharing a column with the junk glyph does not count it", () => {
    // e|--q  B|--x  G|--0 — three in the column, one of them unresolved.
    const copy = instantAt(state, at("---x---", 3))!;
    expect(copy.lead).toBe("this plays · struck with 1 other note");
  });

  test("a dash says nothing; so does a barline; so does prose", () => {
    expect(instantAt(state, at("e|---3") + 3)).toBeNull();
    expect(instantAt(state, at("e|---3") + 1)).toBeNull();
    expect(instantAt(state, at("just some prose") + 5)).toBeNull();
  });

  test("a connector has no Tier-1 answer at all — it is a Tier-2-only position", () => {
    expect(instantAt(state, at("0h3/5", 1))).toBeNull();
  });
});

describe("Tier 2 over a real frame", () => {
  const state = (() => {
    configureTabHost({});
    return forceParsed(EditorState.create({ doc: DOC, extensions: [tablature()] }));
  })();
  const detailAt = (pos: number) => refinedDetail(localInspectionFrame(state, { pos })! as never);

  test("the hammer glyph explains the hammer-on", () => {
    expect(detailAt(DOC.indexOf("0h3/5") + 1)).toBe(
      "hammer-on — the note it lands on sounds without a new pick"
    );
  });

  test("the slide glyph explains the slide", () => {
    expect(detailAt(DOC.indexOf("0h3/5") + 3)).toBe(
      "slide — the finger stays down and slides to the next note"
    );
  });

  test("a fret widens into fret · string · pitch", () => {
    expect(detailAt(DOC.indexOf("---3---") + 3)).toMatch(/^fret 3 on the e string · sounds /);
  });

  test("a parenthesised note is a ghost note", () => {
    expect(detailAt(DOC.indexOf("(5)") + 1)).toMatch(/ghost note — played quietly/);
  });

  test("a dash refines to nothing", () => {
    expect(detailAt(DOC.indexOf("e|---3") + 3)).toBeNull();
  });
});
