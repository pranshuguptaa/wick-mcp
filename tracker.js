/**
 * Wick MCP — token accumulation + session logic.
 *
 * WickTracker owns the current session and a persisted history of past
 * sessions (so wick_summary is meaningful across restarts). It emits:
 *   'update' → after each track(), with the full status object
 *   'reset'  → when the session is reset
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getCost,
  estimateMessagesLeft,
  sessionFraction,
  resolveModel,
  USD_TO_INR,
} from './models.js';

const ROLLING_WINDOW = 5; // rolling average over the last N turns
const STORE_DIR = path.join(os.homedir(), '.wick');
const STORE_FILE = path.join(STORE_DIR, 'history.json');

// ---- formatting helpers ----------------------------------------------------
export const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
export const fmtUSD = (n) => (Number(n) || 0).toFixed((Number(n) || 0) < 1 ? 4 : 2);
export const fmtINR = (n) => (Number(n) || 0).toFixed(2);

function newSession(model = 'claude-sonnet-4-6') {
  return {
    id: `sess_${Date.now().toString(36)}`,
    startTime: new Date(),
    model,
    turns: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUSD: 0,
      totalCostINR: 0,
      turnCount: 0,
    },
    estimates: {
      avgTokensPerTurn: 0,
      burnRatePerMin: 0,
      messagesLeft: null,
      sessionFraction: 0,
    },
  };
}

export class WickTracker extends EventEmitter {
  constructor() {
    super();
    /** @type {any[]} all sessions; the last element is the current one */
    this.sessions = [];
    this.load();
    if (this.sessions.length === 0) this.sessions.push(newSession());
  }

  get current() {
    return this.sessions[this.sessions.length - 1];
  }

  // ---- persistence ---------------------------------------------------------
  load() {
    try {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.sessions)) {
        this.sessions = data.sessions.map((s) => ({
          ...s,
          startTime: new Date(s.startTime),
          turns: (s.turns || []).map((t) => ({ ...t, timestamp: new Date(t.timestamp) })),
        }));
      }
    } catch (_e) {
      /* no history yet — fine */
    }
  }

  save() {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      fs.writeFileSync(STORE_FILE, JSON.stringify({ sessions: this.sessions }, null, 2));
    } catch (_e) {
      /* non-fatal; keep tracking in memory */
    }
  }

  // ---- core ----------------------------------------------------------------
  track(data = {}) {
    const s = this.current;
    const model = data.model || s.model || 'claude-sonnet-4-6';
    s.model = model;

    const inputTokens = Number(data.inputTokens ?? data.input_tokens) || 0;
    const outputTokens = Number(data.outputTokens ?? data.output_tokens) || 0;
    const cacheReadTokens = Number(data.cacheReadTokens ?? data.cache_read_tokens) || 0;
    const cacheCreationTokens =
      Number(data.cacheCreationTokens ?? data.cache_creation_tokens) || 0;

    const cost = getCost(model, inputTokens, outputTokens, cacheReadTokens);

    const turn = {
      timestamp: new Date(),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUSD: cost.totalCostUSD,
      costINR: cost.totalCostINR,
      cacheSavings: cost.cacheSavings,
      turnNumber: s.totals.turnCount + 1,
    };
    s.turns.push(turn);

    // recalc totals
    const t = s.totals;
    t.inputTokens += inputTokens;
    t.outputTokens += outputTokens;
    t.cacheReadTokens += cacheReadTokens;
    t.cacheCreationTokens += cacheCreationTokens;
    t.totalCostUSD += cost.totalCostUSD;
    t.totalCostINR += cost.totalCostINR;
    t.turnCount += 1;

    this.computeEstimates();
    this.save();

    const status = this.getStatus();
    this.emit('update', status);
    return this.formatTrackResult(turn, cost, status);
  }

  computeEstimates() {
    const s = this.current;
    const recent = s.turns.slice(-ROLLING_WINDOW);
    const recentTokens = recent.reduce(
      (a, x) => a + x.inputTokens + x.outputTokens,
      0
    );
    const avgTokensPerTurn = recent.length ? Math.round(recentTokens / recent.length) : 0;

    const totalTokens = s.totals.inputTokens + s.totals.outputTokens;
    const elapsedMin = Math.max(1, (Date.now() - new Date(s.startTime).getTime()) / 60000);
    const burnRatePerMin = Math.round(totalTokens / elapsedMin);

    s.estimates = {
      avgTokensPerTurn,
      burnRatePerMin,
      messagesLeft: estimateMessagesLeft(s.model, totalTokens, avgTokensPerTurn),
      sessionFraction: sessionFraction(s.model, totalTokens, avgTokensPerTurn),
    };
  }

  // ---- status --------------------------------------------------------------
  getStatus() {
    const s = this.current;
    const m = resolveModel(s.model);
    const totalTokens = s.totals.inputTokens + s.totals.outputTokens;
    const cacheSavings = s.turns.reduce((a, x) => a + (x.cacheSavings || 0), 0);

    return {
      id: s.id,
      model: s.model,
      modelLabel: m.label,
      startTime: s.startTime,
      turns: s.turns,
      totals: { ...s.totals, totalTokens },
      estimates: { ...s.estimates },
      cacheSavings,
      // pre-formatted display strings for the dashboard / tools
      display: {
        totalTokens: fmtInt(totalTokens),
        inputTokens: fmtInt(s.totals.inputTokens),
        outputTokens: fmtInt(s.totals.outputTokens),
        cacheReadTokens: fmtInt(s.totals.cacheReadTokens),
        totalCostUSD: fmtUSD(s.totals.totalCostUSD),
        totalCostINR: fmtINR(s.totals.totalCostINR),
        cacheSavings: fmtUSD(cacheSavings),
        messagesLeft:
          s.estimates.messagesLeft == null ? '—' : String(s.estimates.messagesLeft),
        avgTokensPerTurn: fmtInt(s.estimates.avgTokensPerTurn),
        burnRatePerMin: fmtInt(s.estimates.burnRatePerMin),
        turnCount: String(s.totals.turnCount),
      },
    };
  }

  reset() {
    this.sessions.push(newSession(this.current.model));
    this.save();
    this.emit('reset', this.getStatus());
    return true;
  }

  // ---- summary -------------------------------------------------------------
  getSummary() {
    const withTurns = this.sessions.filter((s) => s.totals.turnCount > 0);
    let totalTurns = 0;
    let totalCostUSD = 0;
    let totalCostINR = 0;
    let totalTokens = 0;
    const modelCount = {};

    for (const s of this.sessions) {
      totalTurns += s.totals.turnCount;
      totalCostUSD += s.totals.totalCostUSD;
      totalCostINR += s.totals.totalCostINR;
      totalTokens += s.totals.inputTokens + s.totals.outputTokens;
      if (s.totals.turnCount > 0) {
        modelCount[s.model] = (modelCount[s.model] || 0) + s.totals.turnCount;
      }
    }

    let mostUsedModel = '—';
    let best = -1;
    for (const [model, n] of Object.entries(modelCount)) {
      if (n > best) { best = n; mostUsedModel = resolveModel(model).label; }
    }

    const sessionCount = withTurns.length;
    const avgTokensPerSession = sessionCount ? Math.round(totalTokens / sessionCount) : 0;

    return {
      sessionCount,
      totalTurns,
      totalTokens,
      totalCostUSD,
      totalCostINR,
      mostUsedModel,
      avgTokensPerSession,
    };
  }

  // ---- export --------------------------------------------------------------
  export(format = 'markdown') {
    const s = this.current;
    if (format === 'json') {
      return JSON.stringify(this.getStatus(), null, 2);
    }

    if (format === 'csv') {
      const header = [
        'timestamp',
        'model',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'costUSD',
        'costINR',
        'runningTotalUSD',
      ].join(',');
      let running = 0;
      const rows = s.turns.map((t) => {
        running += t.costUSD;
        return [
          new Date(t.timestamp).toISOString(),
          resolveModel(t.model || s.model).label,
          t.inputTokens,
          t.outputTokens,
          t.cacheReadTokens,
          t.costUSD.toFixed(6),
          t.costINR.toFixed(4),
          running.toFixed(6),
        ].join(',');
      });
      return [header, ...rows].join('\n');
    }

    // markdown (default)
    const head =
      '| Turn | Model | Input | Output | Cache | Cost USD | Cost INR |\n' +
      '|------|-------|-------|--------|-------|----------|----------|';
    const rows = s.turns.map(
      (t) =>
        `| ${t.turnNumber} | ${resolveModel(t.model || s.model).label} | ${fmtInt(t.inputTokens)} | ${fmtInt(
          t.outputTokens
        )} | ${fmtInt(t.cacheReadTokens)} | $${fmtUSD(t.costUSD)} | ₹${fmtINR(
          t.costINR
        )} |`
    );
    return [head, ...rows].join('\n');
  }

  // ---- track result string -------------------------------------------------
  formatTrackResult(turn, cost, status) {
    const turnTokens = turn.inputTokens + turn.outputTokens;
    return [
      '✓ Wick tracked',
      '─────────────────────────────',
      `This turn:   ${fmtInt(turnTokens)} tokens · $${fmtUSD(turn.costUSD)} · ₹${fmtINR(
        turn.costINR
      )}`,
      `Session:     ${status.display.totalTokens} tokens · $${status.display.totalCostUSD} · ₹${status.display.totalCostINR}`,
      `Msgs left:   ≈${status.display.messagesLeft} ${status.modelLabel} messages`,
      `Dashboard:   http://localhost:6789`,
      '─────────────────────────────',
    ].join('\n');
  }
}
