/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Deterministic randomized test of BlockIdExtension over @lexical/yjs: two or
// three peers type, split, join, duplicate, change block types, move blocks,
// undo and redo, with random partitions. After every run all peers must hold
// the same document, every top-level block must have an id, the ids must be
// unique, nothing must change any more, and blocks that were never split,
// merged, copied, or restructured concurrently must keep the ids they started
// with.
//
// CI runs a few seeds per binding; set BLOCK_ID_FUZZ_SEEDS (and optionally
// BLOCK_ID_FUZZ_FIRST_SEED) to run more locally.

import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
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

const SEEDS = Number(process.env.BLOCK_ID_FUZZ_SEEDS || 8);
const FIRST_SEED = Number(process.env.BLOCK_ID_FUZZ_FIRST_SEED || 1);
const STEPS = 40;
// Local diagnostics only: build the peers without BlockIdExtension and check
// convergence alone, to tell binding issues from block id issues.
const CONTROL = process.env.BLOCK_ID_FUZZ_CONTROL === '1';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let network: Network | null = null;
afterEach(() => {
  if (network) {
    network.dispose();
    network = null;
  }
});

interface BlockInfo {
  id: string | null;
  text: string;
}

function readBlocks(peer: Peer): BlockInfo[] {
  return peer.blocks().map(entry => {
    const [, ...rest] = entry.split(':');
    const id = rest.pop()!;
    return {id: id === 'null' ? null : id, text: rest.join(':')};
  });
}

function run(version: CollabVersion, seed: number, log: string[]): void {
  const rng = mulberry32(seed * 7919 + version);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rng() * items.length)];
  const int = (n: number) => Math.floor(rng() * n);

  network = new Network(version);
  const net = network;
  const names = rng() < 0.5 ? ['a', 'b'] : ['a', 'b', 'c'];
  const peers = names.map(name => net.add(name, {withoutBlockIds: CONTROL}));
  const initialCount = 3 + int(4);
  peers[0].update(() => {
    $getRoot()
      .clear()
      .append(
        ...Array.from({length: initialCount}, (_, i) =>
          $createParagraphNode().append($createTextNode(`M${i} text`)),
        ),
      );
  });
  net.sync();
  // The initial document is not an undoable edit of peer a.
  for (const peer of peers) {
    peer.undoManager.clear();
  }
  const marker = new Map<string, string>();
  readBlocks(peers[0]).forEach((block, i) =>
    marker.set(block.id || `#${i}`, `M${i} `),
  );

  // Ids whose stability is not claimed: split, merged, copied, or touched by
  // restructuring ops of two peers between full syncs, or reachable by an
  // undo/redo of a peer that touched them.
  const tainted = new Set<string>();
  const touchedBy = new Map<string, Set<string>>();
  let epochOps = new Map<string, Set<string>>();
  const touch = (peer: Peer, id: string | null, restructure: boolean) => {
    if (id === null) {
      return;
    }
    let ids = touchedBy.get(peer.name);
    if (!ids) {
      ids = new Set();
      touchedBy.set(peer.name, ids);
    }
    ids.add(id);
    if (restructure) {
      let who = epochOps.get(id);
      if (!who) {
        who = new Set();
        epochOps.set(id, who);
      }
      who.add(peer.name);
      if (who.size > 1) {
        tainted.add(id);
      }
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const peer = pick(peers);
    const blocks = readBlocks(peer);
    const n = blocks.length;
    const i = int(n);
    const op = pick([
      'type',
      'type',
      'enter',
      'enter',
      'join',
      'duplicate',
      'retype',
      'move',
      'undo',
      'redo',
      'partition',
      'sync',
      'sync',
    ] as const);
    log.push(
      `${step} ${peer.name}${peer.online ? '' : '(off)'} ${op} @${i} ${JSON.stringify(peer.blocks())}`,
    );
    switch (op) {
      case 'type': {
        const text = blocks[i].text;
        const minOffset = Math.min(text.length, 3);
        const offset = minOffset + int(text.length - minOffset + 1);
        peer.update(() => $type(i, offset, pick(['x', 'yy', ' z'])));
        touch(peer, blocks[i].id, false);
        break;
      }
      case 'enter': {
        const offset = int(blocks[i].text.length + 1);
        peer.update(() => $enter(peer.editor, i, offset));
        if (blocks[i].id) {
          tainted.add(blocks[i].id);
        }
        touch(peer, blocks[i].id, true);
        break;
      }
      case 'join': {
        if (i === 0) {
          break;
        }
        peer.update(() => $join(peer.editor, i));
        for (const id of [blocks[i].id, blocks[i - 1].id]) {
          if (id) {
            tainted.add(id);
          }
          touch(peer, id, true);
        }
        break;
      }
      case 'duplicate': {
        const target = int(n);
        const before = rng() < 0.5;
        peer.update(() => {
          const copy = $deepCopy($block(i));
          if (before) {
            $block(target).insertBefore(copy);
          } else {
            $block(target).insertAfter(copy);
          }
        });
        if (blocks[i].id) {
          tainted.add(blocks[i].id);
        }
        touch(peer, blocks[i].id, true);
        break;
      }
      case 'retype': {
        const kind = pick(['h1', 'h2', 'quote', 'paragraph'] as const);
        peer.update(() => {
          $caretAt(i, 0);
          $setBlocksType($getSelection(), () =>
            kind === 'quote'
              ? $createQuoteNode()
              : kind === 'paragraph'
                ? $createParagraphNode()
                : $createHeadingNode(kind),
          );
        });
        touch(peer, blocks[i].id, true);
        break;
      }
      case 'move': {
        const target = int(n);
        if (target === i) {
          break;
        }
        peer.update(() => {
          $block(target).insertAfter($block(i));
        });
        touch(peer, blocks[i].id, true);
        break;
      }
      case 'undo':
      case 'redo': {
        for (const id of touchedBy.get(peer.name) || []) {
          tainted.add(id);
        }
        if (op === 'undo') {
          peer.undo();
        } else {
          peer.redo();
        }
        break;
      }
      case 'partition': {
        peer.online = !peer.online;
        break;
      }
      case 'sync': {
        net.sync();
        if (peers.every(p => p.online)) {
          epochOps = new Map();
        }
        break;
      }
    }
  }

  for (const peer of peers) {
    peer.online = true;
  }
  net.sync();
  for (const peer of peers) {
    log.push(`final ${peer.name} ${JSON.stringify(peer.blocks())}`);
  }
  log.push(`tainted ${[...tainted].join(',')}`);

  // Convergence.
  const json = peers[0].json();
  for (const peer of peers.slice(1)) {
    expect(peer.json(), `${peer.name} diverged`).toEqual(json);
  }
  if (CONTROL) {
    return;
  }
  // Every block has an id, and ids are unique.
  const final = readBlocks(peers[0]);
  const ids = final.map(block => block.id);
  expect(ids).not.toContain(null);
  expect(new Set(ids).size).toBe(ids.length);
  // Quiescent: one more round of local commits and syncing changes nothing.
  const before = peers.map(peer => peer.localYjsUpdates);
  for (const peer of peers) {
    peer.update(() => $getRoot().markDirty());
  }
  expect(net.sync()).toBe(0);
  expect(peers.map(peer => peer.localYjsUpdates)).toEqual(before);
  // Stability: an untainted block whose content survived (its marker starts
  // exactly one block) still has the id it started with. A block whose
  // content the binding itself lost or rewrote is not something block ids
  // can be judged on, so it is only logged.
  const stable: string[] = [];
  for (const [id, prefix] of marker) {
    if (tainted.has(id)) {
      continue;
    }
    const holders = final.filter(block => block.text.startsWith(prefix));
    if (holders.length !== 1) {
      log.push(`content of ${id} (${prefix.trim()}) did not survive`);
      continue;
    }
    stable.push(id);
    expect(holders[0].id, `${prefix.trim()} keeps ${id}`).toBe(id);
  }
  log.push(`stable: ${stable.join(',')}`);
}

describe.each([1, 2] as const)('BlockIdExtension fuzz, @lexical/yjs v%s', v => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
    test(`seed ${seed}`, () => {
      const log: string[] = [];
      try {
        run(v, seed, log);
      } catch (error) {
        if (process.env.BLOCK_ID_FUZZ_LOG) {
          // eslint-disable-next-line no-console
          console.log(`v${v} seed ${seed}\n${log.join('\n')}`);
        }
        throw error;
      }
    });
  }
});
