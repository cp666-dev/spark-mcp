#!/bin/bash
# Start the MCP server on stdio with Node 22 or later, looked up at every start so a Node upgrade
# never breaks an agent's config: the one on PATH, else the newest nvm one, else Homebrew's.
# Nothing may be printed to stdout here: it carries the MCP protocol.
cd "$(dirname "$0")"
for n in "$(command -v node || true)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV) /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$n" ] && [ "$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; then
    exec "$n" index.mjs "$@"
  fi
done
echo "spark-mcp: Node 22 or later not found" >&2
exit 1
