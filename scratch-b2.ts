import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { tablature } from "./src/index.js";

const WIDE = "-".repeat(56);
const SECTION = [
  `e|--0--2--${WIDE}|`, `B|3--------${WIDE}|`, `G|---------${WIDE}|`,
  `D|---------${WIDE}|`, `A|---------${WIDE}|`, `E|---------${WIDE}|`,
].join("\n");
const DOC = `${SECTION}\n\n${SECTION}\n`;
const s1 = EditorState.create({ doc: DOC, extensions: [tablature()] });
ensureSyntaxTree(s1, DOC.length, 10000);
const editAt = DOC.length - 100;
const s2 = s1.update({ changes: { from: editAt, to: editAt + 1, insert: "7" } }).state;
ensureSyntaxTree(s2, s2.doc.length, 10000);
function segInner(state: EditorState): unknown[] {
  const out: unknown[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name === "TabSegment") {
        out.push((n.node as unknown as { tree: unknown }).tree);
        return false;
      }
    },
  });
  return out;
}
const a = segInner(s1), b = segInner(s2);
console.log("seg count:", a.length, b.length);
console.log("seg0 inner reused:", a[0] === b[0], "| seg1 inner reused:", a[1] === b[1]);
console.log("seg0 inner is Tree:", a[0] != null && typeof a[0] === "object");
