import test from 'node:test';
import assert from 'node:assert/strict';
import { github, foreignCommits, ENGINE_COMMITTER_EMAIL } from '../src/github.js';

test('openSyncPr ignores a PR from another branch', async () => {
  const fakeFetch = async (url) => {
    assert(url.includes('/repos/Freigeist-Agency/site/pulls'));
    return new Response(
      JSON.stringify([
        {
          number: 10,
          head: { ref: 'feature/other', sha: 'other-sha' }
        },
        {
          number: 11,
          head: { ref: 'patch-1', sha: 'patch-sha' }
        }
      ]),
      { status: 200 }
    );
  };

  const gh = github({ token: 'fake-token', repo: 'Freigeist-Agency/site', fetch: fakeFetch });
  const pr = await gh.openSyncPr();
  assert.strictEqual(pr, null);
});

test('openSyncPr finds a PR with head figma-sync/run', async () => {
  const fakeFetch = async () => {
    return new Response(
      JSON.stringify([
        {
          number: 42,
          head: { ref: 'figma-sync/run', sha: 'sync-sha-123' }
        }
      ]),
      { status: 200 }
    );
  };

  const gh = github({ token: 'fake-token', repo: 'Freigeist-Agency/site', fetch: fakeFetch });
  const pr = await gh.openSyncPr();
  assert.deepStrictEqual(pr, { number: 42, headSha: 'sync-sha-123' });
});

test('foreignCommits reports a commit not made by the engine', () => {
  const commits = [
    { sha: 'sha-1', committerEmail: ENGINE_COMMITTER_EMAIL },
    { sha: 'sha-2', committerEmail: 'human@example.com' },
    { sha: 'sha-3', committerEmail: ENGINE_COMMITTER_EMAIL },
    { sha: 'sha-4', committerEmail: 'designer@example.com' }
  ];

  const foreign = foreignCommits(commits);
  assert.deepStrictEqual(foreign, ['sha-2', 'sha-4']);

  const engineOnly = [
    { sha: 'sha-1', committerEmail: ENGINE_COMMITTER_EMAIL }
  ];
  assert.deepStrictEqual(foreignCommits(engineOnly), []);
});

test('defaultBranch returns default branch name', async () => {
  const fakeFetch = async () => {
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  };
  const gh = github({ token: 'fake-token', repo: 'Freigeist-Agency/site', fetch: fakeFetch });
  const branch = await gh.defaultBranch();
  assert.strictEqual(branch, 'main');
});

test('fileAt returns null on 404 and decodes base64 on 200', async () => {
  let callCount = 0;
  const fakeFetch = async (url) => {
    callCount++;
    if (url.includes('missing.txt')) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(
      JSON.stringify({
        content: Buffer.from('hello-world').toString('base64')
      }),
      { status: 200 }
    );
  };

  const gh = github({ token: 'fake-token', repo: 'Freigeist-Agency/site', fetch: fakeFetch });
  const missing = await gh.fileAt('missing.txt', 'ref-1');
  assert.strictEqual(missing, null);

  const found = await gh.fileAt('present.txt', 'ref-1');
  assert.strictEqual(found, 'hello-world');
});

test('compareCommits maps sha and committer email', async () => {
  const fakeFetch = async () => {
    return new Response(
      JSON.stringify({
        commits: [
          { sha: 'sha-1', commit: { committer: { email: 'a@example.com' } } },
          { sha: 'sha-2', commit: { committer: { email: 'b@example.com' } } }
        ]
      }),
      { status: 200 }
    );
  };

  const gh = github({ token: 'fake-token', repo: 'Freigeist-Agency/site', fetch: fakeFetch });
  const comparison = await gh.compareCommits('base', 'head');
  assert.deepStrictEqual(comparison, [
    { sha: 'sha-1', committerEmail: 'a@example.com' },
    { sha: 'sha-2', committerEmail: 'b@example.com' }
  ]);
});
