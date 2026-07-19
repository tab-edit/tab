// THE BUNDLE AUDIT (ADR-003 / the trade-secret posture, mechanically
// enforced): the /client entry must bundle WITHOUT the engine. esbuild
// stamps every included source file's path as a comment, so package
// presence/absence in the output is literal, not inferred.
import { buildSync } from "esbuild";
import * as path from "node:path";

test("@tab-edit/cm/client bundles with the grammar + protocol and WITHOUT the engine", () => {
  const out = buildSync({
    entryPoints: [path.resolve(__dirname, "..", "src", "client.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  // Ships: compiled grammar tables, wire contract, the client machinery.
  expect(code).toContain("@tab-edit/parse");
  expect(code).toContain("@tab-edit/protocol");
  expect(code).toContain("RemoteClient");
  // Never ships: the engine, in any form.
  for (const marker of [
    "@tab-edit/ast",
    "@tab-edit/plugins",
    "PropRegistry",
    "TabParser",
    "StateLayer",
    "documentXml",
    "semparse",
  ]) {
    expect(code).not.toContain(marker);
  }
});
