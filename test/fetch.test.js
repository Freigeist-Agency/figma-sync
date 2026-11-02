import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runFetch } from '../src/fetch.js';
import { FigmaError } from '../src/figma.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeTempRepo(stateJson = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-sync-fetch-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.figma-sync'), { recursive: true });

  const map = loadFixture('map.json');
  fs.writeFileSync(path.join(tmpDir, '.figma-sync', 'map.json'), JSON.stringify(map, null, 2));

  if (stateJson !== null) {
    fs.writeFileSync(path.join(tmpDir, '.figma-sync', 'state.json'), typeof stateJson === 'string' ? stateJson : JSON.stringify(stateJson, null, 2));
  }

  return { tmpDir, map };
}

test('writes tree, renders and only the used fills for each due section', async () => {
  const { tmpDir, map } = makeTempRepo({ sections: {} });

  const readyFixture = loadFixture('nodes-ready.json');
  // Add an image fill to desktop nav (1:1), with imageRef "img-ref-1"
  readyFixture.nodes['1:1'].document.fills = [
    { type: 'IMAGE', imageRef: 'img-ref-1' }
  ];

  const downloads = [];
  const fakeFigma = {
    async getNodes(fileKey, ids) {
      return readyFixture;
    },
    async getRenders(fileKey, ids) {
      return {
        images: {
          '1:1': 'https://s3.example.com/nav-desktop.png',
          '1:2': 'https://s3.example.com/nav-mobile.png',
          '1:3': 'https://s3.example.com/footer-desktop.png',
          '1:4': 'https://s3.example.com/footer-mobile.png'
        }
      };
    },
    async getImageFills(fileKey) {
      return {
        meta: {
          images: {
            'img-ref-1': 'https://s3.example.com/used-fill.png',
            'img-ref-unused': 'https://s3.example.com/unused-fill.png'
          }
        }
      };
    },
    async download(url, dest) {
      downloads.push({ url, dest });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'fake-image-bytes');
      return dest;
    },
    async comment() {}
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'default-sha-100'; },
    async openSyncPr() { return null; },
    async fileAt() { return null; },
    async compareCommits() { return []; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: 'Updated header design',
      force: false
    });

    assert.deepStrictEqual(res.due, ['nav', 'footer']);
    assert(fs.existsSync(path.join(tmpDir, '.figma-sync', 'work', 'nav', 'tree.json')));
    assert(fs.existsSync(path.join(tmpDir, '.figma-sync', 'work', 'nav', 'desktop.png')));
    assert(fs.existsSync(path.join(tmpDir, '.figma-sync', 'work', 'nav', 'mobile.png')));
    assert(fs.existsSync(path.join(tmpDir, '.figma-sync', 'work', 'nav', 'fills', 'img-ref-1.png')));

    // Unused fill must NOT be downloaded
    assert.strictEqual(downloads.some(d => d.url.includes('unused-fill')), false);

    // .figma-sync/work/run.json
    const runJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.figma-sync', 'work', 'run.json'), 'utf8'));
    assert.strictEqual(runJson.changeMessage, 'Updated header design');
    assert.strictEqual(runJson.openPr, null);
    assert.strictEqual(runJson.due.length, 2);
    assert.strictEqual(runJson.due[0].name, 'nav');
    assert.deepStrictEqual(runJson.due[0].frames, ['1:1', '1:2']);

    // .git/info/exclude
    const excludeContent = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf8');
    assert(excludeContent.includes('.figma-sync/work/'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('comments only on the event\'s section', async () => {
  const readyFixture = loadFixture('nodes-ready.json');
  const { tmpDir, map } = makeTempRepo();

  const comments = [];
  const fakeFigma = {
    async getNodes() { return readyFixture; },
    async getRenders() { return { images: {} }; },
    async getImageFills() { return { meta: { images: {} } }; },
    async download() {},
    async comment(fileKey, nodeId, message) {
      comments.push({ fileKey, nodeId, message });
    }
  };

  // We set state.json to current hashes for both nav and footer, so both are unchanged
  const { trimNode, sectionHash } = await import('../src/trim.js');
  const navHash = sectionHash([
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ]);
  const footerHash = sectionHash([
    trimNode(readyFixture.nodes['1:3'].document),
    trimNode(readyFixture.nodes['1:4'].document)
  ]);

  fs.writeFileSync(
    path.join(tmpDir, '.figma-sync', 'state.json'),
    JSON.stringify({
      sections: {
        nav: { hash: navHash, frames: ['1:1', '1:2'] },
        footer: { hash: footerHash, frames: ['1:3', '1:4'] }
      }
    })
  );

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'default-sha-100'; },
    async openSyncPr() { return null; },
    async fileAt() { return null; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1', // Event on nav desktop frame
      changeMessage: '',
      force: false
    });

    assert.deepStrictEqual(res.due, []);
    // Exactly one comment on the event node '1:1', none on footer
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].nodeId, '1:1');
    assert.strictEqual(comments[0].message, 'Site already matches');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an unmapped event node gets the not-mapped comment and nothing is due', async () => {
  const { tmpDir, map } = makeTempRepo();
  const comments = [];
  let getNodesCalled = false;

  const fakeFigma = {
    async getNodes() {
      getNodesCalled = true;
      return { nodes: {} };
    },
    async comment(fileKey, nodeId, message) {
      comments.push({ fileKey, nodeId, message });
    }
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'head'; },
    async openSyncPr() { return null; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '999:999',
      changeMessage: '',
      force: false
    });

    assert.deepStrictEqual(res.due, []);
    assert.strictEqual(getNodesCalled, false);
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].nodeId, '999:999');
    assert.strictEqual(comments[0].message, "This section isn't mapped to the site yet.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('uses the open PR\'s state.json for last hashes', async () => {
  const readyFixture = loadFixture('nodes-ready.json');
  const { tmpDir, map } = makeTempRepo(); // local state is empty/missing

  const { trimNode, sectionHash } = await import('../src/trim.js');
  const navHash = sectionHash([
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ]);
  const footerHash = sectionHash([
    trimNode(readyFixture.nodes['1:3'].document),
    trimNode(readyFixture.nodes['1:4'].document)
  ]);

  const comments = [];
  const fakeFigma = {
    async getNodes() { return readyFixture; },
    async comment(fileKey, nodeId, message) {
      comments.push({ fileKey, nodeId, message });
    }
  };

  const prState = {
    sections: {
      nav: { hash: navHash, frames: ['1:1', '1:2'] },
      footer: { hash: footerHash, frames: ['1:3', '1:4'] }
    }
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'main-sha'; },
    async openSyncPr() {
      return { number: 42, headSha: 'pr-head-sha' };
    },
    async fileAt(filePath, ref) {
      if (filePath === '.figma-sync/state.json' && ref === 'pr-head-sha') {
        return JSON.stringify(prState);
      }
      return null;
    },
    async compareCommits() { return []; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: '',
      force: false
    });

    assert.deepStrictEqual(res.due, []);
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].nodeId, '1:1');
    assert.strictEqual(comments[0].message, 'No design change since #42');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('nothing due makes no render or fill calls', async () => {
  const readyFixture = loadFixture('nodes-ready.json');
  const { tmpDir, map } = makeTempRepo();

  const { trimNode, sectionHash } = await import('../src/trim.js');
  const navHash = sectionHash([
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ]);
  const footerHash = sectionHash([
    trimNode(readyFixture.nodes['1:3'].document),
    trimNode(readyFixture.nodes['1:4'].document)
  ]);

  fs.writeFileSync(
    path.join(tmpDir, '.figma-sync', 'state.json'),
    JSON.stringify({
      sections: {
        nav: { hash: navHash, frames: ['1:1', '1:2'] },
        footer: { hash: footerHash, frames: ['1:3', '1:4'] }
      }
    })
  );

  let renderCalled = false;
  let fillCalled = false;
  const fakeFigma = {
    async getNodes() { return readyFixture; },
    async getRenders() {
      renderCalled = true;
      return { images: {} };
    },
    async getImageFills() {
      fillCalled = true;
      return { meta: { images: {} } };
    },
    async comment() {}
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'head'; },
    async openSyncPr() { return null; },
    async fileAt() { return null; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: '',
      force: false
    });

    assert.deepStrictEqual(res.due, []);
    assert.strictEqual(renderCalled, false);
    assert.strictEqual(fillCalled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('with an open PR the work base is its head; with force it is the default head', async () => {
  const { tmpDir, map } = makeTempRepo({ sections: {} });
  const readyFixture = loadFixture('nodes-ready.json');

  const fakeFigma = {
    async getNodes() { return readyFixture; },
    async getRenders() { return { images: {} }; },
    async getImageFills() { return { meta: { images: {} } }; },
    async download() {},
    async comment() {}
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'default-head-sha'; },
    async openSyncPr() {
      return { number: 15, headSha: 'pr-head-sha' };
    },
    async fileAt() { return null; },
    async compareCommits() { return []; }
  };

  try {
    // 1. Without force -> base is open PR head
    const resNoForce = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: '',
      force: false
    });
    assert.strictEqual(resNoForce.base, 'pr-head-sha');

    // 2. With force -> base is default head
    const resForce = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: '',
      force: true
    });
    assert.strictEqual(resForce.base, 'default-head-sha');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an open PR with hand edits stops the run before any render call, with a comment', async () => {
  const { tmpDir, map } = makeTempRepo({ sections: {} });
  const readyFixture = loadFixture('nodes-ready.json');

  let renderCalled = false;
  const figmaComments = [];
  const ghPrComments = [];

  const fakeFigma = {
    async getNodes() { return readyFixture; },
    async getRenders() {
      renderCalled = true;
      return { images: {} };
    },
    async comment(fileKey, nodeId, message) {
      figmaComments.push({ fileKey, nodeId, message });
    }
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'default-sha'; },
    async openSyncPr() {
      return { number: 9, headSha: 'pr-head-sha' };
    },
    async compareCommits() {
      return [
        { sha: 'c1', committerEmail: 'human@agency.com' }
      ];
    },
    async prComment(number, body) {
      ghPrComments.push({ number, body });
    }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: '',
      force: false
    });

    assert.deepStrictEqual(res.due, []);
    assert.strictEqual(renderCalled, false);

    const expectedMsg = 'Sync not applied: #9 has hand edits; merge or close it, then re-mark';
    assert.strictEqual(ghPrComments.length, 1);
    assert.strictEqual(ghPrComments[0].number, 9);
    assert.strictEqual(ghPrComments[0].body, expectedMsg);

    assert.strictEqual(figmaComments.length, 1);
    assert.strictEqual(figmaComments[0].nodeId, '1:1');
    assert.strictEqual(figmaComments[0].message, expectedMsg);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a one-frame section requests only the desktop render', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-sync-fetch-1f-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.figma-sync'), { recursive: true });

  const map = {
    fileKey: 'key123',
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
  fs.writeFileSync(path.join(tmpDir, '.figma-sync', 'map.json'), JSON.stringify(map, null, 2));

  const nodesResponse = {
    nodes: {
      '1:1': {
        document: {
          id: '1:1',
          name: 'header-desktop',
          type: 'FRAME',
          devStatus: { type: 'READY_FOR_DEV' }
        }
      }
    }
  };

  let requestedRenderIds = null;
  const downloads = [];

  const fakeFigma = {
    async getNodes(fileKey, ids) {
      return nodesResponse;
    },
    async getRenders(fileKey, ids) {
      requestedRenderIds = ids;
      return {
        images: {
          '1:1': 'https://s3.example.com/header-desktop.png',
          undefined: 'https://s3.example.com/bogus-mobile.png'
        }
      };
    },
    async getImageFills() {
      return { meta: { images: {} } };
    },
    async download(url, dest) {
      downloads.push({ url, dest });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'desktop-image-data');
      return dest;
    },
    async comment() {}
  };

  const fakeGh = {
    async defaultBranch() { return 'main'; },
    async branchHead() { return 'sha-1'; },
    async openSyncPr() { return null; },
    async fileAt() { return null; },
    async compareCommits() { return []; }
  };

  try {
    const res = await runFetch({
      repoDir: tmpDir,
      map,
      figma: fakeFigma,
      gh: fakeGh,
      eventNodeId: '1:1',
      changeMessage: 'Desktop only header',
      force: false
    });

    assert.deepStrictEqual(res.due, ['header']);
    assert.deepStrictEqual(requestedRenderIds, ['1:1']);
    assert.strictEqual(downloads.length, 1);
    assert.strictEqual(downloads[0].url, 'https://s3.example.com/header-desktop.png');

    const headerDir = path.join(tmpDir, '.figma-sync', 'work', 'header');
    assert(fs.existsSync(path.join(headerDir, 'tree.json')));
    assert(fs.existsSync(path.join(headerDir, 'desktop.png')));
    assert.strictEqual(fs.existsSync(path.join(headerDir, 'mobile.png')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
