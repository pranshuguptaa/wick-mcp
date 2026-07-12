#!/usr/bin/env node
/**
 * Wick MCP — local MCP server for live Claude token tracking.
 *
 * ⚠ MCP speaks JSON-RPC over STDOUT. Nothing may be written to stdout except
 * the protocol itself. ALL logging uses console.error() (stderr).
 *
 * On startup it also runs:
 *   - an Express dashboard on http://localhost:6789
 *   - a WebSocket server on ws://localhost:6790 for live push updates
 */

// Subcommand routing (runs before the server boots):
//   npx wick-mcp install → run the Claude Desktop installer, then exit
//   npx wick-mcp         → start the MCP server (default path, below)
// Static imports below are hoisted and evaluated first, but they have no
// side effects; the server itself only starts in main() at the bottom.
if (process.argv[2] === 'install') {
  const { default: runInstaller } = await import('./install.js');
  await runInstaller();
  process.exit(0);
}

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { WickTracker, fmtInt, fmtUSD, fmtINR } from './tracker.js';
import { resolveModel } from './models.js';
import { startCodeWatcher } from './codewatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const HTTP_PORT = Number(process.env.WICK_HTTP_PORT) || 6789;
const WS_PORT = Number(process.env.WICK_WS_PORT) || 6790;

const tracker = new WickTracker();

// ---------------------------------------------------------------------------
// WebSocket — live push to the dashboard
// ---------------------------------------------------------------------------
let wss;
function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (_e) {}
    }
  }
}

tracker.on('update', (status) => broadcast({ type: 'update', data: status }));
tracker.on('reset', (status) => broadcast({ type: 'reset', data: status }));

// ---------------------------------------------------------------------------
// Box-drawing helpers for the status / summary tool output
// ---------------------------------------------------------------------------
const BOX_W = 39; // inner content width

function boxTop(title) {
  const prefix = `══ ${title} `;
  const fill = Math.max(0, BOX_W + 2 - prefix.length);
  return '╔' + prefix + '═'.repeat(fill) + '╗';
}
const boxBottom = () => '╚' + '═'.repeat(BOX_W + 2) + '╝';
const boxLine = (s = '') => '║ ' + String(s).padEnd(BOX_W) + ' ║';
const kv = (label, value) => `${String(label).padEnd(11)}${value}`;

function renderStatusBox() {
  const s = tracker.getStatus();
  const d = s.display;
  return [
    boxTop('Wick — Session Status'),
    boxLine(),
    boxLine(kv('Model', s.modelLabel)),
    boxLine(kv('Turns', d.turnCount)),
    boxLine(),
    boxLine('TOKENS'),
    boxLine(kv('Input', d.inputTokens)),
    boxLine(kv('Output', d.outputTokens)),
    boxLine(kv('Cache hit', d.cacheReadTokens)),
    boxLine(),
    boxLine('COST'),
    boxLine(kv('USD', `$${d.totalCostUSD}`)),
    boxLine(kv('INR', `₹${d.totalCostINR}`)),
    boxLine(kv('Saved', `$${d.cacheSavings} (cache)`)),
    boxLine(),
    boxLine('ESTIMATES'),
    boxLine(kv('Msgs left', `≈${d.messagesLeft}`)),
    boxLine(kv('Avg/turn', `${d.avgTokensPerTurn} tokens`)),
    boxLine(kv('Burn rate', `${d.burnRatePerMin}/min`)),
    boxLine(),
    boxLine('Dashboard → http://localhost:6789'),
    boxBottom(),
  ].join('\n');
}

function renderSummaryBox() {
  const sum = tracker.getSummary();
  return [
    boxTop('Wick — All Time'),
    boxLine(),
    boxLine(kv('Sessions', sum.sessionCount)),
    boxLine(kv('Total turns', sum.totalTurns)),
    boxLine(kv('Total tok', fmtInt(sum.totalTokens))),
    boxLine(),
    boxLine('COST ALL TIME'),
    boxLine(kv('USD', `$${fmtUSD(sum.totalCostUSD)}`)),
    boxLine(kv('INR', `₹${fmtINR(sum.totalCostINR)}`)),
    boxLine(),
    boxLine(kv('Most used', sum.mostUsedModel)),
    boxLine(kv('Avg/sess', `${fmtInt(sum.avgTokensPerSession)} tok`)),
    boxBottom(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'wick_track',
    description:
      'Track token usage for this response. Call this after EVERY Claude response ' +
      'automatically. Wick uses this to compute your live burn rate, session cost, ' +
      'and estimated messages remaining.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID e.g. claude-sonnet-4-6' },
        input_tokens: { type: 'number', description: 'Input tokens used this turn' },
        output_tokens: { type: 'number', description: 'Output tokens generated this turn' },
        cache_read_tokens: { type: 'number', description: 'Cache read tokens', default: 0 },
        cache_creation_tokens: { type: 'number', description: 'Cache creation tokens', default: 0 },
      },
      required: ['model', 'input_tokens', 'output_tokens'],
    },
  },
  {
    name: 'wick_status',
    description:
      'Get your current Claude session stats — tokens used, cost in USD and INR, ' +
      'burn rate, and messages left estimate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wick_reset',
    description:
      'Reset the session counter. Use when starting a new task or after a rate limit reset.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wick_export',
    description: 'Export your session data as JSON, CSV, or a Markdown table.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'csv', 'markdown'], default: 'markdown' },
      },
    },
  },
  {
    name: 'wick_summary',
    description: 'All-time usage summary across every Wick session.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const mcp = new Server(
  { name: 'wick-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const asText = (text) => ({ content: [{ type: 'text', text }] });

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'wick_track': {
        const result = tracker.track({
          model: args.model,
          inputTokens: args.input_tokens,
          outputTokens: args.output_tokens,
          cacheReadTokens: args.cache_read_tokens || 0,
          cacheCreationTokens: args.cache_creation_tokens || 0,
        });
        return asText(result);
      }

      case 'wick_status':
        return asText(renderStatusBox());

      case 'wick_reset':
        tracker.reset();
        return asText('✓ Session reset · Wick is watching fresh');

      case 'wick_export': {
        const format = args.format || 'markdown';
        const data = tracker.export(format);
        if (format === 'csv') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = path.join(os.homedir(), `wick-export-${stamp}.csv`);
          fs.writeFileSync(file, data);
          return asText(`✓ Exported to ~/wick-export-${stamp}.csv`);
        }
        const fence = format === 'json' ? 'json' : '';
        return asText('```' + fence + '\n' + data + '\n```');
      }

      case 'wick_summary':
        return asText(renderSummaryBox());

      default:
        return asText(`Unknown tool: ${name}`);
    }
  } catch (err) {
    console.error(chalk.red('[wick] tool error:'), err);
    return asText(`✗ Wick error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP dashboard + WebSocket
// ---------------------------------------------------------------------------
function startWebServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(DASHBOARD_DIR));
  app.get('/api/status', (_req, res) => res.json(tracker.getStatus()));
  app.get('/api/summary', (_req, res) => res.json(tracker.getSummary()));
  // Ingest a turn over HTTP (used by the Claude Code watcher, and handy for
  // demos/tests without needing a Claude client to call the tool).
  app.post('/api/track', (req, res) => {
    const b = req.body || {};
    tracker.track({
      model: b.model,
      inputTokens: b.input_tokens ?? b.inputTokens,
      outputTokens: b.output_tokens ?? b.outputTokens,
      cacheReadTokens: b.cache_read_tokens ?? b.cacheReadTokens ?? 0,
      cacheCreationTokens: b.cache_creation_tokens ?? b.cacheCreationTokens ?? 0,
    });
    res.json(tracker.getStatus());
  });
  app.listen(HTTP_PORT, () => {
    console.error(chalk.hex('#E8793C')(`  dashboard  → http://localhost:${HTTP_PORT}`));
  });

  wss = new WebSocketServer({ port: WS_PORT });
  wss.on('connection', (ws) => {
    // send current state immediately on connect
    try { ws.send(JSON.stringify({ type: 'update', data: tracker.getStatus() })); } catch (_e) {}
  });
  wss.on('error', (e) => console.error(chalk.red('[wick] ws error:'), e.message));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  startWebServer();

  // Auto-track Claude Code usage by reading its logs — no custom instructions,
  // no tool calls, accurate real token counts. Disable with WICK_NO_WATCH=1.
  if (!process.env.WICK_NO_WATCH) {
    startCodeWatcher(
      (turn) => tracker.track(turn),
      (msg) => console.error(chalk.gray('  ' + msg))
    );
  }

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(chalk.hex('#E8793C').bold('🕯 Wick MCP running') + chalk.gray(` · dashboard → http://localhost:${HTTP_PORT}`));
}

main().catch((e) => {
  console.error(chalk.red('[wick] fatal:'), e);
  process.exit(1);
});
