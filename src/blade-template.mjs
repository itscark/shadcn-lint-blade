/**
 * Reads a Blade view into the template AST vue-eslint-parser produces, so that
 * @shadcn/lint's Vue reader lints a Livewire view unchanged.
 *
 * Only what that reader asks for is modelled (see sites/readers/vue.ts in
 * @shadcn/lint): the element tree with parent links (VElement → VStartTag →
 * VAttribute), each attribute's name and value, and the class channels Blade
 * adds on top of HTML:
 *
 *   class="p-4 {{ $active ? 'font-bold' : '' }}"   a bound class, template literal
 *   @class(['p-4', 'bg-red-500' => $tone])          a bound class, PHP array
 *   :class="$flush ? 'p-0!' : ''"                  a bound class, PHP (component tag)
 *   :class="{ 'hidden': open }" / x-bind:class     a bound class, Alpine JS (plain tag)
 *   {{ $attributes->class([...]) }}                 a spread carrying `class`
 *   @php $classes = '...'; @endphp                  a const the template reads one hop away
 *
 * Blade comments become ESLint comments, so `{{-- eslint-disable-next-line
 * shadcn/no-raw-colors --}}` works the way a JS directive comment does.
 * Everything else Blade compiles — echoes in text, control directives, the
 * PHP block of a ⚡ single-file component — is skipped. Nothing here throws on
 * malformed markup: the tree is simply as good as the markup allows.
 */

import { parseAttributesBag, parsePhpAssignments, parsePhpExpression } from './php-expression.mjs';

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);

// Their content is text, not markup, until the matching close tag.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

// Where Blade compiles a colon-prefixed attribute as PHP. On a plain element the
// colon is Alpine's `x-bind:` shorthand and the value is JavaScript.
const COMPONENT_TAG = /^(?:x-|flux:|livewire:)/;

const TAG_NAME = /[A-Za-z][^\s/>]*/y;
const DIRECTIVE_NAME = /[A-Za-z_]\w*/y;
const ATTRIBUTE_NAME = /[^\s=/>]+/y;
const BLADE_IN_VALUE = /\{\{|\{!!|@[A-Za-z_]\w*\s*\(/;

function match(regex, text, at) {
    regex.lastIndex = at;
    const found = regex.exec(text);

    return found && found.index === at ? found[0] : null;
}

function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

class TemplateReader {
    /**
     * @param {string} source
     * @param {{ loc: (start: number, end: number) => object }} locator
     * @param {(text: string, offset: number) => object|null} js  Parses an Alpine expression.
     */
    constructor(source, locator, js) {
        this.source = source;
        this.locator = locator;
        this.js = js;
        this.i = 0;
        this.fragment = this.node('VDocumentFragment', 0, source.length, { children: [] });
        this.stack = [this.fragment];
        this.comments = [];
        this.declarations = [];
    }

    node(type, start, end, props) {
        return { type, range: [start, end], loc: this.locator.loc(start, end), ...props };
    }

    /** Moves a node's end once its extent is known. */
    close(node, end) {
        node.range[1] = end;
        node.loc.end = this.locator.position(end);
    }

    get current() {
        return this.stack[this.stack.length - 1];
    }

    read() {
        const s = this.source;
        const n = s.length;

        while (this.i < n) {
            const c = s[this.i];

            if (c === '{') {
                if (s.startsWith('{{--', this.i)) {
                    this.i = this.readComment(this.i);
                    continue;
                }

                if (s.startsWith('{{', this.i)) {
                    this.i = this.skipPast('}}', this.i + 2);
                    continue;
                }

                if (s.startsWith('{!!', this.i)) {
                    this.i = this.skipPast('!!}', this.i + 3);
                    continue;
                }
            } else if (c === '<') {
                if (s.startsWith('<?php', this.i) || s.startsWith('<?=', this.i)) {
                    this.i = this.readPhpTag(this.i);
                    continue;
                }

                if (s.startsWith('<!--', this.i)) {
                    this.i = this.skipPast('-->', this.i + 4);
                    continue;
                }

                if (s[this.i + 1] === '/') {
                    this.i = this.readCloseTag(this.i);
                    continue;
                }

                if (match(TAG_NAME, s, this.i + 1) !== null) {
                    this.i = this.readOpenTag(this.i);
                    continue;
                }
            } else if (c === '@' && this.atDirective(this.i)) {
                this.i = this.readDirective(this.i);
                continue;
            }

            this.i++;
        }
    }

    skipPast(marker, from) {
        const end = this.source.indexOf(marker, from);

        return end === -1 ? this.source.length : end + marker.length;
    }

    /** `@name` opens a directive unless glued to a word, as in an e-mail address. */
    atDirective(at) {
        const before = this.source[at - 1];

        return match(DIRECTIVE_NAME, this.source, at + 1) !== null && !(before !== undefined && /\w/.test(before));
    }

    readComment(at) {
        const close = this.source.indexOf('--}}', at + 4);
        const end = close === -1 ? this.source.length : close + 4;
        const value = this.source.slice(at + 4, close === -1 ? end : close);
        this.comments.push(this.node('Block', at, end, { value }));

        return end;
    }

    readPhpTag(at) {
        const open = this.source.startsWith('<?php', at) ? 5 : 3;
        const close = this.source.indexOf('?>', at + open);
        const bodyEnd = close === -1 ? this.source.length : close;
        this.declare(this.source.slice(at + open, bodyEnd), at + open);

        return close === -1 ? this.source.length : close + 2;
    }

    declare(php, offset) {
        this.declarations.push(...parsePhpAssignments(php, offset, this.locator));
    }

    /** A directive in text: a `@php` block declares; everything else is skipped. */
    readDirective(at) {
        const s = this.source;
        const name = match(DIRECTIVE_NAME, s, at + 1);
        const afterName = at + 1 + name.length;
        let k = afterName;

        while (s[k] === ' ' || s[k] === '\t') {
            k++;
        }

        if (name === 'php' && s[k] !== '(') {
            const end = s.indexOf('@endphp', afterName);
            this.declare(s.slice(afterName, end === -1 ? s.length : end), afterName);

            return end === -1 ? s.length : end + '@endphp'.length;
        }

        if (name === 'verbatim') {
            return this.skipPast('@endverbatim', afterName);
        }

        if (s[k] === '(') {
            const close = this.skipBalanced(k);

            if (name === 'php') {
                this.declare(s.slice(k + 1, close - 1), k + 1);
            }

            return close;
        }

        return afterName;
    }

    /** From an opening parenthesis to just past its match, strings respected. */
    skipBalanced(at) {
        const s = this.source;
        let depth = 0;

        for (let i = at; i < s.length; i++) {
            const c = s[i];

            if (c === "'" || c === '"') {
                i = this.stringEnd(i) - 1;
            } else if (c === '(') {
                depth++;
            } else if (c === ')' && --depth === 0) {
                return i + 1;
            }
        }

        return s.length;
    }

    stringEnd(at) {
        const s = this.source;
        const quote = s[at];

        for (let i = at + 1; i < s.length; i++) {
            if (s[i] === '\\') {
                i++;
            } else if (s[i] === quote) {
                return i + 1;
            }
        }

        return s.length;
    }

    readOpenTag(at) {
        const s = this.source;
        const n = s.length;
        const tagName = match(TAG_NAME, s, at + 1);
        const component = COMPONENT_TAG.test(tagName);
        // The Vue reader derives "is a component" from rawName's spelling (a dash
        // or a capital). A Blade component tag is spelled with a colon, so it is
        // handed over kebab-cased: <flux:badge> reads as <flux-badge>, a component
        // whose color="red" is a prop rather than an SVG paint attribute. `name`
        // keeps the real tag for matching the close tag.
        const rawName = component ? tagName.replace(/::?/g, '-') : tagName;
        const attributes = [];
        const startTag = this.node('VStartTag', at, at, { attributes });
        const element = this.node('VElement', at, at, {
            name: tagName.toLowerCase(),
            rawName,
            startTag,
            children: [],
            endTag: null,
            parent: this.current,
        });
        startTag.parent = element;
        let selfClosing = false;
        let j = at + 1 + tagName.length;

        while (j < n) {
            const c = s[j];

            if (isSpace(c)) {
                j++;
                continue;
            }

            if (c === '>') {
                j++;
                break;
            }

            if (c === '/') {
                if (s[j + 1] === '>') {
                    selfClosing = true;
                    j += 2;
                    break;
                }

                j++;
                continue;
            }

            if (s.startsWith('{{--', j)) {
                j = this.readComment(j);
                continue;
            }

            if (s.startsWith('{{', j)) {
                j = this.readTagEcho(j, startTag, attributes);
                continue;
            }

            if (s.startsWith('{!!', j)) {
                j = this.skipPast('!!}', j + 3);
                continue;
            }

            if (c === '@') {
                const name = match(DIRECTIVE_NAME, s, j + 1);
                const next = name === null ? '' : s[j + 1 + name.length];

                // `@click.prevent="…"` is an Alpine attribute, not a directive.
                if (name !== null && next !== '=' && next !== '.' && next !== ':') {
                    let k = j + 1 + name.length;

                    while (s[k] === ' ' || s[k] === '\t') {
                        k++;
                    }

                    if (s[k] === '(') {
                        const close = this.skipBalanced(k);

                        if (name === 'class' || name === 'style') {
                            attributes.push(this.directiveAttribute(name, j, k + 1, close - 1, close, startTag));
                        }

                        j = close;
                        continue;
                    }

                    j = k;
                    continue;
                }
            }

            const name = match(ATTRIBUTE_NAME, s, j);

            if (name === null) {
                j++;
                continue;
            }

            const nameStart = j;
            const nameEnd = j + name.length;
            let k = nameEnd;

            while (isSpace(s[k])) {
                k++;
            }

            let valueStart = -1;
            let valueEnd = -1;
            let quote = '';

            if (s[k] === '=') {
                k++;

                while (isSpace(s[k])) {
                    k++;
                }

                if (s[k] === '"' || s[k] === "'") {
                    quote = s[k];
                    valueStart = k + 1;
                    valueEnd = this.valueEnd(valueStart, quote);
                    j = Math.min(valueEnd + 1, n);
                } else {
                    valueStart = k;

                    while (k < n && !isSpace(s[k]) && s[k] !== '>') {
                        k++;
                    }

                    valueEnd = k;
                    j = k;
                }
            } else {
                j = nameEnd;
            }

            attributes.push(this.attribute(name, nameStart, nameEnd, valueStart, valueEnd, quote, component, startTag));
        }

        this.close(startTag, j);
        this.close(element, j);
        this.current.children.push(element);

        if (selfClosing || VOID_ELEMENTS.has(element.name)) {
            return j;
        }

        this.stack.push(element);

        if (RAW_TEXT_ELEMENTS.has(element.name)) {
            const closeTag = new RegExp(`</${element.name}\\b`, 'ig');
            closeTag.lastIndex = j;
            const found = closeTag.exec(s);

            return found ? found.index : n;
        }

        return j;
    }

    /** The index of the quote closing an attribute value, Blade constructs stepped over. */
    valueEnd(from, quote) {
        const s = this.source;

        for (let i = from; i < s.length; i++) {
            const c = s[i];

            if (c === quote) {
                return i;
            }

            if (c === '{') {
                if (s.startsWith('{{--', i)) {
                    i = this.skipPast('--}}', i + 4) - 1;
                } else if (s.startsWith('{{', i)) {
                    i = this.skipPast('}}', i + 2) - 1;
                } else if (s.startsWith('{!!', i)) {
                    i = this.skipPast('!!}', i + 3) - 1;
                }
            } else if (c === '@') {
                const name = match(DIRECTIVE_NAME, s, i + 1);
                let k = name === null ? -1 : i + 1 + name.length;

                while (k !== -1 && (s[k] === ' ' || s[k] === '\t')) {
                    k++;
                }

                if (k !== -1 && s[k] === '(') {
                    i = this.skipBalanced(k) - 1;
                }
            }
        }

        return s.length;
    }

    readCloseTag(at) {
        const s = this.source;
        const name = match(TAG_NAME, s, at + 2);
        const gt = s.indexOf('>', at);
        const end = gt === -1 ? s.length : gt + 1;

        if (name === null) {
            return end;
        }

        const lower = name.toLowerCase();

        for (let depth = this.stack.length - 1; depth > 0; depth--) {
            const element = this.stack[depth];

            if (element.name !== lower) {
                continue;
            }

            element.endTag = this.node('VEndTag', at, end, { parent: element });
            this.close(element, end);
            this.stack.length = depth;
            break;
        }

        return end;
    }

    /** `{{ $attributes->… }}` inside a tag is a spread; any other echo there is skipped. */
    readTagEcho(at, startTag, attributes) {
        const s = this.source;
        const close = s.indexOf('}}', at + 2);
        const end = close === -1 ? s.length : close + 2;
        const innerStart = at + 2;
        const innerEnd = close === -1 ? s.length : close;
        const inner = s.slice(innerStart, innerEnd);

        if (/^\s*\$attributes\b/.test(inner)) {
            const expression = parseAttributesBag(inner, innerStart, this.locator);
            attributes.push(this.boundAttribute(null, at, end, at, at + 2, innerStart, innerEnd, expression, startTag));
        }

        return end;
    }

    /** `@class([...])` and `@style([...])` are bound attributes of that name. */
    directiveAttribute(name, at, argStart, argEnd, end, startTag) {
        const argument = parsePhpExpression(this.source.slice(argStart, argEnd), argStart, this.locator);
        const expression = name === 'style' ? styleObjectOf(argument, this) : argument;

        return this.boundAttribute(name, at, end, at + 1, at + 1 + name.length, argStart, argEnd, expression, startTag);
    }

    attribute(name, nameStart, nameEnd, valueStart, valueEnd, quote, component, startTag) {
        const end = valueStart === -1 ? nameEnd : Math.min(this.source.length, quote ? valueEnd + 1 : valueEnd);
        const text = valueStart === -1 ? null : this.source.slice(valueStart, valueEnd);

        if (name.startsWith('::')) {
            return this.boundAttribute(name.slice(2), nameStart, end, nameStart, nameEnd, valueStart, valueEnd, this.expression(text, valueStart, false), startTag);
        }

        if (name.startsWith(':') && name.length > 1) {
            return this.boundAttribute(name.slice(1), nameStart, end, nameStart, nameEnd, valueStart, valueEnd, this.expression(text, valueStart, component), startTag);
        }

        if (name.startsWith('x-bind:')) {
            return this.boundAttribute(name.slice(7), nameStart, end, nameStart, nameEnd, valueStart, valueEnd, this.expression(text, valueStart, false), startTag);
        }

        if (text !== null && BLADE_IN_VALUE.test(text)) {
            const expression = this.interpolated(valueStart, valueEnd);

            return this.boundAttribute(name, nameStart, end, nameStart, nameEnd, valueStart, valueEnd, expression, startTag);
        }

        const key = this.node('VIdentifier', nameStart, nameEnd, { name, rawName: name });
        const attribute = this.node('VAttribute', nameStart, end, { directive: false, key, value: null, parent: startTag });
        key.parent = attribute;

        if (text !== null) {
            attribute.value = this.node('VLiteral', valueStart - (quote ? 1 : 0), end, { value: text, parent: attribute });
        }

        return attribute;
    }

    expression(text, offset, php) {
        if (text === null) {
            return null;
        }

        return php ? parsePhpExpression(text, offset, this.locator) : this.js(text, offset);
    }

    /**
     * A bound attribute, the way vue-eslint-parser writes `:class` / `v-bind`:
     * a `bind` directive whose argument is the attribute name, or null for a
     * spread.
     */
    boundAttribute(argument, start, end, keyStart, keyEnd, valueStart, valueEnd, expression, startTag) {
        const attribute = this.node('VAttribute', start, end, { directive: true, key: null, value: null, parent: startTag });
        const name = this.node('VIdentifier', keyStart, keyStart, { name: 'bind', rawName: ':' });
        const key = this.node('VDirectiveKey', keyStart, keyEnd, {
            name,
            argument: argument === null ? null : this.node('VIdentifier', keyStart, keyEnd, { name: argument, rawName: argument }),
            modifiers: [],
            parent: attribute,
        });
        name.parent = key;

        if (key.argument !== null) {
            key.argument.parent = key;
        }

        attribute.key = key;

        if (valueStart !== -1) {
            const container = this.node('VExpressionContainer', valueStart, valueEnd, { expression, references: [], parent: attribute });

            if (expression !== null) {
                expression.parent = container;
            }

            attribute.value = container;
        }

        return attribute;
    }

    /**
     * A value mixing text with `{{ }}` echoes or directives, as a TemplateLiteral:
     * the text chunks are classes, each echo an expression in its own hole.
     */
    interpolated(from, to) {
        const s = this.source;
        const quasis = [];
        const expressions = [];
        let chunkStart = from;
        let i = from;

        const flush = (end, tail = false) => {
            const text = s.slice(chunkStart, end);
            quasis.push(this.node('TemplateElement', chunkStart, end, { value: { raw: text, cooked: text }, tail }));
        };

        while (i < to) {
            if (s.startsWith('{{--', i)) {
                flush(i);
                const end = this.skipPast('--}}', i + 4);
                expressions.push(this.node('PhpExpression', i, end, { text: '' }));
                i = end;
                chunkStart = i;
                continue;
            }

            if (s.startsWith('{{', i) || s.startsWith('{!!', i)) {
                const raw = s.startsWith('{!!', i);
                const open = raw ? 3 : 2;
                const close = s.indexOf(raw ? '!!}' : '}}', i + open);
                const innerEnd = close === -1 ? to : close;
                const end = close === -1 ? to : close + 3 - (raw ? 0 : 1);
                flush(i);
                expressions.push(
                    parsePhpExpression(s.slice(i + open, innerEnd), i + open, this.locator)
                        ?? this.node('PhpExpression', i, end, { text: '' }),
                );
                i = end;
                chunkStart = i;
                continue;
            }

            if (s[i] === '@') {
                const name = match(DIRECTIVE_NAME, s, i + 1);
                let k = name === null ? -1 : i + 1 + name.length;

                while (k !== -1 && (s[k] === ' ' || s[k] === '\t')) {
                    k++;
                }

                if (k !== -1 && s[k] === '(') {
                    const end = this.skipBalanced(k);
                    flush(i);
                    expressions.push(this.node('PhpExpression', i, end, { text: s.slice(i, end) }));
                    i = end;
                    chunkStart = i;
                    continue;
                }
            }

            i++;
        }

        flush(to, true);

        const template = this.node('TemplateLiteral', from, to, { quasis, expressions });

        for (const child of [...quasis, ...expressions]) {
            child.parent = template;
        }

        return template;
    }
}

/**
 * `@style(['color: red' => $x, 'display: none'])` as the style object
 * no-inline-styles judges property by property.
 */
function styleObjectOf(argument, reader) {
    if (argument === null) {
        return null;
    }

    const keys = argument.type === 'ObjectExpression'
        ? argument.properties.map((property) => property.key)
        : argument.type === 'ArrayExpression'
            ? argument.elements.map((element) => (element?.type === 'ObjectExpression' ? element.properties[0]?.key : element))
            : null;

    if (keys === null) {
        return argument;
    }

    const properties = [];

    for (const key of keys) {
        if (key?.type !== 'Literal' || typeof key.value !== 'string' || !key.value.includes(':')) {
            continue;
        }

        const colon = key.value.indexOf(':');
        const [start, end] = key.range;
        const name = reader.node('Literal', start, end, { value: key.value.slice(0, colon).trim(), raw: key.raw });
        const value = reader.node('Literal', start, end, { value: key.value.slice(colon + 1).trim(), raw: key.raw });
        const property = reader.node('Property', start, end, { key: name, value, computed: false, kind: 'init', method: false, shorthand: false });
        name.parent = property;
        value.parent = property;
        properties.push(property);
    }

    const object = reader.node('ObjectExpression', argument.range[0], argument.range[1], { properties });

    for (const property of properties) {
        property.parent = object;
    }

    return object;
}

/**
 * @returns {{ fragment: object, declarations: object[], comments: object[] }}
 */
export function parseBladeTemplate(source, { locator, js }) {
    const reader = new TemplateReader(source, locator, js);
    reader.read();

    return { fragment: reader.fragment, declarations: reader.declarations, comments: reader.comments };
}
