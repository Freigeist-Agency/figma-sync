import fs from 'node:fs';
import path from 'node:path';
import { readState } from './state.js';
import { decide, lastHashes } from './due.js';
import { foreignCommits } from './github.js';
import { FigmaError } from './figma.js';

/**
 * Recursively collects imageRef strings from a Figma node's fills and its children.
 * @param {object} node
 * @param {Set<string>} set
 * @returns {Set<string>}
 */
function collectImageRefs(node, set = new Set()) {
  if (!node || typeof node !== 'object') return set;
  if (Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      if (fill && fill.imageRef) {
        set.add(fill.imageRef);
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectImageRefs(child, set);
    }
  }
  return set;
}

/**
 * Executes the engine's fetch step.
 * @param {{
 *   repoDir: string,
 *   map: object,
 *   figma: object,
 *   gh: object,
 *   eventNodeId?: string | null,
 *   changeMessage?: string,
 *   force?: boolean,
 *   now?: string | Date,
 *   runUrl?: string
 * }} options
 * @returns {Promise<{ due: string[], workDir: string | null, base: string | null, openPr: object | null }>}
 */
export function runFetch({
  repoDir,
  map,
  figma,
  gh,
  eventNodeId,
  changeMessage,
  force = false,
  now = new Date().toISOString(),
  runUrl
}) {
  return runFetchInternal({
    repoDir,
    map,
    figma,
    gh,
    eventNodeId,
    changeMessage,
    force,
    now,
    runUrl
  }).catch(async (err) => {
    if (err instanceof FigmaError || err?.name === 'FigmaError') {
      if (eventNodeId) {
        const url =
          runUrl ||
          `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
        await figma.comment(map.fileKey, eventNodeId, `Sync failed, see ${url}`).catch(() => {});
      }
    }
    throw err;
  });
}

async function runFetchInternal({
  repoDir,
  map,
  figma,
  gh,
  eventNodeId,
  changeMessage,
  force = false
}) {
  // 1. Check if eventNodeId belongs to a mapped section
  const eventSection = eventNodeId
    ? (map.sections || []).find((s) => s.frames.includes(eventNodeId))
    : null;

  if (eventNodeId && !eventSection) {
    await figma.comment(map.fileKey, eventNodeId, "This section isn't mapped to the site yet.");
    return { due: [], workDir: null, base: null, openPr: null };
  }

  // 2. Query open sync PR and default branch info
  const openPr = await gh.openSyncPr();
  const defaultBranch = await gh.defaultBranch();
  const defaultHead = await gh.branchHead(defaultBranch);

  // 3. Foreign commits check on open PR
  if (openPr) {
    const commits = await gh.compareCommits(defaultHead, openPr.headSha);
    const foreign = foreignCommits(commits);
    if (foreign.length > 0) {
      const msg = `Sync not applied: #${openPr.number} has hand edits; merge or close it, then re-mark`;
      await gh.prComment(openPr.number, msg);
      if (eventNodeId) {
        await figma.comment(map.fileKey, eventNodeId, msg);
      }
      return { due: [], workDir: null, base: openPr.headSha, openPr };
    }
  }

  // 4. Work-branch base SHA
  let baseSha;
  if (force) {
    baseSha = defaultHead;
  } else if (openPr) {
    baseSha = openPr.headSha;
  } else {
    baseSha = defaultHead;
  }

  // 5. Read last state
  let openPrState = null;
  if (openPr) {
    const prStateText = await gh.fileAt('.figma-sync/state.json', openPr.headSha);
    openPrState = readState(prStateText);
  }

  const defaultStatePath = path.join(repoDir, '.figma-sync', 'state.json');
  const defaultStateText = fs.existsSync(defaultStatePath)
    ? fs.readFileSync(defaultStatePath, 'utf8')
    : null;
  const defaultState = readState(defaultStateText);

  const last = lastHashes(openPrState, defaultState);

  // 6. Fetch nodes from Figma
  const allFrameIds = (map.sections || []).flatMap((s) => s.frames);
  const nodesResponse = await figma.getNodes(map.fileKey, allFrameIds);

  // 7. Decide sections
  const decision = decide(map, nodesResponse, last, { force });
  const { due, notReady, unchanged, missing } = decision;

  // 8. Handle comments on missing frames and unchanged event section
  for (const item of missing) {
    const sec = (map.sections || []).find((s) => s.name === item.name);
    const otherFrameId = sec?.frames.find((id) => id !== item.frameId);
    if (otherFrameId && nodesResponse?.nodes?.[otherFrameId]?.document) {
      await figma.comment(
        map.fileKey,
        otherFrameId,
        `Frame ${item.frameId} not found in Figma; check .figma-sync/map.json`
      );
    }
  }

  if (eventSection && unchanged.includes(eventSection.name)) {
    const msg = openPr
      ? `No design change since #${openPr.number}`
      : 'Site already matches';
    await figma.comment(map.fileKey, eventNodeId, msg);
  }

  // 9. Stop if nothing due
  if (due.length === 0) {
    return { due: [], workDir: null, base: baseSha, openPr };
  }

  // 10. Prepare work directory and fetch renders/fills
  const workDir = path.join(repoDir, '.figma-sync', 'work');
  fs.mkdirSync(workDir, { recursive: true });

  // Add .figma-sync/work/ to .git/info/exclude
  const gitInfoDir = path.join(repoDir, '.git', 'info');
  if (fs.existsSync(gitInfoDir)) {
    const excludePath = path.join(gitInfoDir, 'exclude');
    const existingExclude = fs.existsSync(excludePath)
      ? fs.readFileSync(excludePath, 'utf8')
      : '';
    if (!existingExclude.includes('.figma-sync/work/')) {
      const updated =
        existingExclude.endsWith('\n') || existingExclude === ''
          ? `${existingExclude}.figma-sync/work/\n`
          : `${existingExclude}\n.figma-sync/work/\n`;
      fs.writeFileSync(excludePath, updated);
    }
  }

  const dueFrameIds = due.flatMap((d) => {
    const sec = (map.sections || []).find((m) => m.name === d.name);
    return sec ? sec.frames : [];
  });

  const renders = await figma.getRenders(map.fileKey, dueFrameIds);
  const renderImages = renders?.images || {};

  let fillsMap = null;

  for (const item of due) {
    const secConfig = (map.sections || []).find((m) => m.name === item.name);
    const [desktopId, mobileId] = secConfig.frames;
    const secDir = path.join(workDir, item.name);
    fs.mkdirSync(secDir, { recursive: true });

    // Write trimmed tree
    fs.writeFileSync(path.join(secDir, 'tree.json'), JSON.stringify(item.trimmed, null, 2));

    // Download renders
    if (renderImages[desktopId]) {
      await figma.download(renderImages[desktopId], path.join(secDir, 'desktop.png'));
    }
    if (renderImages[mobileId]) {
      await figma.download(renderImages[mobileId], path.join(secDir, 'mobile.png'));
    }

    // Collect and download used image fills only
    const usedRefs = new Set();
    for (const frameId of secConfig.frames) {
      collectImageRefs(nodesResponse?.nodes?.[frameId]?.document, usedRefs);
    }

    if (usedRefs.size > 0) {
      if (!fillsMap) {
        const fillsResponse = await figma.getImageFills(map.fileKey);
        fillsMap = fillsResponse?.meta?.images || {};
      }
      const fillsDir = path.join(secDir, 'fills');
      fs.mkdirSync(fillsDir, { recursive: true });

      for (const ref of usedRefs) {
        const url = fillsMap[ref];
        if (url) {
          let ext = 'png';
          try {
            const parsed = new URL(url);
            const m = parsed.pathname.match(/\.(png|jpe?g|svg|webp|gif)$/i);
            if (m) ext = m[1].toLowerCase();
          } catch {}
          await figma.download(url, path.join(fillsDir, `${ref}.${ext}`));
        }
      }
    }
  }

  // Write run.json
  const runDue = due.map((d) => ({
    name: d.name,
    hash: d.hash,
    frames: (map.sections || []).find((m) => m.name === d.name).frames
  }));

  const runData = {
    changeMessage: changeMessage ?? '',
    due: runDue,
    openPr: openPr ? { number: openPr.number, headSha: openPr.headSha } : null
  };

  fs.writeFileSync(path.join(workDir, 'run.json'), JSON.stringify(runData, null, 2));

  return {
    due: due.map((d) => d.name),
    workDir,
    base: baseSha,
    openPr
  };
}
