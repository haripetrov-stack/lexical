/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Measures the cost of BlockIdExtension on a 10,000-block document. Timing
// is machine-dependent, so this only runs when BLOCK_ID_PERF=1:
//
//   BLOCK_ID_PERF=1 npx vitest --project unit --no-watch \
//     packages/lexical-extension/src/__tests__/unit/BlockIdExtension.perf.test.ts

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  INSERT_PARAGRAPH_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const BLOCKS = 10000;
const ROUNDS = 300;

function build(withIds: boolean): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ...(withIds ? [configExtension(BlockIdExtension, {})] : []),
    ],
    name: '[block-id-perf]',
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(withIds: boolean) {
  const editor = build(withIds);
  const json = JSON.stringify({
    root: {
      children: Array.from({length: BLOCKS}, (_, i) => ({
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: `Block ${i} with some text`,
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      })),
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
  let start = performance.now();
  editor.setEditorState(editor.parseEditorState(json));
  const load = performance.now() - start;

  const keys = editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => node.getKey()),
  );
  let seed = 1;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  const $caret = () => {
    const block = $getNodeByKey(keys[next() % BLOCKS]);
    const text = $isElementNode(block) ? block.getFirstDescendant() : null;
    if ($isTextNode(text)) {
      text.select(3, 3);
    }
  };
  const keystroke: number[] = [];
  const enter: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    start = performance.now();
    editor.update(
      () => {
        $caret();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('x');
        }
      },
      {discrete: true},
    );
    keystroke.push(performance.now() - start);
    start = performance.now();
    editor.update(
      () => {
        $caret();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      },
      {discrete: true},
    );
    enter.push(performance.now() - start);
  }
  editor.dispose();
  return {enter: median(enter), keystroke: median(keystroke), load};
}

describe.skipIf(process.env.BLOCK_ID_PERF !== '1')(
  'BlockIdExtension perf',
  () => {
    test(
      `${BLOCKS} blocks: keystroke and Enter overhead`,
      {timeout: 600000},
      () => {
        // Warm up the JIT on both configurations first.
        measure(false);
        measure(true);
        const without = measure(false);
        const withIds = measure(true);
        const row = (name: string, a: number, b: number) =>
          `${name.padEnd(22)} ${a.toFixed(3).padStart(9)} ms ${b
            .toFixed(3)
            .padStart(9)} ms ${(b - a).toFixed(3).padStart(9)} ms`;
        // eslint-disable-next-line no-console
        console.log(
          [
            `${BLOCKS} blocks, median of ${ROUNDS}   without      with     delta`,
            row('keystroke (median)', without.keystroke, withIds.keystroke),
            row('Enter (median)', without.enter, withIds.enter),
            row('load JSON (once)', without.load, withIds.load),
          ].join('\n'),
        );
        // Typing creates no block: no measurable cost.
        expect(withIds.keystroke).toBeLessThan(without.keystroke * 1.05 + 0.5);
        // Enter assigns one id. The extension's own work is ~0.1 ms here; the
        // rest is Lexical running the root transforms a second time because a
        // transform changed a node (see the PR for the profile).
        expect(withIds.enter).toBeLessThan(without.enter * 1.25 + 0.5);
      },
    );
  },
);
