import fs from 'node:fs';
import path from 'node:path';

export class FigmaError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.name = 'FigmaError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Creates a Figma API client with retry and backoff handling.
 * @param {{ token: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} options
 */
export function figmaClient({ token, fetch = globalThis.fetch, sleep }) {
  const baseUrl = 'https://api.figma.com';
  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const doSleep = sleep ?? defaultSleep;

  async function request(endpointOrUrl, options = {}) {
    const isFullUrl = endpointOrUrl.startsWith('http://') || endpointOrUrl.startsWith('https://');
    const url = isFullUrl ? endpointOrUrl : `${baseUrl}${endpointOrUrl}`;

    const headers = {
      ...(options.headers || {})
    };
    if (!isFullUrl || url.startsWith(baseUrl)) {
      headers['X-Figma-Token'] = token;
    }

    const maxAttempts = 4;
    const defaultDelays = [2000, 4000, 8000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(url, {
        ...options,
        headers
      });

      if (res.ok) {
        return res;
      }

      const isRetryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (!isRetryable || attempt === maxAttempts) {
        let errorBody = null;
        try {
          errorBody = await res.text();
        } catch {
          // ignore
        }
        throw new FigmaError(`Figma API request failed with status ${res.status}`, res.status, errorBody);
      }

      // Compute delay from Retry-After header or fallback to 2/4/8 s backoff
      const retryAfterHeader = res.headers.get('retry-after') || res.headers.get('Retry-After');
      // Retry-After may also be an HTTP date; anything unparseable falls back to the backoff.
      const retryAfterSeconds = parseFloat(retryAfterHeader);
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : defaultDelays[attempt - 1];

      await doSleep(delayMs);
    }
  }

  return {
    async getNodes(fileKey, ids) {
      const idList = Array.isArray(ids) ? ids.join(',') : ids;
      const res = await request(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${idList}`);
      return await res.json();
    },

    async getRenders(fileKey, ids) {
      const idList = Array.isArray(ids) ? ids.join(',') : ids;
      const res = await request(`/v1/images/${encodeURIComponent(fileKey)}?ids=${idList}&format=png&scale=2`);
      return await res.json();
    },

    async getImageFills(fileKey) {
      const res = await request(`/v1/files/${encodeURIComponent(fileKey)}/images`);
      return await res.json();
    },

    async download(url, dest) {
      const res = await request(url);
      const arrayBuffer = await res.arrayBuffer();
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, Buffer.from(arrayBuffer));
      return dest;
    },

    // https://developers.figma.com/docs/rest-api/comments-endpoints/
    async comment(fileKey, nodeId, message) {
      const res = await request(`/v1/files/${encodeURIComponent(fileKey)}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message,
          client_meta: {
            node_id: nodeId,
            node_offset: { x: 0, y: 0 }
          }
        })
      });
      return await res.json();
    },

    // https://developers.figma.com/docs/rest-api/dev-resources-endpoints/
    async addDevResource(fileKey, nodeId, name, url) {
      const res = await request('/v1/dev_resources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dev_resources: [
            {
              name,
              url,
              file_key: fileKey,
              node_id: nodeId
            }
          ]
        })
      });

      const data = await res.json();
      if (data.errors && data.errors.length > 0) {
        for (const item of data.errors) {
          const isAlreadyExists = /already exists|same url/i.test(item.error || '');
          if (!isAlreadyExists) {
            throw new FigmaError(`Failed to add dev resource: ${item.error}`, 400, data);
          }
        }
      }
      return data;
    }
  };
}
