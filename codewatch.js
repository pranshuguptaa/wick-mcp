/**
 * Wick MCP — Claude Code log watcher.
 *
 * Claude Code writes every response's REAL token usage to
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * Each assistant line contains:
 *   { type:"assistant", uuid, message:{ model, usage:{ input_tokens,
 *     output_tokens, cache_read_input_tokens, cache_creation_input_tokens } } }
 *
 * Instead of asking Claude to self-report via the wick_track tool (which is
 * manual + estimated), we tail these logs and ingest the real numbers — no
 * custom instructions, no model cooperation, accurate counts.
 *
 * We only ever track NEW appends (each file's offset starts at EOF the first
 * time we see it), so nothing is back-filled or double-counted across restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECTS_DIR =
  process.env.WICK_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = Number(process.env.WICK_WATCH_POLL_MS) || 1500;

function newestJsonl() {
  let best = null;
  let bestM = -1;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const sub = path.join(PROJECTS_DIR, d);
    let files;
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sub, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = fp; }
      } catch {
        /* ignore */
      }
    }
  }
  return best;
}

/**
 * @param {(turn:{model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens})=>void} onTurn
 * @param {(msg:string)=>void} log
 * @returns {() => void} stop function
 */
export function startCodeWatcher(onTurn, log = () => {}) {
  const offsets = new Map(); // file -> byte offset already processed
  const seen = new Set(); // uuids already counted (guards re-reads)

  function processBytes(buf) {
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
      const uuid = o.uuid || `${o.requestId || ''}:${o.message.id || ''}`;
      if (seen.has(uuid)) continue;
      seen.add(uuid);
      const u = o.message.usage;
      onTurn({
        model: o.message.model || 'claude-sonnet-4-6',
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_tokens: u.cache_read_input_tokens || 0,
        cache_creation_tokens: u.cache_creation_input_tokens || 0,
      });
    }
  }

  function tick() {
    const fp = newestJsonl();
    if (!fp) return;
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      return;
    }
    if (!offsets.has(fp)) {
      // first time we see this file → start at EOF (track new turns only)
      offsets.set(fp, st.size);
      return;
    }
    let off = offsets.get(fp);
    if (st.size < off) off = 0; // truncated / rotated
    if (st.size <= off) return;

    try {
      const fd = fs.openSync(fp, 'r');
      const len = st.size - off;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      fs.closeSync(fd);
      const nl = buf.lastIndexOf(0x0a); // last newline → last complete line
      if (nl === -1) return; // no complete line yet
      processBytes(buf.subarray(0, nl));
      offsets.set(fp, off + nl + 1);
    } catch {
      /* transient read error; retry next tick */
    }
  }

  const timer = setInterval(tick, POLL_MS);
  tick();
  log(`watching Claude Code logs → ${PROJECTS_DIR}`);
  return () => clearInterval(timer);
}
