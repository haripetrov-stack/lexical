/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getBlockId,
  $getExtensionOutput,
  BlockIdExtension,
  blockIdState,
  namedSignals,
} from '@lexical/extension';
import {
  $isDecoratorNode,
  $isElementNode,
  $setState,
  configExtension,
  defineExtension,
  isHTMLElement,
  type LexicalNode,
  safeCast,
} from 'lexical';

import {domOverride} from './domOverride';
import {DOMRenderExtension} from './DOMRenderExtension';
import {defineImportRule} from './import/defineImportRule';
import {defineOverlayRules} from './import/defineOverlayRules';
import {DOMImportExtension} from './import/DOMImportExtension';
import {ImportOverlays} from './import/ImportContext';
import {selBase as sel} from './import/sel';
import {type DOMPreprocessFn} from './import/types';

/**
 * The attribute that carries a block id in HTML.
 *
 * @experimental
 */
export const BLOCK_ID_ATTRIBUTE = 'data-block-id';

/** @experimental */
export interface BlockIdHTMLConfig {
  /**
   * Write {@link BLOCK_ID_ATTRIBUTE} on the exported element of every
   * identified block (`$generateHtmlFromNodes`, copy as HTML, …).
   */
  export: boolean;
  /**
   * Read {@link BLOCK_ID_ATTRIBUTE} back when HTML is imported through
   * {@link DOMImportExtension}. Imported ids are never trusted: they are
   * validated like any other id and go through the uniqueness rule of
   * {@link BlockIdExtension}, so pasting HTML that carries ids already in the
   * document gives the pasted blocks fresh ids.
   */
  import: boolean;
}

function $isBlockForId(node: LexicalNode): boolean {
  return ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
}

const BlockIdImportRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const nodes = $next();
    if (!$getExtensionOutput(BlockIdHTMLExtension).import.peek()) {
      return nodes;
    }
    const id = blockIdState.parse(el.getAttribute(BLOCK_ID_ATTRIBUTE));
    if (id !== undefined) {
      // The element produced this block (and possibly inline siblings or
      // hoisted children after it): the first block is the one it describes.
      for (const node of nodes) {
        if ($isBlockForId(node)) {
          if ($getBlockId(node) === null) {
            $setState(node, blockIdState, id);
          }
          break;
        }
      }
    }
    return nodes;
  },
  match: sel.any().attr(BLOCK_ID_ATTRIBUTE, true),
  name: '@lexical/html/block-id',
});

const BlockIdImportOverlay = defineOverlayRules([BlockIdImportRule]);

/**
 * Installs the import rule as a walk-wide overlay, so it wraps whichever rule
 * converts the element, whatever the order of the extensions that contribute
 * import rules.
 */
const $installBlockIdImportOverlay: DOMPreprocessFn = (dom, ctx, $next) => {
  ctx.session.update(ImportOverlays, prev => [...prev, BlockIdImportOverlay]);
  $next();
};

/**
 * Opt-in HTML support for {@link BlockIdExtension}: exported HTML carries
 * each identified block's id in a `data-block-id` attribute, and HTML imported
 * through {@link DOMImportExtension} reads it back (through the uniqueness
 * rule, so ids in pasted HTML never clash with ids in the document).
 *
 * This lives in `@lexical/html` rather than in {@link BlockIdExtension}
 * because `@lexical/html` depends on `@lexical/extension`. The legacy
 * `$generateNodesFromDOM` path (`importDOM`) does not read the attribute.
 *
 * @experimental
 */
export const BlockIdHTMLExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<BlockIdHTMLConfig>({export: true, import: true}),
  dependencies: [
    BlockIdExtension,
    configExtension(DOMRenderExtension, {
      overrides: [
        domOverride('*', {
          $exportDOM(node, $next) {
            const output = $next();
            if (
              isHTMLElement(output.element) &&
              $getExtensionOutput(BlockIdHTMLExtension).export.peek() &&
              $getExtensionOutput(BlockIdExtension).$isIdentifiedBlock(node)
            ) {
              const id = $getBlockId(node);
              if (id !== null) {
                output.element.setAttribute(BLOCK_ID_ATTRIBUTE, id);
              }
            }
            return output;
          },
        }),
      ],
    }),
    configExtension(DOMImportExtension, {
      preprocess: [$installBlockIdImportOverlay],
    }),
  ],
  name: '@lexical/html/BlockIdHTML',
});
