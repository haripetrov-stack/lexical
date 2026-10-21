/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getNodeByKey,
  $getRoot,
  $getState,
  $hasUpdateTag,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  createState,
  defineExtension,
  type EditorState,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  NODE_STATE_DIRECT,
  type NodeKey,
  RootNode,
  safeCast,
  TextNode,
} from 'lexical';

import {$getExtensionOutput} from './getExtensionDependency';
import {namedSignals} from './namedSignals';
import {effect, type Signal} from './signals';

const __DEV__ = process.env.NODE_ENV !== 'production';

/** The longest id accepted from JSON, HTML, or a remote peer. */
const MAX_BLOCK_ID_LENGTH = 128;

/** 64 URL-safe characters, so one random byte masked to 6 bits picks one. */
const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Length of ids made by {@link generateBlockId}: 48 random bits. */
const GENERATED_ID_LENGTH = 8;

/**
 * Attempts to find an unused id before giving up, which only a broken
 * `generateId` (one that keeps returning ids already in use) can exhaust.
 */
const MAX_ID_ATTEMPTS = 32;

/**
 * Tag of the follow-up update that repairs ids after a commit that did not run
 * transforms (a remote collaboration change, for instance).
 */
const BLOCK_ID_REPAIR_TAG = 'block-id-repair';

/**
 * Above this many nodes to order, one walk of the document is cheaper than
 * pairwise `isBefore` comparisons.
 */
const PAIRWISE_ORDER_LIMIT = 32;

function parseBlockId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BLOCK_ID_LENGTH
    ? value
    : undefined;
}

/**
 * The NodeState that stores a block's id, serialized in node JSON as
 * `"$": {"blockId": "..."}`.
 *
 * It is ordinary NodeState, so it survives clones and undo, round-trips
 * through `exportJSON`/`importJSON`, and is synchronized by any collaboration
 * binding that synchronizes NodeState. It is reset by `$copyNode`, so a node
 * split off another one (e.g. the new `ListItemNode` that Enter creates) starts
 * without an id instead of with a duplicate.
 *
 * Any non-empty string of at most 128 characters is accepted; anything else
 * reads as "no id".
 *
 * @experimental
 */
export const blockIdState = createState('blockId', {
  parse: parseBlockId,
  resetOnCopyNode: true,
});

/**
 * Returns the id stored on `node`, or `null` if it has none.
 *
 * This reads the NodeState directly, so it also returns an id left on a node
 * that is not an identified block (one moved into a list item, say); such ids
 * are not indexed and {@link $getBlockById} does not find them.
 *
 * @experimental
 */
export function $getBlockId(node: LexicalNode): string | null {
  const id = $getState(node, blockIdState);
  return id === undefined ? null : id;
}

/**
 * Returns the identified block with the given id in the active editor state,
 * or `null`. Requires {@link BlockIdExtension}.
 *
 * The lookup goes through an index kept up to date from the dirty nodes of
 * each commit and is verified against the active state, so it never returns a
 * stale node. A block created or re-keyed earlier in the same update is found
 * once that update has committed.
 *
 * @experimental
 */
export function $getBlockById(id: string): LexicalNode | null {
  return $getExtensionOutput(BlockIdExtension).$getBlockById(id);
}

/**
 * The default {@link BlockIdConfig.$isIdentifiedBlock}: the element and
 * decorator children of the root. Compose it to identify nested blocks too:
 *
 * ```ts
 * configExtension(BlockIdExtension, {
 *   $isIdentifiedBlock: (node) =>
 *     $defaultIsIdentifiedBlock(node) || $isListItemNode(node),
 * });
 * ```
 *
 * @experimental
 */
export function $defaultIsIdentifiedBlock(node: LexicalNode): boolean {
  return (
    ($isElementNode(node) || $isDecoratorNode(node)) &&
    $isRootNode(node.getParent())
  );
}

/**
 * The default {@link BlockIdConfig.generateId}: 8 characters from the
 * URL-safe base64 alphabet (48 random bits), from `crypto.getRandomValues`
 * where available.
 *
 * @experimental
 */
export function generateBlockId(): string {
  const bytes = new Uint8Array(GENERATED_ID_LENGTH);
  const cryptoImpl = typeof crypto === 'undefined' ? undefined : crypto;
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
    cryptoImpl.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += ID_ALPHABET[bytes[i] & 63];
  }
  return id;
}

/** @experimental */
export interface BlockIdConfig {
  /**
   * Set to `true` to stop assigning, repairing, and indexing ids. Ids already
   * stored on nodes are kept. While disabled, {@link $getBlockById} falls back
   * to a scan of the document.
   */
  disabled: boolean;
  /**
   * Which nodes get an id. Evaluated when a node is marked dirty, so it should
   * depend only on the node and its ancestors. Default:
   * {@link $defaultIsIdentifiedBlock} (the children of the root).
   */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
  /**
   * Makes a new id. It must return a non-empty string of at most 128
   * characters. Collisions with ids in use are retried, so it does not need
   * to be globally unique; tests can inject a deterministic counter.
   * Default: {@link generateBlockId}.
   */
  generateId: () => string;
}

/** @experimental */
export interface BlockIdOutput {
  /** See {@link BlockIdConfig.disabled}. */
  disabled: Signal<boolean>;
  /** The same as {@link $getBlockById} for this editor. */
  $getBlockById: (id: string) => LexicalNode | null;
  /** The configured {@link BlockIdConfig.$isIdentifiedBlock}. */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
}

/**
 * An index of the committed editor state: id → keys of the identified blocks
 * that carry it (almost always one), and key → id.
 */
class BlockIdIndex {
  /** One holder per id. */
  readonly primary = new Map<string, NodeKey>();
  /** Further holders of an id, only while a duplicate awaits repair. */
  readonly extra = new Map<string, Set<NodeKey>>();
  readonly idOfKey = new Map<NodeKey, string>();

  clear(): void {
    this.primary.clear();
    this.extra.clear();
    this.idOfKey.clear();
  }

  has(id: string): boolean {
    return this.primary.has(id);
  }

  holders(id: string): NodeKey[] {
    const first = this.primary.get(id);
    if (first === undefined) {
      return [];
    }
    const rest = this.extra.get(id);
    return rest === undefined ? [first] : [first, ...rest];
  }

  set(key: NodeKey, id: string): void {
    const prevId = this.idOfKey.get(key);
    if (prevId === id) {
      return;
    }
    if (prevId !== undefined) {
      this.remove(key);
    }
    this.idOfKey.set(key, id);
    const first = this.primary.get(id);
    if (first === undefined) {
      this.primary.set(id, key);
    } else {
      let rest = this.extra.get(id);
      if (rest === undefined) {
        rest = new Set();
        this.extra.set(id, rest);
      }
      rest.add(key);
    }
  }

  remove(key: NodeKey): void {
    const id = this.idOfKey.get(key);
    if (id === undefined) {
      return;
    }
    this.idOfKey.delete(key);
    const rest = this.extra.get(id);
    if (this.primary.get(id) === key) {
      if (rest === undefined) {
        this.primary.delete(id);
      } else {
        const [next] = rest;
        rest.delete(next);
        this.primary.set(id, next);
        if (rest.size === 0) {
          this.extra.delete(id);
        }
      }
    } else if (rest !== undefined) {
      rest.delete(key);
      if (rest.size === 0) {
        this.extra.delete(id);
      }
    }
  }
}

interface BlockIdRuntime {
  readonly config: BlockIdConfig;
  readonly index: BlockIdIndex;
  /** Whether `index` is being maintained (the extension is enabled). */
  active: boolean;
  $getBlockById: (id: string) => LexicalNode | null;
}

let runtimes: undefined | WeakMap<LexicalEditor, BlockIdRuntime>;

/** Per-editor state, created lazily so that the module has no side effects. */
function getRuntimes(): WeakMap<LexicalEditor, BlockIdRuntime> {
  if (runtimes === undefined) {
    runtimes = new WeakMap();
  }
  return runtimes;
}

/** The previous-state id of a frozen node, read without an active state. */
function $prevIdOf(node: undefined | LexicalNode): string | null {
  if (node === undefined) {
    return null;
  }
  const id = $getState(node, blockIdState, NODE_STATE_DIRECT);
  return id === undefined ? null : id;
}

function $isLiveIdentified(
  runtime: BlockIdRuntime,
  node: null | LexicalNode,
): node is LexicalNode {
  return (
    node !== null &&
    node.isAttached() &&
    runtime.config.$isIdentifiedBlock(node)
  );
}

/** Attached identified blocks of the active state that carry `id`. */
function $liveHolders(
  runtime: BlockIdRuntime,
  id: string,
  extraKeys: Iterable<NodeKey> = [],
): LexicalNode[] {
  const seen = new Set<NodeKey>();
  const result: LexicalNode[] = [];
  const visit = (key: NodeKey) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node) && $getBlockId(node) === id) {
      result.push(node);
    }
  };
  for (const key of runtime.index.holders(id)) {
    visit(key);
  }
  for (const key of extraKeys) {
    visit(key);
  }
  return result;
}

/** Sort nodes of the active state into document order. */
function $sortInDocumentOrder(nodes: LexicalNode[]): LexicalNode[] {
  if (nodes.length < 2) {
    return nodes;
  }
  if (nodes.length <= PAIRWISE_ORDER_LIMIT) {
    // Pre-order: an ancestor comes before its descendants.
    return nodes.sort((a, b) =>
      a.is(b)
        ? 0
        : a.isParentOf(b)
          ? -1
          : b.isParentOf(a)
            ? 1
            : a.isBefore(b)
              ? -1
              : 1,
    );
  }
  const wanted = new Set(nodes.map(node => node.getKey()));
  const position = new Map<NodeKey, number>();
  const stack: LexicalNode[] = [$getRoot()];
  while (stack.length > 0 && position.size < wanted.size) {
    const node = stack.pop()!;
    if (wanted.has(node.getKey())) {
      position.set(node.getKey(), position.size);
    }
    if ($isElementNode(node)) {
      const children = node.getChildren();
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }
  return nodes.sort(
    (a, b) => (position.get(a.getKey()) || 0) - (position.get(b.getKey()) || 0),
  );
}

function $makeFreshId(runtime: BlockIdRuntime, used: Set<string>): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = runtime.config.generateId();
    if (
      parseBlockId(id) === id &&
      !used.has(id) &&
      $liveHolders(runtime, id).length === 0
    ) {
      used.add(id);
      return id;
    }
  }
  throw new Error(
    `BlockIdExtension: generateId returned ${MAX_ID_ATTEMPTS} ids in a row that were invalid or already in use`,
  );
}

/**
 * Runs as the RootNode transform, which Lexical applies after every other
 * transform of the same pass. `candidates` holds the identified blocks marked
 * dirty in this update.
 *
 * 1. Lineage, for blocks created in this update, using the previous state:
 *    - a block that took the children of a removed block (a type change via
 *      `replace(…, true)`) takes its id;
 *    - a block that took all the children of a block that is now empty (Enter
 *      at the start of a block) takes its id, and the emptied block gets a
 *      new one;
 *    - an empty block that sits exactly where a removed block sat (a type
 *      change of an empty block) takes its id.
 * 2. Every candidate without an id gets a fresh one.
 * 3. Every id carried by a candidate and by any other identified block is
 *    kept by a block that carried it before this update; when several or
 *    none did, by the earliest of those in document order. The others get
 *    fresh ids. Fresh ids of steps 2 and 3 are generated in document order.
 */
function $assignBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
  candidates: Set<NodeKey>,
): void {
  if (candidates.size === 0) {
    return;
  }
  const keys = Array.from(candidates);
  candidates.clear();
  if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
    // Bindings do not write changes made during these updates back to the
    // shared document, so the repair runs in a follow-up update instead (see
    // the update listener).
    return;
  }
  const blocks: LexicalNode[] = [];
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node)) {
      blocks.push(node);
    }
  }
  if (blocks.length === 0) {
    return;
  }
  const blockKeys = new Set(blocks.map(node => node.getKey()));
  const prevNodeMap = editor.getEditorState()._nodeMap;
  const used = new Set<string>();
  // New key → key of the previous-state block it continues.
  const lineage = new Map<NodeKey, NodeKey>();

  const $isRemoved = (key: null | NodeKey): key is NodeKey => {
    if (key === null) {
      return false;
    }
    // A node removed in this update is still in the pending node map, only
    // detached. A key that is missing altogether belongs to a state that was
    // replaced wholesale (setEditorState), which has no lineage.
    const node = $getNodeByKey(key);
    return node !== null && !node.isAttached();
  };
  const $isTaken = (id: string, except: NodeKey): boolean =>
    used.has(id) ||
    $liveHolders(runtime, id).some(node => node.getKey() !== except);
  const $inherit = (node: LexicalNode, id: string, fromKey: NodeKey) => {
    lineage.set(node.getKey(), fromKey);
    used.add(id);
    if ($getBlockId(node) !== id) {
      $setState(node, blockIdState, id);
    }
  };

  // 1a. Children-based lineage.
  const newBlocks = blocks.filter(node => !prevNodeMap.has(node.getKey()));
  for (const node of newBlocks) {
    const ownId = $getBlockId(node);
    if (!$isElementNode(node)) {
      continue;
    }
    const firstChild = node.getFirstChild();
    if (firstChild === null) {
      continue;
    }
    const prevChild = prevNodeMap.get(firstChild.getKey());
    if (prevChild === undefined || prevChild.__parent === null) {
      continue;
    }
    const sourceKey = prevChild.__parent;
    const prevSource = prevNodeMap.get(sourceKey);
    const id = $prevIdOf(prevSource);
    if (id === null || (ownId !== null && ownId !== id)) {
      continue;
    }
    if ($isRemoved(sourceKey)) {
      // Replaced, e.g. by $setBlocksType.
      if (!$isTaken(id, sourceKey)) {
        $inherit(node, id, sourceKey);
      }
      continue;
    }
    const source = $getNodeByKey(sourceKey);
    if (
      $isElementNode(source) &&
      source.isAttached() &&
      source.getChildrenSize() === 0 &&
      $isElementNode(prevSource) &&
      prevSource.__first === firstChild.getKey() &&
      $getBlockId(source) === id &&
      !used.has(id)
    ) {
      // All of the content moved on (Enter at the start): the id follows it,
      // and the emptied block is re-keyed below.
      $setState(source, blockIdState, $makeFreshId(runtime, used));
      $inherit(node, id, sourceKey);
    }
  }

  // 1b. Position-based lineage for the remaining new blocks without an id.
  const resolved = new Set<NodeKey>();
  const $resolvePosition = (start: LexicalNode) => {
    const stack: LexicalNode[] = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const key = node.getKey();
      if (resolved.has(key)) {
        stack.pop();
        continue;
      }
      const prevSibling = node.getPreviousSibling();
      if (
        prevSibling !== null &&
        !prevNodeMap.has(prevSibling.getKey()) &&
        blockKeys.has(prevSibling.getKey()) &&
        !resolved.has(prevSibling.getKey())
      ) {
        // Resolve the new block before this one first: a run of replaced
        // blocks is matched against the removed run in order.
        stack.push(prevSibling);
        continue;
      }
      stack.pop();
      resolved.add(key);
      if (lineage.has(key) || $getBlockId(node) !== null) {
        continue;
      }
      let removedKey: null | NodeKey = null;
      if (prevSibling === null) {
        const parent = node.getParent();
        const prevParent = parent && prevNodeMap.get(parent.getKey());
        removedKey = $isElementNode(prevParent) ? prevParent.__first : null;
      } else {
        const anchorKey = prevNodeMap.has(prevSibling.getKey())
          ? prevSibling.getKey()
          : lineage.get(prevSibling.getKey());
        const prevAnchor =
          anchorKey === undefined ? undefined : prevNodeMap.get(anchorKey);
        removedKey = prevAnchor === undefined ? null : prevAnchor.__next;
      }
      if ($isRemoved(removedKey)) {
        const id = $prevIdOf(prevNodeMap.get(removedKey));
        if (id !== null && !$isTaken(id, removedKey)) {
          $inherit(node, id, removedKey);
        }
      }
    }
  };
  for (const node of newBlocks) {
    $resolvePosition(node);
  }

  // 2. Blocks without an id, and 3. all but one holder of an id
  // that several identified blocks carry, get fresh ids, assigned in
  // document order.
  const candidatesById = new Map<string, NodeKey[]>();
  const needFresh: LexicalNode[] = [];
  for (const node of blocks) {
    const id = $getBlockId(node);
    if (id === null) {
      needFresh.push(node);
    } else {
      const keysWithId = candidatesById.get(id);
      if (keysWithId === undefined) {
        candidatesById.set(id, [node.getKey()]);
      } else {
        keysWithId.push(node.getKey());
      }
    }
  }
  for (const [id, keysWithId] of candidatesById) {
    const holders = $liveHolders(runtime, id, keysWithId);
    if (holders.length > 1) {
      used.add(id);
      // A block that already carried the id before this update keeps it; a
      // block that got it in this update (a paste, a duplicate, an import)
      // yields. Document order breaks the tie between several blocks that
      // all, or none, carried it before.
      const existing = holders.filter(
        node => $prevIdOf(prevNodeMap.get(node.getKey())) === id,
      );
      const [keeper] = $sortInDocumentOrder(
        existing.length > 0 ? existing : holders.slice(),
      );
      for (const node of holders) {
        if (!node.is(keeper)) {
          needFresh.push(node);
        }
      }
    }
  }
  for (const node of $sortInDocumentOrder(needFresh)) {
    $setState(node, blockIdState, $makeFreshId(runtime, used));
  }
}

/**
 * Brings the index up to date with a committed state. Returns the keys of
 * identified blocks that lack an id or share one, which need a repair update.
 */
function $syncIndex(
  runtime: BlockIdRuntime,
  editorState: EditorState,
  prevEditorState: EditorState,
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
): NodeKey[] {
  const {index, config} = runtime;
  const nodeMap = editorState._nodeMap;
  const prevNodeMap = prevEditorState._nodeMap;
  const needsRepair: NodeKey[] = [];
  const touchedIds = new Set<string>();

  const visit = (node: LexicalNode) => {
    const key = node.getKey();
    if (node.isAttached() && config.$isIdentifiedBlock(node)) {
      const id = $getBlockId(node);
      if (id === null) {
        index.remove(key);
        needsRepair.push(key);
      } else {
        index.set(key, id);
        touchedIds.add(id);
      }
    } else {
      index.remove(key);
    }
  };

  if (
    dirtyLeaves.size === 0 &&
    dirtyElements.size === 1 &&
    dirtyElements.has('root')
  ) {
    // Only the root is dirty: the state was replaced with setEditorState (an
    // undo or redo, for instance) and nothing says which nodes changed.
    // Rebuild, which costs the same order as the full reconciliation that
    // Lexical performs for such a commit.
    index.clear();
    const stack: LexicalNode[] = [...$getRoot().getChildren()];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if ($isTextNode(node)) {
        continue;
      }
      visit(node);
      if ($isElementNode(node)) {
        stack.push(...node.getChildren());
      }
    }
  } else {
    const removeSubtree = (key: NodeKey) => {
      const stack: NodeKey[] = [key];
      while (stack.length > 0) {
        const k = stack.pop()!;
        if (nodeMap.has(k)) {
          // Moved elsewhere; it is dirty itself if it matters.
          continue;
        }
        index.remove(k);
        const prevNode = prevNodeMap.get(k);
        if ($isElementNode(prevNode)) {
          let child = prevNode.__first;
          while (child !== null) {
            stack.push(child);
            const prevChild = prevNodeMap.get(child);
            child = prevChild === undefined ? null : prevChild.__next;
          }
        }
      }
    };
    const visitKey = (key: NodeKey) => {
      const node = nodeMap.get(key);
      if (node === undefined) {
        removeSubtree(key);
      } else if (!$isTextNode(node)) {
        visit(node);
      }
    };
    for (const [key, intentional] of dirtyElements) {
      // Elements marked dirty only because a descendant changed cannot have
      // changed id, position, or identity.
      if (intentional) {
        visitKey(key);
      }
    }
    for (const key of dirtyLeaves) {
      visitKey(key);
    }
  }

  for (const id of touchedIds) {
    if (index.extra.has(id)) {
      const holders = $liveHolders(runtime, id);
      if (holders.length > 1) {
        for (const node of holders) {
          needsRepair.push(node.getKey());
        }
      }
    }
  }
  return needsRepair;
}

function $rebuildIndex(
  runtime: BlockIdRuntime,
  editorState: EditorState,
): NodeKey[] {
  return $syncIndex(
    runtime,
    editorState,
    editorState,
    new Map([['root', false]]),
    new Set(),
  );
}

function registerBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
): () => void {
  const candidates = new Set<NodeKey>();
  const {$isIdentifiedBlock} = runtime.config;
  const collect = (node: LexicalNode) => {
    if ($isIdentifiedBlock(node)) {
      candidates.add(node.getKey());
    }
  };
  const scheduleRepair = (keys: NodeKey[]) => {
    editor.update(
      () => {
        for (const key of keys) {
          const node = $getNodeByKey(key);
          if (node !== null && node.isAttached()) {
            node.markDirty();
          }
        }
      },
      // Discrete, so it commits on its own right after the commit that needed
      // it: batched into a later collaboration update, its changes would not
      // be written to the shared document.
      {discrete: true, tag: [HISTORY_MERGE_TAG, BLOCK_ID_REPAIR_TAG]},
    );
  };

  runtime.index.clear();
  runtime.active = true;
  const currentState = editor.getEditorState();
  const initialRepairs = currentState.read(
    () => $rebuildIndex(runtime, currentState),
    {editor},
  );

  const cleanups: (() => void)[] = [
    editor.registerUpdateListener(
      ({editorState, prevEditorState, dirtyElements, dirtyLeaves, tags}) => {
        const repairs = editorState.read(
          () =>
            $syncIndex(
              runtime,
              editorState,
              prevEditorState,
              dirtyElements,
              dirtyLeaves,
            ),
          {editor},
        );
        if (repairs.length > 0) {
          if (tags.has(BLOCK_ID_REPAIR_TAG)) {
            if (__DEV__) {
              console.warn(
                'BlockIdExtension: a repair update left blocks without a unique id; is $isIdentifiedBlock stable?',
              );
            }
          } else {
            scheduleRepair(repairs);
          }
        }
      },
    ),
  ];
  // Registering a transform marks every node of that type dirty, so the first
  // update assigns ids to a document that was opened without them.
  for (const {klass} of editor._nodes.values()) {
    if (
      klass === RootNode ||
      klass === TextNode ||
      klass === LineBreakNode ||
      klass.prototype instanceof TextNode
    ) {
      continue;
    }
    cleanups.push(editor.registerNodeTransform(klass, collect));
  }
  cleanups.push(
    editor.registerNodeTransform(RootNode, () =>
      $assignBlockIds(editor, runtime, candidates),
    ),
  );
  if (initialRepairs.length > 0) {
    scheduleRepair(initialRepairs);
  }
  return () => {
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
    runtime.active = false;
    runtime.index.clear();
    candidates.clear();
  };
}

function createRuntime(config: BlockIdConfig): BlockIdRuntime {
  const runtime: BlockIdRuntime = {
    $getBlockById(id: string): LexicalNode | null {
      if (!runtime.active) {
        // Not indexed while disabled: scan.
        const stack: LexicalNode[] = [...$getRoot().getChildren()];
        while (stack.length > 0) {
          const node = stack.shift()!;
          if (
            !$isTextNode(node) &&
            config.$isIdentifiedBlock(node) &&
            $getBlockId(node) === id
          ) {
            return node;
          }
          if ($isElementNode(node)) {
            stack.unshift(...node.getChildren());
          }
        }
        return null;
      }
      const holders = $liveHolders(runtime, id);
      return holders.length === 0 ? null : $sortInDocumentOrder(holders)[0];
    },
    active: false,
    config,
    index: new BlockIdIndex(),
  };
  return runtime;
}

/**
 * Gives blocks stable ids, stored as NodeState ({@link blockIdState}), so that
 * code outside the editor (an AI agent, a server pipeline, a comment system)
 * can address a block by id across sessions, collaborators, and serializations.
 *
 * - Every identified block (see {@link BlockIdConfig.$isIdentifiedBlock})
 *   gets an id in the same update that creates it, whether it was typed,
 *   pasted, or produced by `importJSON`, `importDOM`, or a markdown import. A
 *   document loaded without ids gets them in the update that loads it (or in
 *   the first update after the extension is registered).
 * - Ids are unique: when several identified blocks share one, a block that
 *   already had it keeps it and blocks that got it in this update (a paste,
 *   a duplicate, an import) get fresh ids, so a reference never jumps to a
 *   copy. Between blocks that all (or none) had it before, the earliest in
 *   document order keeps it, so collaborators repairing the same duplicate
 *   concurrently converge.
 * - Splits, joins, type changes, moves, and undo/redo keep ids with the
 *   content the user sees; see the documentation for the exact rules.
 * - {@link $getBlockById} finds a block from an index that is maintained from
 *   the dirty nodes of each update, never from a scan of the document.
 *
 * @experimental
 */
export const BlockIdExtension = defineExtension({
  build(editor, config): BlockIdOutput {
    const runtime = createRuntime(config);
    getRuntimes().set(editor, runtime);
    const signals = namedSignals({disabled: config.disabled});
    return {
      $getBlockById: runtime.$getBlockById,
      $isIdentifiedBlock: config.$isIdentifiedBlock,
      disabled: signals.disabled,
    };
  },
  config: safeCast<BlockIdConfig>({
    $isIdentifiedBlock: $defaultIsIdentifiedBlock,
    disabled: false,
    generateId: generateBlockId,
  }),
  name: '@lexical/extension/BlockId',
  register(editor, config, state) {
    const output = state.getOutput();
    const runtime = getRuntimes().get(editor)!;
    return effect(() => {
      if (!output.disabled.value) {
        return registerBlockIds(editor, runtime);
      }
    });
  },
});
