/**
 * Reads and parses .figma-sync/state.json content.
 * Returns default empty state when json is null, empty, or invalid.
 * @param {string | null} json
 * @returns {{ sections: Record<string, { hash: string, frames: string[], syncedAt: string }> }}
 */
export function readState(json) {
  if (!json || typeof json !== 'string' || !json.trim()) {
    return { sections: {} };
  }

  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || !parsed.sections || typeof parsed.sections !== 'object') {
      return { sections: {} };
    }
    return { sections: parsed.sections };
  } catch {
    return { sections: {} };
  }
}

/**
 * Returns an updated State with the given section marked as synced.
 * @param {object} state
 * @param {string} name
 * @param {{ hash: string, frames: string[] }} sectionInfo
 * @param {string | Date} [now]
 * @returns {object}
 */
export function withSynced(state, name, { hash, frames }, now = new Date().toISOString()) {
  const currentSections = state?.sections && typeof state.sections === 'object' ? state.sections : {};
  const syncedAt = typeof now === 'string' ? now : (now instanceof Date ? now.toISOString() : String(now));

  return {
    sections: {
      ...currentSections,
      [name]: {
        hash,
        frames: Array.isArray(frames) ? [...frames] : [],
        syncedAt
      }
    }
  };
}
