import { ArtifactCache, TabFragment, TabParser } from "@tab-edit/ast";
import { parser } from "@tab-edit/parse";

const WIDE = "-".repeat(56);
const SECTION = [
  `e|--0--2--${WIDE}|`, `B|3--------${WIDE}|`, `G|---------${WIDE}|`,
  `D|---------${WIDE}|`, `A|---------${WIDE}|`, `E|---------${WIDE}|`,
].join("\n");
const DOC = `${SECTION}\n\n${SECTION}\n`;
for (const [bl, mg] of [[32, 0], [32, undefined], [256, 0], [256, undefined], [1024, 0]] as const) {
  const tp = new TabParser({ baseParser: parser.configure({ bufferLength: bl }), cache: new ArtifactCache() });
  const t1 = tp.parse(DOC);
  const editAt = DOC.length - 100;
  const next = DOC.slice(0, editAt) + "7" + DOC.slice(editAt + 1);
  const frags = TabFragment.applyChanges(TabFragment.addTree(t1), [{ fromA: editAt, toA: editAt + 1, fromB: editAt, toB: editAt + 1 }], mg as number | undefined);
  const t2 = tp.parse(next, frags);
  const art = (t: any, i: number) => t.units.filter((u: any) => u.kind === "segment")[i].artifact;
  console.log(`bufferLength=${bl} minGap=${mg}: seg0 identity=${art(t1, 0) === art(t2, 0)}`);
}
