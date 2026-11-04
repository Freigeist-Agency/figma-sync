import { readState } from './state.js';

/**
 * Handles PR closure for figma-sync:
 * - If merged: posts "Shipped in #<n> — mark Completed" on each synced section's desktop frame.
 * - If unmerged: deletes the sync branch and posts "Not shipped (#<n> closed) — re-mark Ready for dev to try again".
 *
 * @param {Object} options
 * @param {{ number: number | string, merged: boolean | string, baseSha: string, headSha: string }} options.pr
 * @param {Object} options.gh
 * @param {Object} options.figma
 * @param {Object} options.map
 * @returns {Promise<{ syncedSections: string[], merged: boolean }>}
 */
export async function runClosed({ pr: { number, merged, baseSha, headSha }, gh, figma, map }) {
  const isMerged = merged === true || merged === 'true';

  const baseContent = await gh.fileAt('.figma-sync/state.json', baseSha);
  const headContent = await gh.fileAt('.figma-sync/state.json', headSha);

  const baseState = readState(baseContent);
  const headState = readState(headContent);

  // Synced sections are those whose hash changed between base and head
  const syncedSections = (map.sections || []).filter((s) => {
    const headHash = headState.sections[s.name]?.hash;
    const baseHash = baseState.sections[s.name]?.hash;
    return headHash && headHash !== baseHash;
  });

  if (isMerged) {
    for (const sec of syncedSections) {
      const desktopFrame = sec.frames[0];
      await figma.comment(map.fileKey, desktopFrame, `Shipped in #${number} — mark Completed`);
    }
  } else {
    await gh.deleteBranch('figma-sync/run');
    for (const sec of syncedSections) {
      const desktopFrame = sec.frames[0];
      await figma.comment(map.fileKey, desktopFrame, `Not shipped (#${number} closed) — re-mark Ready for dev to try again`);
    }
  }

  return {
    syncedSections: syncedSections.map((s) => s.name),
    merged: isMerged
  };
}
