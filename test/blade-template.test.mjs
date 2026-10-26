import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBladeTemplate } from '../src/blade-template.mjs';
import { createLocator } from '../src/source-locations.mjs';

/** Parses with a stand-in for the Alpine parser: an expression node carrying the text. */
function parse(source) {
    const locator = createLocator(source);
    const js = (text, offset) => ({ type: 'JsStub', text, range: [offset, offset + text.length], loc: locator.loc(offset, offset + text.length) });

    return parseBladeTemplate(source, { locator, js });
}

function elements(fragment) {
    const out = [];
    const walk = (node) => {
        for (const child of node.children) {
            out.push(child);
            walk(child);
        }
    };
    walk(fragment);

    return out;
}

function attribute(element, name) {
    return element.startTag.attributes.find((candidate) => {
        const key = candidate.key;

        return candidate.directive ? key.argument?.name === name : key.name === name;
    });
}

test('nests elements with parent links the way the Vue reader walks them', () => {
    const { fragment } = parse('<section class="a"><div class="b"><br><img src="x"/><span>t</span></div></section><p>after</p>');
    const [section, div, br, img, span, p] = elements(fragment);

    assert.deepEqual([section, div, br, img, span, p].map((element) => element.name), ['section', 'div', 'br', 'img', 'span', 'p']);
    assert.equal(div.parent, section);
    assert.equal(br.parent, div);
    assert.equal(span.parent, div);
    assert.equal(p.parent, fragment);
    // An attribute's grandparent is its element: reader.elementOf(node) = node.parent.parent.
    assert.equal(attribute(div, 'class').parent.parent, div);
    assert.equal(span.endTag.type, 'VEndTag');
});

test('a static class is a VLiteral whose range includes the quotes, as markup fixes expect', () => {
    const source = '<div class="p-4 bg-accent" data-x=unquoted hidden></div>';
    const { fragment } = parse(source);
    const [div] = elements(fragment);
    const klass = attribute(div, 'class');

    assert.equal(klass.directive, false);
    assert.equal(klass.key.name, 'class');
    assert.equal(klass.value.type, 'VLiteral');
    assert.equal(klass.value.value, 'p-4 bg-accent');
    assert.equal(source.slice(...klass.value.range), '"p-4 bg-accent"');
    assert.equal(attribute(div, 'data-x').value.value, 'unquoted');
    assert.equal(attribute(div, 'hidden').value, null);
});

test('a class with an echo inside is a bound TemplateLiteral: text chunks are classes, echoes are holes', () => {
    const source = `<a class="mt-2 {{ $active ? 'ring-2' : '' }} truncate" href="{{ route('x') }}">z</a>`;
    const { fragment } = parse(source);
    const klass = attribute(elements(fragment)[0], 'class');

    assert.equal(klass.directive, true);
    assert.equal(klass.key.name.name, 'bind');
    assert.equal(klass.value.type, 'VExpressionContainer');
    const template = klass.value.expression;
    assert.equal(template.type, 'TemplateLiteral');
    assert.deepEqual(template.quasis.map((quasi) => quasi.value.cooked), ['mt-2 ', ' truncate']);
    assert.equal(template.expressions[0].type, 'ConditionalExpression');
    assert.equal(source.slice(...template.expressions[0].consequent.range), "'ring-2'");
});

test('@class() is a bound class carrying the PHP array; @style() a style object by property', () => {
    const source = `<flux:card @class(['p-4', 'border-red-300' => $tone === 'red']) @style(['color: red' => $x, 'display: none'])>x</flux:card>`;
    const { fragment } = parse(source);
    const [card] = elements(fragment);
    const klass = attribute(card, 'class');
    const style = attribute(card, 'style');

    assert.equal(klass.value.expression.type, 'ArrayExpression');
    assert.equal(klass.value.expression.elements[1].properties[0].key.value, 'border-red-300');
    assert.equal(source.slice(...klass.range), "@class(['p-4', 'border-red-300' => $tone === 'red'])");
    assert.deepEqual(style.value.expression.properties.map((property) => [property.key.value, property.value.value]), [['color', 'red'], ['display', 'none']]);
});

test('a colon attribute is PHP on a component tag and Alpine JavaScript on a plain element', () => {
    const source = `<flux:button :class="$flush ? 'p-0!' : ''"><span :class="{ 'hidden': open }" x-bind:class="dirty ? '' : 'opacity-70'" ::class="alpineOnRoot"></span></flux:button>`;
    const { fragment } = parse(source);
    const [button, span] = elements(fragment);

    assert.equal(attribute(button, 'class').value.expression.type, 'ConditionalExpression');
    assert.equal(attribute(span, 'class').value.expression.type, 'JsStub');
    const bound = span.startTag.attributes.filter((candidate) => candidate.directive && candidate.key.argument?.name === 'class');
    assert.deepEqual(bound.map((candidate) => candidate.value.expression.text), ["{ 'hidden': open }", "dirty ? '' : 'opacity-70'", 'alpineOnRoot']);
});

test('{{ $attributes->class() }} inside a tag is a spread carrying class; other echoes there are skipped', () => {
    const source = `<div {{ $attributes->class(['inline-flex', 'gap-2']) }} {{ $open ? 'open' : '' }} data-test="x"></div>`;
    const { fragment } = parse(source);
    const [div] = elements(fragment);
    const [spread, dataTest] = div.startTag.attributes;

    assert.equal(div.startTag.attributes.length, 2);
    assert.equal(spread.directive, true);
    assert.equal(spread.key.argument, null);
    assert.equal(spread.value.expression.type, 'ObjectExpression');
    assert.equal(spread.value.expression.properties[0].key.value, 'class');
    assert.equal(dataTest.key.name, 'data-test');
});

test('Blade component tags are handed to the reader kebab-cased, so they count as components', () => {
    const { fragment } = parse('<flux:badge color="red"><x-layouts::app.sidebar><livewire:foo /><div></div></x-layouts::app.sidebar></flux:badge>');
    const [badge, layout, livewire, div] = elements(fragment);

    assert.equal(badge.rawName, 'flux-badge');
    assert.equal(badge.name, 'flux:badge');
    assert.equal(layout.rawName, 'x-layouts-app.sidebar');
    assert.equal(livewire.rawName, 'livewire-foo');
    assert.equal(div.rawName, 'div');
    assert.equal(div.parent, layout);
    assert.equal(badge.endTag.type, 'VEndTag');
});

test('the PHP block of a ⚡ component is skipped; @php assignments become declarations', () => {
    const source = `<?php
use Livewire\\Component;
new class extends Component {
    public string $tone = 'red';
}; ?>

@php
    $classes = 'block w-full';
@endphp
@php($fill = $sticky ? 'flex-1' : '')
<div></div>`;
    const { fragment, declarations } = parse(source);

    assert.deepEqual(declarations.map((declaration) => declaration.declarations[0].id.name), ['$classes', '$fill']);
    assert.equal(elements(fragment).length, 1);
    assert.equal(source.slice(...declarations[0].declarations[0].init.range), "'block w-full'");
});

test('Blade comments become Block comments for ESLint directives, inside and outside tags', () => {
    const source = `{{-- eslint-disable-next-line shadcn/no-raw-colors --}}\n<div {{-- note --}} class="a"></div>`;
    const { comments, fragment } = parse(source);

    assert.deepEqual(comments.map((comment) => [comment.type, comment.value]), [['Block', ' eslint-disable-next-line shadcn/no-raw-colors '], ['Block', ' note ']]);
    assert.equal(comments[0].loc.start.line, 1);
    assert.equal(attribute(elements(fragment)[0], 'class').value.value, 'a');
});

test('control directives, echoes in text, HTML comments and e-mail addresses are not markup', () => {
    const source = `@if ($x)\n  {{ $title }} mail@example.com <!-- <b class="no"> -->\n@else\n  <span class="yes"></span>\n@endif\n@foreach($items as $item) {{ $item }} @endforeach`;
    const { fragment } = parse(source);

    assert.deepEqual(elements(fragment).map((element) => element.name), ['span']);
});

test('script and style content is text, not markup, until the matching close tag', () => {
    const source = `<script>if (a < b) { el.innerHTML = '<div class="x">'; }</script><style>.a { color: red }</style><p class="y"></p>`;
    const { fragment } = parse(source);

    assert.deepEqual(elements(fragment).map((element) => element.name), ['script', 'style', 'p']);
    assert.equal(elements(fragment)[2].parent, fragment);
});

test('an Alpine @click attribute is an attribute; a Blade @checked() in the tag is a directive', () => {
    const source = `<input @click.prevent="go()" @keydown.enter="x" @checked($on) @disabled(fn () => $busy) class="a">`;
    const { fragment } = parse(source);
    const names = elements(fragment)[0].startTag.attributes.map((candidate) => candidate.key.name);

    assert.deepEqual(names, ['@click.prevent', '@keydown.enter', 'class']);
});

test('a quoted value steps over echoes and directive arguments that contain the quote', () => {
    const source = `<div title="{{ __("a") }}" data-x="@js(")") still" class="z"></div>`;
    const { fragment } = parse(source);
    const [div] = elements(fragment);

    assert.equal(attribute(div, 'class').value.value, 'z');
    assert.equal(attribute(div, 'title').value.expression.type, 'TemplateLiteral');
});

test('a stray close tag and unterminated markup degrade without throwing', () => {
    for (const source of ['</div><span class="a">', '<div class="unterminated', '<div @class([', '<a href="x', '{{ $open', '<?php echo 1;']) {
        assert.doesNotThrow(() => parse(source), source);
    }

    const { fragment } = parse('<ul><li>a<li>b</ul><p class="after"></p>');
    assert.equal(elements(fragment).at(-1).name, 'p');
    assert.equal(elements(fragment).at(-1).parent, fragment);
});
