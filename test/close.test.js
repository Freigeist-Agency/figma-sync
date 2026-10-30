import test from 'node:test';
import assert from 'node:assert/strict';
import { runClosed } from '../src/close.js';

test('closed merged comments Shipped on the synced sections only', async () => {
  const map = {
    fileKey: 'testFileKey',
    sections: [
      { name: 'nav', frames: ['1:1', '1:2'] },
      { name: 'footer', frames: ['1:3', '1:4'] }
    ]
  };

  // State at baseSha has nav at hash-1, footer at hash-2
  const baseStateJson = JSON.stringify({
    sections: {
      nav: { hash: 'hash-1', frames: ['1:1', '1:2'] },
      footer: { hash: 'hash-2', frames: ['1:3', '1:4'] }
    }
  });

  // State at headSha has nav updated to hash-1-new, footer remains hash-2
  const headStateJson = JSON.stringify({
    sections: {
      nav: { hash: 'hash-1-new', frames: ['1:1', '1:2'] },
      footer: { hash: 'hash-2', frames: ['1:3', '1:4'] }
    }
  });

  const gh = {
    async fileAt(filePath, ref) {
      if (ref === 'base123') return baseStateJson;
      if (ref === 'head456') return headStateJson;
      return null;
    },
    async deleteBranch() {
      throw new Error('deleteBranch should not be called when merged');
    }
  };

  const figmaComments = [];
  const figma = {
    async comment(fileKey, nodeId, message) {
      figmaComments.push({ fileKey, nodeId, message });
    }
  };

  const res = await runClosed({
    pr: {
      number: 42,
      merged: true,
      baseSha: 'base123',
      headSha: 'head456'
    },
    gh,
    figma,
    map
  });

  assert.deepStrictEqual(res.syncedSections, ['nav']);
  assert.strictEqual(res.merged, true);

  // Exactly 1 comment on nav's desktop frame (1:1)
  assert.strictEqual(figmaComments.length, 1);
  assert.strictEqual(figmaComments[0].fileKey, 'testFileKey');
  assert.strictEqual(figmaComments[0].nodeId, '1:1');
  assert.strictEqual(figmaComments[0].message, 'Shipped in #42 — mark Completed');
});

test('closed unmerged deletes the branch and comments Not shipped', async () => {
  const map = {
    fileKey: 'testFileKey',
    sections: [
      { name: 'nav', frames: ['1:1', '1:2'] },
      { name: 'footer', frames: ['1:3', '1:4'] }
    ]
  };

  const baseStateJson = JSON.stringify({
    sections: {
      nav: { hash: 'hash-1', frames: ['1:1', '1:2'] },
      footer: { hash: 'hash-2', frames: ['1:3', '1:4'] }
    }
  });

  const headStateJson = JSON.stringify({
    sections: {
      nav: { hash: 'hash-1-new', frames: ['1:1', '1:2'] },
      footer: { hash: 'hash-2', frames: ['1:3', '1:4'] }
    }
  });

  let deletedBranch = null;
  const gh = {
    async fileAt(filePath, ref) {
      if (ref === 'base123') return baseStateJson;
      if (ref === 'head456') return headStateJson;
      return null;
    },
    async deleteBranch(name) {
      deletedBranch = name;
    }
  };

  const figmaComments = [];
  const figma = {
    async comment(fileKey, nodeId, message) {
      figmaComments.push({ fileKey, nodeId, message });
    }
  };

  const res = await runClosed({
    pr: {
      number: 99,
      merged: false,
      baseSha: 'base123',
      headSha: 'head456'
    },
    gh,
    figma,
    map
  });

  assert.deepStrictEqual(res.syncedSections, ['nav']);
  assert.strictEqual(res.merged, false);
  assert.strictEqual(deletedBranch, 'figma-sync/run');

  // Comment on nav's desktop frame
  assert.strictEqual(figmaComments.length, 1);
  assert.strictEqual(figmaComments[0].fileKey, 'testFileKey');
  assert.strictEqual(figmaComments[0].nodeId, '1:1');
  assert.strictEqual(figmaComments[0].message, 'Not shipped (#99 closed) — re-mark Ready for dev to try again');
});
