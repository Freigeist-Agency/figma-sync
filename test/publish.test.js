import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { prTitle, prBody, preparePublish } from '../src/publish.js';

test('prTitle flags failing checks', () => {
  // 1. Checks pass -> standard title
  const passTitle = prTitle(['nav', 'footer'], true);
  assert.strictEqual(passTitle, 'Figma: nav, footer');

  // 2. Checks fail -> title with [checks failing] prefix
  const failTitle = prTitle(['nav', 'footer'], false);
  assert.strictEqual(failTitle, '[checks failing] Figma: nav, footer');

  const singleFail = prTitle(['nav'], false);
  assert.strictEqual(singleFail, '[checks failing] Figma: nav');
});

test('prBody links every frame, embeds the review images, and includes each report', () => {
  const body = prBody({
    changeMessage: 'Updated navbar and footer styles',
    sections: [
      {
        name: 'nav',
        frames: ['1:1', '1:2'],
        selector: 'header.site-header',
        page: 'index.html'
      },
      {
        name: 'footer',
        frames: ['1:3', '1:4'],
        selector: 'footer.site-footer',
        page: 'index.html'
      }
    ],
    fileKey: 'HFuZZUOKyUWmXb8yER287l',
    shots: [
      { section: 'nav', width: 1440, file: 'nav-1440.png', figma: 'desktop' },
      { section: 'nav', width: 375, file: 'nav-375.png', figma: 'mobile' },
      { section: 'nav', width: 768, file: 'nav-768.png' },
      { section: 'footer', width: 1440, file: 'footer-1440.png', figma: 'desktop' },
      { section: 'footer', width: 375, file: 'footer-375.png', figma: 'mobile' },
      { section: 'footer', width: 768, file: 'footer-768.png' }
    ],
    reviewBase: 'https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345',
    reports: {
      nav: 'Navbar updated with modern font-size and padding.',
      footer: 'Footer links aligned and copyright year updated.'
    },
    guardOk: true,
    checks: {
      ok: true,
      problems: []
    }
  });

  // Designer change message
  assert(body.includes('Updated navbar and footer styles'));

  // Links every frame with : -> -
  assert(body.includes('https://www.figma.com/design/HFuZZUOKyUWmXb8yER287l/?node-id=1-1'));
  assert(body.includes('https://www.figma.com/design/HFuZZUOKyUWmXb8yER287l/?node-id=1-2'));
  assert(body.includes('https://www.figma.com/design/HFuZZUOKyUWmXb8yER287l/?node-id=1-3'));
  assert(body.includes('https://www.figma.com/design/HFuZZUOKyUWmXb8yER287l/?node-id=1-4'));

  // Embeds review images with reviewBase
  assert(body.includes('https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345/nav-1440.png'));
  assert(body.includes('https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345/nav-375.png'));
  assert(body.includes('https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345/nav-768.png'));
  assert(body.includes('https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345/footer-1440.png'));

  // Includes each section report
  assert(body.includes('Navbar updated with modern font-size and padding.'));
  assert(body.includes('Footer links aligned and copyright year updated.'));

  // Includes guard and checks
  assert(body.includes('Guard'));
  assert(body.includes('Checks'));
});

function setupGitRepoWithOrigin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-pub-test-'));
  const bareDir = path.join(tmp, 'bare.git');
  const repoDir = path.join(tmp, 'repo');

  execFileSync('git', ['init', '--bare', bareDir]);
  fs.mkdirSync(repoDir);
  execFileSync('git', ['init', '-b', 'main', repoDir]);
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir });

  // Initial map and state
  const mapDir = path.join(repoDir, '.figma-sync');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'map.json'),
    JSON.stringify({
      fileKey: 'key123',
      tokens: 'tokens.css',
      assets: 'assets',
      sections: [
        { name: 'nav', frames: ['1:1', '1:2'], selector: 'header', page: 'index.html' },
        { name: 'footer', frames: ['1:3', '1:4'], selector: 'footer', page: 'index.html' }
      ]
    })
  );

  fs.writeFileSync(
    path.join(mapDir, 'state.json'),
    JSON.stringify({
      sections: {
        nav: { hash: 'hash-nav-old', frames: ['1:1', '1:2'], syncedAt: '2026-10-20T00:00:00Z' }
      }
    })
  );

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit with nav state'], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return { tmp, bareDir, repoDir };
}

test('prepare-publish lists sections carried over from the open PR in the title', async () => {
  const { tmp, repoDir } = setupGitRepoWithOrigin();
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Create a work branch that carries over nav: hash-nav-carried and updates footer: hash-footer-new
    execFileSync('git', ['checkout', '-b', 'work-branch'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'some change\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    // Section job commits with exact subject: figma-sync: footer
    execFileSync('git', ['commit', '-m', 'figma-sync: footer'], { cwd: repoDir });
    const workRef = 'work-branch';

    // Switch back to main (simulating publish job checkout default branch and squash-merge)
    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

    // The working tree has open PR state before prepare-publish writes to it:
    // nav has hash-nav-carried (differs from main's hash-nav-old)
    fs.writeFileSync(
      path.join(repoDir, '.figma-sync', 'state.json'),
      JSON.stringify({
        sections: {
          nav: { hash: 'hash-nav-carried', frames: ['1:1', '1:2'], syncedAt: '2026-10-25T00:00:00Z' }
        }
      })
    );

    // Setup .figma-sync/work/run.json
    const workDir = path.join(repoDir, '.figma-sync', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'run.json'),
      JSON.stringify({
        changeMessage: 'Updated footer',
        due: [
          { name: 'footer', hash: 'hash-footer-new', frames: ['1:3', '1:4'] }
        ]
      })
    );

    const map = JSON.parse(fs.readFileSync(path.join(repoDir, '.figma-sync', 'map.json'), 'utf8'));

    const res = await preparePublish({
      repoDir,
      base: baseSha,
      workRef,
      map,
      figma: { comment: async () => {} },
      repo: 'org/repo',
      runId: '100'
    });

    assert.strictEqual(res.skip, false);
    // Title lists BOTH footer (diff in this run) AND nav (carried over from open PR)
    assert(res.title.includes('footer'), `Expected title to include footer: ${res.title}`);
    assert(res.title.includes('nav'), `Expected title to include nav: ${res.title}`);

    // Verify .figma-sync/state.json was updated with footer
    const newState = JSON.parse(fs.readFileSync(path.join(repoDir, '.figma-sync', 'state.json'), 'utf8'));
    assert.strictEqual(newState.sections.footer.hash, 'hash-footer-new');
    assert.strictEqual(newState.sections.nav.hash, 'hash-nav-carried');

    // Verify pr-body.md was written
    assert(fs.existsSync(path.join(workDir, 'pr-body.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepare-publish skips with a comment when no section changed anything', async () => {
  const { tmp, repoDir } = setupGitRepoWithOrigin();
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Create a work branch with no figma-sync: <section> commit
    execFileSync('git', ['checkout', '-b', 'empty-work-branch'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'unrelated.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'chore: unrelated change'], { cwd: repoDir });
    const workRef = 'empty-work-branch';

    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

    const workDir = path.join(repoDir, '.figma-sync', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'run.json'),
      JSON.stringify({
        changeMessage: 'No change',
        due: [
          { name: 'nav', hash: 'hash-nav-new', frames: ['1:1', '1:2'] }
        ]
      })
    );

    const comments = [];
    const fakeFigma = {
      comment: async (fileKey, nodeId, message) => {
        comments.push({ fileKey, nodeId, message });
      }
    };

    const map = JSON.parse(fs.readFileSync(path.join(repoDir, '.figma-sync', 'map.json'), 'utf8'));

    const res = await preparePublish({
      repoDir,
      base: baseSha,
      workRef,
      map,
      figma: fakeFigma,
      repo: 'org/repo',
      runId: '101',
      runUrl: 'https://github.com/org/repo/actions/runs/101'
    });

    assert.strictEqual(res.skip, true);
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].nodeId, '1:1');
    assert.strictEqual(comments[0].message, 'Sync made no changes; see https://github.com/org/repo/actions/runs/101');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepare-publish pushes the shots to figma-sync-review under runs/<runId>', async () => {
  const { tmp, bareDir, repoDir } = setupGitRepoWithOrigin();
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-b', 'shots-work-branch'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'change.txt'), 'diff\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'figma-sync: nav'], { cwd: repoDir });
    const workRef = 'shots-work-branch';

    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

    const workDir = path.join(repoDir, '.figma-sync', 'work');
    const shotsDir = path.join(workDir, 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, 'nav-1440.png'), 'fake-png-1440');
    fs.writeFileSync(path.join(shotsDir, 'nav-375.png'), 'fake-png-375');

    fs.writeFileSync(
      path.join(workDir, 'run.json'),
      JSON.stringify({
        changeMessage: 'Updated nav',
        due: [
          { name: 'nav', hash: 'hash-nav-new', frames: ['1:1', '1:2'] }
        ]
      })
    );

    const map = JSON.parse(fs.readFileSync(path.join(repoDir, '.figma-sync', 'map.json'), 'utf8'));

    const res = await preparePublish({
      repoDir,
      base: baseSha,
      workRef,
      map,
      figma: { comment: async () => {} },
      repo: 'org/repo',
      runId: '456'
    });

    assert.strictEqual(res.skip, false);

    // Verify bare origin has figma-sync-review branch with runs/456/*.png
    const filesInReview = execFileSync('git', ['ls-tree', '-r', '--name-only', 'figma-sync-review'], {
      cwd: bareDir,
      encoding: 'utf8'
    });

    assert(filesInReview.includes('runs/456/nav-1440.png'), `Expected nav-1440.png in review branch: ${filesInReview}`);
    assert(filesInReview.includes('runs/456/nav-375.png'), `Expected nav-375.png in review branch: ${filesInReview}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepare-publish --dry-run pushes nothing', async () => {
  const { tmp, bareDir, repoDir } = setupGitRepoWithOrigin();
  try {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-b', 'dry-run-branch'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'change.txt'), 'diff\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'figma-sync: nav'], { cwd: repoDir });
    const workRef = 'dry-run-branch';

    execFileSync('git', ['checkout', 'main'], { cwd: repoDir });

    const workDir = path.join(repoDir, '.figma-sync', 'work');
    const shotsDir = path.join(workDir, 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(path.join(shotsDir, 'nav-1440.png'), 'fake-png-1440');

    fs.writeFileSync(
      path.join(workDir, 'run.json'),
      JSON.stringify({
        changeMessage: 'Updated nav',
        due: [
          { name: 'nav', hash: 'hash-nav-new', frames: ['1:1', '1:2'] }
        ]
      })
    );

    const map = JSON.parse(fs.readFileSync(path.join(repoDir, '.figma-sync', 'map.json'), 'utf8'));

    const res = await preparePublish({
      repoDir,
      base: baseSha,
      workRef,
      map,
      figma: { comment: async () => {} },
      repo: 'org/repo',
      runId: '789',
      dryRun: true
    });

    assert.strictEqual(res.skip, false);
    assert(res.title.includes('nav'));
    assert(fs.existsSync(res.prBodyPath));

    // Bare origin should NOT have figma-sync-review branch
    const branches = execFileSync('git', ['branch', '-a'], { cwd: bareDir, encoding: 'utf8' });
    assert(!branches.includes('figma-sync-review'), `Expected no figma-sync-review branch: ${branches}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a desktop-only section shows no mobile frame link', () => {
  const body = prBody({
    changeMessage: 'Updated header',
    sections: [
      {
        name: 'header',
        frames: ['1:1'],
        selector: 'header',
        page: 'index.html'
      }
    ],
    fileKey: 'HFuZZUOKyUWmXb8yER287l',
    shots: [
      { section: 'header', width: 1440, file: 'header-1440.png', figma: 'desktop' },
      { section: 'header', width: 375, file: 'header-375.png' }
    ],
    reviewBase: 'https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345',
    reports: {},
    guardOk: true,
    checks: { ok: true, problems: [] }
  });

  // Desktop link is present
  assert(body.includes('https://www.figma.com/design/HFuZZUOKyUWmXb8yER287l/?node-id=1-1'));
  // Mobile cell has none (desktop only)
  assert(body.includes('| Mobile (375px) | none (desktop only) |'));
  // 375 screenshot is still embedded
  assert(body.includes('https://raw.githubusercontent.com/org/repo/figma-sync-review/runs/12345/header-375.png'));
});
