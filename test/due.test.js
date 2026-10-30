import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, withSynced } from '../src/state.js';
import { lastHashes, decide } from '../src/due.js';
import { trimNode, sectionHash } from '../src/trim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('readState handles null, empty, and valid JSON', () => {
  assert.deepStrictEqual(readState(null), { sections: {} });
  assert.deepStrictEqual(readState(''), { sections: {} });
  assert.deepStrictEqual(readState('{}'), { sections: {} });

  const validJson = JSON.stringify({
    sections: {
      nav: {
        hash: 'hash123',
        frames: ['1:1', '1:2'],
        syncedAt: '2026-10-30T09:00:00.000Z'
      }
    }
  });

  const state = readState(validJson);
  assert.strictEqual(state.sections.nav.hash, 'hash123');
  assert.deepStrictEqual(state.sections.nav.frames, ['1:1', '1:2']);
});

test('withSynced updates state immutably', () => {
  const initial = { sections: {} };
  const updated = withSynced(initial, 'nav', { hash: 'hash1', frames: ['1:1', '1:2'] }, '2026-10-30T10:00:00.000Z');

  assert.deepStrictEqual(initial, { sections: {} });
  assert.strictEqual(updated.sections.nav.hash, 'hash1');
  assert.deepStrictEqual(updated.sections.nav.frames, ['1:1', '1:2']);
  assert.strictEqual(updated.sections.nav.syncedAt, '2026-10-30T10:00:00.000Z');
});

test('lastHashes prefers open PR state over default state', () => {
  const defaultState = {
    sections: {
      nav: { hash: 'stale-nav-hash', frames: ['1:1', '1:2'], syncedAt: '...' },
      footer: { hash: 'footer-hash', frames: ['1:3', '1:4'], syncedAt: '...' }
    }
  };

  const openPrState = {
    sections: {
      nav: { hash: 'current-pr-nav-hash', frames: ['1:1', '1:2'], syncedAt: '...' }
    }
  };

  const hashes = lastHashes(openPrState, defaultState);
  assert.strictEqual(hashes.nav, 'current-pr-nav-hash');
  assert.strictEqual(hashes.footer, 'footer-hash');

  const withNullPr = lastHashes(null, defaultState);
  assert.strictEqual(withNullPr.nav, 'stale-nav-hash');
  assert.strictEqual(withNullPr.footer, 'footer-hash');
});

test('only both frames ready makes a section due', () => {
  const map = loadFixture('map.json');
  const halfReadyFixture = loadFixture('nodes-half-ready.json');

  const result = decide(map, halfReadyFixture, {});

  // Nav has only frame 1:1 ready (1:2 is NONE), so nav is notReady
  assert(result.notReady.includes('nav'));
  assert.strictEqual(result.due.some((s) => s.name === 'nav'), false);

  // Footer has both 1:3 and 1:4 ready, so footer is due
  assert(result.due.some((s) => s.name === 'footer'));
});

test('an unchanged hash is not due unless forced', () => {
  const map = loadFixture('map.json');
  const readyFixture = loadFixture('nodes-ready.json');

  const navTrimmed = [
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ];
  const navHash = sectionHash(navTrimmed);

  // 1. When hash matches lastHashes, it is unchanged
  const resultUnchanged = decide(map, readyFixture, { nav: navHash }, { force: false });
  assert(resultUnchanged.unchanged.includes('nav'));
  assert.strictEqual(resultUnchanged.due.some((s) => s.name === 'nav'), false);

  // 2. When forced is true, it is due despite matching hash
  const resultForced = decide(map, readyFixture, { nav: navHash }, { force: true });
  assert.strictEqual(resultForced.unchanged.includes('nav'), false);
  assert(resultForced.due.some((s) => s.name === 'nav'));
});

test("due compares against the open PR's hashes", () => {
  const map = loadFixture('map.json');
  const readyFixture = loadFixture('nodes-ready.json');

  const navTrimmed = [
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ];
  const navHash = sectionHash(navTrimmed);

  const defaultState = {
    sections: {
      nav: { hash: 'stale-hash-from-main', frames: ['1:1', '1:2'] }
    }
  };

  const openPrState = {
    sections: {
      nav: { hash: navHash, frames: ['1:1', '1:2'] }
    }
  };

  const hashes = lastHashes(openPrState, defaultState);
  const result = decide(map, readyFixture, hashes);

  // Default state is stale, but PR state has current hash -> unchanged, not due
  assert(result.unchanged.includes('nav'));
  assert.strictEqual(result.due.some((s) => s.name === 'nav'), false);
});

test('a null node makes the section missing, not due', () => {
  const map = loadFixture('map.json');
  const missingFixture = loadFixture('nodes-missing.json');

  const result = decide(map, missingFixture, {});

  // In nodes-missing.json, frame 1:2 is null
  assert.deepStrictEqual(result.missing, [{ name: 'nav', frameId: '1:2' }]);
  assert.strictEqual(result.due.some((s) => s.name === 'nav'), false);
  assert.strictEqual(result.notReady.includes('nav'), false);

  // Other sections (footer) are still decided
  assert(result.due.some((s) => s.name === 'footer'));
});
