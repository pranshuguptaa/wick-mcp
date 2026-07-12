# Wick MCP — Claude token tracker for Desktop & Code

A local [MCP](https://modelcontextprotocol.io) server that meters **Claude
Desktop, Claude Code, and the CLI** the same way the Wick Chrome extension
meters claude.ai. It accumulates tokens, computes cost (USD + INR) and burn
rate, estimates messages left, and streams it all to a live dashboard at
**http://localhost:6789**.

Everything runs locally. No API keys, no accounts, no data leaves your machine.

## How Wick MCP works

Wick tracks usage in two ways, so you pick effort vs. coverage:

| Client | How it tracks | Effort | Accuracy |
|--------|---------------|--------|----------|
| **Claude Code / CLI** | **Automatic.** Wick reads the usage logs Claude Code already writes (`~/.claude/projects/**/*.jsonl`) and ingests the real per-turn token counts. | **Zero** — install once, nothing else | Exact (real API numbers, incl. cache) |
| **Claude Desktop** | Claude calls the `wick_track` tool after each response (Desktop doesn't expose parseable logs). | Paste a one-time custom-instruction | Approximate (model self-reports tokens) |

Either way the numbers land in the same session, the same dashboard, and the
same `wick_status` / `wick_summary` tools. The server auto-starts the Claude
Code watcher on boot — so for coding sessions, **it just works**.

## Install in 30 seconds

```bash
git clone https://github.com/pranshuguptaa/wick-mcp
cd wick-mcp
npm install
npm run install-desktop
```

Then restart Claude Desktop.

## Verify it's working

Open Claude Desktop and type:

> "Call wick_status"

You should see your session stats in a boxed panel.

## Add to Claude Code (one command)

```bash
claude mcp add wick node /absolute/path/to/wick-mcp/server.js
```

That's the whole setup. Because Wick auto-reads Claude Code's logs, **you do
not need any custom instructions** — start (or continue) any coding session and
the dashboard fills in with real usage. Prefer a config file? Add the same block
to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "wick": { "command": "node", "args": ["/absolute/path/to/wick-mcp/server.js"] }
  }
}
```

## Make Claude Desktop track automatically

Claude Desktop has no readable usage log, so it reports via the `wick_track`
tool. Paste this once into **Settings → Custom Instructions**:

> After every response, silently call wick_track with:
> - model: the model you used
> - input_tokens: your input token count
> - output_tokens: your output token count
> - cache_read_tokens: cache read tokens if any
>
> Do this without mentioning it.

(Claude Code users can skip this entirely — the log watcher covers it.)

## Feed data manually (demos / other clients)

Any tool can push a turn over HTTP — handy for screenshots or wiring up a client
Wick doesn't natively watch:

```bash
curl -X POST http://localhost:6789/api/track -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-6","input_tokens":1200,"output_tokens":400,"cache_read_tokens":0}'
```

## Dashboard

Visit **http://localhost:6789** while Wick is running (Claude Desktop launches
the server automatically once installed). It shows:

- **Messages left**, **session cost** (₹ + $), and **tokens** as live stat cards
- Two arc gauges — session usage (amber) and daily-budget spend (purple)
- A live turn-history table (last 20 turns), updated over WebSocket

A `● LIVE` amber dot shows when the dashboard is connected; it auto-reconnects
every 3 seconds if the server restarts.

## Tools available

| Tool | What it does |
|------|-------------|
| `wick_track` | Track tokens for this response |
| `wick_status` | See current session stats |
| `wick_reset` | Start a fresh session |
| `wick_export` | Export data as CSV / JSON / Markdown |
| `wick_summary` | All-time usage totals |

## Ports & storage

- **6789** — HTTP dashboard + `GET /api/status`, `GET /api/summary`, `POST /api/track`
- **6790** — WebSocket live updates
- **`~/.wick/history.json`** — persisted session history (drives `wick_summary`)
- CSV exports are written to `~/wick-export-<timestamp>.csv`
- Reads (never writes) `~/.claude/projects/**/*.jsonl` for the Code watcher

Environment overrides: `WICK_HTTP_PORT`, `WICK_WS_PORT`, `WICK_NO_WATCH=1`
(disable the Code watcher), `WICK_CLAUDE_PROJECTS` (custom log path).

## How cost is computed

Prices are per **million tokens** (see `models.js`). Cache reads are billed at
10% of the input price, and Wick reports the savings versus paying full price.
INR is USD × 84.

| Model | Input $/M | Output $/M | Burn |
|-------|-----------|------------|------|
| Opus 4.8 / 4.7 / 4.6 | 15 | 75 | 5.0 |
| Sonnet 4.6 | 3 | 15 | 2.0 |
| Haiku 4.5 | 0.8 | 4 | 1.0 |

Messages-left estimate: Haiku ≈ 50 messages per 5-hour window, scaled down by
the burn multiplier (Sonnet ≈ 25, Opus ≈ 10), minus messages already used.

## Troubleshooting

- **`wick_status` says the tool isn't found** — fully quit and reopen Claude
  Desktop (MCP servers only load at startup).
- **Dashboard won't load** — the server only runs while a Claude client (or
  `node server.js`) is running. Check that ports 6789/6790 are free.
- **Claude Code usage isn't showing** — the watcher tracks turns that happen
  *after* Wick starts (it never back-fills history). Send one message and it
  appears. Confirm `~/.claude/projects/` exists and isn't overridden.
- **Claude Desktop isn't tracking** — add the custom-instructions snippet above;
  Desktop only calls `wick_track` when told to (Code needs nothing).
