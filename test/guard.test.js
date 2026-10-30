import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { protectedViolations, runGuard } from '../src/guard.js';
import { protectedGlobs } from '../src/config.js';

test('flags js/** and css/loader.css but not css/site.css', () => {
  const mtmMap = {
    protected: [
      'js/**',
      'css/loader.css',
      'css/orbit.css',
      'css/carousel.css',
      'css/menu.css',
      'tests/**'
    ]
  };

  const changedFiles = [
    'js/app.js',
    'css/loader.css',
    'css/site.css',
    'index.html'
  ];

  const globs = protectedGlobs(mtmMap);
  const violations = protectedViolations(changedFiles, globs);

  assert.deepStrictEqual(violations, ['js/app.js', 'css/loader.css']);
});

test('flags a new untracked file under .github', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-guard-test-'));

  try {
    execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
    execSync('git add index.html && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

    const baseSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    // Create an untracked dotfile under .github
    const ghDir = path.join(tmpDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, '.sync.yml'), 'name: sync');

    const map = {
      fileKey: 'test-file-key',
      tokens: 'css/tokens.css',
      assets: 'assets',
      protected: ['js/**'],
      sections: [
        {
          name: 'nav',
          frames: ['1:1', '1:2'],
          files: ['index.html'],
          selector: 'header',
          page: 'index.html'
        }
      ]
    };

    const comments = [];
    const fakeFigma = {
      async comment(fileKey, nodeId, message) {
        comments.push({ fileKey, nodeId, message });
      }
    };

    const violations = await runGuard({
      repoDir: tmpDir,
      base: baseSha,
      sectionName: 'nav',
      map,
      figma: fakeFigma
    });

    assert(violations.includes('.github/.sync.yml'));
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].fileKey, 'test-file-key');
    assert.strictEqual(comments[0].nodeId, '1:1');
    assert.strictEqual(
      comments[0].message,
      'Sync stopped: it changed protected files: .github/.sync.yml'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('flags .figma-sync/state.json even if the map does not list it', () => {
  const mapWithoutEngineProtected = {
    protected: ['js/**']
  };

  const globs = protectedGlobs(mapWithoutEngineProtected);
  const changedFiles = ['.figma-sync/state.json', 'index.html'];

  const violations = protectedViolations(changedFiles, globs);
  assert.deepStrictEqual(violations, ['.figma-sync/state.json']);
});

test('guard returns empty array when clean', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-guard-clean-'));

  try {
    execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
    execSync('git add index.html && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
    const baseSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

    // Modify a non-protected file
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Updated</h1>');

    const map = {
      fileKey: 'test-file-key',
      tokens: 'css/tokens.css',
      assets: 'assets',
      protected: ['js/**'],
      sections: [
        {
          name: 'nav',
          frames: ['1:1', '1:2'],
          files: ['index.html'],
          selector: 'header',
          page: 'index.html'
        }
      ]
    };

    const comments = [];
    const fakeFigma = {
      async comment(fileKey, nodeId, message) {
        comments.push({ fileKey, nodeId, message });
      }
    };

    const violations = await runGuard({
      repoDir: tmpDir,
      base: baseSha,
      sectionName: 'nav',
      map,
      figma: fakeFigma
    });

    assert.deepStrictEqual(violations, []);
    assert.strictEqual(comments.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a base git cannot diff stops the guard instead of passing it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-guard-badbase-'));
  try {
    execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
    const map = { fileKey: 'k', protected: [], sections: [] };
    await assert.rejects(runGuard({ repoDir: tmpDir, base: 'deadbeef', sectionName: 'nav', map }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
