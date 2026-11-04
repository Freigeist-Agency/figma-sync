import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readState, withSynced } from './state.js';

const ENGINE_COMMITTER_NAME = 'github-actions[bot]';
const ENGINE_COMMITTER_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/**
 * Generates PR title indicating synced sections and checks status.
 * @param {string[]} sections
 * @param {boolean} checksOk
 * @returns {string}
 */
export function prTitle(sections, checksOk) {
  const prefix = checksOk ? '' : '[checks failing] ';
  return `${prefix}Figma: ${sections.join(', ')}`;
}

/**
 * Builds the Markdown body for the figma-sync PR.
 *
 * @param {Object} options
 * @param {string} [options.changeMessage]
 * @param {Array<{ name: string, frames?: string[], selector?: string, page?: string }>} options.sections
 * @param {string} options.fileKey
 * @param {Array<{ section: string, width: number, file?: string, figma?: string, error?: string }>} [options.shots]
 * @param {string} options.reviewBase
 * @param {Record<string, string>} [options.reports]
 * @param {boolean} [options.guardOk]
 * @param {{ ok: boolean, problems?: string[] }} [options.checks]
 * @returns {string}
 */
export function prBody({
  changeMessage = '',
  sections = [],
  fileKey,
  shots = [],
  reviewBase,
  reports = {},
  guardOk = true,
  checks = { ok: true, problems: [] }
}) {
  const lines = [];

  // 1. Designer change message
  if (changeMessage && changeMessage.trim()) {
    lines.push('### Change Message');
    lines.push(`> ${changeMessage.trim()}`);
    lines.push('');
  }

  // 2. Figma frame links
  lines.push('### Figma Frames');
  for (const sec of sections) {
    const frameLinks = (sec.frames || []).map((f) => {
      const nodeIdParam = f.replaceAll(':', '-');
      const url = `https://www.figma.com/design/${fileKey}/?node-id=${nodeIdParam}`;
      return `[Frame ${nodeIdParam}](${url})`;
    });
    lines.push(`- **${sec.name}**: ${frameLinks.length > 0 ? frameLinks.join(', ') : 'None'}`);
  }
  lines.push('');

  // 3. Screenshot tables per section
  lines.push('### Screenshots');
  for (const sec of sections) {
    lines.push(`#### ${sec.name}`);
    lines.push('| Viewport | Figma Frame | Site Render |');
    lines.push('| :--- | :--- | :--- |');

    const secShots = shots.filter((s) => s.section === sec.name);
    const shot1440 = secShots.find((s) => s.width === 1440);
    const shot375 = secShots.find((s) => s.width === 375);
    const shot768 = secShots.find((s) => s.width === 768);

    const desktopFrame = sec.frames?.[0];
    const mobileFrame = sec.frames?.[1];

    const desktopFigmaLink = desktopFrame
      ? `[Desktop Frame](https://www.figma.com/design/${fileKey}/?node-id=${desktopFrame.replaceAll(':', '-')})`
      : '—';
    const mobileFigmaLink = mobileFrame
      ? `[Mobile Frame](https://www.figma.com/design/${fileKey}/?node-id=${mobileFrame.replaceAll(':', '-')})`
      : 'none (desktop only)';

    const renderCell = (shot) => {
      if (!shot) return '—';
      if (shot.error) return `⚠️ ${shot.error}`;
      if (shot.file) return `![${shot.section}-${shot.width}](${reviewBase}/${shot.file})`;
      return '—';
    };

    lines.push(`| Desktop (1440px) | ${desktopFigmaLink} | ${renderCell(shot1440)} |`);
    lines.push(`| Mobile (375px) | ${mobileFigmaLink} | ${renderCell(shot375)} |`);
    lines.push(`| Tablet (768px breakage) | — | ${renderCell(shot768)} |`);
    lines.push('');
  }

  // 4. Per-section reports
  const reportKeys = Object.keys(reports);
  if (reportKeys.length > 0) {
    lines.push('### Reports');
    for (const name of reportKeys) {
      if (reports[name] && reports[name].trim()) {
        lines.push(`#### ${name}`);
        lines.push(reports[name].trim());
        lines.push('');
      }
    }
  }

  // 5. Guard and Checks
  lines.push('### Quality Gates');
  lines.push(`- **Guard:** ${guardOk ? 'Passed' : 'Failed'}`);
  lines.push(`- **Checks:** ${checks.ok ? 'Passed' : 'Failed'}`);
  if (checks.problems && checks.problems.length > 0) {
    for (const prob of checks.problems) {
      lines.push(`  - ${prob}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Pushes section screenshot PNGs to review branch under runs/<runId>/
 * using a temporary git worktree.
 */
function pushReviewShots({ repoDir, runId, shotsDir }) {
  if (!fs.existsSync(shotsDir)) return;
  const pngFiles = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png'));
  if (pngFiles.length === 0) return;

  const tempWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-sync-review-'));

  try {
    let remoteExists = false;
    try {
      const ls = execFileSync('git', ['ls-remote', '--heads', 'origin', 'figma-sync-review'], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      remoteExists = ls.includes('refs/heads/figma-sync-review');
    } catch {}

    if (remoteExists) {
      execFileSync('git', ['fetch', 'origin', 'figma-sync-review:figma-sync-review'], {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      execFileSync('git', ['worktree', 'add', tempWorktree, 'figma-sync-review'], {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    } else {
      let localExists = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', 'figma-sync-review'], {
          cwd: repoDir,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        localExists = true;
      } catch {}

      if (localExists) {
        execFileSync('git', ['worktree', 'add', tempWorktree, 'figma-sync-review'], {
          cwd: repoDir,
          stdio: ['pipe', 'pipe', 'ignore']
        });
      } else {
        try {
          execFileSync('git', ['worktree', 'add', '--orphan', '-b', 'figma-sync-review', tempWorktree], {
            cwd: repoDir,
            stdio: ['pipe', 'pipe', 'ignore']
          });
        } catch {
          execFileSync('git', ['worktree', 'add', '--detach', tempWorktree], {
            cwd: repoDir,
            stdio: ['pipe', 'pipe', 'ignore']
          });
          execFileSync('git', ['switch', '--orphan', 'figma-sync-review'], {
            cwd: tempWorktree,
            stdio: ['pipe', 'pipe', 'ignore']
          });
        }
      }
    }

    const destDir = path.join(tempWorktree, 'runs', String(runId));
    fs.mkdirSync(destDir, { recursive: true });

    for (const f of pngFiles) {
      fs.copyFileSync(path.join(shotsDir, f), path.join(destDir, f));
    }

    execFileSync('git', ['add', `runs/${runId}`], {
      cwd: tempWorktree,
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: tempWorktree,
      encoding: 'utf8'
    });

    if (status.trim()) {
      execFileSync(
        'git',
        [
          '-c',
          `user.name=${ENGINE_COMMITTER_NAME}`,
          '-c',
          `user.email=${ENGINE_COMMITTER_EMAIL}`,
          'commit',
          '-m',
          `Screenshots for run ${runId}`
        ],
        { cwd: tempWorktree, stdio: ['pipe', 'pipe', 'ignore'] }
      );

      execFileSync('git', ['push', 'origin', 'HEAD:figma-sync-review'], {
        cwd: tempWorktree,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    }
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', tempWorktree], {
        cwd: repoDir,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch {}
    fs.rmSync(tempWorktree, { recursive: true, force: true });
  }
}

/**
 * Prepares the sync PR publish step:
 * - Detects sections with diffs from commits "figma-sync: <section>"
 * - Updates .figma-sync/state.json via withSynced
 * - Pushes screenshot PNGs to figma-sync-review
 * - Writes .figma-sync/work/pr-body.md
 * - Emits outputs title and skip
 *
 * @param {Object} options
 * @param {string} options.repoDir
 * @param {string} options.base
 * @param {string} options.workRef
 * @param {Object} options.map
 * @param {Object} options.figma
 * @param {string} [options.runUrl]
 * @param {string} [options.runId]
 * @param {string} [options.repo]
 * @returns {Promise<{ skip: boolean, title?: string, body?: string, sections?: string[] }>}
 */
export async function preparePublish({
  repoDir,
  base,
  workRef,
  map,
  figma,
  runUrl,
  runId = process.env.GITHUB_RUN_ID || '1',
  repo = process.env.GITHUB_REPOSITORY || '',
  dryRun = false
}) {
  const effectiveRunUrl =
    runUrl ||
    `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${runId}`;

  // Read commit subjects between base and workRef
  // No try/catch: an unreadable work branch must fail the run, not read as "no changes".
  const commitLogs = execFileSync('git', ['log', '--format=%s', `${base}..${workRef}`], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const diffSections = new Set();
  for (const line of commitLogs.split('\n')) {
    const match = line.trim().match(/^figma-sync:\s*(.+)$/);
    if (match) {
      diffSections.add(match[1].trim());
    }
  }

  const workDir = path.join(repoDir, '.figma-sync', 'work');
  let runData = { due: [] };
  const runJsonPath = path.join(workDir, 'run.json');
  if (fs.existsSync(runJsonPath)) {
    try {
      runData = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
    } catch {}
  }

  // If no section produced a diff, skip and comment
  if (diffSections.size === 0) {
    for (const dueItem of runData.due || []) {
      const desktopFrame = dueItem.frames?.[0];
      if (desktopFrame) {
        await figma.comment(map.fileKey, desktopFrame, `Sync made no changes; see ${effectiveRunUrl}`);
      }
    }

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
    }
    return { skip: true };
  }

  // Read default-branch state from git HEAD
  let defaultState = { sections: {} };
  try {
    const rawHead = execFileSync('git', ['show', 'HEAD:.figma-sync/state.json'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    defaultState = readState(rawHead);
  } catch {}

  // Read working tree state before writing
  const statePath = path.join(repoDir, '.figma-sync', 'state.json');
  let currentState = { sections: {} };
  if (fs.existsSync(statePath)) {
    currentState = readState(fs.readFileSync(statePath, 'utf8'));
  }

  // Update state for sections that have a diff
  for (const name of diffSections) {
    const dueItem = (runData.due || []).find((d) => (typeof d === 'string' ? d : d.name) === name);
    const mapSection = (map.sections || []).find((s) => s.name === name);
    const hash = dueItem?.hash;
    const frames = dueItem?.frames || mapSection?.frames || [];
    if (hash) {
      currentState = withSynced(currentState, name, { hash, frames });
    }
  }

  // Save updated state.json
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(currentState, null, 2) + '\n');

  // Title and body list every section whose hash differs from default branch
  const prSections = (map.sections || [])
    .filter((s) => {
      const newHash = currentState.sections[s.name]?.hash;
      const defHash = defaultState.sections[s.name]?.hash;
      return newHash && newHash !== defHash;
    })
    .map((s) => s.name);

  const effectiveSections = prSections.length > 0 ? prSections : Array.from(diffSections);

  // Push shots to review branch (skipped on dry-run)
  const shotsDir = path.join(workDir, 'shots');
  if (!dryRun) {
    pushReviewShots({ repoDir, runId, shotsDir });
  }

  // Read checks and shots
  let checks = { ok: true, problems: [] };
  const checksPath = path.join(workDir, 'checks.json');
  if (fs.existsSync(checksPath)) {
    try {
      checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
    } catch {}
  }

  let shots = [];
  const shotsPath = path.join(workDir, 'shots.json');
  if (fs.existsSync(shotsPath)) {
    try {
      shots = JSON.parse(fs.readFileSync(shotsPath, 'utf8'));
    } catch {}
  }

  // Read per-section reports
  const reports = {};
  for (const name of effectiveSections) {
    const reportArtifact = path.join(workDir, 'reports', name, 'report.md');
    const directReport = path.join(workDir, name, 'report.md');
    if (fs.existsSync(reportArtifact)) {
      reports[name] = fs.readFileSync(reportArtifact, 'utf8');
    } else if (fs.existsSync(directReport)) {
      reports[name] = fs.readFileSync(directReport, 'utf8');
    }
  }

  const reviewBase = `https://raw.githubusercontent.com/${repo}/figma-sync-review/runs/${runId}`;
  const title = prTitle(effectiveSections, checks.ok);

  const bodySections = effectiveSections.map(
    (name) => (map.sections || []).find((s) => s.name === name) || { name, frames: [] }
  );

  const body = prBody({
    changeMessage: runData.changeMessage || '',
    sections: bodySections,
    fileKey: map.fileKey,
    shots,
    reviewBase,
    reports,
    guardOk: true,
    checks
  });

  const prBodyPath = path.join(workDir, 'pr-body.md');
  fs.writeFileSync(prBodyPath, body);

  if (!dryRun && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\nskip=false\n`);
  }

  return {
    skip: false,
    title,
    body,
    prBodyPath,
    sections: effectiveSections
  };
}

/**
 * Links PR dev resource on all frames of synced sections.
 * @param {Object} options
 * @param {string} options.repoDir
 * @param {number | string} options.prNumber
 * @param {Object} options.map
 * @param {Object} options.figma
 * @param {string} [options.repo]
 */
export async function afterPublish({
  repoDir,
  prNumber,
  map,
  figma,
  repo = process.env.GITHUB_REPOSITORY || ''
}) {
  const statePath = path.join(repoDir, '.figma-sync', 'state.json');
  let currentState = { sections: {} };
  if (fs.existsSync(statePath)) {
    currentState = readState(fs.readFileSync(statePath, 'utf8'));
  }

  let defaultState = { sections: {} };
  try {
    const rawHead = execFileSync('git', ['show', 'HEAD:.figma-sync/state.json'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    defaultState = readState(rawHead);
  } catch {}

  let syncedSections = (map.sections || []).filter((s) => {
    const currHash = currentState.sections[s.name]?.hash;
    return currHash && currHash !== defaultState.sections[s.name]?.hash;
  });

  if (syncedSections.length === 0) {
    try {
      const runJsonPath = path.join(repoDir, '.figma-sync', 'work', 'run.json');
      const runData = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
      const dueNames = new Set((runData.due || []).map((d) => (typeof d === 'string' ? d : d.name)));
      syncedSections = (map.sections || []).filter((s) => dueNames.has(s.name));
    } catch {}
  }

  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  const resourceName = `PR #${prNumber}`;

  for (const sec of syncedSections) {
    for (const frameId of sec.frames || []) {
      await figma.addDevResource(map.fileKey, frameId, resourceName, prUrl);
    }
  }
}
