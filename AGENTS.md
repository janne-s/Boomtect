# Agents

To make a sound from a request in words, follow `.claude/skills/boomtect-sound/SKILL.md`: start from the nearest scene in `examples/`, render it with `node tools/render.mjs <scene.json> <folder>` (Node 20 or later, no installed packages), and check it by the measurements the command prints. README.md, section "Writing a scene", maps changes to what they do to the sound.

The same rendering is an MCP server, `node src/shared/mcp/server.mjs`, that also serves the app for links to the rendered scene; in Claude Code, `claude mcp add tect -- node "$PWD/src/shared/mcp/server.mjs"`.

To change the code, run `npm test`. The shared parts in `src/shared/` are a synced copy of tect-shared; they are not edited here.
