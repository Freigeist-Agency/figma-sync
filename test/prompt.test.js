import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPrompt, writeSectionPrompt } from '../src/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('buildPrompt names every file of the section and the work dir, and leaves no {{ }} unfilled', () => {
  const map = loadFixture('map.json');
  const section = map.sections[0]; // nav
  const workDir = '/test/repo/.figma-sync/work';

  const prompt = buildPrompt(map, section, workDir);

  // Assert all section files are named
  for (const file of section.files) {
    assert(
      prompt.includes(file),
      `Expected prompt to include section file: ${file}`
    );
  }

  // Assert workDir is named (workDir/section name)
  const expectedSectionWorkDir = path.join(workDir, section.name);
  assert(
    prompt.includes(expectedSectionWorkDir),
    `Expected prompt to include section work dir: ${expectedSectionWorkDir}`
  );

  // Assert section name, selector, page, tokens, assets are included
  assert(prompt.includes(section.name));
  assert(prompt.includes(section.selector));
  assert(prompt.includes(section.page));
  assert(prompt.includes(map.tokens));
  assert(prompt.includes(map.assets));

  // Assert protected files list is included (including .github/** and .figma-sync/**)
  assert(prompt.includes('.github/**'));
  assert(prompt.includes('.figma-sync/**'));
  for (const prot of map.protected) {
    assert(prompt.includes(prot));
  }

  // Assert no unresolved template placeholders {{...}} remain
  const unfilledMatch = prompt.match(/\{\{[a-zA-Z0-9_-]+\}\}/g);
  assert.strictEqual(
    unfilledMatch,
    null,
    `Found unfilled placeholders: ${unfilledMatch ? unfilledMatch.join(', ') : ''}`
  );
});

test('writeSectionPrompt writes prompt.md under work dir and returns file path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-prompt-test-'));
  const map = loadFixture('map.json');
  const section = map.sections[0];

  try {
    const writtenPath = writeSectionPrompt(tmpDir, map, section.name);
    const expectedPath = path.join(tmpDir, '.figma-sync', 'work', section.name, 'prompt.md');

    assert.strictEqual(writtenPath, expectedPath);
    assert(fs.existsSync(writtenPath));

    const content = fs.readFileSync(writtenPath, 'utf8');
    assert(content.includes(section.name));
    assert(content.includes(section.selector));
    assert(!/\{\{[a-zA-Z0-9_-]+\}\}/.test(content));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('the prompt for a one-frame section says there is no mobile design', () => {
  const map = {
    fileKey: 'key1',
    tokens: 'tokens.css',
    assets: 'assets',
    protected: ['js/**'],
    sections: [
      {
        name: 'header',
        frames: ['1:1'],
        files: ['index.html'],
        selector: 'header',
        page: 'index.html'
      }
    ]
  };
  const section = map.sections[0];
  const workDir = '/test/repo/.figma-sync/work';

  const prompt = buildPrompt(map, section, workDir);

  assert(prompt.includes('there is no mobile design. Keep the existing mobile layout working, do not redesign it.'));
  assert(prompt.includes('(present only when the section has a mobile frame)'));
  assert.strictEqual(prompt.match(/\{\{[a-zA-Z0-9_-]+\}\}/g), null);
});

test('the prompt for a two-frame section keeps the mobile design', () => {
  const map = {
    fileKey: 'key1',
    tokens: 'tokens.css',
    assets: 'assets',
    protected: ['js/**'],
    sections: [
      {
        name: 'header',
        frames: ['1:1', '1:2'],
        files: ['index.html'],
        selector: 'header',
        page: 'index.html'
      }
    ]
  };

  const prompt = buildPrompt(map, map.sections[0], '/test/repo/.figma-sync/work');

  assert(prompt.includes('`mobile.png` is the mobile frame at its own width.'));
  assert(!prompt.includes('there is no mobile design'));
});
