#!/bin/sh
# Build one self-contained executable: dist/benchforge (runs without Node on the target).
# It is a copy of the Node binary that runs this script plus the bundled program, so it only runs on the
# same OS and CPU as the machine that builds it. Build on Linux x86_64 for a Linux x86_64 target.
# Needs Node 25.5+ (node --build-sea) and `npm install` done once.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build dist
./node_modules/.bin/esbuild src/cli.ts --bundle --platform=node --format=cjs --target=node22 --define:import.meta.url='"file:///unused"' --outfile=build/benchforge.cjs --log-level=warning
cat > build/sea-config.json <<JSON
{
  "main": "build/benchforge.cjs",
  "output": "dist/benchforge",
  "disableExperimentalSEAWarning": true,
  "assets": { "schema/model.schema.json": "schema/model.schema.json", "src/web/index.html": "src/web/index.html" }
}
JSON
rm -f dist/benchforge
node --build-sea build/sea-config.json
if [ "$(uname -s)" = Darwin ]; then codesign --sign - --force dist/benchforge >/dev/null 2>&1 || true; fi
echo "built dist/benchforge ($(du -h dist/benchforge | cut -f1))"
