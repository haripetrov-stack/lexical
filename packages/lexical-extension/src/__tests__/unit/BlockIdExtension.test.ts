/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {
  $createHorizontalRuleNode,
  $defaultIsIdentifiedBlock,
  $getBlockById,
  $getBlockId,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  generateBlockId,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $isListItemNode,
  INSERT_UNORDERED_LIST_COMMAND,
  ListExtension,
} from '@lexical/list';
import {
  $convertFromMarkdownString,
  HEADING,
  ORDERED_LIST,
  QUOTE,
  UNORDERED_LIST,
} from '@lexical/markdown';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  TableExtension,
} from '@lexical/table';
import {
  $copyNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $setState,
  COLLABORATION_TAG,
  configExtension,
  DELETE_CHARACTER_COMMAND,
  type ElementNode,
  HISTORY_PUSH_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  PASTE_TAG,
  REDO_COMMAND,
  type SerializedEditorState,
  type SerializedElementNode,
  type SerializedLexicalNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, test, vi} from 'vitest';

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

interface BuildOptions {
  generateId?: () => string;
  $isIdentifiedBlock?: (node: LexicalNode) => boolean;
  disabled?: boolean;
  history?: boolean;
}

function build(options: BuildOptions = {}): LexicalEditorWithDispose {
  let clock = 0;
  return buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      TableExtension,
      HorizontalRuleExtension,
      ...(options.history
        ? [
            configExtension(HistoryExtension, {
              // History is disabled by default where there is no window.
              disabled: false,
              now: () => (clock += 10000),
            }),
          ]
        : []),
      configExtension(BlockIdExtension, {
        generateId: options.generateId || counter(),
        ...(options.$isIdentifiedBlock
          ? {$isIdentifiedBlock: options.$isIdentifiedBlock}
          : {}),
        disabled: options.disabled || false,
      }),
    ],
    name: '[block-id-test]',
  });
}

function update(
  editor: LexicalEditor,
  fn: () => void,
  tag?: string | string[],
): void {
  editor.update(fn, {discrete: true, tag});
}

/** `type:text:id` for each child of the root. */
function blocks(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(
        node =>
          `${node.getType()}:${node.getTextContent()}:${$getBlockId(node)}`,
      ),
  );
}

function ids(editor: LexicalEditor): (string | null)[] {
  return editor.read(() => $getRoot().getChildren().map($getBlockId));
}

function $paragraph(text: string): ElementNode {
  return $createParagraphNode().append($createTextNode(text));
}

/** A deep copy that keeps NodeState, as a Lexical-JSON paste does. */
function $deepCopy<T extends LexicalNode>(node: T): T {
  const serialize = (n: LexicalNode): SerializedLexicalNode => {
    const json = n.exportJSON();
    if ($isElementNode(n)) {
      (json as SerializedElementNode).children = n.getChildren().map(serialize);
    }
    return json;
  };
  return $parseSerializedNode(serialize(node)) as T;
}

function $nth(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  assert($isElementNode(node), `child ${index} is an element`);
  return node;
}

/** Put a collapsed selection at `offset` characters into block `index`. */
function $caret(index: number, offset: number): void {
  const block = $nth(index);
  const text = block.getFirstDescendant();
  if ($isTextNode(text)) {
    text.select(offset, offset);
  } else {
    block.select(0, 0);
  }
}

/** Select from the start of block `from` to the end of block `to`. */
function $selectBlocks(from: number, to: number): void {
  const first = $nth(from).getFirstDescendant();
  const last = $nth(to).getLastDescendant();
  assert($isTextNode(first) && $isTextNode(last));
  first.select(0, 0);
  const range = $getSelection();
  assert($isRangeSelection(range));
  range.focus.set(last.getKey(), last.getTextContentSize(), 'text');
}

function seed(editor: LexicalEditor, texts: string[]): void {
  update(editor, () => {
    $getRoot()
      .clear()
      .append(...texts.map($paragraph));
  });
}

function paragraphJSON(text: string, id?: unknown): SerializedLexicalNode {
  return {
    ...(id === undefined ? {} : {$: {blockId: id}}),
    children: [
      {
        detail: 0,
        format: 0,
        mode: 'normal',
        style: '',
        text,
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
  } as SerializedLexicalNode;
}

function docJSON(children: SerializedLexicalNode[]): string {
  return JSON.stringify({
    root: {
      children,
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
}

function expectUnique(editor: LexicalEditor): void {
  const all = ids(editor);
  expect(all.every(id => typeof id === 'string')).toBe(true);
  expect(new Set(all).size).toBe(all.length);
}

describe('BlockIdExtension: assignment', () => {
  test('a block gets its id in the commit that creates it', () => {
    using editor = build();
    const committed: (string | null)[][] = [];
    editor.registerUpdateListener(({editorState}) => {
      committed.push(
        editorState.read(() => $getRoot().getChildren().map($getBlockId)),
      );
    });
    update(editor, () => {
      $getRoot().append($paragraph('one'), $createHorizontalRuleNode());
    });
    // One commit, already carrying both ids: nothing is left for a later
    // update to assign.
    expect(committed).toEqual([['b1', 'b2']]);
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'horizontalrule:\n:b2',
    ]);
  });

  test('importJSON assigns ids in the same commit, keeps existing ones', () => {
    using editor = build();
    let commits = 0;
    editor.registerUpdateListener(() => commits++);
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          paragraphJSON('kept', 'keep-me'),
          paragraphJSON('missing'),
          paragraphJSON('also kept', 'x_9-Z'),
        ]),
      ),
    );
    expect(commits).toBe(1);
    expect(blocks(editor)).toEqual([
      'paragraph:kept:keep-me',
      'paragraph:missing:b1',
      'paragraph:also kept:x_9-Z',
    ]);
  });

  test('a document opened without ids gets them on its first update', () => {
    const json = docJSON([paragraphJSON('a'), paragraphJSON('b')]);
    using editor = buildEditorFromExtensions({
      $initialEditorState: json,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {generateId: counter()}),
      ],
      name: '[opened]',
    });
    expect(blocks(editor)).toEqual(['paragraph:a:b1', 'paragraph:b:b2']);
  });

  test('a state from an editor without the extension is repaired', () => {
    using plain = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot().append($paragraph('a'), $paragraph('b'));
      },
      dependencies: [RichTextExtension],
      name: '[plain]',
    });
    plain.read(() => {});
    using editor = build();
    // Not parsed: setEditorState marks only the root dirty, so the index is
    // rebuilt and the missing ids are assigned by a follow-up update.
    editor.setEditorState(plain.getEditorState());
    expect(blocks(editor)).toEqual(['paragraph:a:b1', 'paragraph:b:b2']);
  });

  test('headless one-write recipe from the docs', () => {
    // Stored JSON without ids (or with some) …
    const stored = docJSON([
      paragraphJSON('Intro'),
      paragraphJSON('Body', 'b-body'),
    ]);
    // … is loaded, assigned, and serialized in one synchronous write.
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {generateId: counter('id')}),
      ],
      name: '[server]',
    });
    editor.setEditorState(editor.parseEditorState(stored));
    const json: SerializedEditorState = editor.getEditorState().toJSON();
    expect(json.root.children.map(child => child.$)).toEqual([
      {blockId: 'id1'},
      {blockId: 'b-body'},
    ]);
    // An agent edit addressed by id, also synchronous.
    editor.update(
      () => {
        const block = $getBlockById('b-body');
        assert(block !== null);
        block.replace($paragraph('New body'));
      },
      {discrete: true},
    );
    const after = editor.getEditorState().toJSON();
    // The replacement sits where the removed block sat, so it keeps its id.
    expect(after.root.children.map(child => child.$)).toEqual([
      {blockId: 'id1'},
      {blockId: 'b-body'},
    ]);
  });

  test('invalid stored ids are replaced', () => {
    using editor = build();
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          paragraphJSON('number', 42),
          paragraphJSON('empty', ''),
          paragraphJSON('long', 'x'.repeat(129)),
          paragraphJSON('max', 'y'.repeat(128)),
        ]),
      ),
    );
    expect(ids(editor)).toEqual(['b1', 'b2', 'b3', 'y'.repeat(128)]);
  });

  test('generateId collisions are retried and a broken generator throws', () => {
    const sequence = ['dup', 'dup', 'dup', 'fresh'];
    using editor = build({generateId: () => sequence.shift() || 'dup'});
    update(editor, () => {
      $getRoot().append($paragraph('a'), $paragraph('b'));
    });
    expect(ids(editor)).toEqual(['dup', 'fresh']);
    expect(() =>
      update(editor, () => {
        $getRoot().append($paragraph('c'));
      }),
    ).toThrow(/generateId returned 32 ids in a row/);
  });

  test('the default generator makes short URL-safe ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateBlockId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });

  test('markdown import assigns ids', () => {
    using editor = build();
    update(editor, () => {
      $convertFromMarkdownString(
        '# Title\n\nText\n\n> Quote\n\n- one\n- two\n\n1. first',
        [HEADING, QUOTE, UNORDERED_LIST, ORDERED_LIST],
      );
    });
    expect(blocks(editor)).toEqual([
      'heading:Title:b1',
      'paragraph:Text:b2',
      'quote:Quote:b3',
      'list:one\n\ntwo:b4',
      'list:first:b5',
    ]);
  });
});

describe('BlockIdExtension: uniqueness', () => {
  test('duplicates in imported JSON: the earliest keeps the id', () => {
    using editor = build();
    editor.setEditorState(
      editor.parseEditorState(
        docJSON([
          paragraphJSON('first', 'x'),
          paragraphJSON('second', 'y'),
          paragraphJSON('copy of first', 'x'),
          paragraphJSON('another copy', 'x'),
          paragraphJSON('copy of second', 'y'),
        ]),
      ),
    );
    expect(ids(editor)).toEqual(['x', 'y', 'b1', 'b2', 'b3']);
  });

  test('deterministic and idempotent', () => {
    const json = docJSON([
      paragraphJSON('c', 'z'),
      paragraphJSON('a', 'z'),
      paragraphJSON('b'),
      paragraphJSON('d', 'z'),
    ]);
    const run = () => {
      using editor = build();
      editor.setEditorState(editor.parseEditorState(json));
      return editor.getEditorState().toJSON();
    };
    const first = run();
    expect(run()).toEqual(first);
    // Loading the repaired document again changes nothing.
    using editor = build({generateId: counter('again')});
    editor.setEditorState(editor.parseEditorState(JSON.stringify(first)));
    expect(editor.getEditorState().toJSON()).toEqual(first);
    // And neither do more updates.
    update(editor, () => $nth(0).markDirty());
    expect(editor.getEditorState().toJSON()).toEqual(first);
  });

  test('a duplicate inserted after the original gets a fresh id', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      const original = $nth(0);
      const copy = $parseSerializedNode(original.exportJSON());
      expect($getBlockId(copy)).toBe('b1');
      $nth(1).insertAfter(copy);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph::b3',
    ]);
  });

  test('a duplicate inserted above the original yields to it', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      const copy = $parseSerializedNode($nth(1).exportJSON());
      expect($getBlockId(copy)).toBe('b2');
      $nth(0).insertBefore(copy);
    });
    // The original existed before this update, so it keeps b2 even though
    // the copy comes first in the document.
    expect(ids(editor)).toEqual(['b3', 'b1', 'b2']);
  });

  test('duplicating a block upward keeps the id on the original', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $nth(0).insertBefore($deepCopy($nth(2)));
    });
    expect(blocks(editor)).toEqual([
      'paragraph:three:b4',
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph:three:b3',
    ]);
    editor.read(() => {
      expect($getBlockById('b3')).toBe($nth(3));
    });
  });

  test('blocks that all arrive in one update: the earliest keeps the id', () => {
    using editor = build();
    seed(editor, ['one']);
    update(editor, () => {
      const copy = (text: string) => {
        const node = $paragraph(text);
        $setState(node, blockIdState, 'same');
        return node;
      };
      $nth(0).insertAfter(copy('later'));
      $nth(0).insertAfter(copy('earlier'));
    });
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:earlier:same',
      'paragraph:later:b2',
    ]);
  });

  test('$copyNode does not copy the id', () => {
    using editor = build();
    seed(editor, ['one']);
    update(editor, () => {
      const copy = $copyNode($nth(0));
      expect($getState(copy, blockIdState)).toBeUndefined();
      $nth(0).insertBefore(copy);
    });
    // The original keeps its id even though the copy comes first.
    expect(ids(editor)).toEqual(['b2', 'b1']);
  });

  test('an explicit id that is already in use is repaired', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $setState($nth(1), blockIdState, 'b1');
    });
    expect(ids(editor)).toEqual(['b1', 'b3']);
    update(editor, () => {
      $setState($nth(0), blockIdState, 'b3');
    });
    // The first block claims the second block's id, but the second block
    // already had it and keeps it.
    expect(ids(editor)).toEqual(['b4', 'b3']);
  });

  test('copy and paste within one editor and between editors', () => {
    using source = build({generateId: counter('s')});
    using target = build({generateId: counter('t')});
    seed(source, ['alpha', 'beta']);
    seed(target, ['gamma']);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(source, () => {
      $selectBlocks(0, 1);
      copied = $generateJSONFromSelectedNodes(source, $getSelection());
    });
    expect(copied.nodes.map(node => (node as {$?: unknown}).$)).toEqual([
      {blockId: 's1'},
      {blockId: 's2'},
    ]);
    const paste = (editor: LexicalEditor) =>
      update(editor, () => {
        $getRoot().selectEnd();
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(copied.nodes),
          $getSelection()!,
        );
      });
    // Into another editor that does not use the ids: they are kept.
    paste(target);
    expect(blocks(target)).toEqual([
      'paragraph:gammaalpha:t1',
      'paragraph:beta:s2',
    ]);
    // Into the same editor: the pasted copies yield to the originals.
    paste(source);
    expectUnique(source);
    expect(ids(source).slice(0, 2)).toEqual(['s1', 's2']);
  });

  function $copyBlocks(editor: LexicalEditor, from: number, to: number) {
    $selectBlocks(from, to);
    return $generateJSONFromSelectedNodes(editor, $getSelection());
  }

  function $pasteInto(
    editor: LexicalEditor,
    copied: ReturnType<typeof $generateJSONFromSelectedNodes>,
    block: ElementNode,
  ) {
    block.select();
    $insertGeneratedNodes(
      editor,
      $generateNodesFromSerializedNodes(copied.nodes),
      $getSelection()!,
    );
  }

  test('pasting a copy above the original: the original keeps its id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createParagraphNode(),
        $paragraph('alpha'),
        $paragraph('beta'),
      );
    });
    expect(ids(editor)).toEqual(['b1', 'b2', 'b3']);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(editor, () => {
      copied = $copyBlocks(editor, 1, 2);
    });
    update(editor, () => $pasteInto(editor, copied, $nth(0)), PASTE_TAG);
    // The pasted blocks replace the empty paragraph (b1 goes with it). They
    // are new in this update, so they yield to the originals.
    expect(blocks(editor)).toEqual([
      'paragraph:alpha:b4',
      'paragraph:beta:b5',
      'paragraph:alpha:b2',
      'paragraph:beta:b3',
    ]);
  });

  test('cut and paste moves the ids with the blocks', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('one'),
        $paragraph('two'),
        $paragraph('three'),
        $createParagraphNode(),
      );
    });
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    // Cut, in its own update…
    update(editor, () => {
      copied = $copyBlocks(editor, 0, 1);
      $nth(1).remove();
      $nth(0).remove();
    });
    expect(ids(editor)).toEqual(['b3', 'b4']);
    // …and paste later: nothing else has the ids, so the pasted blocks keep
    // them.
    update(editor, () => $pasteInto(editor, copied, $nth(1)), PASTE_TAG);
    expect(blocks(editor)).toEqual([
      'paragraph:three:b3',
      'paragraph:one:b1',
      'paragraph:two:b2',
    ]);
    // The same in a single update (a move done as remove + insert of a copy).
    update(editor, () => {
      const copy = $deepCopy($nth(0));
      $nth(0).remove();
      $nth(1).insertAfter(copy);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:one:b1',
      'paragraph:two:b2',
      'paragraph:three:b3',
    ]);
  });

  test('undo of a paste restores the ids, redo the repaired ones', () => {
    using editor = build({history: true});
    update(editor, () => {
      $getRoot().append(
        $createParagraphNode(),
        $paragraph('alpha'),
        $paragraph('beta'),
      );
    });
    const before = blocks(editor);
    let copied!: ReturnType<typeof $generateJSONFromSelectedNodes>;
    update(editor, () => {
      copied = $copyBlocks(editor, 1, 2);
    });
    update(editor, () => $pasteInto(editor, copied, $nth(0)), PASTE_TAG);
    const after = blocks(editor);
    expect(after).toEqual([
      'paragraph:alpha:b4',
      'paragraph:beta:b5',
      'paragraph:alpha:b2',
      'paragraph:beta:b3',
    ]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(blocks(editor)).toEqual(before);
    editor.read(() => {
      expect($getBlockById('b4')).toBeNull();
      expect($getBlockById('b5')).toBeNull();
      expect($getBlockById('b2')!.getTextContent()).toBe('alpha');
    });
    editor.dispatchCommand(REDO_COMMAND, undefined);
    expect(blocks(editor)).toEqual(after);
  });
});

describe('BlockIdExtension: split and merge', () => {
  function enter(editor: LexicalEditor, index: number, offset: number) {
    update(editor, () => {
      $caret(index, offset);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
  }

  test.each([
    ['start', 0, ['paragraph::b3', 'paragraph:hello:b1']],
    ['middle', 2, ['paragraph:he:b1', 'paragraph:llo:b3']],
    ['end', 5, ['paragraph:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a paragraph', (_, offset, expected) => {
    using editor = build();
    seed(editor, ['hello', 'next']);
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    ['start', 0, ['paragraph::b3', 'heading:hello:b1']],
    ['middle', 2, ['heading:he:b1', 'heading:llo:b3']],
    ['end', 5, ['heading:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a heading', (_, offset, expected) => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createHeadingNode('h1').append($createTextNode('hello')),
        $paragraph('next'),
      );
    });
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    // QuoteNode.insertNewAfter creates a paragraph, so Enter at the start
    // leaves an empty quote above and moves the text into a paragraph. The
    // text keeps its id.
    ['start', 0, ['quote::b3', 'paragraph:hello:b1']],
    ['middle', 2, ['quote:he:b1', 'paragraph:llo:b3']],
    ['end', 5, ['quote:hello:b1', 'paragraph::b3']],
  ])('Enter at the %s of a quote', (_, offset, expected) => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createQuoteNode().append($createTextNode('hello')),
        $paragraph('next'),
      );
    });
    enter(editor, 0, offset);
    expect(blocks(editor)).toEqual([...expected, 'paragraph:next:b2']);
  });

  test.each([
    ['start', 0, [':b4', 'one:b1']],
    ['middle', 1, ['o:b1', 'ne:b4']],
    ['end', 3, ['one:b1', ':b4']],
  ])('Enter at the %s of a list item (nested ids)', (_, offset, expected) => {
    using editor = build({
      $isIdentifiedBlock: node =>
        $defaultIsIdentifiedBlock(node) || $isListItemNode(node),
    });
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $selectBlocks(0, 1);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    const items = () =>
      editor.read(() =>
        $nth(0)
          .getChildren()
          .map(item => `${item.getTextContent()}:${$getBlockId(item)}`),
      );
    // The items took the paragraphs' content, and with it their ids; the
    // list is a new block.
    expect(ids(editor)).toEqual(['b3']);
    expect(items()).toEqual(['one:b1', 'two:b2']);
    update(editor, () => {
      const item = $nth(0).getFirstChildOrThrow<ElementNode>();
      const text = item.getFirstDescendant();
      assert($isTextNode(text));
      text.select(offset, offset);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(items()).toEqual([...expected, 'two:b2']);
  });

  test('Backspace join keeps the surviving block id', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual([
      'paragraph:onetwo:b1',
      'paragraph:three:b3',
    ]);
    // Forward delete at the end joins the next block into this one.
    update(editor, () => {
      $caret(0, 6);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, false);
    });
    expect(blocks(editor)).toEqual(['paragraph:onetwothree:b1']);
  });

  test('Backspace into a heading keeps the heading id', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $createHeadingNode('h2').append($createTextNode('Title')),
        $paragraph('body'),
      );
    });
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual(['heading:Titlebody:b1']);
  });

  test('Backspace at the start of a heading after a paragraph joins into the paragraph', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('before'),
        $createHeadingNode('h2').append($createTextNode('Title')),
      );
    });
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    expect(blocks(editor)).toEqual(['paragraph:beforeTitle:b1']);
  });
});

describe('BlockIdExtension: type changes and moves', () => {
  test.each([
    ['heading', () => $createHeadingNode('h1')],
    ['quote', () => $createQuoteNode()],
  ])('paragraph to %s keeps the id', (type, $create) => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $caret(1, 1);
      $setBlocksType($getSelection(), $create as () => ElementNode);
    });
    expect(blocks(editor)).toEqual(['paragraph:one:b1', `${type}:two:b2`]);
    // And back.
    update(editor, () => {
      $caret(1, 1);
      $setBlocksType($getSelection(), $createParagraphNode);
    });
    expect(blocks(editor)).toEqual(['paragraph:one:b1', 'paragraph:two:b2']);
  });

  test('several blocks at once, including empty ones, keep their ids', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append(
        $paragraph('a'),
        $createParagraphNode(),
        $createParagraphNode(),
        $paragraph('d'),
      );
    });
    update(editor, () => {
      $getRoot().select(0, 4);
      $setBlocksType($getSelection(), () => $createHeadingNode('h3'));
    });
    expect(blocks(editor)).toEqual([
      'heading:a:b1',
      'heading::b2',
      'heading::b3',
      'heading:d:b4',
    ]);
  });

  test('paragraph to list keeps the id on the list', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $caret(1, 0);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    expect(blocks(editor)).toEqual(['paragraph:one:b1', 'list:two:b2']);
  });

  test('moving a block (drag and drop) moves its id', () => {
    using editor = build();
    seed(editor, ['one', 'two', 'three']);
    update(editor, () => {
      $nth(2).insertAfter($nth(0));
    });
    expect(blocks(editor)).toEqual([
      'paragraph:two:b2',
      'paragraph:three:b3',
      'paragraph:one:b1',
    ]);
    update(editor, () => {
      $nth(0).insertBefore($nth(2));
    });
    expect(ids(editor)).toEqual(['b1', 'b2', 'b3']);
  });

  test('replacing a block by hand keeps its id unless the new block has one', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $nth(0).replace($paragraph('uno'));
    });
    expect(ids(editor)).toEqual(['b1', 'b2']);
    update(editor, () => {
      const replacement = $paragraph('dos');
      $setState(replacement, blockIdState, 'explicit');
      $nth(1).replace(replacement);
    });
    expect(ids(editor)).toEqual(['b1', 'explicit']);
  });

  test('removing a block and appending a new one elsewhere does not reuse the id', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    update(editor, () => {
      $nth(0).remove();
      $getRoot().append($paragraph('three'));
    });
    expect(ids(editor)).toEqual(['b2', 'b3']);
  });
});

describe('BlockIdExtension: undo and redo', () => {
  test('restore exact ids', () => {
    using editor = build({history: true});
    seed(editor, ['one', 'two']);
    const snapshots: string[][] = [blocks(editor)];
    const step = (fn: () => void) => {
      update(editor, fn, HISTORY_PUSH_TAG);
      snapshots.push(blocks(editor));
    };
    step(() => {
      $caret(0, 1);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    step(() => {
      $caret(2, 0);
      $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
    });
    step(() => {
      $caret(1, 0);
      editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    });
    step(() => {
      $nth(1).insertBefore($nth(0));
    });
    for (let i = snapshots.length - 2; i >= 0; i--) {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(blocks(editor)).toEqual(snapshots[i]);
      editor.read(() => {
        for (const block of $getRoot().getChildren()) {
          expect($getBlockById($getBlockId(block)!)).toBe(block);
        }
      });
    }
    for (let i = 1; i < snapshots.length; i++) {
      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(blocks(editor)).toEqual(snapshots[i]);
    }
  });
});

describe('BlockIdExtension: index', () => {
  test('$getBlockById finds blocks and follows changes', () => {
    using editor = build();
    seed(editor, ['one', 'two']);
    editor.read(() => {
      expect($getBlockById('b1')!.getTextContent()).toBe('one');
      expect($getBlockById('b2')!.getTextContent()).toBe('two');
      expect($getBlockById('nope')).toBeNull();
    });
    update(editor, () => {
      $nth(0).remove();
      // Removed in this update: no longer found, even before the commit.
      expect($getBlockById('b1')).toBeNull();
    });
    editor.read(() => {
      expect($getBlockById('b1')).toBeNull();
      expect($getBlockById('b2')!.getTextContent()).toBe('two');
    });
    update(editor, () => {
      $setState($nth(0), blockIdState, 'renamed');
    });
    editor.read(() => {
      expect($getBlockById('b2')).toBeNull();
      expect($getBlockById('renamed')!.getTextContent()).toBe('two');
    });
  });

  test('typing does not evaluate $isIdentifiedBlock for untouched blocks', () => {
    const predicate = vi.fn($defaultIsIdentifiedBlock);
    using editor = build({$isIdentifiedBlock: predicate});
    seed(
      editor,
      Array.from({length: 1000}, (_, i) => `block ${i}`),
    );
    expect(new Set(ids(editor)).size).toBe(1000);
    predicate.mockClear();
    update(editor, () => {
      $caret(500, 3);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.insertText('x');
    });
    // O(dirty): the edited text's block and its ancestors, not the document.
    expect(predicate.mock.calls.length).toBeLessThan(10);
    predicate.mockClear();
    update(editor, () => {
      $caret(500, 3);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(predicate.mock.calls.length).toBeLessThan(20);
    expectUnique(editor);
  });

  test('nested blocks in lists and tables', () => {
    using editor = build({
      $isIdentifiedBlock: node =>
        $defaultIsIdentifiedBlock(node) ||
        $isListItemNode(node) ||
        $isTableCellNode(node),
    });
    update(editor, () => {
      $getRoot().append(
        $createTableNodeWithDimensions(2, 2, false),
        $paragraph('a'),
        $paragraph('b'),
      );
    });
    update(editor, () => {
      $selectBlocks(1, 2);
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    const tree = editor.read(() => {
      const out: string[] = [];
      const walk = (node: LexicalNode, depth: number) => {
        const id = $getBlockId(node);
        if (id !== null) {
          out.push(`${'  '.repeat(depth)}${node.getType()}:${id}`);
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) {
            walk(child, depth + 1);
          }
        }
      };
      walk($getRoot(), -1);
      return out;
    });
    expect(tree).toEqual([
      'table:b1',
      '    tablecell:b2',
      '    tablecell:b3',
      '    tablecell:b4',
      '    tablecell:b5',
      'list:b8',
      '  listitem:b6',
      '  listitem:b7',
    ]);
    editor.read(() => {
      expect($getBlockById('b4')!.getType()).toBe('tablecell');
      expect($getBlockById('b7')!.getTextContent()).toBe('b');
      expect($getBlockById('b8')!.getType()).toBe('list');
    });
  });

  test('disabled stops assignment; enabling assigns everything', () => {
    using editor = build({disabled: true});
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      BlockIdExtension,
    ).output;
    seed(editor, ['one', 'two']);
    expect(ids(editor)).toEqual([null, null]);
    update(editor, () => {
      $setState($nth(1), blockIdState, 'manual');
    });
    editor.read(() => {
      // Not indexed while disabled: found by a scan.
      expect($getBlockById('manual')!.getTextContent()).toBe('two');
    });
    disabled.value = false;
    expect(ids(editor)).toEqual(['b1', 'manual']);
    editor.read(() => {
      expect($getBlockById('b1')!.getTextContent()).toBe('one');
    });
    disabled.value = true;
    update(editor, () => {
      $getRoot().append($paragraph('three'));
    });
    // Existing ids are kept; new blocks are left alone.
    expect(ids(editor)).toEqual(['b1', 'manual', null]);
  });
});

describe('BlockIdExtension: transforms skipped', () => {
  test('a change applied without transforms (remote) is repaired in a follow-up', () => {
    using editor = build();
    seed(editor, ['one']);
    let collabCommits = 0;
    let repairCommits = 0;
    editor.registerUpdateListener(({tags}) => {
      if (tags.has(COLLABORATION_TAG)) {
        collabCommits++;
      } else if (tags.has('block-id-repair')) {
        repairCommits++;
      }
    });
    editor.update(
      () => {
        const copy = $parseSerializedNode($nth(0).exportJSON());
        $getRoot().append(copy, $paragraph('no id'));
      },
      {discrete: true, skipTransforms: true, tag: COLLABORATION_TAG},
    );
    // Reading flushes the follow-up update queued by the listener.
    const after = blocks(editor);
    expect(collabCommits).toBe(1);
    expect(repairCommits).toBe(1);
    expect(after).toEqual([
      'paragraph:one:b1',
      // exportJSON does not include children, so the copy is empty.
      'paragraph::b2',
      'paragraph:no id:b3',
    ]);
  });

  test('transforms in a collaboration update leave the repair to the follow-up', () => {
    using editor = build();
    seed(editor, ['one']);
    const tagsSeen: string[][] = [];
    editor.registerUpdateListener(({tags, editorState}) => {
      tagsSeen.push([
        ...[...tags].filter(t => t !== 'history-merge'),
        ...editorState.read(() =>
          $getRoot()
            .getChildren()
            .map(n => `${$getBlockId(n)}`),
        ),
      ]);
    });
    update(
      editor,
      () => {
        $getRoot().append($paragraph('remote'));
      },
      COLLABORATION_TAG,
    );
    editor.read(() => {});
    expect(tagsSeen).toEqual([
      ['collaboration', 'b1', 'null'],
      ['block-id-repair', 'b1', 'b2'],
    ]);
  });
});

describe('BlockIdExtension: misc', () => {
  test('headings created by Enter at start keep ids unique', () => {
    using editor = build();
    update(editor, () => {
      $getRoot().append($createHeadingNode('h1').append($createTextNode('A')));
    });
    update(editor, () => {
      $caret(0, 0);
      editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    expect(blocks(editor)).toEqual(['paragraph::b2', 'heading:A:b1']);
    editor.read(() => {
      expect($isParagraphNode($nth(0))).toBe(true);
      expect($isHeadingNode($nth(1))).toBe(true);
    });
  });
});
