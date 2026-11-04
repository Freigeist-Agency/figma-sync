import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

/**
 * Starts a local HTTP static server on a free port serving files from dir.
 * Refuses path traversal attempts and serves correct mime types.
 * @param {string} dir
 * @returns {Promise<{ url: string, close(): Promise<void> }>}
 */
export function serveDir(dir) {
  const rootDir = path.resolve(dir);

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      pathname = decodeURIComponent(parsedUrl.pathname);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    // Resolve absolute path and guard against directory traversal
    const safePath = path.resolve(rootDir, '.' + pathname);
    const isInsideRoot = safePath === rootDir || safePath.startsWith(rootDir + path.sep);

    if (!isInsideRoot) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    fs.stat(safePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      const ext = path.extname(safePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.statusCode = 200;

      fs.createReadStream(safePath).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}`;

      resolve({
        url,
        close() {
          return new Promise((resClose) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(resClose);
          });
        }
      });
    });

    server.on('error', reject);
  });
}
