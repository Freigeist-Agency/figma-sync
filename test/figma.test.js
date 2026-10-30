import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { figmaClient, FigmaError } from '../src/figma.js';

test('getNodes joins ids with commas', async () => {
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(JSON.stringify({ nodes: {} }), { status: 200 });
  };
  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await client.getNodes('test-file-key', ['1:1', '1:2', '2:3']);

  assert.strictEqual(recorded.length, 1);
  const requestedUrl = new URL(recorded[0].url);
  assert.strictEqual(requestedUrl.origin, 'https://api.figma.com');
  assert.strictEqual(requestedUrl.pathname, '/v1/files/test-file-key/nodes');
  assert.strictEqual(requestedUrl.searchParams.get('ids'), '1:1,1:2,2:3');
});

test('retries a 429 honouring Retry-After, then succeeds', async () => {
  const delays = [];
  const fakeSleep = async (ms) => {
    delays.push(ms);
  };
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response('Rate limited', {
        status: 429,
        headers: { 'Retry-After': '3' }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: fakeSleep
  });

  const result = await client.getNodes('file1', ['1:1']);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(delays, [3000]);
  assert.deepStrictEqual(result, { ok: true });
});

test('gives up after 4 attempts with the status in the error', async () => {
  const delays = [];
  const fakeSleep = async (ms) => {
    delays.push(ms);
  };
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return new Response('Service Unavailable', { status: 503 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: fakeSleep
  });

  await assert.rejects(
    async () => {
      await client.getNodes('file1', ['1:1']);
    },
    (err) => {
      assert(err instanceof FigmaError);
      assert.strictEqual(err.status, 503);
      assert.match(err.message, /503/);
      return true;
    }
  );

  assert.strictEqual(calls, 4);
  assert.deepStrictEqual(delays, [2000, 4000, 8000]);
});

test('addDevResource treats already-exists as success', async () => {
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(
      JSON.stringify({
        links_created: [],
        errors: [
          {
            file_key: 'file1',
            node_id: '1:1',
            error: 'Another dev resource for the node has the same url'
          }
        ]
      }),
      { status: 200 }
    );
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  const res = await client.addDevResource('file1', '1:1', 'PR #12', 'https://github.com/org/repo/pull/12');
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].url, 'https://api.figma.com/v1/dev_resources');
  assert.deepStrictEqual(JSON.parse(recorded[0].options.body), {
    dev_resources: [
      {
        name: 'PR #12',
        url: 'https://github.com/org/repo/pull/12',
        file_key: 'file1',
        node_id: '1:1'
      }
    ]
  });
  assert(res);
});

test('no test output contains the token (stub records headers; assert the token appears only in X-Figma-Token)', async () => {
  const fakeToken = 'test-secret-token-xyz-987';
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(JSON.stringify({ nodes: {} }), { status: 200 });
  };

  const client = figmaClient({
    token: fakeToken,
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await client.getNodes('file1', ['1:1']);

  assert.strictEqual(recorded.length, 1);
  const { url, options } = recorded[0];

  // Token must not be in URL
  assert.strictEqual(url.includes(fakeToken), false);

  // Token must not be in body (if any)
  if (options.body) {
    assert.strictEqual(options.body.includes(fakeToken), false);
  }

  // Token must appear only in X-Figma-Token header
  const headers = options.headers || {};
  assert.strictEqual(headers['X-Figma-Token'], fakeToken);

  const headerKeys = Object.keys(headers).filter((k) => k !== 'X-Figma-Token');
  for (const k of headerKeys) {
    assert.strictEqual(String(headers[k]).includes(fakeToken), false);
  }
});

test('getRenders uses format=png&scale=2', async () => {
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(JSON.stringify({ images: { '1:1': 'https://s3.example.com/1.png' } }), { status: 200 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await client.getRenders('file1', ['1:1', '1:2']);

  assert.strictEqual(recorded.length, 1);
  const parsed = new URL(recorded[0].url);
  assert.strictEqual(parsed.origin, 'https://api.figma.com');
  assert.strictEqual(parsed.pathname, '/v1/images/file1');
  assert.strictEqual(parsed.searchParams.get('ids'), '1:1,1:2');
  assert.strictEqual(parsed.searchParams.get('format'), 'png');
  assert.strictEqual(parsed.searchParams.get('scale'), '2');
});

test('getImageFills queries images endpoint', async () => {
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(JSON.stringify({ meta: { images: {} } }), { status: 200 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await client.getImageFills('file1');

  assert.strictEqual(recorded.length, 1);
  const parsed = new URL(recorded[0].url);
  assert.strictEqual(parsed.origin, 'https://api.figma.com');
  assert.strictEqual(parsed.pathname, '/v1/files/file1/images');
});

test('download writes body to destination file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-download-test-'));
  const destPath = path.join(tmpDir, 'nested', 'image.png');
  const fileBytes = Buffer.from('fake-png-data-stream');

  const fakeFetch = async (url) => {
    return new Response(fileBytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' }
    });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  try {
    await client.download('https://s3.example.com/image.png', destPath);
    assert(fs.existsSync(destPath));
    const content = fs.readFileSync(destPath);
    assert.deepStrictEqual(content, fileBytes);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('comment posts message and client_meta with node_id and zero offset', async () => {
  const recorded = [];
  const fakeFetch = async (url, options) => {
    recorded.push({ url, options });
    return new Response(JSON.stringify({ id: 'c1', message: 'Hello' }), { status: 200 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await client.comment('file1', '10:20', 'Sync completed');

  assert.strictEqual(recorded.length, 1);
  const { url, options } = recorded[0];
  assert.strictEqual(url, 'https://api.figma.com/v1/files/file1/comments');
  assert.strictEqual(options.method, 'POST');
  assert.strictEqual(options.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(options.body), {
    message: 'Sync completed',
    client_meta: {
      node_id: '10:20',
      node_offset: { x: 0, y: 0 }
    }
  });
});

test('throws FigmaError without retrying on 4xx errors', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return new Response('Not Found', { status: 404 });
  };

  const client = figmaClient({
    token: 'fake-token',
    fetch: fakeFetch,
    sleep: async () => {}
  });

  await assert.rejects(
    async () => {
      await client.getNodes('file1', ['1:1']);
    },
    (err) => {
      assert(err instanceof FigmaError);
      assert.strictEqual(err.status, 404);
      return true;
    }
  );

  assert.strictEqual(calls, 1);
});
