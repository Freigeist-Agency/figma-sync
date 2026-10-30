import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serveDir } from '../src/serve.js';
import { shootSections, smoke } from '../src/shots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_SITE_DIR = path.join(__dirname, 'fixtures', 'site');

test('serveDir refuses a path outside the directory', async () => {
  const server = await serveDir(FIXTURES_SITE_DIR);
  try {
    // 1. Normal file serves 200 with appropriate content type
    const normalRes = await fetch(`${server.url}/index.html`);
    assert.strictEqual(normalRes.status, 200);
    assert(normalRes.headers.get('content-type')?.includes('text/html'));
    const text = await normalRes.text();
    assert(text.includes('Clean Fixture Site'));

    // 2. Traversal attempt with ../ or encoded %2e%2e
    const traversalRes1 = await fetch(`${server.url}/../package.json`);
    assert(traversalRes1.status === 403 || traversalRes1.status === 404);

    const traversalRes2 = await fetch(`${server.url}/%2e%2e/package.json`);
    assert(traversalRes2.status === 403 || traversalRes2.status === 404);

    // 3. Non-existent file serves 404
    const notFoundRes = await fetch(`${server.url}/nonexistent.html`);
    assert.strictEqual(notFoundRes.status, 404);
  } finally {
    await server.close();
  }
});

test('crops the header at the three widths and pairs 1440 with desktop and 375 with mobile', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-out-'));
  const sections = [
    {
      name: 'header',
      selector: 'header.site-header',
      page: 'index.html'
    }
  ];

  try {
    const shots = await shootSections({
      repoDir: FIXTURES_SITE_DIR,
      sections,
      outDir
    });

    assert.strictEqual(shots.length, 3);

    const shot375 = shots.find((s) => s.width === 375);
    const shot768 = shots.find((s) => s.width === 768);
    const shot1440 = shots.find((s) => s.width === 1440);

    assert(shot375, 'Expected 375 shot');
    assert.strictEqual(shot375.section, 'header');
    assert.strictEqual(shot375.figma, 'mobile');
    assert(fs.existsSync(path.join(outDir, shot375.file)));
    assert(fs.statSync(path.join(outDir, shot375.file)).size > 0);

    assert(shot768, 'Expected 768 shot');
    assert.strictEqual(shot768.section, 'header');
    assert.strictEqual(shot768.figma, undefined);
    assert(fs.existsSync(path.join(outDir, shot768.file)));
    assert(fs.statSync(path.join(outDir, shot768.file)).size > 0);

    assert(shot1440, 'Expected 1440 shot');
    assert.strictEqual(shot1440.section, 'header');
    assert.strictEqual(shot1440.figma, 'desktop');
    assert(fs.existsSync(path.join(outDir, shot1440.file)));
    assert(fs.statSync(path.join(outDir, shot1440.file)).size > 0);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a missing selector is reported, not thrown', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-missing-'));
  const sections = [
    {
      name: 'missing-section',
      selector: '.completely-missing-selector',
      page: 'index.html'
    }
  ];

  const startTime = Date.now();
  try {
    const shots = await shootSections({
      repoDir: FIXTURES_SITE_DIR,
      sections,
      outDir
    });

    const elapsed = Date.now() - startTime;
    // Should resolve within ~5 seconds per item, well below 30s timeout
    assert(elapsed < 20000, `Took too long: ${elapsed}ms`);

    assert.strictEqual(shots.length, 3);
    for (const shot of shots) {
      assert.strictEqual(shot.section, 'missing-section');
      assert.strictEqual(shot.error, 'selector not found');
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('smoke flags horizontal overflow and a console error', async () => {
  const pages = ['overflow.html', 'error.html'];
  const res = await smoke({
    repoDir: FIXTURES_SITE_DIR,
    pages
  });

  assert.strictEqual(res.ok, false);
  assert(res.problems.length >= 2, `Expected at least 2 problems, got ${res.problems.length}`);

  const overflowProblem = res.problems.find((p) => p.includes('overflow.html') && p.includes('overflow'));
  assert(overflowProblem, `Expected overflow problem, got: ${res.problems.join('\n')}`);

  const errorProblem = res.problems.find((p) => p.includes('error.html') && p.includes('console'));
  assert(errorProblem, `Expected console error problem, got: ${res.problems.join('\n')}`);
});

test('smoke passes the clean fixture', async () => {
  const res = await smoke({
    repoDir: FIXTURES_SITE_DIR,
    pages: ['index.html']
  });

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.problems, []);
});
