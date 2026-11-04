import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedGlobs } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'prompt', 'section.md');

/**
 * Builds the Claude instruction prompt for a specific section.
 * @param {object} map
 * @param {object} section
 * @param {string} workDir
 * @returns {string}
 */
export function buildPrompt(map, section, workDir) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const sectionWorkDir = workDir.endsWith(section.name)
    ? workDir
    : path.join(workDir, section.name);

  const filesList = (section.files || []).map((f) => `- ${f}`).join('\n');
  const allProtected = protectedGlobs(map);
  const protectedList = allProtected.map((p) => `- ${p}`).join('\n');
  const mobile = section.frames?.length === 2
    ? '`mobile.png` is the mobile frame at its own width. Match each at that width.'
    : 'there is no mobile design. Keep the existing mobile layout working, do not redesign it.';

  let result = template;
  result = result.replaceAll('{{section}}', section.name);
  result = result.replaceAll('{{selector}}', section.selector || '');
  result = result.replaceAll('{{page}}', section.page || '');
  result = result.replaceAll('{{tokens}}', map.tokens || '');
  result = result.replaceAll('{{assets}}', map.assets || '');
  result = result.replaceAll('{{files}}', filesList);
  result = result.replaceAll('{{protected}}', protectedList);
  result = result.replaceAll('{{mobile}}', mobile);
  result = result.replaceAll('{{workDir}}', sectionWorkDir);

  return result;
}

/**
 * Writes the filled prompt for a section to .figma-sync/work/<section>/prompt.md.
 * @param {string} repoDir
 * @param {object} map
 * @param {string} sectionName
 * @returns {string}
 */
export function writeSectionPrompt(repoDir, map, sectionName) {
  const section = (map.sections || []).find((s) => s.name === sectionName);
  if (!section) {
    throw new Error(`Section "${sectionName}" not found in map`);
  }

  const workDir = path.join(repoDir, '.figma-sync', 'work');
  const promptContent = buildPrompt(map, section, workDir);

  const destDir = path.join(workDir, sectionName);
  fs.mkdirSync(destDir, { recursive: true });

  const destPath = path.join(destDir, 'prompt.md');
  fs.writeFileSync(destPath, promptContent, 'utf8');

  return destPath;
}
