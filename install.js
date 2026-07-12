#!/usr/bin/env node
/**
 * Wick MCP — one-command installer.
 * Adds the "wick" MCP server to Claude Desktop's config, creating the file
 * (and parent dirs) if needed. Prompts before overwriting an existing entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'server.js');

// How Claude Desktop should launch Wick:
//  - Installed from npm (this file runs from inside node_modules / the npx
//    cache): use `npx -y usewick-mcp`, so the config never points at a path
//    that npm/npx can garbage-collect, and it always runs the published build.
//  - Running from a source checkout: point straight at the local server.js
//    (a stable absolute path, ideal for development).
const IS_PACKAGED = __dirname.includes(`${path.sep}node_modules${path.sep}`);
const SERVER_ENTRY = IS_PACKAGED
  ? { command: 'npx', args: ['-y', 'usewick-mcp'] }
  : { command: 'node', args: [SERVER_PATH] };

function configPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    default: // linux + others
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

function claudeIsRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist', { encoding: 'utf8' });
      return /claude\.exe/i.test(out);
    }
    const out = execSync('ps aux', { encoding: 'utf8' });
    return /Claude\.app|Claude Helper|[Cc]laude Desktop/.test(out);
  } catch (_e) {
    return false;
  }
}

async function main() {
  const cfgPath = configPath();
  console.error(chalk.hex('#E8793C').bold('\n🕯 Wick MCP installer\n'));
  console.error(chalk.gray('Config: ') + cfgPath);

  // 1. read existing config (or start fresh)
  let config = {};
  if (fs.existsSync(cfgPath)) {
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
    } catch (e) {
      console.error(chalk.red('\n✗ Existing config is not valid JSON. Fix or remove it first:'));
      console.error('  ' + cfgPath);
      process.exit(1);
    }
  } else {
    console.error(chalk.gray('No config found — creating a new one.'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};

  // 2. overwrite guard
  if (config.mcpServers.wick) {
    if (JSON.stringify(config.mcpServers.wick) === JSON.stringify(SERVER_ENTRY)) {
      console.error(chalk.green('\n✓ Wick is already installed and up to date. Nothing to do.'));
      printNext(cfgPath);
      return;
    }
    const answer = (await ask(chalk.yellow('\nA "wick" MCP entry already exists. Overwrite it? (y/N) '))).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.error(chalk.gray('Aborted — no changes made.'));
      return;
    }
  }

  // 3. write entry
  config.mcpServers.wick = SERVER_ENTRY;

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));

  console.error(chalk.green('\n✓ Wick MCP installed into Claude Desktop'));

  if (claudeIsRunning()) {
    console.error(chalk.yellow('\n⚠ Claude Desktop appears to be running — fully quit and reopen it to load Wick.'));
  }
  printNext(cfgPath);
}

function printNext(cfgPath) {
  console.error(
    '\n' +
    'Restart Claude Desktop to activate.\n' +
    "Then ask Claude: 'call wick_status' to verify it's working.\n\n" +
    'Dashboard will be available at: ' + chalk.hex('#E8793C')('http://localhost:6789') + '\n'
  );
}

export default async function install() {
  return main();
}

// Direct run (`node install.js`): only self-execute when this file is the
// entry point. When imported by server.js (`npx wick-mcp install`) this guard
// is false, so server.js controls when the installer runs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  install().catch((e) => {
    console.error(chalk.red('\n✗ Install failed:'), e.message);
    process.exit(1);
  });
}
