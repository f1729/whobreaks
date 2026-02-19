# whobreaks

> Find out what breaks before you touch a file.

**whobreaks** builds a real-time dependency graph of your codebase and tells you the blast radius of any change — before you make it. Works as a CLI, HTTP API, and MCP server for AI coding tools.

```
# Without whobreaks:
AI edits UserService.ts → breaks 14 files → you spend 2 hours fixing

# With whobreaks:
AI queries whobreaks first → knows 14 files depend on UserService → makes safe changes
```

---

## Quick start

```bash
npx whobreaks .
```

```
  ╭──────────────────────────────────────╮
  │  💥 whobreaks v0.1.0                 │
  │  Scanning your codebase...           │
  ╰──────────────────────────────────────╯

  📁 Found 247 files
  ⏱️  Analyzed in 1.2s

  ┌─ Summary ──────────────────────────────┐
  │                                        │
  │  Files:              247               │
  │  Edges:            1,847               │
  │  Avg depth:          4.2               │
  │  Max depth:           11               │
  │                                        │
  └────────────────────────────────────────┘

  ⚠️  Issues Found:

  🔄 Circular Dependencies (3)
     src/services/auth.ts ↔ src/services/user.ts
     src/models/order.ts → src/models/product.ts → src/models/order.ts

  🏝️  Orphan Files — imported by nothing (12)
     src/utils/old-helpers.ts
     src/components/DeprecatedButton.tsx

  🕸️  God Modules — imported by 20+ files (2)
     src/utils/helpers.ts        → 89 dependents
     src/lib/api-client.ts       → 47 dependents

  💣 High-Impact Files — editing these affects the most files
     src/types/index.ts          → 142 files affected
     src/utils/helpers.ts        → 89 files affected

  📁 Output: .whobreaks/graph.json
```

---

## MCP setup

whobreaks runs as an MCP server so AI tools (Claude Code, Cursor, Windsurf) can query it before editing files. Set it up once; the AI uses it automatically.

### Claude Code

```bash
claude mcp add whobreaks npx whobreaks mcp
```

That's it. Verify:

```bash
claude mcp list
# whobreaks: npx whobreaks mcp
```

### Cursor

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "whobreaks": {
      "command": "npx",
      "args": ["whobreaks", "mcp"]
    }
  }
}
```

### VS Code (Copilot / GitHub Copilot Chat)

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "whobreaks": {
      "type": "stdio",
      "command": "npx",
      "args": ["whobreaks", "mcp"]
    }
  }
}
```

### Windsurf

Create `.windsurf/mcp_config.json` in your project root:

```json
{
  "mcpServers": {
    "whobreaks": {
      "command": "npx",
      "args": ["whobreaks", "mcp"]
    }
  }
}
```

---

### Tell the AI to use it (CLAUDE.md / .cursorrules)

Drop this in your `CLAUDE.md` or `.cursorrules`:

```markdown
## Architectural awareness

This project has whobreaks running as an MCP server.

Before editing any file, call:
- `get_impact` — see how many files depend on it and which exports are critical
- `get_context` — understand what it imports/exports and its risk level

Before creating a new file or moving an export, call:
- `find_related` — check if similar functionality already exists

Files with 20+ dependents are god modules — treat export changes as breaking changes.
Files in circular dependencies require extra care — changes propagate in both directions.
```

---

### Available MCP tools

| Tool | When to use |
|------|-------------|
| `get_impact` | Before editing any file — see direct + transitive dependents and critical exports |
| `get_context` | Before editing — full picture: imports, exports, risk level, line count |
| `find_related` | Before creating something new — check if it already exists |

```
get_impact("src/services/user.ts")
→ Editing this file will affect 14 files:
  Direct dependents (3): auth.ts, dashboard.ts, settings.ts
  Transitive (11): app.tsx, router.ts, ... +9 more
  High-usage exports: getUserById, UserSchema

get_context("src/services/user.ts")
→ ## src/services/user.ts
  Imports from (2): db/client.ts, utils/crypto.ts
  Imported by (3): auth.ts, dashboard.ts, settings.ts
  Exports: getUserById (function), UserSchema (type), updateUser (function)
  Risk level: MEDIUM (3 dependents)
  Lines: 187
```

---

## Watch mode + live dashboard

```bash
npx whobreaks watch . --port 3001
```

Starts a file watcher and HTTP server. Open `http://localhost:3001` for the interactive dependency graph dashboard.

The dashboard auto-reloads when files change. Every node is sized by dependent count, colored by risk, and clickable for a full impact analysis panel.

---

## HTTP API

Available when running `whobreaks watch` or `whobreaks . --port <n>`.

| Endpoint | Description |
|----------|-------------|
| `GET /` | Interactive dashboard |
| `GET /health` | Status, file count, edge count, last update |
| `GET /graph` | Full dependency graph (JSON) |
| `GET /summary` | Architecture summary (circulars, orphans, god modules) |
| `GET /impact?file=src/foo.ts` | Impact analysis — what breaks if this changes |
| `GET /dependents?file=src/foo.ts` | Files that import this file |
| `GET /dependencies?file=src/foo.ts` | Files this file imports |
| `GET /node?file=src/foo.ts` | Full node record with export list |

---

## Output files

Every scan writes to `.whobreaks/` in your project root:

| File | Contents |
|------|----------|
| `graph.json` | Full dependency graph, machine-readable |
| `summary.md` | Human-readable architecture overview |

Add `.whobreaks/` to `.gitignore` or commit `summary.md` as living documentation.

---

## Commands

```bash
npx whobreaks [path]              # One-shot scan (default: current directory)
npx whobreaks watch [path]        # Watch mode + HTTP API + dashboard
npx whobreaks mcp                 # MCP server (uses current directory)
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | 3001 | HTTP server port (watch mode) |
| `--max-files <n>` | unlimited | Cap files scanned (useful for huge monorepos) |
| `--help` | | Show help |

---

## How it works

```
┌─────────────────────────────────────────────────┐
│                  whobreaks                       │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Watcher  │→│ Analyzer  │→│  Graph Store  │  │
│  │(chokidar) │ │ (regex)   │ │ (in-memory)   │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│                                     │           │
│                          ┌──────────┴────┐      │
│                          │               │      │
│                    ┌─────▼──┐    ┌───────▼──┐   │
│                    │  CLI   │    │ MCP/HTTP  │   │
│                    │ Output │    │  Server   │   │
│                    └────────┘    └──────────┘   │
│                                                  │
│              ┌──────────────────┐                │
│              │  Web Dashboard   │                │
│              │ (D3 force graph) │                │
│              └──────────────────┘                │
└─────────────────────────────────────────────────┘
```

- **Watcher** — [chokidar](https://github.com/paulmillr/chokidar) watches `**/*.{ts,tsx,js,jsx}`, debounces rapid changes
- **Analyzer** — regex-based import/export extraction on raw source text. Strips comments, extracts `import`/`export` statements, resolves specifiers via `tsconfig.json` paths, workspace package names, and filesystem probing. No compiler overhead — scans 2,500 files in ~2.5s.
- **Graph Store** — in-memory `Map<string, FileNode>` with forward and reverse indexes. Incremental updates on file change.
- **MCP Server** — [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) exposes the graph to Claude Code, Cursor, Windsurf, and any MCP-compatible client.
- **Dashboard** — single HTML file, D3 force-directed graph, served by the built-in HTTP server. No build step.

---

## Compared to alternatives

| Tool | Weakness vs whobreaks |
|------|-----------------------|
| `code-graph-context` | Requires Docker + Neo4j + OpenAI key |
| `typescript-graph` | One-shot only, no watch mode, no AI integration |
| `madge` | Only detects circular deps, no impact analysis |
| `ts-codebase-analyzer` | Library only — no CLI, no watch, no MCP |

whobreaks: `npx whobreaks .` — no Docker, no API keys, no database. Zero config.

---

## Development

```bash
git clone https://github.com/f1729/whobreaks
cd whobreaks
npm install
npm run build
node dist/index.js .
```

```bash
npm run dev    # tsc --watch
```

---

## License

MIT
