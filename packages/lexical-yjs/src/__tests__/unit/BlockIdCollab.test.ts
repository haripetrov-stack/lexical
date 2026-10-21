/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$defaultIsIdentifiedBlock, $getBlockById} from '@lexical/extension';
import {$isListItemNode, INSERT_UNORDERED_LIST_COMMAND} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  type ElementNode,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  $block,
  $caretAt,
  $deepCopy,
  $enter,
  $join,
  $type,
  type CollabVersion,
  Network,
  type Peer,
} from './utils/blockIdPeers';

let network: Network | null = null;
afterEach(() => {
  if (network) {
    network.dispose();
    network = null;
  }
});

function setup(version: CollabVersion, names: string[] = ['a', 'b']) {
  network = new Network(version);
  const peers = names.map(name => network!.add(name));
  return {net: network, peers};
}

function seed(peer: Peer, texts: string[]) {
  peer.update(() => {
    $getRoot()
      .clear()
      .append(
        ...texts.map(text =>
          $createParagraphNode().append($createTextNode(text)),
        ),
      );
  });
}

function expectConverged(peers: Peer[]) {
  const [first, ...rest] = peers;
  for (const peer of rest) {
    expect(peer.json()).toEqual(first.json());
  }
  const blocks = first.blocks();
  const ids = blocks.map(block => block.slice(block.lastIndexOf(':') + 1));
  expect(ids.includes('null')).toBe(false);
  expect(new Set(ids).size).toBe(ids.length);
}

/** No peer produces anything more: the ids are stable (no ping-pong). */
function expectQuiescent(net: Network) {
  const before = net.peers.map(peer => peer.localYjsUpdates);
  for (const peer of net.peers) {
    peer.update(() => {
      // An unrelated local commit: nothing for the extension to do.
      $getRoot().markDirty();
    });
  }
  expect(net.sync()).toBe(0);
  expect(net.peers.map(peer => peer.localYjsUpdates)).toEqual(before);
}

describe.each([1, 2] as const)('BlockIdExtension with @lexical/yjs v%s', v => {
  test('ids are assigned once, by the peer that creates the block', () => {
    const {net, peers} = setup(v, ['a', 'b', 'c']);
    const [a, b, c] = peers;
    seed(a, ['one', 'two']);
    net.sync();
    expect(a.blocks()).toEqual(['paragraph:one:a1', 'paragraph:two:a2']);
    expectConverged(peers);
    // The receivers did not need to repair anything.
    expect([b.repairs, c.repairs]).toEqual([0, 0]);
    b.update(() => $enter(b.editor, 1, 3));
    net.sync();
    expect(c.blocks()).toEqual([
      'paragraph:one:a1',
      'paragraph:two:a2',
      'paragraph::b1',
    ]);
    expect([a.repairs, b.repairs, c.repairs]).toEqual([0, 0, 0]);
    c.editor.read(() => {
      expect($getBlockById('b1')).toBe($block(2));
    });
    expectQuiescent(net);
  });

  test('a late joiner receives the ids and writes nothing', () => {
    const {net, peers} = setup(v, ['a']);
    seed(peers[0], ['one', 'two', 'three']);
    net.sync();
    const late = net.add('z');
    const updatesBefore = late.localYjsUpdates;
    net.sync();
    expect(late.blocks()).toEqual(peers[0].blocks());
    expect(late.localYjsUpdates).toBe(updatesBefore);
    expect(late.repairs).toBe(0);
  });

  test('concurrent Enter in the same block converges to unique ids', () => {
    const {net, peers} = setup(v);
    const [a, b] = peers;
    seed(a, ['hello world', 'next']);
    net.sync();
    a.update(() => $enter(a.editor, 0, 5));
    b.update(() => $enter(b.editor, 0, 0));
    net.sync();
    expectConverged(peers);
    // Neither split was a copy: the merged document has no duplicate to
    // repair, and the untouched block keeps its id.
    expect(a.blocks()).toContain('paragraph:next:a2');
    expectQuiescent(net);
  });

  test('concurrent duplicates of one block converge: the original keeps the id', () => {
    const {net, peers} = setup(v, ['a', 'b', 'c']);
    const [a, b, c] = peers;
    seed(a, ['first', 'second', 'third']);
    net.sync();
    // a and b both duplicate "second" (as a paste of copied content would),
    // at different places, while offline from each other.
    a.update(() => $block(2).insertAfter($deepCopy($block(1))));
    b.update(() => $block(0).insertBefore($deepCopy($block(1))));
    // Each peer repairs its own duplicate locally right away: the copy,
    // which is new, yields to the original, wherever it was pasted.
    expect(a.blocks()).toEqual([
      'paragraph:first:a1',
      'paragraph:second:a2',
      'paragraph:third:a3',
      'paragraph:second:a4',
    ]);
    expect(b.blocks()).toEqual([
      'paragraph:second:b1',
      'paragraph:first:a1',
      'paragraph:second:a2',
      'paragraph:third:a3',
    ]);
    net.sync();
    expectConverged(peers);
    // Nothing is left to repair after the merge: no peer ever wrote a
    // duplicate to the shared document.
    expect(c.blocks()).toEqual([
      'paragraph:second:b1',
      'paragraph:first:a1',
      'paragraph:second:a2',
      'paragraph:third:a3',
      'paragraph:second:a4',
    ]);
    expect(c.repairs).toBe(0);
    expectQuiescent(net);
  });

  test('concurrent moves of one block (a duplicate after merge) are repaired once', () => {
    const {net, peers} = setup(v, ['a', 'b', 'c']);
    const [a, b] = peers;
    seed(a, ['one', 'two', 'three']);
    net.sync();
    // Both peers move "one" while partitioned. A move is a delete and an
    // insert in the shared document, so after the merge "one" exists twice,
    // with the same id, and neither peer saw a duplicate locally.
    a.online = false;
    a.update(() => {
      $block(2).insertAfter($block(0));
    });
    b.update(() => {
      $block(1).insertAfter($block(0));
    });
    expect(a.blocks()).toEqual([
      'paragraph:two:a2',
      'paragraph:three:a3',
      'paragraph:one:a1',
    ]);
    expect(b.blocks()).toEqual([
      'paragraph:two:a2',
      'paragraph:one:a1',
      'paragraph:three:a3',
    ]);
    a.online = true;
    net.sync();
    expectConverged(peers);
    // Whatever the binding makes of the two concurrent moves, exactly one
    // block carries a1.
    const withA1 = a.blocks().filter(block => block.endsWith(':a1'));
    expect(withA1).toHaveLength(1);
    if (v === 1) {
      // v1 keeps both moved copies; the earlier one keeps the id. All three
      // peers repaired the later one at the same time (a4, b?, c1); the
      // shared document kept one of their values.
      expect(a.blocks()).toEqual([
        'paragraph:two:a2',
        'paragraph:one:a1',
        'paragraph:three:a3',
        'paragraph:one:c1',
      ]);
    }
    expectQuiescent(net);
  });

  test('a document written without ids is repaired by peers concurrently and converges', () => {
    network = new Network(v);
    const net = network;
    const old = net.add('o', {withoutBlockIds: true});
    seed(old, ['one', 'two', 'three']);
    expect(old.blocks()).toEqual([
      'paragraph:one:null',
      'paragraph:two:null',
      'paragraph:three:null',
    ]);
    // Two peers with the extension open it at the same time, each without
    // seeing the other, and both assign ids.
    const a = net.add('a');
    const b = net.add('b');
    for (const peer of net.peers) {
      peer.online = false;
    }
    net.deliver(old, a);
    net.deliver(old, b);
    expect(a.blocks().map(x => x.split(':')[2])).toEqual(['a1', 'a2', 'a3']);
    expect(b.blocks().map(x => x.split(':')[2])).toEqual(['b1', 'b2', 'b3']);
    for (const peer of net.peers) {
      peer.online = true;
    }
    net.sync();
    expectConverged(net.peers);
    // Concurrent assignments of one block resolve to one of them (the
    // shared document's last-writer-wins), never to a mix that repeats.
    for (const block of a.blocks()) {
      expect(block).toMatch(/:[ab][123]$/);
    }
    expectQuiescent(net);
  });

  test('a type change and a move keep the id on every peer', () => {
    const {net, peers} = setup(v);
    const [a, b] = peers;
    seed(a, ['one', 'two', 'three']);
    net.sync();
    a.update(() => {
      $caretAt(1, 1);
      $setBlocksType($getSelection(), () => $createHeadingNode('h2'));
    });
    net.sync();
    expect(b.blocks()).toEqual([
      'paragraph:one:a1',
      'heading:two:a2',
      'paragraph:three:a3',
    ]);
    b.update(() => {
      $block(2).insertAfter($block(0));
    });
    net.sync();
    expect(a.blocks()).toEqual([
      'heading:two:a2',
      'paragraph:three:a3',
      'paragraph:one:a1',
    ]);
    expectConverged(peers);
    expectQuiescent(net);
  });

  test('concurrent type change and typing in the same block', () => {
    const {net, peers} = setup(v);
    const [a, b] = peers;
    seed(a, ['one', 'two']);
    net.sync();
    a.update(() => {
      $caretAt(1, 0);
      $setBlocksType($getSelection(), () => $createHeadingNode('h1'));
    });
    b.update(() => $type(1, 3, '!'));
    net.sync();
    expectConverged(peers);
    expect(a.blocks()[1]).toMatch(/^heading:two!?:a2$/);
    expectQuiescent(net);
  });

  test('undo and redo of a split restore exact ids on every peer', () => {
    const {net, peers} = setup(v);
    const [a, b] = peers;
    seed(a, ['hello', 'world']);
    net.sync();
    a.undoManager.clear();
    const before = b.blocks();
    a.update(() => $enter(a.editor, 0, 2));
    net.sync();
    const after = b.blocks();
    expect(after).toEqual([
      'paragraph:he:a1',
      'paragraph:llo:a3',
      'paragraph:world:a2',
    ]);
    a.undo();
    net.sync();
    expect(b.blocks()).toEqual(before);
    a.redo();
    net.sync();
    expect(b.blocks()).toEqual(after);
    expectConverged(peers);
    expectQuiescent(net);
  });

  test('join on one peer, Enter in the joined block on the other', () => {
    const {net, peers} = setup(v);
    const [a, b] = peers;
    seed(a, ['one', 'two', 'three']);
    net.sync();
    a.update(() => $join(a.editor, 1));
    b.update(() => $enter(b.editor, 1, 1));
    net.sync();
    expectConverged(peers);
    expect(a.blocks()[0].endsWith(':a1')).toBe(true);
    expectQuiescent(net);
  });

  test('nested ids in lists sync', () => {
    network = new Network(v);
    const net = network;
    const $isIdentified = (node: LexicalNode) =>
      $defaultIsIdentifiedBlock(node) || $isListItemNode(node);
    const a = net.add('a', {$isIdentifiedBlock: $isIdentified});
    const b = net.add('b', {$isIdentifiedBlock: $isIdentified});
    seed(a, ['one', 'two']);
    a.update(() => {
      $caretAt(0, 0);
      const selection = $getSelection()!;
      const last = $block(1).getLastDescendant()!;
      selection.getStartEndPoints()![1].set(last.getKey(), 3, 'text');
      a.editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    });
    net.sync();
    expect(b.blocks($isIdentified)).toEqual([
      'list:one\n\ntwo:a3',
      'listitem:one:a1',
      'listitem:two:a2',
    ]);
    b.update(() => {
      // Enter at the end of the first item.
      $block(0).getFirstChildOrThrow<ElementNode>().selectEnd();
      b.editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    });
    net.sync();
    expect(a.blocks($isIdentified)).toEqual([
      'list:one\n\n\n\ntwo:a3',
      'listitem:one:a1',
      'listitem::b1',
      'listitem:two:a2',
    ]);
    expectConverged([a, b]);
  });
});
