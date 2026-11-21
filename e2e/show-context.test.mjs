import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const cli = path.join(repo, 'bin/show-context.mjs');
const fixtures = path.join(import.meta.dirname, 'fixtures');
const mainId = 'aaaaaaaa-1111-4111-8111-111111111111';
const compactId = 'bbbbbbbb-2222-4222-8222-222222222222';
const oldId = 'cccccccc-3333-4333-8333-333333333333';
const demoId = 'dddddddd-4444-4444-8444-444444444444';
const fixtureProjectSlug = '-Users-example-projects-demo';
const expectedHelp = `Show a Claude Code conversation and the context it read.

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

let chrome = '';
let temp;
let root;
let project;
let fixtureProject;
let mainPagePromise;
let shellPagePromise;

const jsonLine = value => `${JSON.stringify(value)}\n`;

function selectionFixture(id, fileName = 'alpha.txt') {
  return [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Read the file.' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a1`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `${id}-read`, name: 'Read', input: { file_path: `/tmp/${fileName}` } }],
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 }
      }
    },
    {
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `${id}-read`, content: `1\t${'file content '.repeat(30)}` }]
      }
    },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a2`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 240, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 }
      }
    }
  ]
    .map(jsonLine)
    .join('');
}

function imageFixture(id) {
  return [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Read the image.' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a1`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `${id}-image`, name: 'Read', input: { file_path: '/tmp/screen.png' } }],
        usage: { input_tokens: 100 }
      }
    },
    {
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `${id}-image`,
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]
          }
        ]
      }
    },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a2`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 260 }
      }
    }
  ]
    .map(jsonLine)
    .join('');
}

function smallReadsFixture(id) {
  const uses = [
    { id: `${id}-file`, name: 'Read', input: { file_path: '/tmp/small.txt' } },
    { id: `${id}-mcp`, name: 'mcp__notes__read', input: { path: 'notes/small.md' } },
    { id: `${id}-web`, name: 'WebFetch', input: { url: 'https://example.test/a' } },
    { id: `${id}-bash`, name: 'Bash', input: { command: 'true', description: 'Empty command' } },
    { id: `${id}-error`, name: 'mcp__notes__read', input: { path: 'notes/error.md' } }
  ];
  return [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Read small content.' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a1`,
        role: 'assistant',
        content: uses.map(use => ({ type: 'tool_use', ...use })),
        usage: { input_tokens: 100 }
      }
    },
    {
      type: 'user',
      isSidechain: false,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `${id}-file`, content: 'small file' },
          { type: 'tool_result', tool_use_id: `${id}-mcp`, content: 'small MCP result' },
          { type: 'tool_result', tool_use_id: `${id}-web`, content: 'small web result' },
          { type: 'tool_result', tool_use_id: `${id}-bash`, content: 'ok' },
          { type: 'tool_result', tool_use_id: `${id}-error`, content: 'permission denied', is_error: true }
        ]
      }
    },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a2`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 500 }
      }
    }
  ]
    .map(jsonLine)
    .join('');
}

function shellKindsFixture(id) {
  const calls = [
    {
      description: 'Read project rules from git',
      command: 'cd ~/projects/demo && git show origin/main:PROJECT.md'
    },
    { description: 'Read coverage sample', command: "cd /tmp/weekly && jq '.[0:2]' coverage.json" },
    { description: 'Read canvas data', command: 'sed -n 1,80p ~/.config/demo/canvas.json' },
    {
      description: 'Read two reference files',
      command: 'cat ~/bin/demo-README.md | head -150; echo ====; sed -n 1,120p ~/projects/guide/dev-tools.md'
    },
    {
      description: 'Inspect skills and read one',
      command: 'ls -la ~/.claude/skills | head -8; ls ~/.agents/skills | head -30; sed -n 1,60p ~/skills/SKILL.md'
    },
    { description: 'List weekly data', command: 'ls -la ~/projects/demo/data' },
    { description: 'Find Node workers', command: 'cd /tmp && pgrep -fl "node worker"' },
    { description: 'Run task worker', command: 'command node /tmp/worker.mjs > /tmp/worker.log 2>&1' },
    { description: 'Run tests', command: 'cd /Users/example/projects/demo && npm test 2>&1 | tail -12' },
    { description: 'Commit changes', command: 'git add src/x.mjs && git commit -q -m "x"' },
    { description: 'Write prompt file', command: "cat > /tmp/x.md <<'EOF'\nhello\nEOF" },
    { description: 'Search source', command: 'grep -n "foo" src/a.mjs | head' },
    {
      description: 'Init repo and check',
      command: 'cd /Users/example/projects/demo && git init -q && git status -sb'
    },
    { description: 'Make folder and list it', command: 'mkdir -p /tmp/demo-logs && ls /tmp/demo-logs' }
  ];
  const uses = calls.map((call, index) => ({
    type: 'tool_use',
    id: `${id}-shell-${index}`,
    name: 'Bash',
    input: call
  }));
  const results = calls.map((call, index) => ({
    type: 'tool_result',
    tool_use_id: `${id}-shell-${index}`,
    content: `${call.description}\n${'sample output '.repeat(24)}`
  }));
  return [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Run shell examples.' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: { id: `${id}-a1`, role: 'assistant', content: uses, usage: { input_tokens: 100 } }
    },
    { type: 'user', isSidechain: false, message: { role: 'user', content: results } },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: `${id}-a2`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 1300 }
      }
    }
  ]
    .map(jsonLine)
    .join('');
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const result = await exec('which', [command]);
      if (result.stdout.trim()) return result.stdout.trim();
    } catch {}
  }
  return '';
}

async function run(sessionRoot, args, options = {}) {
  const out = options.out || path.join(sessionRoot, `out-${Math.random().toString(16).slice(2)}.html`);
  const env = { ...process.env, SHOW_CONTEXT_PROJECTS: sessionRoot, SHOW_CONTEXT_OUT: out, ...options.env };
  delete env.CONTEXT_LENS_ROOT;
  if (options.clearSession) delete env.CLAUDE_CODE_SESSION_ID;
  try {
    const result = await exec(process.execPath, [cli, ...args, '--no-open'], {
      cwd: options.cwd || repo,
      env,
      maxBuffer: 64 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, out };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '', out };
  }
}

async function runCli(args) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: repo });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

function dataFrom(html) {
  const match = html.match(/<script id="show-context-data" type="application\/json">([^<]*)<\/script>/);
  assert.ok(match, 'page has embedded read data');
  return JSON.parse(match[1]);
}

function formatTokens(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value);
}

async function mainPage() {
  mainPagePromise ||= (async () => {
    const out = path.join(temp, 'main.html');
    const result = await run(root, [mainId.slice(0, 8)], { out });
    assert.equal(result.code, 0, result.stdout);
    const html = await readFile(out, 'utf8');
    return { out, html, model: dataFrom(html) };
  })();
  return mainPagePromise;
}

async function shellPage() {
  shellPagePromise ||= (async () => {
    const id = '66666666-1111-4111-8111-111111111111';
    await writeFile(path.join(project, `${id}.jsonl`), shellKindsFixture(id));
    const result = await run(root, [id]);
    assert.equal(result.code, 0, result.stdout);
    return dataFrom(await readFile(result.out, 'utf8'));
  })();
  return shellPagePromise;
}

async function chromeDom(file, profileName) {
  const profile = path.join(temp, profileName);
  await mkdir(profile, { recursive: true });
  const result = await exec(
    chrome,
    [
      '--headless=new',
      '--virtual-time-budget=2000',
      '--dump-dom',
      '--disable-gpu',
      '--no-first-run',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      `file://${file}`
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return result.stdout;
}

before(async () => {
  chrome = await findChrome();
  temp = await mkdtemp(path.join(os.tmpdir(), 'show-context-e2e-'));
  root = path.join(temp, 'projects');
  project = path.join(root, 'sample-project');
  fixtureProject = path.join(root, fixtureProjectSlug);
  await mkdir(project, { recursive: true });
  await mkdir(fixtureProject, { recursive: true });
  for (const [name, id] of [
    ['main', mainId],
    ['compact', compactId],
    ['old', oldId],
    ['demo', demoId]
  ]) {
    await copyFile(path.join(fixtures, `${name}.jsonl`), path.join(fixtureProject, `${id}.jsonl`));
  }
});

test('help, version, and unknown flags are complete CLI E2E paths', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, expectedHelp);
    assert.equal(result.stderr, '');
  }
  for (const flag of ['--version', '-v']) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0);
    const packageJson = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
    assert.equal(result.stdout, `${packageJson.version}\n`);
    assert.equal(result.stderr, '');
  }
  const unknown = await runCli(['--unknown']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, 'show-context: unknown flag: --unknown. Use --help for help.\n');
  assert.equal(unknown.stderr, '');
});

test('--json prints a summary and writes no page or server', async () => {
  const id = '55555555-1111-4111-8111-111111111111';
  await writeFile(path.join(project, `${id}.jsonl`), selectionFixture(id));
  const result = await run(root, [id, '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.sessionId, id);
  assert.equal(typeof summary.startLoadTokens, 'number');
  assert.ok(Array.isArray(summary.startLoad));
  assert.equal(typeof summary.readTokens, 'number');
  assert.ok(Array.isArray(summary.reads));
  assert.ok(summary.reads.some(read => read.kind === 'file' && typeof read.tokens === 'number'));
  // No show-context: progress line, and no live server URL.
  assert.doesNotMatch(result.stdout, /show-context: /);
  assert.doesNotMatch(result.stdout, /^http/);
});

test('session selection, errors, and deterministic output', async () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '11111111-2222-4222-8222-222222222222';
  await writeFile(path.join(project, `${first}.jsonl`), selectionFixture(first));
  await writeFile(path.join(project, `${second}.jsonl`), selectionFixture(second, 'beta.txt'));
  const byId = await run(root, [first]);
  assert.equal(byId.code, 0);
  assert.match(byId.stdout, /^show-context: 1 reads, 140 tokens · 11111111 · .+\n$/);
  assert.equal(byId.stderr, '');
  assert.equal((await run(root, ['11111111-1111'])).code, 0);
  const ambiguous = await run(root, ['11111111']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stdout, /11111111-1111-4111-8111-111111111111.*11111111-2222-4222-8222-222222222222/);
  assert.equal(ambiguous.stdout.trim().split('\n').length, 1);
  assert.equal((await run(root, [], { env: { CLAUDE_CODE_SESSION_ID: second } })).code, 0);
  const guessedCwd = path.join(temp, 'guess.project');
  await mkdir(guessedCwd, { recursive: true });
  const guessedSlug = (await realpath(guessedCwd)).replaceAll('/', '-').replaceAll('.', '-');
  const guessedProject = path.join(root, guessedSlug);
  await mkdir(guessedProject, { recursive: true });
  const guessedId = '33333333-1111-4111-8111-111111111111';
  await writeFile(path.join(guessedProject, `${guessedId}.jsonl`), selectionFixture(guessedId));
  const guessed = await run(root, [], { cwd: guessedCwd, clearSession: true });
  assert.equal(guessed.code, 0);
  assert.match(guessed.stdout, /guessed: newest session in this folder/);
  const stableOut = path.join(temp, 'stable.html');
  assert.equal((await run(root, [first], { out: stableOut })).code, 0);
  const firstBytes = await readFile(stableOut);
  assert.equal((await run(root, [first], { out: stableOut })).code, 0);
  assert.deepEqual(await readFile(stableOut), firstBytes);
  for (const [id, body] of [
    ['empty-session', ''],
    ['broken-session', '{not json}\n']
  ]) {
    await writeFile(path.join(project, `${id}.jsonl`), body);
    const failed = await run(root, [id]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /^show-context: .+\n$/);
    assert.equal(failed.stdout.trim().split('\n').length, 1);
    assert.equal(failed.stderr, '');
  }
  assert.equal((await run(root, ['not-found'])).code, 1);
});

const scriptErrorProbe = `<script>
  window.onerror = function (message) {
    document.documentElement.setAttribute('data-script-error', String(message));
  };
</script>`;

test('generated page runs without script errors and renders every segment', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install google-chrome or chromium.');
  const { html, model } = await mainPage();
  const resultProbe = `<script>
    const explore = document.querySelector('.seg.explore .body');
    const system = document.querySelector('[data-start-key="system"] .body');
    if (system) system.click();
    const setResult = (name, value) => document.documentElement.setAttribute(name, String(value));
    const startSegments = document.querySelectorAll('.seg.start-part,.seg.start-subpart');
    const systemRow = system?.closest('.seg');
    const systemText = systemRow?.nextElementSibling?.querySelector('.full')?.textContent;
    setResult('data-segment-count', document.querySelectorAll('.seg').length);
    setResult('data-start-row-count', startSegments.length);
    setResult('data-system-open', Boolean(systemRow?.classList.contains('open')));
    setResult('data-system-text', Boolean(systemText?.startsWith('You are Claude Code')));
    setResult('data-explore-count', document.querySelectorAll('.seg.explore').length);
    setResult('data-explore-height', explore ? Math.round(explore.getBoundingClientRect().height) : 'none');
  </script>`;
  const probeFile = path.join(temp, 'main-probe.html');
  await writeFile(
    probeFile,
    html.replace('<head>', `<head>${scriptErrorProbe}`).replace('</body>', `${resultProbe}</body>`)
  );
  const dom = await chromeDom(`${probeFile}?min=0`, 'chrome-dom-profile');
  assert.doesNotMatch(dom, /<html[^>]*data-script-error=/);
  const startRows = model.startLoad.parts.reduce((sum, part) => sum + 1 + (part.items?.length || 0), 0);
  assert.match(dom, new RegExp(`data-segment-count="${model.reads.length + startRows}"`));
  assert.match(dom, new RegExp(`data-start-row-count="${startRows}"`));
  assert.match(dom, /data-system-open="true"/);
  assert.match(dom, /data-system-text="true"/);
  assert.match(
    dom,
    new RegExp(`data-explore-count="${model.reads.filter(read => read.category === 'Explore').length}"`)
  );
  assert.match(dom, /data-explore-height="30"/);
  assert.ok(dom.includes(`${model.reads.length} reads · ${formatTokens(model.totalReadTokens)} tokens`));
});

test('size filter hides rows under 2k tokens by default, start parts included', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install google-chrome or chromium.');
  const { html, model } = await mainPage();
  const resultProbe = `<script>
    const page = document.documentElement;
    const reads = document.querySelectorAll('.seg:not(.start-part):not(.start-subpart)');
    const startSegments = document.querySelectorAll('.seg.start-part,.seg.start-subpart');
    page.setAttribute('data-read-count', String(reads.length));
    page.setAttribute('data-start-row-count', String(startSegments.length));
    page.setAttribute('data-amount', document.getElementById('amount').value);
    page.setAttribute('data-theme-start', page.dataset.theme);
  </script>`;
  const probeFile = path.join(temp, 'filter-probe.html');
  await writeFile(
    probeFile,
    html.replace('<head>', `<head>${scriptErrorProbe}`).replace('</body>', `${resultProbe}</body>`)
  );
  const dom = await chromeDom(probeFile, 'chrome-filter-profile');
  assert.doesNotMatch(dom, /<html[^>]*data-script-error=/);
  const startRows = model.startLoad.parts.flatMap(part => [part, ...(part.items || [])]);
  assert.match(dom, /data-amount="2000"/);
  assert.match(dom, /data-theme-start="light"/);
  assert.match(dom, new RegExp(`data-read-count="${model.reads.filter(read => read.size >= 2000).length}"`));
  assert.match(dom, new RegExp(`data-start-row-count="${startRows.filter(row => row.size >= 2000).length}"`));
  assert.ok(
    model.reads.some(read => read.size < 2000),
    'the fixture must have small reads to hide'
  );
  assert.ok(
    startRows.some(row => row.size < 2000),
    'the fixture must have small start rows to hide'
  );
});

test('start load has named parts with exact measured sizes', async () => {
  const { model } = await mainPage();
  const parts = model.startLoad.parts;
  assert.deepEqual(
    parts.slice(0, 5).map(part => part.name),
    ['System prompt', 'Tools', 'Instructions', 'Skills list', 'MCP instructions']
  );
  const transcript = (await readFile(path.join(fixtureProject, `${mainId}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const firstSystemBlock = transcript.find(record => record.type === 'api-request-shape').shape.system[0].text;
  assert.ok(parts.find(part => part.name === 'System prompt').text.startsWith(firstSystemBlock));
  const instructions = parts.find(part => part.name === 'Instructions');
  assert.ok(instructions.items.some(item => item.name === '~/.claude/CLAUDE.md'));
  assert.equal(
    instructions.items.reduce((sum, item) => sum + item.size, 0),
    instructions.size
  );
  assert.equal(
    parts.reduce((sum, part) => sum + part.size, 0),
    model.startLoadTokens
  );
});

test('image tool results become measured File reads', async () => {
  const id = '44444444-1111-4111-8111-111111111111';
  await writeFile(path.join(project, `${id}.jsonl`), imageFixture(id));
  const result = await run(root, [id]);
  assert.equal(result.code, 0);
  const model = dataFrom(await readFile(result.out, 'utf8'));
  assert.deepEqual(
    model.reads.map(read => ({ category: read.category, name: read.name, text: read.text, size: read.size })),
    [{ category: 'File', name: 'screen.png', text: '[image: /tmp/screen.png]', size: 160 }]
  );
  const main = (await mainPage()).model;
  const imageNames = main.reads
    .flatMap(read => read.items || [read.name])
    .filter(name => /\.(?:png|jpe?g|gif|webp)$/i.test(name));
  assert.equal(imageNames.length, 6);
});

test('small File, MCP, and Web reads remain while small commands and errors do not', async () => {
  const id = '55555555-1111-4111-8111-111111111111';
  await writeFile(path.join(project, `${id}.jsonl`), smallReadsFixture(id));
  const result = await run(root, [id]);
  assert.equal(result.code, 0);
  const model = dataFrom(await readFile(result.out, 'utf8'));
  assert.deepEqual(
    model.reads.map(read => [read.category, read.name]),
    [
      ['File', 'small.txt'],
      ['MCP', 'notes/small.md'],
      ['Web', 'https://example.test/a']
    ]
  );
  const main = (await mainPage()).model;
  for (const name of ['notes', 'notes/demo', 'notes/demo/plan.md']) {
    assert.ok(
      main.reads.some(read => read.category === 'MCP' && read.name === name),
      `missing MCP read: ${name}`
    );
  }
});

test('Bash file readers become File rows with resolved names and locations', async () => {
  const model = await shellPage();
  const files = model.reads.filter(read => read.tool === 'Bash' && read.category === 'File');
  assert.deepEqual(
    files.map(read => ({ name: read.name, location: read.location, items: read.items })),
    [
      { name: 'PROJECT.md', location: '~/projects/demo @ origin/main', items: undefined },
      { name: 'coverage.json', location: '/tmp/weekly', items: undefined },
      { name: 'canvas.json', location: '~/.config/demo', items: undefined },
      { name: '2 files', location: '', items: ['demo-README.md', 'dev-tools.md'] },
      { name: 'SKILL.md', location: '~/skills', items: undefined }
    ]
  );
  const main = (await mainPage()).model;
  assert.ok(
    main.reads.some(
      read =>
        read.tool === 'Bash' &&
        read.category === 'File' &&
        read.name === 'PROJECT.md' &&
        read.location === '~/projects/demo @ origin/main'
    )
  );
});

test('Bash exploration commands become Explore rows', async () => {
  const model = await shellPage();
  const explores = model.reads.filter(read => read.tool === 'Bash' && read.category === 'Explore');
  assert.deepEqual(
    explores.map(read => read.name),
    ['List weekly data', 'Find Node workers', 'Search source', 'Make folder and list it']
  );
  assert.ok(explores.every(read => read.kind === 'explore'));
});

test('Bash run commands do not become reads', async () => {
  const model = await shellPage();
  assert.equal(
    model.reads.some(read =>
      ['Run task worker', 'Run tests', 'Commit changes', 'Write prompt file', 'Init repo and check'].includes(
        read.name
      )
    ),
    false
  );
  assert.equal(model.reads.length, 9);
  assert.ok(model.totalReadTokens > 0 && model.totalReadTokens < 1200);
});

test('saved output, exclusions, compaction, and old transcripts remain compatible', async () => {
  const { html, model } = await mainPage();
  assert.equal(
    model.reads.filter(
      read =>
        read.category === 'File' && (read.name.includes('saved-output') || read.location.includes('saved-output'))
    ).length,
    0
  );
  assert.equal(
    model.reads.filter(
      read =>
        read.name === 'PROJECT.md' && read.category === 'File' && read.location === '~/projects/demo @ origin/main'
    ).length,
    1
  );
  assert.ok(
    model.reads.some(
      read =>
        read.category === 'Skill' &&
        read.name === 'summarize' &&
        read.text.startsWith('Base directory for this skill:')
    )
  );
  assert.equal(
    model.reads.some(read => ['Write', 'Edit', 'ToolSearch', 'AskUserQuestion'].includes(read.tool)),
    false
  );
  assert.equal(
    model.reads.some(read => read.tool === 'mcp__notes__write_note'),
    false
  );
  assert.doesNotMatch(html, /<(?:script|link|img|source|iframe)[^>]+(?:src|href)=["']https?:\/\//i);
  const compactResult = await run(root, [compactId]);
  assert.equal(compactResult.code, 0);
  const compactModel = dataFrom(await readFile(compactResult.out, 'utf8'));
  assert.equal(compactModel.reads.length, 1);
  assert.match(
    await readFile(path.join(fixtureProject, `${compactId}.jsonl`), 'utf8'),
    /"type":"compact_boundary"/
  );
  const old = await run(root, [oldId]);
  assert.equal(old.code, 0);
  const oldModel = dataFrom(await readFile(old.out, 'utf8'));
  assert.equal(
    oldModel.startLoad.parts.reduce((sum, part) => sum + part.size, 0),
    oldModel.startLoadTokens
  );
  assert.ok(oldModel.startLoad.parts.some(part => part.name === 'Not recorded in this session file'));
  assert.doesNotMatch(await readFile(path.join(fixtureProject, `${oldId}.jsonl`), 'utf8'), /api-request-shape/);
});

test('report and screenshot are repeatable E2E artifacts', async t => {
  if (!chrome) return t.skip('Chrome was not found. Set CHROME_PATH or install google-chrome or chromium.');
  const { out, model } = await mainPage();
  const reportDir = path.join(repo, 'e2e/.local/report');
  await mkdir(reportDir, { recursive: true });
  const rows = model.reads.map(
    read => `| ${read.category} | ${read.name.replaceAll('|', '\\|')} | ${read.size} |`
  );
  const report = [
    '# show-context E2E report',
    '',
    `Session: ${mainId}`,
    '',
    `Reads: ${model.reads.length}`,
    '',
    `Tokens: ${model.totalReadTokens}`,
    '',
    '## Loaded at start',
    '',
    '| Name | Detail | Tokens |',
    '| --- | --- | ---: |',
    ...model.startLoad.parts.map(
      part => `| ${part.name.replaceAll('|', '\\|')} | ${part.detail.replaceAll('|', '\\|')} | ${part.size} |`
    ),
    '',
    '## Reads',
    '',
    '| Category | Name | Tokens |',
    '| --- | --- | ---: |',
    ...rows,
    ''
  ].join('\n');
  await writeFile(path.join(reportDir, 'show-context-report.md'), report);
  const demoOut = path.join(temp, 'demo.html');
  const demoResult = await run(root, [demoId], { out: demoOut });
  assert.equal(demoResult.code, 0, demoResult.stdout);
  const demoModel = dataFrom(await readFile(demoOut, 'utf8'));
  assert.ok(demoModel.reads.length >= 14 && demoModel.reads.length <= 18);
  assert.deepEqual(
    new Set(demoModel.reads.map(read => read.category)),
    new Set(['File', 'Explore', 'MCP', 'Skill', 'Web'])
  );
  assert.ok(Math.min(...demoModel.reads.map(read => read.size)) <= 300);
  assert.ok(Math.max(...demoModel.reads.map(read => read.size)) >= 12_000);
  assert.ok(demoModel.reads.some(read => read.items?.length === 2));
  assert.deepEqual(
    demoModel.startLoad.parts.map(part => part.name),
    [
      'System prompt',
      'Tools',
      'Instructions',
      'Skills list',
      'MCP instructions',
      'Deferred tools',
      'Other',
      'Your first message'
    ]
  );
  const localScreenshot = path.join(reportDir, 'show-context.png');
  const publicScreenshot = path.join(repo, 'docs/screenshot.png');
  const profile = path.join(temp, 'chrome-screenshot-profile');
  await mkdir(profile, { recursive: true });
  await exec(
    chrome,
    [
      '--headless=new',
      '--virtual-time-budget=2000',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      `--screenshot=${localScreenshot}`,
      '--window-size=1280,1000',
      `file://${demoOut}?min=500`
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  assert.ok((await stat(localScreenshot)).size > 10_000);
  if (process.env.UPDATE_SCREENSHOTS === '1') {
    await mkdir(path.dirname(publicScreenshot), { recursive: true });
    await copyFile(localScreenshot, publicScreenshot);
    assert.deepEqual(await readFile(publicScreenshot), await readFile(localScreenshot));
  }
});
