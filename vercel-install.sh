#!/usr/bin/env bash
# Vercel install: reconstruct the tab-edit WORKSPACE — the repos are
# independent siblings by contract (file:../ deps), so the cloud build
# recreates that exact layout instead of denormalizing copies anywhere.
# Requires a Vercel env var GITHUB_TOKEN: fine-grained PAT, read-only
# Contents on tab-edit/{parse,ast,plugins}.
set -euo pipefail
: "${GITHUB_TOKEN:?set GITHUB_TOKEN in Vercel project env (read-only PAT for tab-edit/parse, tab-edit/ast, tab-edit/plugins)}"
base="https://x-access-token:${GITHUB_TOKEN}@github.com/tab-edit"

for r in parse ast plugins; do
  rm -rf "../$r"
  git clone --quiet --depth 1 --branch main "$base/$r.git" "../$r"
done

# Same chain refresh-deps.sh does locally: build producers in dependency
# order (parse's prepare hook builds its dist during install).
(cd ../parse && npm install --no-audit --no-fund)
(cd ../ast && npm install --no-audit --no-fund && npm run build)
(cd ../plugins && npm install --no-audit --no-fund && npm run build)
npm install --no-audit --no-fund
