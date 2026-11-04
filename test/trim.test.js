import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimNode, sectionHash } from '../src/trim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const p = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('trimNode drops ids, devStatus, and position while keeping styles and size', () => {
  const node = {
    id: '123:456',
    name: 'Test Frame',
    type: 'FRAME',
    devStatus: { type: 'READY_FOR_DEV' },
    transitionNodeID: '789:0',
    absoluteRenderBounds: { x: 10, y: 20, width: 100, height: 200 },
    absoluteBoundingBox: { x: 50, y: 100, width: 250, height: 180 },
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    strokes: [],
    strokeWeight: 2,
    effects: [],
    cornerRadius: 8,
    rectangleCornerRadii: [8, 8, 8, 8],
    opacity: 0.9,
    visible: true,
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 24,
    paddingRight: 24,
    primaryAxisAlignItems: 'CENTER',
    counterAxisAlignItems: 'MAX',
    layoutSizingHorizontal: 'FILL',
    layoutSizingVertical: 'HUG',
    layoutWrap: 'NO_WRAP',
    children: [
      {
        id: 'child:1',
        name: 'Label',
        type: 'TEXT',
        characters: 'Hello World',
        devStatus: { type: 'READY_FOR_DEV' },
        style: {
          fontFamily: 'Inter',
          fontWeight: 600,
          fontSize: 16,
          lineHeightPx: 24,
          letterSpacing: 0.5,
          textAlignHorizontal: 'CENTER',
          textAlignVertical: 'CENTER',
          textCase: 'UPPER'
        },
        absoluteBoundingBox: { x: 60, y: 110, width: 80, height: 24 }
      }
    ]
  };

  const trimmed = trimNode(node);

  // Assert dropped properties
  assert.strictEqual(trimmed.id, undefined);
  assert.strictEqual(trimmed.devStatus, undefined);
  assert.strictEqual(trimmed.transitionNodeID, undefined);
  assert.strictEqual(trimmed.absoluteRenderBounds, undefined);
  assert.strictEqual(trimmed.absoluteBoundingBox, undefined);
  assert.strictEqual(trimmed.x, undefined);
  assert.strictEqual(trimmed.y, undefined);

  // Assert kept properties
  assert.strictEqual(trimmed.name, 'Test Frame');
  assert.strictEqual(trimmed.type, 'FRAME');
  assert.deepStrictEqual(trimmed.size, { w: 250, h: 180 });
  assert.strictEqual(trimmed.strokeWeight, 2);
  assert.strictEqual(trimmed.cornerRadius, 8);
  assert.strictEqual(trimmed.opacity, 0.9);
  assert.strictEqual(trimmed.layoutMode, 'VERTICAL');
  assert.strictEqual(trimmed.paddingTop, 12);
  assert.strictEqual(trimmed.paddingLeft, 24);
  assert.strictEqual(trimmed.primaryAxisAlignItems, 'CENTER');
  assert.strictEqual(trimmed.counterAxisAlignItems, 'MAX');
  assert.strictEqual(trimmed.layoutSizingHorizontal, 'FILL');

  // Assert child trimming
  assert.strictEqual(trimmed.children.length, 1);
  const child = trimmed.children[0];
  assert.strictEqual(child.id, undefined);
  assert.strictEqual(child.devStatus, undefined);
  assert.strictEqual(child.characters, 'Hello World');
  assert.deepStrictEqual(child.size, { w: 80, h: 24 });
  assert.strictEqual(child.style.fontFamily, 'Inter');
  assert.strictEqual(child.style.textCase, 'UPPER');
});

test('hash ignores devStatus, ids and canvas position', () => {
  const readyFixture = loadFixture('nodes-ready.json');
  const movedFixture = loadFixture('nodes-moved.json');

  const readyNavTrimmed = [
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ];

  const movedNavTrimmed = [
    trimNode(movedFixture.nodes['1:1'].document),
    trimNode(movedFixture.nodes['1:2'].document)
  ];

  const hashReady = sectionHash(readyNavTrimmed);
  const hashMoved = sectionHash(movedNavTrimmed);

  assert.strictEqual(typeof hashReady, 'string');
  assert.match(hashReady, /^[a-f0-9]{64}$/);
  assert.strictEqual(hashReady, hashMoved);
});

test('hash changes when text, a fill or padding changes', () => {
  const readyFixture = loadFixture('nodes-ready.json');
  const baseFrames = [
    trimNode(readyFixture.nodes['1:1'].document),
    trimNode(readyFixture.nodes['1:2'].document)
  ];
  const baseHash = sectionHash(baseFrames);

  // 1. Text change
  const textChangedFrames = JSON.parse(JSON.stringify(baseFrames));
  textChangedFrames[0].children[0].characters = 'Different Text';
  const textHash = sectionHash(textChangedFrames);
  assert.notStrictEqual(textHash, baseHash);

  // 2. Fill change
  const fillChangedFrames = JSON.parse(JSON.stringify(baseFrames));
  fillChangedFrames[0].fills = [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }];
  const fillHash = sectionHash(fillChangedFrames);
  assert.notStrictEqual(fillHash, baseHash);

  // 3. Padding change
  const paddingChangedFrames = JSON.parse(JSON.stringify(baseFrames));
  paddingChangedFrames[0].paddingTop = 99;
  const paddingHash = sectionHash(paddingChangedFrames);
  assert.notStrictEqual(paddingHash, baseHash);
});

test('moving the whole frame on the canvas keeps the hash', () => {
  const tree = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 130, y: 260, width: 200, height: 200 },
        children: [
          {
            id: '1:2',
            name: 'Grandchild',
            type: 'FRAME',
            absoluteBoundingBox: { x: 140, y: 270, width: 50, height: 50 }
          }
        ]
      }
    ]
  };

  // Every absoluteBoundingBox shifted by (+500, +300)
  const shiftedTree = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 600, y: 500, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 630, y: 560, width: 200, height: 200 },
        children: [
          {
            id: '1:2',
            name: 'Grandchild',
            type: 'FRAME',
            absoluteBoundingBox: { x: 640, y: 570, width: 50, height: 50 }
          }
        ]
      }
    ]
  };

  const hashOriginal = sectionHash([trimNode(tree)]);
  const hashShifted = sectionHash([trimNode(shiftedTree)]);
  assert.strictEqual(hashShifted, hashOriginal);
});

test('moving a layer inside the frame changes the hash', () => {
  const tree = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 130, y: 260, width: 200, height: 200 },
        children: [
          {
            id: '1:2',
            name: 'Grandchild',
            type: 'FRAME',
            absoluteBoundingBox: { x: 140, y: 270, width: 50, height: 50 }
          }
        ]
      }
    ]
  };

  // Shift one child and its descendants by y + 40
  const shiftedChildTree = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 130, y: 300, width: 200, height: 200 },
        children: [
          {
            id: '1:2',
            name: 'Grandchild',
            type: 'FRAME',
            absoluteBoundingBox: { x: 140, y: 310, width: 50, height: 50 }
          }
        ]
      }
    ]
  };

  const hashOriginal = sectionHash([trimNode(tree)]);
  const hashMoved = sectionHash([trimNode(shiftedChildTree)]);
  assert.notStrictEqual(hashMoved, hashOriginal);
});

test('children carry their position relative to the parent', () => {
  const root = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 130, y: 260, width: 200, height: 200 },
        children: [
          {
            id: '1:2',
            name: 'Grandchild',
            type: 'FRAME',
            absoluteBoundingBox: { x: 140, y: 270, width: 50, height: 50 }
          }
        ]
      }
    ]
  };

  const trimmed = trimNode(root);
  assert.strictEqual(trimmed.pos, undefined);
  assert.deepStrictEqual(trimmed.children[0].pos, { x: 30, y: 60 });
  assert.deepStrictEqual(trimmed.children[0].children[0].pos, { x: 10, y: 10 });

  // Check rounding to 2 decimals
  const rootWithDecimals = {
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        absoluteBoundingBox: { x: 130.456, y: 260.789, width: 200, height: 200 }
      }
    ]
  };
  const trimmedDecimals = trimNode(rootWithDecimals);
  assert.deepStrictEqual(trimmedDecimals.children[0].pos, { x: 30.46, y: 60.79 });
});

test('a numeric second argument is ignored', () => {
  const root = {
    id: '1:0',
    name: 'Root',
    type: 'FRAME',
    absoluteBoundingBox: { x: 100, y: 200, width: 500, height: 500 },
    children: [
      {
        id: '1:1',
        name: 'Child',
        type: 'FRAME',
        absoluteBoundingBox: { x: 130, y: 260, width: 200, height: 200 }
      }
    ]
  };

  const fromMap = [root].map(trimNode)[0];
  const direct = trimNode(root);
  assert.deepStrictEqual(fromMap, direct);
});
