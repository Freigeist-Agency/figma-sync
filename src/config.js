import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Loads and validates .figma-sync/map.json from repoDir.
 * @param {string} repoDir
 * @returns {object}
 */
export function loadMap(repoDir) {
  const mapPath = path.join(repoDir, '.figma-sync', 'map.json');
  if (!fs.existsSync(mapPath)) {
    throw new Error(`Missing .figma-sync/map.json file at ${mapPath}`);
  }

  let map;
  try {
    const raw = fs.readFileSync(mapPath, 'utf8');
    map = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse .figma-sync/map.json: ${err.message}`);
  }

  if (!map || typeof map !== 'object') {
    throw new Error('Invalid map: root must be an object');
  }

  // Validate top-level required fields
  const requiredTopFields = ['fileKey', 'tokens', 'assets', 'protected', 'sections'];
  for (const field of requiredTopFields) {
    if (map[field] === undefined || map[field] === null) {
      throw new Error(`Missing field "${field}"`);
    }
  }

  if (typeof map.fileKey !== 'string') {
    throw new Error('Field "fileKey" must be a string');
  }
  if (typeof map.tokens !== 'string') {
    throw new Error('Field "tokens" must be a string');
  }
  if (typeof map.assets !== 'string') {
    throw new Error('Field "assets" must be a string');
  }
  if (!Array.isArray(map.protected)) {
    throw new Error('Missing field "protected": must be an array');
  }
  if (!Array.isArray(map.sections)) {
    throw new Error('Missing field "sections": must be an array');
  }
  if (map.checks !== undefined && typeof map.checks !== 'string') {
    throw new Error('Field "checks" must be a string');
  }
  if (map.ready !== undefined && (typeof map.ready !== 'string' || !map.ready.trim())) {
    throw new Error('Field "ready" must be a non-empty string');
  }

  const seenSectionNames = new Set();
  const seenFrameIds = new Set();
  const namePattern = /^[a-z0-9-]+$/;

  for (const section of map.sections) {
    if (!section || typeof section !== 'object') {
      throw new Error('Invalid section in "sections"');
    }

    const requiredSectionFields = ['name', 'frames', 'files', 'selector', 'page'];
    for (const field of requiredSectionFields) {
      if (section[field] === undefined || section[field] === null) {
        throw new Error(`Missing field "${field}" in section "${section.name || ''}"`);
      }
    }

    if (typeof section.name !== 'string' || !namePattern.test(section.name)) {
      throw new Error(`Invalid section name "${section.name}": must match ^[a-z0-9-]+$`);
    }

    if (seenSectionNames.has(section.name)) {
      throw new Error(`Duplicate section name: "${section.name}"`);
    }
    seenSectionNames.add(section.name);

    if (
      !Array.isArray(section.frames) ||
      (section.frames.length !== 1 && section.frames.length !== 2) ||
      section.frames.some((f) => typeof f !== 'string' || !f)
    ) {
      throw new Error(`Section "${section.name}" frames must contain 1 or 2 frame IDs`);
    }

    for (const frameId of section.frames) {
      if (seenFrameIds.has(frameId)) {
        throw new Error(`Duplicate frame id "${frameId}" found in section "${section.name}"`);
      }
      seenFrameIds.add(frameId);
    }

    if (!Array.isArray(section.files)) {
      throw new Error(`Missing field "files" in section "${section.name}": must be an array`);
    }
    if (typeof section.selector !== 'string') {
      throw new Error(`Missing field "selector" in section "${section.name}": must be a string`);
    }
    if (typeof section.page !== 'string') {
      throw new Error(`Missing field "page" in section "${section.name}": must be a string`);
    }
  }

  return map;
}

/**
 * Returns protected globs from map plus engine protected paths.
 * @param {object} map
 * @returns {string[]}
 */
export function protectedGlobs(map) {
  const base = Array.isArray(map?.protected) ? map.protected : [];
  const enginePaths = ['.github/**', '.figma-sync/**'];
  const combined = [...base];
  for (const p of enginePaths) {
    if (!combined.includes(p)) {
      combined.push(p);
    }
  }
  return combined;
}

/**
 * Recursively lists all relative file paths in repoDir, excluding .git and node_modules.
 * @param {string} repoDir
 * @returns {string[]}
 */
function listRepoFiles(repoDir) {
  const files = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(repoDir, full).split(path.sep).join('/'));
      }
    }
  }
  walk(repoDir);
  return files;
}

/**
 * Validates map configuration and checks that every files glob and page exists.
 * @param {string} repoDir
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validate(repoDir) {
  let map;
  try {
    map = loadMap(repoDir);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }

  const errors = [];
  const filesInRepo = listRepoFiles(repoDir);

  for (const section of map.sections) {
    // Check that section page exists
    const pagePath = path.join(repoDir, section.page);
    if (!fs.existsSync(pagePath) || !fs.statSync(pagePath).isFile()) {
      errors.push(`Page "${section.page}" in section "${section.name}" not found`);
    }

    // Check that every files glob matches at least one file
    for (const glob of section.files) {
      const normalizedGlob = glob.replace(/^\.\//, '');
      const isMatch = picomatch(normalizedGlob);
      const matched = filesInRepo.some((f) => isMatch(f));
      if (!matched) {
        errors.push(`Files glob "${glob}" in section "${section.name}" matched no files`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
