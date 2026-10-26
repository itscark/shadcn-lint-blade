/**
 * An ESLint parser for Blade views, written for @shadcn/lint.
 *
 * @shadcn/lint picks its template reader from the parser's services: a parser
 * that offers `defineTemplateBodyVisitor` — vue-eslint-parser's hook — gets the
 * Vue reader, which walks VElement / VAttribute / VLiteral nodes. This parser
 * builds exactly those nodes from a Blade file (blade-template.mjs), so the
 * plugin's rules, options, messages and suggestions run on a Livewire view
 * without a fork of the plugin.
 *
 * The ESTree `Program` holds the `@php` assignments as `const` declarations
 * (so a class string assigned there resolves one hop away in the template,
 * through ESLint's own scope analysis) and the Blade comments, so ESLint's
 * directive comments work in `{{-- --}}`. The template hangs off
 * `templateBody`, outside the keys ESLint traverses, and is walked once per
 * file from `Program:exit`, the way vue-eslint-parser does it.
 *
 *   // eslint.config.mjs
 *   import * as blade from '@itscark/shadcn-lint-blade'
 *   { files: ['**\/*.blade.php'], languageOptions: { parser: blade } }
 */

import * as espree from 'espree';

import { parseBladeTemplate } from './blade-template.mjs';
import { createLocator } from './source-locations.mjs';

export const meta = { name: '@itscark/shadcn-lint-blade', version: '0.1.0' };

const TEMPLATE_KEYS = {
    VDocumentFragment: ['children'],
    VElement: ['startTag', 'children', 'endTag'],
    VStartTag: ['attributes'],
    VEndTag: [],
    VAttribute: ['key', 'value'],
    VDirectiveKey: ['name', 'argument'],
    VIdentifier: [],
    VLiteral: [],
    VText: [],
    VExpressionContainer: ['expression'],
    PhpExpression: [],
};

// ESLint and eslint-scope use these to descend; the template types are listed
// so neither ever enters a template node by accident.
export const VISITOR_KEYS = { ...espree.VisitorKeys, ...TEMPLATE_KEYS };

const SKIPPED_KEYS = new Set(['parent', 'loc', 'range', 'type']);

function childKeys(node) {
    return VISITOR_KEYS[node.type] ?? Object.keys(node).filter((key) => !SKIPPED_KEYS.has(key));
}

/** Rebases an espree AST so its ranges point into the Blade file. */
function rebase(node, shift, locator, parent) {
    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            rebase(item, shift, locator, parent);
        }

        return;
    }

    if (typeof node.type !== 'string') {
        return;
    }

    const [start, end] = node.range;
    node.range = [start + shift, end + shift];
    node.loc = locator.loc(node.range[0], node.range[1]);
    node.parent = parent;

    for (const key of Object.keys(node)) {
        if (!SKIPPED_KEYS.has(key)) {
            rebase(node[key], shift, locator, node);
        }
    }
}

/**
 * An Alpine expression (`:class="{ 'hidden': open }"` on a plain element) as
 * the ESTree espree produces. One that does not parse is opaque.
 */
function parseJsExpression(text, offset, locator) {
    try {
        const program = espree.parse(`(${text}\n)`, { ecmaVersion: 'latest', sourceType: 'script', range: true, loc: true });
        const statement = program.body[0];

        if (program.body.length !== 1 || statement.type !== 'ExpressionStatement') {
            throw new SyntaxError('not an expression');
        }

        const expression = statement.expression;
        rebase(expression, offset - 1, locator, null);

        return expression;
    } catch {
        const range = [offset, offset + text.length];

        return { type: 'PhpExpression', text, range, loc: locator.loc(range[0], range[1]) };
    }
}

function dispatch(listeners, selector, node) {
    const handlers = listeners.get(selector);

    if (handlers !== undefined) {
        for (const handler of handlers) {
            handler(node);
        }
    }
}

function traverse(node, listeners) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
        return;
    }

    dispatch(listeners, node.type, node);

    for (const key of childKeys(node)) {
        const child = node[key];

        if (Array.isArray(child)) {
            for (const item of child) {
                traverse(item, listeners);
            }
        } else {
            traverse(child, listeners);
        }
    }

    dispatch(listeners, `${node.type}:exit`, node);
}

/**
 * The service vue-eslint-parser offers, reduced to what @shadcn/lint uses:
 * node-type selectors and their `:exit` form. Every rule's template visitors
 * join one registry; the first caller's `Program:exit` walks the template once
 * and dispatches to all of them.
 */
function createServices(ast) {
    const listeners = new Map();
    let scheduled = false;

    return {
        isBlade: true,
        defineTemplateBodyVisitor(templateVisitor, scriptVisitor = {}) {
            for (const [selector, handler] of Object.entries(templateVisitor)) {
                if (typeof handler !== 'function') {
                    continue;
                }

                let handlers = listeners.get(selector);

                if (handlers === undefined) {
                    handlers = [];
                    listeners.set(selector, handlers);
                }

                handlers.push(handler);
            }

            if (scheduled) {
                return scriptVisitor;
            }

            scheduled = true;
            const exit = scriptVisitor['Program:exit'];

            return {
                ...scriptVisitor,
                'Program:exit'(node) {
                    if (typeof exit === 'function') {
                        exit(node);
                    }

                    traverse(ast.templateBody, listeners);
                },
            };
        },
    };
}

export function parseForESLint(code) {
    const locator = createLocator(code);
    const js = (text, offset) => parseJsExpression(text, offset, locator);
    const { fragment, declarations, comments } = parseBladeTemplate(code, { locator, js });
    const ast = {
        type: 'Program',
        body: declarations,
        sourceType: 'module',
        range: [0, code.length],
        loc: locator.loc(0, code.length),
        tokens: [],
        comments,
        templateBody: fragment,
    };

    fragment.parent = ast;

    for (const declaration of declarations) {
        declaration.parent = ast;
    }

    return { ast, services: createServices(ast), visitorKeys: VISITOR_KEYS };
}

/** The ESTree Program alone, for tooling that calls `parse` rather than `parseForESLint`. */
export function parse(code) {
    return parseForESLint(code).ast;
}
