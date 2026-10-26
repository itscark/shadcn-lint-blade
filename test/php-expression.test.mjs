import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAttributesBag, parsePhpAssignments, parsePhpExpression } from '../src/php-expression.mjs';
import { createLocator } from '../src/source-locations.mjs';

// Every expression is parsed as if it sat at this offset of a larger file, so
// the ranges below prove the rebasing, not just the shapes.
const OFFSET = 100;

function parse(text) {
    const source = ' '.repeat(OFFSET) + text;

    return parsePhpExpression(text, OFFSET, createLocator(source));
}

test('a single-quoted string is a Literal with its raw text and file range', () => {
    const node = parse("'p-4 bg-accent'");

    assert.equal(node.type, 'Literal');
    assert.equal(node.value, 'p-4 bg-accent');
    assert.equal(node.raw, "'p-4 bg-accent'");
    assert.deepEqual(node.range, [OFFSET, OFFSET + 15]);
    assert.equal(node.loc.start.column, OFFSET);
});

test('single-quoted escapes are resolved in the value and kept in the raw text', () => {
    const node = parse("'it\\'s \\\\ fine'");

    assert.equal(node.value, "it's \\ fine");
    assert.equal(node.raw, "'it\\'s \\\\ fine'");
});

test('a double-quoted string without interpolation is a Literal', () => {
    const node = parse('"mt-2\\tp-4"');

    assert.equal(node.type, 'Literal');
    assert.equal(node.value, 'mt-2\tp-4');
});

test('a double-quoted string interpolating a variable is a TemplateLiteral with the variable in its hole', () => {
    const node = parse('"p-4 $tone {$this->gap}"');

    assert.equal(node.type, 'TemplateLiteral');
    assert.deepEqual(node.quasis.map((quasi) => quasi.value.cooked), ['p-4 ', ' ', '']);
    assert.deepEqual(node.expressions.map((expression) => expression.type), ['Identifier', 'PhpExpression']);
    assert.equal(node.expressions[0].name, '$tone');
    assert.equal(node.quasis[2].tail, true);
});

test('a list array is an ArrayExpression of its values', () => {
    const node = parse("['p-4', 'rounded-lg']");

    assert.equal(node.type, 'ArrayExpression');
    assert.deepEqual(node.elements.map((element) => element.value), ['p-4', 'rounded-lg']);
});

test('an all-keyed array is an ObjectExpression with the classes as keys', () => {
    const node = parse("['font-medium' => true, 'text-red-800' => $tone === 'red']");

    assert.equal(node.type, 'ObjectExpression');
    assert.deepEqual(node.properties.map((property) => property.key.value), ['font-medium', 'text-red-800']);
    assert.deepEqual(node.properties.map((property) => property.computed), [false, false]);
    assert.equal(node.properties[1].value.type, 'PhpExpression');
});

test('a mixed array keeps the list shape and wraps each keyed entry as its own object', () => {
    const node = parse("['p-4', 'bg-red-50' => $danger]");

    assert.equal(node.type, 'ArrayExpression');
    assert.equal(node.elements[0].type, 'Literal');
    assert.equal(node.elements[1].type, 'ObjectExpression');
    assert.equal(node.elements[1].properties[0].key.value, 'bg-red-50');
});

test('a dynamic key is a computed property, which the walker treats as unreadable', () => {
    const node = parse("[$tone => true]");

    assert.equal(node.properties[0].computed, true);
    assert.equal(node.properties[0].key.type, 'Identifier');
});

test('a ternary becomes a ConditionalExpression with an opaque test and literal branches', () => {
    const node = parse("$surface === 'sticky' ? 'flex-1' : 'w-auto'");

    assert.equal(node.type, 'ConditionalExpression');
    assert.equal(node.test.type, 'PhpExpression');
    assert.equal(node.test.text, "$surface === 'sticky'");
    assert.equal(node.consequent.value, 'flex-1');
    assert.equal(node.alternate.value, 'w-auto');
});

test('the short ternary and null coalescing become LogicalExpressions', () => {
    assert.equal(parse("$size ?: 'size-5'").operator, '||');
    assert.equal(parse("$size ?? 'size-5'").operator, '??');
    assert.equal(parse("$size ?? 'size-5'").right.value, 'size-5');
});

test('concatenation is a TemplateLiteral so a class glued to a variable stays dynamic', () => {
    const node = parse("'block w-full ' . $extra . ' bg-' . $tone");

    assert.equal(node.type, 'TemplateLiteral');
    assert.deepEqual(node.quasis.map((quasi) => quasi.value.cooked), ['block w-full ', ' bg-', '']);
    assert.deepEqual(node.expressions.map((expression) => expression.name), ['$extra', '$tone']);
});

test('adjacent string parts of a concatenation merge into one chunk spanning both', () => {
    const node = parse("'p-4 ' . 'rounded'");

    assert.equal(node.type, 'TemplateLiteral');
    assert.equal(node.quasis.length, 1);
    assert.equal(node.quasis[0].value.cooked, 'p-4 rounded');
    assert.deepEqual(node.quasis[0].range, [OFFSET, OFFSET + 18]);
});

test('a match expression is a chain of conditionals: every arm value is read, the conditions stay opaque', () => {
    const node = parse("match ($variant) { 'danger' => 'bg-danger-surface', 'warning', 'amber' => 'bg-warning-surface', default => 'bg-zinc-100' }");

    assert.equal(node.type, 'ConditionalExpression');
    assert.equal(node.test.type, 'PhpExpression');
    assert.equal(node.test.text, "'danger' ");
    assert.equal(node.consequent.value, 'bg-danger-surface');
    assert.equal(node.alternate.type, 'ConditionalExpression');
    assert.equal(node.alternate.test.text, "'warning', 'amber' ");
    assert.equal(node.alternate.consequent.value, 'bg-warning-surface');
    assert.equal(node.alternate.alternate.value, 'bg-zinc-100');

    const noDefault = parse("match (true) { $x => 'a' }");
    assert.equal(noDefault.alternate.type, 'PhpExpression');
});

test('method calls, comparisons, closures and function calls are one opaque node', () => {
    for (const text of ["$errors->has('name')", "count($items) > 2", "fn ($x) => $x . 'a'", "__('messages.label')", 'Foo::BAR']) {
        const node = parse(text);
        assert.equal(node.type, 'PhpExpression', text);
        assert.equal(node.text, text);
    }
});

test('an unparsable expression is opaque as a whole and never throws', () => {
    const node = parse("['unterminated' => ");

    assert.equal(node.type, 'PhpExpression');
    assert.deepEqual(node.range, [OFFSET, OFFSET + "['unterminated' => ".length]);
    assert.equal(parse('   '), null);
});

test('children carry parent links, as the walker expects of ESTree', () => {
    const node = parse("['p-4' => $x]");

    assert.equal(node.properties[0].parent, node);
    assert.equal(node.properties[0].key.parent, node.properties[0]);
});

test('assignments in a PHP block become const declarations; other statements are ignored', () => {
    const php = "\n    $classes = 'block ' . 'w-full';\n    if ($x) { $y = 1; }\n    $fill = $sticky ? 'flex-1' : '';\n";
    const source = ' '.repeat(OFFSET) + php;
    const declarations = parsePhpAssignments(php, OFFSET, createLocator(source));

    assert.deepEqual(declarations.map((declaration) => declaration.declarations[0].id.name), ['$classes', '$fill']);
    assert.equal(declarations[0].kind, 'const');
    assert.equal(declarations[0].declarations[0].init.type, 'TemplateLiteral');
    assert.equal(declarations[1].declarations[0].init.type, 'ConditionalExpression');
    assert.equal(source.slice(...declarations[1].range), "$fill = $sticky ? 'flex-1' : ''");
    assert.equal(declarations[1].loc.start.line, 4);
});

test('a list destructuring becomes an ArrayPattern declaration the walker follows slot by slot', () => {
    const php = "[$label, $classes] = match ($env) { 'production' => ['Prod', 'bg-danger-surface'], default => ['Dev', 'bg-zinc-100'] };\nlist($a, , $c) = $parts;";
    const declarations = parsePhpAssignments(php, OFFSET, createLocator(' '.repeat(OFFSET) + php));

    assert.equal(declarations.length, 2);
    const [first, second] = declarations.map((declaration) => declaration.declarations[0]);
    assert.equal(first.id.type, 'ArrayPattern');
    assert.deepEqual(first.id.elements.map((element) => element.name), ['$label', '$classes']);
    assert.equal(first.id.elements[1].parent, first.id);
    assert.equal(first.init.type, 'ConditionalExpression');
    assert.equal(first.init.consequent.elements[1].value, 'bg-danger-surface');
    assert.deepEqual(second.id.elements.map((element) => element?.name ?? null), ['$a', null, '$c']);
});

test('$attributes->class() and ->merge() become the object a class spread carries', () => {
    const text = "$attributes->except('id')->class(['inline-flex', 'gap-2' => $gap])->merge(['class' => 'p-4', 'id' => 'x'])";
    const node = parseAttributesBag(text, OFFSET, createLocator(' '.repeat(OFFSET) + text));

    assert.equal(node.type, 'ObjectExpression');
    assert.deepEqual(node.properties.map((property) => property.key.value), ['class', 'id', 'class']);
    assert.equal(node.properties[2].value.type, 'ArrayExpression');
    assert.equal(node.properties[0].value.value, 'p-4');
});

test('a bag that sets no class stays the bare identifier, which the walker leaves alone', () => {
    for (const text of ['$attributes', "$attributes->except('class')", '$attributes->merge($dynamic)']) {
        const node = parseAttributesBag(text, OFFSET, createLocator(' '.repeat(OFFSET) + text));
        assert.equal(node.type, 'Identifier', text);
        assert.equal(node.name, '$attributes');
    }
});
