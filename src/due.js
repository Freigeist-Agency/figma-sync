import { trimNode, sectionHash } from './trim.js';

/**
 * Computes the last synced hashes per section, preferring the open PR's state over default branch state.
 * @param {object | null} openPrState
 * @param {object} defaultState
 * @returns {Record<string, string>}
 */
export function lastHashes(openPrState, defaultState) {
  const result = {};

  if (defaultState?.sections && typeof defaultState.sections === 'object') {
    for (const [name, sec] of Object.entries(defaultState.sections)) {
      if (sec?.hash) {
        result[name] = sec.hash;
      }
    }
  }

  if (openPrState?.sections && typeof openPrState.sections === 'object') {
    for (const [name, sec] of Object.entries(openPrState.sections)) {
      if (sec?.hash) {
        result[name] = sec.hash;
      }
    }
  }

  return result;
}

/**
 * Decides which sections are due, not ready, unchanged, or missing from Figma nodes response.
 * @param {object} map
 * @param {object} nodesResponse
 * @param {Record<string, string>} [lastHashes]
 * @param {{ force?: boolean }} [options]
 * @returns {{ due: Array<{ name: string, hash: string, trimmed: object[] }>, notReady: string[], unchanged: string[], missing: Array<{ name: string, frameId: string }> }}
 */
export function decide(map, nodesResponse, lastHashes = {}, { force = false } = {}) {
  const due = [];
  const notReady = [];
  const unchanged = [];
  const missing = [];

  const nodes = nodesResponse?.nodes || {};

  for (const section of map.sections || []) {
    const frameEntries = [];
    let isMissing = false;

    for (const frameId of section.frames || []) {
      const entry = nodes[frameId];
      if (!entry || !entry.document) {
        missing.push({ name: section.name, frameId });
        isMissing = true;
      } else {
        frameEntries.push(entry.document);
      }
    }

    if (isMissing) {
      continue;
    }

    // All of section.frames resolved and ready (devStatus.type === 'READY_FOR_DEV')
    const allReady =
      frameEntries.length === (section.frames || []).length &&
      frameEntries.every((doc) => doc.devStatus?.type === 'READY_FOR_DEV');

    if (!allReady) {
      notReady.push(section.name);
      continue;
    }

    // All listed frames are ready; compute trimmed trees and section hash
    const trimmed = frameEntries.map(trimNode);
    const hash = sectionHash(trimmed);
    const lastHash = lastHashes[section.name];

    if (force || hash !== lastHash) {
      due.push({ name: section.name, hash, trimmed });
    } else {
      unchanged.push(section.name);
    }
  }

  return { due, notReady, unchanged, missing };
}
