import crypto from 'node:crypto';

/**
 * Trims a Figma node tree keeping only visual layout, styling, text, and size properties.
 * Drops ids, devStatus, position coordinates (x, y), and non-visual metadata.
 * @param {object} node
 * @returns {object}
 */
export function trimNode(node) {
  if (!node || typeof node !== 'object') return node;

  const out = {};

  if (node.type !== undefined) out.type = node.type;
  if (node.name !== undefined) out.name = node.name;
  if (node.characters !== undefined) out.characters = node.characters;

  if (node.style && typeof node.style === 'object') {
    const allowedStyleKeys = [
      'fontFamily',
      'fontWeight',
      'fontSize',
      'lineHeightPx',
      'lineHeightPercent',
      'lineHeightPercentFontSize',
      'lineHeightUnit',
      'letterSpacing',
      'textAlignHorizontal',
      'textAlignVertical',
      'textCase',
      'textDecoration'
    ];
    const s = {};
    for (const key of allowedStyleKeys) {
      if (node.style[key] !== undefined) {
        s[key] = node.style[key];
      }
    }
    if (Object.keys(s).length > 0) {
      out.style = s;
    }
  }

  const directKeys = [
    'fills',
    'strokes',
    'strokeWeight',
    'effects',
    'cornerRadius',
    'rectangleCornerRadii',
    'opacity',
    'visible',
    'layoutMode',
    'itemSpacing',
    'primaryAxisAlignItems',
    'counterAxisAlignItems',
    'layoutSizingHorizontal',
    'layoutSizingVertical',
    'layoutWrap'
  ];

  for (const k of directKeys) {
    if (node[k] !== undefined) {
      out[k] = node[k];
    }
  }

  // Padding properties (paddingLeft, paddingRight, paddingTop, paddingBottom, etc.)
  for (const k of Object.keys(node)) {
    if (k.startsWith('padding') && node[k] !== undefined) {
      out[k] = node[k];
    }
  }

  // Size { w, h } from absoluteBoundingBox (drops x and y canvas offsets)
  if (node.absoluteBoundingBox && typeof node.absoluteBoundingBox === 'object') {
    const { width, height } = node.absoluteBoundingBox;
    if (width !== undefined && height !== undefined) {
      out.size = { w: width, h: height };
    }
  }

  // Recurse into children
  if (Array.isArray(node.children)) {
    out.children = node.children.map(trimNode);
  }

  return out;
}

/**
 * Recursively strips every 'name' property from an object or array.
 */
function stripNames(val) {
  if (Array.isArray(val)) {
    return val.map(stripNames);
  }
  if (val && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === 'name') continue;
      res[k] = stripNames(v);
    }
    return res;
  }
  return val;
}

/**
 * Serializes a value to canonical JSON with sorted object keys.
 */
function canonicalStringify(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(val[k]));
  return '{' + entries.join(',') + '}';
}

/**
 * Computes sha256 hex hash of canonical JSON with every 'name' removed.
 * @param {object[]} trimmedFrames
 * @returns {string}
 */
export function sectionHash(trimmedFrames) {
  const frames = Array.isArray(trimmedFrames) ? trimmedFrames : [trimmedFrames];
  const withoutNames = stripNames(frames);
  const canonical = canonicalStringify(withoutNames);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
