import { execFileSync } from 'node:child_process';
import picomatch from 'picomatch';
import { protectedGlobs } from './config.js';

/**
 * Returns any files from changedFiles that match any protected glob pattern.
 * @param {string[]} changedFiles
 * @param {string[]} globs
 * @returns {string[]}
 */
export function protectedViolations(changedFiles, globs) {
  if (!Array.isArray(changedFiles) || !Array.isArray(globs) || globs.length === 0) {
    return [];
  }

  // picomatch with dot: true ensures hidden folders/files (.github, .figma-sync) match wildcards
  const matchers = globs.map((g) => picomatch(g.replace(/^\.\//, ''), { dot: true }));

  return changedFiles.filter((file) => {
    const normalized = file.replace(/^\.\//, '');
    return matchers.some((isMatch) => isMatch(normalized));
  });
}

/**
 * Checks git diff against base SHA and untracked files for protected path violations.
 * Posts a Figma comment on the section's desktop frame if violations are found.
 * @param {{
 *   repoDir: string,
 *   base: string,
 *   sectionName: string,
 *   map: object,
 *   figma?: object
 * }} options
 * @returns {Promise<string[]>}
 */
export async function runGuard({ repoDir, base, sectionName, map, figma }) {
  // Fail closed: a diff that cannot run must stop the sync, not pass it with an empty file list.
  const git = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const diffOutput = git(['diff', '--name-only', base]);
  const untrackedOutput = git(['ls-files', '--others', '--exclude-standard']);

  const diffFiles = diffOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  const untrackedFiles = untrackedOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  const allChanged = Array.from(new Set([...diffFiles, ...untrackedFiles]));

  // 3. Match against protected globs
  const globs = protectedGlobs(map);
  const violations = protectedViolations(allChanged, globs);

  if (violations.length > 0) {
    const section = (map.sections || []).find((s) => s.name === sectionName);
    const desktopFrameId = section?.frames?.[0];
    if (desktopFrameId && figma) {
      const msg = `Sync stopped: it changed protected files: ${violations.join(', ')}`;
      await figma.comment(map.fileKey, desktopFrameId, msg);
    }
  }

  return violations;
}
