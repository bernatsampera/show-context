#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseTranscript } from '../src/show-context.mjs';
import { renderShowContextPage } from '../src/show-context-page.mjs';
import { startServer } from '../src/server.mjs';

const runFile = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const help = `Show a Claude Code conversation and the context it read.

Usage: show-context [session-id-or-prefix] [--no-open] [--static]

Flags:
  --no-open       Do not open the report.
  --static        Write a static report without a live server.
  --json          Print a JSON summary to stdout and exit (no page or server).
  -h, --help      Show this help.
  -v, --version   Show the version.

Environment:
  SHOW_CONTEXT_OUT          Set the report output path.
  SHOW_CONTEXT_PROJECTS     Set the Claude projects root.
  CONTEXT_LENS_ROOT         Set the old fallback projects root.
  SHOW_CONTEXT_PORT         Set the live server port.
  SHOW_CONTEXT_IDLE_MS      Set the live server idle timeout in milliseconds.
  SHOW_CONTEXT_CLAUDE_BIN   Set the Claude CLI binary.

Example:
  show-context abc123 --no-open
`;

function projectsRoot() {
  return path.resolve(process.env.SHOW_CONTEXT_PROJECTS
    || process.env.CONTEXT_LENS_ROOT
    || path.join(os.homedir(), '.claude/projects'));
}

async function allSessions(root) {
  const sessions = [];
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch { throw new Error(`cannot read projects root: ${root}`); }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const folder = path.join(root, project.name);
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, entry.name);
      const details = await stat(file);
      sessions.push({
        id: entry.name.slice(0, -6), file, project: project.name, mtimeMs: details.mtimeMs
      });
    }
  }
  return sessions;
}

function ambiguous(matches) {
  const ids = matches.map(match => match.id).sort().join(', ');
  throw new Error(`session prefix is ambiguous: ${ids}`);
}

async function selectSession(root, idArgument) {
  const sessions = await allSessions(root);
  if (idArgument) {
    const matches = sessions.filter(session => session.id.startsWith(idArgument));
    if (!matches.length) throw new Error(`session not found: ${idArgument}`);
    if (matches.length > 1) ambiguous(matches);
    return { session: matches[0], guessed: false };
  }
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    const id = process.env.CLAUDE_CODE_SESSION_ID;
    const matches = sessions.filter(session => session.id === id);
    if (!matches.length) throw new Error(`session not found: ${id}`);
    if (matches.length > 1) ambiguous(matches);
    return { session: matches[0], guessed: false };
  }
  const slug = path.resolve(process.cwd()).replaceAll('/', '-').replaceAll('.', '-');
  const matches = sessions
    .filter(session => session.project === slug)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  if (!matches.length) throw new Error('no session found for this folder');
  return { session: matches[0], guessed: true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--serve') {
    const [, transcript, sessionId] = args;
    const source = await readFile(transcript, 'utf8');
    const model = parseTranscript(source, { sessionId, home: os.homedir() });
    const html = renderShowContextPage(model, { live: true });
    const { url } = await startServer({ model, html });
    process.stdout.write(`${url}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  const flags = new Set(['--no-open', '--static', '--json']);
  const unknownFlag = args.find(argument => argument.startsWith('-') && !flags.has(argument));
  if (unknownFlag) throw new Error(`unknown flag: ${unknownFlag}. Use --help for help.`);
  const noOpen = args.includes('--no-open');
  const staticOnly = args.includes('--static');
  const positional = args.filter(argument => !flags.has(argument));
  if (positional.length > 1) {
    throw new Error('usage: show-context [session-id-or-prefix] [--no-open] [--static]');
  }
  const { session, guessed } = await selectSession(projectsRoot(), positional[0]);
  let source;
  try { source = await readFile(session.file, 'utf8'); }
  catch { throw new Error(`cannot read transcript: ${session.id}`); }
  const model = parseTranscript(source, { sessionId: session.id, home: os.homedir() });
  if (args.includes('--json')) {
    const summary = {
      sessionId: model.sessionId,
      startLoadTokens: model.startLoadTokens,
      startLoad: model.startLoad.parts.map(part => ({ name: part.name, tokens: part.size })),
      readTokens: model.totalReadTokens,
      reads: model.reads.map(read => ({ kind: read.kind, name: read.name, tokens: read.size })),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  const html = renderShowContextPage(model);
  const output = path.resolve(
    process.env.SHOW_CONTEXT_OUT || path.join(os.homedir(), '.cache/show-context/show-context.html')
  );
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, html, { mode: 0o600 });
  let target = output;
  if (!staticOnly) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', session.file, session.id], {
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    target = await new Promise((resolve, reject) => {
      let line = '';
      const timeout = setTimeout(() => reject(new Error('live server did not start')), 4000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        line += chunk;
        const newline = line.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        resolve(line.slice(0, newline).trim());
      });
    });
    child.stdout.destroy();
    child.unref();
  }
  if (!noOpen) await runFile('open', [target]);
  const note = guessed ? ' · guessed: newest session in this folder' : '';
  console.log(
    `show-context: ${model.reads.length} reads, ${model.totalReadTokens} tokens` +
    ` · ${session.id.slice(0, 8)}${note} · ${target} · ${output}`
  );
}

try {
  await main();
} catch (error) {
  console.log(`show-context: ${String(error?.message || error).replaceAll(/\s+/g, ' ').trim()}`);
  process.exitCode = 1;
}
