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

function createLoaderSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-loader-site-'));
  const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    section.target {
      width: 100px;
      height: 100px;
      background: #ccc;
    }
    html.is-loaded section.target {
      width: 400px;
    }
  </style>
</head>
<body>
  <section class="target">Content</section>
  <script>
    setTimeout(() => {
      document.documentElement.classList.add('is-loaded');
    }, 300);
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

test('ready waits for the site before the shot', async () => {
  const siteDir = createLoaderSite();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-ready-'));
  const sections = [
    {
      name: 'target',
      selector: 'section.target',
      page: 'index.html'
    }
  ];

  try {
    const shots = await shootSections({
      repoDir: siteDir,
      sections,
      outDir,
      ready: 'html.is-loaded'
    });

    assert.strictEqual(shots.length, 3);
    for (const shot of shots) {
      assert(shot.file, `Expected shot.file for width ${shot.width}`);
      const buf = fs.readFileSync(path.join(outDir, shot.file));
      const width = buf.readUInt32BE(16);
      assert.strictEqual(width, 400);
    }
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('without ready the shot is taken at load', async () => {
  const siteDir = createLoaderSite();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-noready-'));
  const sections = [
    {
      name: 'target',
      selector: 'section.target',
      page: 'index.html'
    }
  ];

  try {
    const shots = await shootSections({
      repoDir: siteDir,
      sections,
      outDir
    });

    assert.strictEqual(shots.length, 3);
    for (const shot of shots) {
      assert(shot.file, `Expected shot.file for width ${shot.width}`);
      const buf = fs.readFileSync(path.join(outDir, shot.file));
      const width = buf.readUInt32BE(16);
      assert.strictEqual(width, 100);
    }
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a page that never becomes ready records an error and no file', async () => {
  const siteDir = createLoaderSite();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-never-'));
  const sections = [
    {
      name: 'target',
      selector: 'section.target',
      page: 'index.html'
    }
  ];

  try {
    const shots = await shootSections({
      repoDir: siteDir,
      sections,
      outDir,
      ready: 'html.never',
      readyTimeout: 100
    });

    assert.strictEqual(shots.length, 3);
    for (const shot of shots) {
      assert.match(shot.error, /never became ready/);
      assert.strictEqual(shot.file, undefined);
    }
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.png'));
    assert.strictEqual(files.length, 0);
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createLazySite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lazy-site-'));
  fs.writeFileSync(path.join(dir, 'pixel.png'), Buffer.from(PIXEL_PNG_BASE64, 'base64'));
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>initial</title>
  <style>
    body {
      margin: 0;
    }
    .spacer {
      height: 3000px;
      margin-bottom: 1000px;
    }
    section.lazy-target {
      width: 400px;
      height: 100px;
      background: #eee;
    }
  </style>
</head>
<body>
  <div class="spacer"></div>
  <section class="lazy-target">
    <img loading="lazy" src="pixel.png" width="400" height="100">
  </section>
  <script>
    const img = document.querySelector('img');
    const sec = document.querySelector('section.lazy-target');
    img.addEventListener('load', () => {
      if (img.complete && img.naturalWidth > 0) {
        sec.setAttribute('data-loaded', 'true');
        document.title = 'loaded';
      }
    });
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

test('a lazy image below the fold is loaded before the shot', async () => {
  const siteDir = createLazySite();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-shots-lazy-'));
  const sections = [
    {
      name: 'lazy',
      selector: 'section.lazy-target',
      page: 'index.html'
    }
  ];

  const titles = [];
  const loadedAttrs = [];
  try {
    const shots = await shootSections({
      repoDir: siteDir,
      sections,
      outDir,
      onBeforeShot: async (page, section) => {
        titles.push(await page.title());
        loadedAttrs.push(await page.locator(section.selector).getAttribute('data-loaded'));
      }
    });

    assert.strictEqual(shots.length, 3);
    for (const shot of shots) {
      assert.strictEqual(shot.error, undefined);
      assert(shot.file, `Expected shot.file for width ${shot.width}`);
      assert(fs.existsSync(path.join(outDir, shot.file)));
    }
    assert.strictEqual(titles.length, 3);
    for (const title of titles) {
      assert.strictEqual(title, 'loaded');
    }
    assert.strictEqual(loadedAttrs.length, 3);
    for (const attr of loadedAttrs) {
      assert.strictEqual(attr, 'true');
    }
  } finally {
    fs.rmSync(siteDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});


