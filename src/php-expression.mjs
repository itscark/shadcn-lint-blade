/**
 * A PHP expression the way @shadcn/lint's value walker reads it.
 *
 * The walker (collect.ts in @shadcn/lint) understands ESTree: string literals,
 * template literals, arrays, objects with classes as keys, ternaries and
 * logical expressions. Blade carries class names in exactly those PHP shapes:
 *
 *   @class(['p-4', 'bg-red-500' => $tone === 'red'])
 *   :class="$flush ? 'p-0!' : ''"
 *   {{ $attributes->class('inline-flex ' . $gap) }}
 *
 * So those shapes become their ESTree counterparts, with ranges pointing into
 * the Blade file. Everything else — a method call, a comparison, a closure —
 * becomes one opaque `PhpExpression` node, which the walker reports as dynamic
 * and never guesses at. Parsing never throws: an expression this module cannot
 * read is opaque as a whole.
 */

const OPERATORS = [
    '?->', '...', '===', '!==', '<=>', '**=', '??=', '<<=', '>>=',
    '.=', '=>', '->', '::', '??', '==', '!=', '<>', '<=', '>=', '&&', '||',
    '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '?:',
];

const WHITESPACE = /[ \t\r\n]+/y;
const VARIABLE = /\$[A-Za-z_\x80-\uffff][\w\x80-\uffff]*/y;
const NUMBER = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*/y;
const NAME = /[A-Za-z_\\\x80-\uffff][\w\\\x80-\uffff]*/y;
const COMPARISON = new Set(['<', '>', '<=', '>=']);
const EQUALITY = new Set(['==', '!=', '===', '!==', '<>', '<=>']);

const BAIL = Symbol('php-expression bail');

function stringEnd(text, start) {
    const quote = text[start];

    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
        } else if (text[i] === quote) {
            return i + 1;
        }
    }

    return text.length;
}

function lineEnd(text, start) {
    const end = text.indexOf('\n', start);

    return end === -1 ? text.length : end;
}

function match(regex, text, at) {
    regex.lastIndex = at;
    const found = regex.exec(text);

    return found && found.index === at ? found[0] : null;
}

/**
 * @returns {{ type: 'string'|'variable'|'number'|'name'|'op', value: string, start: number, end: number }[]}
 */
export function tokenizePhp(text) {
    const tokens = [];
    let i = 0;

    while (i < text.length) {
        const c = text[i];
        const space = match(WHITESPACE, text, i);

        if (space !== null) {
            i += space.length;
            continue;
        }

        if ((c === '/' && text[i + 1] === '/') || (c === '#' && text[i + 1] !== '[')) {
            i = lineEnd(text, i);
            continue;
        }

        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end === -1 ? text.length : end + 2;
            continue;
        }

        if (c === "'" || c === '"') {
            const end = stringEnd(text, i);
            tokens.push({ type: 'string', value: text.slice(i, end), start: i, end });
            i = end;
            continue;
        }

        const variable = match(VARIABLE, text, i);

        if (variable !== null) {
            tokens.push({ type: 'variable', value: variable, start: i, end: i + variable.length });
            i += variable.length;
            continue;
        }

        const number = match(NUMBER, text, i);

        if (number !== null) {
            tokens.push({ type: 'number', value: number, start: i, end: i + number.length });
            i += number.length;
            continue;
        }

        const name = match(NAME, text, i);

        if (name !== null) {
            tokens.push({ type: 'name', value: name, start: i, end: i + name.length });
            i += name.length;
            continue;
        }

        const op = OPERATORS.find((candidate) => text.startsWith(candidate, i)) ?? c;
        tokens.push({ type: 'op', value: op, start: i, end: i + op.length });
        i += op.length;
    }

    return tokens;
}

/**
 * The PHP escapes a double-quoted string resolves. Unknown escapes keep the
 * backslash, as PHP does.
 */
const DOUBLE_QUOTE_ESCAPES = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', e: '\x1b', '\\': '\\', $: '$', '"': '"' };

class ExpressionParser {
    constructor(tokens, text, offset, locator) {
        this.tokens = tokens;
        this.text = text;
        this.offset = offset;
        this.locator = locator;
        this.p = 0;
    }

    get token() {
        return this.tokens[this.p];
    }

    at(value) {
        const token = this.token;

        return token !== undefined && token.type === 'op' && token.value === value;
    }

    atName(value) {
        const token = this.token;

        return token !== undefined && token.type === 'name' && token.value.toLowerCase() === value;
    }

    advance() {
        const token = this.token;

        if (token === undefined) {
            throw BAIL;
        }

        this.p++;

        return token;
    }

    expect(value) {
        if (!this.at(value)) {
            throw BAIL;
        }

        return this.advance();
    }

    /** Builds a node over text-relative offsets. */
    node(type, start, end, props) {
        const from = this.offset + start;
        const to = this.offset + end;

        return { type, range: [from, to], loc: this.locator.loc(from, to), ...props };
    }

    opaque(start, end) {
        return this.node('PhpExpression', start, end, { text: this.text.slice(start, end) });
    }

    /** One opaque node spanning two nodes the walker cannot combine. */
    span(left, right) {
        return this.opaque(left.range[0] - this.offset, right.range[1] - this.offset);
    }

    parseExpression() {
        return this.parseTernary();
    }

    parseTernary() {
        const test = this.parseCoalesce();

        if (this.at('?:')) {
            this.advance();

            return this.logical('||', test, this.parseTernary());
        }

        if (!this.at('?')) {
            return test;
        }

        this.advance();

        if (this.at(':')) {
            this.advance();

            return this.logical('||', test, this.parseTernary());
        }

        const consequent = this.parseTernary();
        this.expect(':');
        const alternate = this.parseTernary();

        return this.node(
            'ConditionalExpression',
            test.range[0] - this.offset,
            alternate.range[1] - this.offset,
            { test, consequent, alternate },
        );
    }

    logical(operator, left, right) {
        return this.node(
            'LogicalExpression',
            left.range[0] - this.offset,
            right.range[1] - this.offset,
            { operator, left, right },
        );
    }

    parseCoalesce() {
        const left = this.parseOr();

        if (!this.at('??')) {
            return left;
        }

        this.advance();

        return this.logical('??', left, this.parseCoalesce());
    }

    parseOr() {
        let left = this.parseAnd();

        while (this.at('||') || this.atName('or')) {
            this.advance();
            left = this.logical('||', left, this.parseAnd());
        }

        return left;
    }

    parseAnd() {
        let left = this.parseEquality();

        while (this.at('&&') || this.atName('and')) {
            this.advance();
            left = this.logical('&&', left, this.parseEquality());
        }

        return left;
    }

    parseEquality() {
        let left = this.parseComparison();

        while (this.token?.type === 'op' && EQUALITY.has(this.token.value)) {
            this.advance();
            left = this.span(left, this.parseComparison());
        }

        return left;
    }

    parseComparison() {
        let left = this.parseConcat();

        while ((this.token?.type === 'op' && COMPARISON.has(this.token.value)) || this.atName('instanceof')) {
            this.advance();
            left = this.span(left, this.parseConcat());
        }

        return left;
    }

    parseConcat() {
        const parts = [this.parseAdditive()];

        while (this.at('.')) {
            this.advance();
            parts.push(this.parseAdditive());
        }

        return parts.length === 1 ? parts[0] : this.template(parts);
    }

    parseAdditive() {
        let left = this.parseMultiplicative();

        while (this.at('+') || this.at('-')) {
            this.advance();
            left = this.span(left, this.parseMultiplicative());
        }

        return left;
    }

    parseMultiplicative() {
        let left = this.parseUnary();

        while (this.at('*') || this.at('/') || this.at('%') || this.at('**')) {
            this.advance();
            left = this.span(left, this.parseUnary());
        }

        return left;
    }

    parseUnary() {
        const token = this.token;

        if (token === undefined) {
            throw BAIL;
        }

        if (token.type === 'op' && ['!', '-', '+', '~', '@', '&'].includes(token.value)) {
            this.advance();
            const argument = this.parseUnary();

            return this.opaque(token.start, argument.range[1] - this.offset);
        }

        if (this.atName('new') || this.atName('clone') || this.atName('print')) {
            this.advance();
            const argument = this.parseUnary();

            return this.opaque(token.start, argument.range[1] - this.offset);
        }

        return this.parsePostfix();
    }

    parsePostfix() {
        let node = this.parsePrimary();

        for (;;) {
            if (this.at('->') || this.at('?->') || this.at('::')) {
                this.advance();
                const member = this.advance();
                node = this.opaque(node.range[0] - this.offset, member.end);
                continue;
            }

            if (this.at('(') || this.at('[')) {
                const close = this.skipGroup();
                node = this.opaque(node.range[0] - this.offset, close.end);
                continue;
            }

            return node;
        }
    }

    /** Skips a balanced group starting at the current open token; returns the closing token. */
    skipGroup() {
        let depth = 0;

        for (;;) {
            const token = this.advance();

            if (token.type !== 'op') {
                continue;
            }

            if (token.value === '(' || token.value === '[' || token.value === '{') {
                depth++;
            } else if (token.value === ')' || token.value === ']' || token.value === '}') {
                depth--;

                if (depth === 0) {
                    return token;
                }
            }
        }
    }

    parsePrimary() {
        const token = this.token;

        if (token === undefined) {
            throw BAIL;
        }

        switch (token.type) {
            case 'string':
                this.advance();

                return this.string(token);
            case 'number':
                this.advance();

                return this.node('Literal', token.start, token.end, { value: Number(token.value.replace(/_/g, '')), raw: token.value });
            case 'variable':
                this.advance();

                return this.node('Identifier', token.start, token.end, { name: token.value });
            case 'name':
                return this.parseName(token);
            default:
                break;
        }

        if (token.value === '[') {
            return this.parseArray('[', ']');
        }

        if (token.value === '(') {
            this.advance();
            const inner = this.parseExpression();
            this.expect(')');

            return inner;
        }

        throw BAIL;
    }

    parseName(token) {
        const name = token.value.toLowerCase();

        if (name === 'true' || name === 'false' || name === 'null') {
            this.advance();

            return this.node('Literal', token.start, token.end, {
                value: name === 'true' ? true : name === 'false' ? false : null,
                raw: token.value,
            });
        }

        if (name === 'array' && this.tokens[this.p + 1]?.value === '(') {
            this.advance();

            return this.parseArray('(', ')');
        }

        const next = this.tokens[this.p + 1];
        const closureAhead = name === 'static' && next?.type === 'name' && /^(?:fn|function)$/i.test(next.value);

        if (name === 'match' && next?.type === 'op' && next.value === '(') {
            return this.parseMatch(token);
        }

        if (name === 'fn' || name === 'function' || closureAhead) {
            return this.parseClosureLike(token);
        }

        this.advance();

        return this.opaque(token.start, token.end);
    }

    /**
     * `match ($x) { 'a' => '…', 'b', 'c' => '…', default => '…' }` as a chain of
     * conditionals, the shape the walker already follows branch by branch: every
     * arm's value is read, every condition stays opaque. A match without a
     * default ends in an opaque alternate, so the fall-through is dynamic.
     */
    parseMatch(start) {
        this.advance();
        const subject = this.skipGroup();
        this.expect('{');
        const arms = [];
        let fallback = null;

        while (!this.at('}')) {
            const first = this.token;

            if (first === undefined) {
                throw BAIL;
            }

            let isDefault = false;

            while (!this.at('=>')) {
                if (this.atName('default')) {
                    isDefault = true;
                    this.advance();
                } else {
                    this.parseExpression();
                }

                if (this.at(',')) {
                    this.advance();
                } else if (!this.at('=>')) {
                    throw BAIL;
                }
            }

            const arrow = this.advance();
            const value = this.parseExpression();

            if (isDefault) {
                fallback = value;
            } else {
                arms.push({ test: this.opaque(first.start, arrow.start), value });
            }

            if (this.at(',')) {
                this.advance();
            } else if (!this.at('}')) {
                throw BAIL;
            }
        }

        const end = this.advance();
        let node = fallback ?? this.opaque(start.start, end.end);

        for (let i = arms.length - 1; i >= 0; i--) {
            node = this.node('ConditionalExpression', start.start, end.end, {
                test: arms[i].test,
                consequent: arms[i].value,
                alternate: node,
            });
        }

        return subject === undefined ? node : node;
    }

    /** `fn ($x) => ...` and `function () use () {}` are one opaque value. */
    parseClosureLike(start) {
        this.advance();

        if (start.value.toLowerCase() === 'static') {
            this.advance();
        }

        let last = start;

        if (this.at('(')) {
            last = this.skipGroup();
        }

        if (this.atName('use')) {
            this.advance();
            last = this.skipGroup();
        }

        if (this.at(':')) {
            this.advance();
            last = this.advance();
        }

        if (this.at('=>')) {
            this.advance();
            const body = this.parseExpression();

            return this.opaque(start.start, body.range[1] - this.offset);
        }

        if (this.at('{')) {
            last = this.skipGroup();
        }

        return this.opaque(start.start, last.end);
    }

    parseArguments() {
        this.expect('(');
        const args = [];

        while (!this.at(')')) {
            if (this.at('...')) {
                this.advance();
            }

            if (this.token?.type === 'name' && this.tokens[this.p + 1]?.value === ':' && this.tokens[this.p + 1]?.type === 'op') {
                this.advance();
                this.advance();
            }

            args.push(this.parseExpression());

            if (this.at(',')) {
                this.advance();
            } else if (!this.at(')')) {
                throw BAIL;
            }
        }

        this.advance();

        return args;
    }

    /**
     * A PHP array. Keyed entries are the clsx shape — the key is the class, the
     * value its condition — so an all-keyed array is an ObjectExpression; a list
     * is an ArrayExpression, with each keyed entry wrapped as its own object.
     */
    parseArray(open, close) {
        const start = this.expect(open);
        const items = [];

        while (!this.at(close)) {
            if (this.at('...')) {
                const spread = this.advance();
                const argument = this.parseExpression();
                items.push({ spread, argument });
            } else {
                const first = this.parseExpression();

                if (this.at('=>')) {
                    this.advance();
                    items.push({ key: first, value: this.parseExpression() });
                } else {
                    items.push({ value: first });
                }
            }

            if (this.at(',')) {
                this.advance();
            } else if (!this.at(close)) {
                throw BAIL;
            }
        }

        const end = this.advance();
        const property = (item) => this.node(
            'Property',
            item.key.range[0] - this.offset,
            item.value.range[1] - this.offset,
            {
                key: item.key,
                value: item.value,
                computed: !(item.key.type === 'Literal' && typeof item.key.value === 'string'),
                kind: 'init',
                method: false,
                shorthand: false,
            },
        );

        if (items.length > 0 && items.every((item) => item.key)) {
            return this.node('ObjectExpression', start.start, end.end, { properties: items.map(property) });
        }

        const elements = items.map((item) => {
            if (item.spread) {
                return this.node('SpreadElement', item.spread.start, item.argument.range[1] - this.offset, { argument: item.argument });
            }

            if (item.key) {
                const entry = property(item);

                return this.node('ObjectExpression', entry.range[0] - this.offset, entry.range[1] - this.offset, { properties: [entry] });
            }

            return item.value;
        });

        return this.node('ArrayExpression', start.start, end.end, { elements });
    }

    string(token) {
        const raw = token.value;
        const quote = raw[0];
        const closed = raw.length > 1 && raw[raw.length - 1] === quote;
        const inner = raw.slice(1, closed ? -1 : undefined);

        if (quote === "'") {
            return this.node('Literal', token.start, token.end, {
                value: inner.replace(/\\(['\\])/g, '$1'),
                raw,
            });
        }

        return this.interpolated(token, inner);
    }

    /** A double-quoted string: a Literal, or a TemplateLiteral when it interpolates. */
    interpolated(token, inner) {
        const base = token.start + 1;
        const quasis = [];
        const expressions = [];
        let cooked = '';
        let chunkStart = 0;
        let i = 0;

        const flush = (end) => {
            quasis.push(this.node('TemplateElement', base + chunkStart, base + end, { value: { raw: inner.slice(chunkStart, end), cooked }, tail: false }));
            cooked = '';
        };

        while (i < inner.length) {
            const c = inner[i];

            if (c === '\\' && i + 1 < inner.length) {
                const escaped = DOUBLE_QUOTE_ESCAPES[inner[i + 1]];
                cooked += escaped === undefined ? c + inner[i + 1] : escaped;
                i += 2;
                continue;
            }

            if (c === '{' && inner[i + 1] === '$') {
                const close = inner.indexOf('}', i + 2);
                const end = close === -1 ? inner.length : close;
                flush(i);
                expressions.push(this.embedded(inner.slice(i + 1, end), base + i + 1));
                i = end + 1;
                chunkStart = i;
                continue;
            }

            if (c === '$' && /[A-Za-z_]/.test(inner[i + 1] ?? '')) {
                const found = /^\$[A-Za-z_]\w*(?:->[A-Za-z_]\w*|\[[^\]]*\])?/.exec(inner.slice(i));
                flush(i);
                expressions.push(this.embedded(found[0], base + i));
                i += found[0].length;
                chunkStart = i;
                continue;
            }

            cooked += c;
            i++;
        }

        if (expressions.length === 0) {
            return this.node('Literal', token.start, token.end, { value: cooked, raw: token.value });
        }

        flush(inner.length);
        quasis[quasis.length - 1].tail = true;

        return this.node('TemplateLiteral', token.start, token.end, { quasis, expressions });
    }

    /** `$name` inside a string is the variable; anything longer is opaque. */
    embedded(text, start) {
        if (/^\$[A-Za-z_]\w*$/.test(text)) {
            return this.node('Identifier', start, start + text.length, { name: text });
        }

        return this.opaque(start, start + text.length);
    }

    /**
     * `'a ' . $b . ' c'` as one TemplateLiteral, so the walker keeps a class glued
     * to a variable (`'bg-' . $tone`) dynamic rather than reading "bg-".
     */
    template(parts) {
        const quasis = [];
        const expressions = [];
        let cooked = '';
        let chunkStart = parts[0].range[0];
        let chunkEnd = chunkStart;

        const push = (end, tail = false) => {
            const from = chunkStart - this.offset;
            quasis.push(this.node('TemplateElement', from, end - this.offset, { value: { raw: cooked, cooked }, tail }));
            cooked = '';
        };

        for (const part of parts) {
            if (part.type === 'Literal' && (typeof part.value === 'string' || typeof part.value === 'number')) {
                if (cooked === '') {
                    chunkStart = part.range[0];
                }

                cooked += String(part.value);
                chunkEnd = part.range[1];
                continue;
            }

            if (part.type === 'TemplateLiteral') {
                part.quasis.forEach((quasi, index) => {
                    if (cooked === '') {
                        chunkStart = quasi.range[0];
                    }

                    cooked += quasi.value.cooked;
                    chunkEnd = quasi.range[1];

                    if (index < part.expressions.length) {
                        push(chunkEnd);
                        expressions.push(part.expressions[index]);
                        chunkStart = part.expressions[index].range[1];
                        chunkEnd = chunkStart;
                    }
                });
                continue;
            }

            push(chunkEnd);
            expressions.push(part);
            chunkStart = part.range[1];
            chunkEnd = chunkStart;
        }

        push(chunkEnd, true);

        return this.node(
            'TemplateLiteral',
            parts[0].range[0] - this.offset,
            parts[parts.length - 1].range[1] - this.offset,
            { quasis, expressions },
        );
    }
}

function setParents(node, parent) {
    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            setParents(item, parent);
        }

        return;
    }

    if (typeof node.type !== 'string') {
        return;
    }

    node.parent = parent;

    for (const [key, value] of Object.entries(node)) {
        if (key !== 'parent' && key !== 'loc' && key !== 'range' && typeof value === 'object') {
            setParents(value, node);
        }
    }
}

function opaqueOver(text, offset, locator) {
    const from = offset;
    const to = offset + text.length;

    return { type: 'PhpExpression', text, range: [from, to], loc: locator.loc(from, to) };
}

/**
 * Parses one PHP expression. `offset` is where `text` starts in the Blade file.
 * Never throws; an unreadable expression is one opaque node.
 */
export function parsePhpExpression(text, offset, locator) {
    const tokens = tokenizePhp(text);

    if (tokens.length === 0) {
        return null;
    }

    const parser = new ExpressionParser(tokens, text, offset, locator);
    let node;

    try {
        node = parser.parseExpression();

        if (parser.token !== undefined) {
            node = parser.opaque(tokens[0].start, tokens[tokens.length - 1].end);
        }
    } catch (error) {
        if (error !== BAIL) {
            throw error;
        }

        node = opaqueOver(text, offset, locator);
    }

    setParents(node, null);

    return node;
}

function nodeAt(type, start, end, offset, locator, props) {
    return { type, range: [offset + start, offset + end], loc: locator.loc(offset + start, offset + end), ...props };
}

/** `$x = …`: the variable and how many tokens the target and the `=` take. */
function variableTarget(statement, text, offset, locator) {
    const [target, operator] = statement;

    if (statement.length < 3 || target.type !== 'variable' || operator?.type !== 'op' || operator.value !== '=') {
        return null;
    }

    return {
        id: nodeAt('Identifier', target.start, target.end, offset, locator, { name: target.value }),
        start: target.start,
        consumed: 2,
    };
}

/**
 * `[$a, $b] = …` and `list($a, $b) = …`: an ArrayPattern, which the walker
 * follows slot by slot (`$b` is element 1 of whatever the right side holds).
 * A keyed or nested pattern is left alone.
 */
function destructuringTarget(statement, text, offset, locator) {
    const [first] = statement;
    let open = 0;

    if (first?.type === 'op' && first.value === '[') {
        open = 0;
    } else if (first?.type === 'name' && first.value.toLowerCase() === 'list' && statement[1]?.value === '(') {
        open = 1;
    } else {
        return null;
    }

    const closeValue = statement[open].value === '[' ? ']' : ')';
    const elements = [];
    let i = open + 1;

    for (; i < statement.length; i++) {
        const token = statement[i];

        if (token.type === 'op' && token.value === closeValue) {
            break;
        }

        if (token.type === 'op' && token.value === ',') {
            if (statement[i - 1]?.value === ',' || statement[i - 1]?.value === '[' || statement[i - 1]?.value === '(') {
                elements.push(null);
            }

            continue;
        }

        if (token.type !== 'variable') {
            return null;
        }

        elements.push(nodeAt('Identifier', token.start, token.end, offset, locator, { name: token.value }));
    }

    const close = statement[i];
    const operator = statement[i + 1];

    if (close === undefined || operator?.type !== 'op' || operator.value !== '=' || statement.length < i + 3) {
        return null;
    }

    const id = nodeAt('ArrayPattern', first.start, close.end, offset, locator, { elements });

    for (const element of elements) {
        if (element !== null) {
            element.parent = id;
        }
    }

    return { id, start: first.start, consumed: i + 2 };
}

/**
 * `$x = expr;` and `[$a, $b] = expr;` statements of a PHP block as `const`
 * declarations, so a class string assigned in `@php` resolves one hop away in
 * the template, the way a `<script setup>` constant does in Vue. Other
 * statements are ignored.
 */
export function parsePhpAssignments(text, offset, locator) {
    const statements = [];
    let current = [];
    let depth = 0;

    for (const token of tokenizePhp(text)) {
        if (token.type === 'op') {
            if (token.value === '(' || token.value === '[' || token.value === '{') {
                depth++;
            } else if (token.value === ')' || token.value === ']' || token.value === '}') {
                depth = Math.max(0, depth - 1);

                // A block (`if (...) { ... }`) ends at its brace, with no semicolon.
                if (token.value === '}' && depth === 0) {
                    current.push(token);
                    statements.push(current);
                    current = [];
                    continue;
                }
            } else if (token.value === ';' && depth === 0) {
                statements.push(current);
                current = [];
                continue;
            }
        }

        current.push(token);
    }

    statements.push(current);

    const declarations = [];

    for (const statement of statements) {
        const target = destructuringTarget(statement, text, offset, locator) ?? variableTarget(statement, text, offset, locator);

        if (target === null) {
            continue;
        }

        const rhs = statement.slice(target.consumed);
        const parser = new ExpressionParser(rhs, text, offset, locator);
        let init;

        try {
            init = parser.parseExpression();

            if (parser.token !== undefined) {
                init = parser.opaque(rhs[0].start, rhs[rhs.length - 1].end);
            }
        } catch (error) {
            if (error !== BAIL) {
                throw error;
            }

            init = parser.opaque(rhs[0].start, rhs[rhs.length - 1].end);
        }

        const id = target.id;
        const declarator = parser.node('VariableDeclarator', target.start, init.range[1] - offset, { id, init });
        const declaration = parser.node('VariableDeclaration', target.start, init.range[1] - offset, {
            kind: 'const',
            declarations: [declarator],
        });
        setParents(declaration, null);
        declarations.push(declaration);
    }

    return declarations;
}

/**
 * `$attributes->class([...])->merge(['class' => ...])` as the object a Vue
 * `v-bind="{ class: ... }"` spread carries: the walker then reads the `class`
 * key as a class site. A bag that sets no class is the bare identifier, which
 * the walker leaves alone.
 */
export function parseAttributesBag(text, offset, locator) {
    const tokens = tokenizePhp(text);
    const [first] = tokens;

    if (first?.type !== 'variable' || first.value !== '$attributes') {
        return parsePhpExpression(text, offset, locator);
    }

    const parser = new ExpressionParser(tokens, text, offset, locator);
    const properties = [];
    let classValue = null;
    let classToken = null;
    parser.advance();

    try {
        while (parser.at('->') || parser.at('?->')) {
            parser.advance();
            const method = parser.advance();

            if (method.type !== 'name' || !parser.at('(')) {
                break;
            }

            const args = parser.parseArguments();

            if (method.value === 'class' && args[0]) {
                classValue = args[0];
                classToken = method;
            } else if (method.value === 'merge' && args[0]?.type === 'ObjectExpression') {
                properties.push(...args[0].properties);
            }
        }
    } catch (error) {
        if (error !== BAIL) {
            throw error;
        }

        return opaqueOver(text, offset, locator);
    }

    if (classValue !== null) {
        const key = parser.node('Literal', classToken.start, classToken.end, { value: 'class', raw: 'class' });
        properties.push(parser.node('Property', classToken.start, classValue.range[1] - offset, {
            key,
            value: classValue,
            computed: false,
            kind: 'init',
            method: false,
            shorthand: false,
        }));
    }

    const node = properties.length === 0
        ? parser.node('Identifier', first.start, first.end, { name: '$attributes' })
        : parser.node('ObjectExpression', first.start, tokens[tokens.length - 1].end, { properties });

    setParents(node, null);

    return node;
}
