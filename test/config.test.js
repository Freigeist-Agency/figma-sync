import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadMap, protectedGlobs, validate } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createTempRepo(mapContent, extraFiles = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-sync-test-'));
  if (mapContent !== null) {
    const mapDir = path.join(tmpDir, '.figma-sync');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.writeFileSync(path.join(mapDir, 'map.json'), typeof mapContent === 'string' ? mapContent : JSON.stringify(mapContent, null, 2));
  }
  for (const [relPath, content] of Object.entries(extraFiles)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return tmpDir;
}

test('loadMap accepts test/fixtures/map.json (the MTM shape) and rejects each invalid case above by message', () => {
  // 1. Accepts valid fixture
  const fixturePath = path.join(__dirname, 'fixtures', 'map.json');
  const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const validDir = createTempRepo(fixtureData);
  try {
    const map = loadMap(validDir);
    assert.strictEqual(map.fileKey, 'HFuZZUOKyUWmXb8yER287l');
    assert.strictEqual(map.tokens, 'css/tokens.css');
    assert.strictEqual(map.assets, 'assets');
    assert.strictEqual(map.sections.length, 2);
    assert.strictEqual(map.sections[0].name, 'nav');
    assert.deepStrictEqual(map.sections[0].frames, ['1:1', '1:2']);
  } finally {
    fs.rmSync(validDir, { recursive: true, force: true });
  }

  // 2. Missing map file
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-sync-empty-'));
  try {
    assert.throws(
      () => loadMap(emptyDir),
      (err) => {
        assert(err instanceof Error);
        assert.match(err.message, /map\.json|file/i);
        return true;
      }
    );
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  // 3. Missing top-level fields
  const baseMap = {
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

  for (const field of ['fileKey', 'tokens', 'assets', 'protected', 'sections']) {
    const invalid = { ...baseMap };
    delete invalid[field];
    const dir = createTempRepo(invalid);
    try {
      assert.throws(
        () => loadMap(dir),
        (err) => {
          assert(err instanceof Error);
          assert.match(err.message, new RegExp(field, 'i'));
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 4. Missing section fields
  for (const field of ['name', 'frames', 'files', 'selector', 'page']) {
    const invalidSection = { ...baseMap.sections[0] };
    delete invalidSection[field];
    const invalid = { ...baseMap, sections: [invalidSection] };
    const dir = createTempRepo(invalid);
    try {
      assert.throws(
        () => loadMap(dir),
        (err) => {
          assert(err instanceof Error);
          assert.match(err.message, new RegExp(field, 'i'));
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 5. Section without exactly 2 frames
  for (const badFrames of [[], ['1:1'], ['1:1', '1:2', '1:3']]) {
    const invalid = {
      ...baseMap,
      sections: [{ ...baseMap.sections[0], frames: badFrames }]
    };
    const dir = createTempRepo(invalid);
    try {
      assert.throws(
        () => loadMap(dir),
        (err) => {
          assert(err instanceof Error);
          assert.match(err.message, /frames/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 6. Duplicate section names
  const dupSections = {
    ...baseMap,
    sections: [
      { ...baseMap.sections[0], name: 'nav', frames: ['1:1', '1:2'] },
      { ...baseMap.sections[0], name: 'nav', frames: ['1:3', '1:4'] }
    ]
  };
  const dupSectionDir = createTempRepo(dupSections);
  try {
    assert.throws(
      () => loadMap(dupSectionDir),
      (err) => {
        assert(err instanceof Error);
        assert.match(err.message, /duplicate.*section|name/i);
        return true;
      }
    );
  } finally {
    fs.rmSync(dupSectionDir, { recursive: true, force: true });
  }

  // 7. Frame id in two sections
  const dupFrames = {
    ...baseMap,
    sections: [
      { ...baseMap.sections[0], name: 'nav', frames: ['1:1', '1:2'] },
      { ...baseMap.sections[0], name: 'footer', frames: ['1:2', '1:3'] }
    ]
  };
  const dupFrameDir = createTempRepo(dupFrames);
  try {
    assert.throws(
      () => loadMap(dupFrameDir),
      (err) => {
        assert(err instanceof Error);
        assert.match(err.message, /duplicate.*frame|frame.*id/i);
        return true;
      }
    );
  } finally {
    fs.rmSync(dupFrameDir, { recursive: true, force: true });
  }

  // 8. Section name not matching ^[a-z0-9-]+$
  for (const badName of ['NavHeader', 'nav_header', 'nav header', 'nav!']) {
    const badNameMap = {
      ...baseMap,
      sections: [{ ...baseMap.sections[0], name: badName }]
    };
    const badNameDir = createTempRepo(badNameMap);
    try {
      assert.throws(
        () => loadMap(badNameDir),
        (err) => {
          assert(err instanceof Error);
          assert.match(err.message, /name|\^\[a-z0-9\-\]\+\$/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(badNameDir, { recursive: true, force: true });
    }
  }
});

test('protectedGlobs always adds .github and .figma-sync', () => {
  const mapWithProtected = {
    protected: ['js/**', 'css/loader.css']
  };
  const result1 = protectedGlobs(mapWithProtected);
  assert(result1.includes('js/**'));
  assert(result1.includes('css/loader.css'));
  assert(result1.includes('.github/**'));
  assert(result1.includes('.figma-sync/**'));

  const mapEmpty = { protected: [] };
  const result2 = protectedGlobs(mapEmpty);
  assert.deepStrictEqual(result2, ['.github/**', '.figma-sync/**']);

  const mapUndefined = {};
  const result3 = protectedGlobs(mapUndefined);
  assert(result3.includes('.github/**'));
  assert(result3.includes('.figma-sync/**'));
});

test('validate reports a files glob that matches nothing', () => {
  const map = {
    fileKey: 'key1',
    tokens: 'tokens.css',
    assets: 'assets',
    protected: ['js/**'],
    sections: [
      {
        name: 'nav',
        frames: ['1:1', '1:2'],
        files: ['index.html', 'missing/*.css'],
        selector: 'header',
        page: 'index.html'
      }
    ]
  };

  const dir = createTempRepo(map, {
    'index.html': '<html><body><header></header></body></html>'
  });
  try {
    const res = validate(dir);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errors.length, 1);
    assert.match(res.errors[0], /missing\/\*\.css/);
    assert.match(res.errors[0], /matched no files|matches nothing|no files matched/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate reports a missing page', () => {
  const map = {
    fileKey: 'key1',
    tokens: 'tokens.css',
    assets: 'assets',
    protected: ['js/**'],
    sections: [
      {
        name: 'nav',
        frames: ['1:1', '1:2'],
        files: ['index.html'],
        selector: 'header',
        page: 'missing-page.html'
      }
    ]
  };

  const dir = createTempRepo(map, {
    'index.html': '<html><body><header></header></body></html>'
  });
  try {
    const res = validate(dir);
    assert.strictEqual(res.ok, false);
    assert.match(res.errors.join('\n'), /missing-page\.html/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate succeeds when all files globs and pages exist', () => {
  const map = {
    fileKey: 'key1',
    tokens: 'tokens.css',
    assets: 'assets',
    protected: ['js/**'],
    sections: [
      {
        name: 'nav',
        frames: ['1:1', '1:2'],
        files: ['index.html', 'css/*.css'],
        selector: 'header',
        page: 'index.html'
      }
    ]
  };

  const dir = createTempRepo(map, {
    'index.html': '<html><body><header></header></body></html>',
    'css/site.css': 'body { margin: 0; }'
  });
  try {
    const res = validate(dir);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
