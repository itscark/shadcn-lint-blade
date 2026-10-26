import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import { plugin as shadcn } from '@shadcn/lint';

import * as blade from '../src/parser.mjs';

// A project of its own, so @shadcn/lint discovers this theme's tokens
// (zinc, brand, accent) rather than any stylesheet around the checkout.
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/project');
const PAGE = path.join(FIXTURE, 'resources/views/page.blade.php');

const RULES = {
    'shadcn/no-raw-colors': 'error',
    'shadcn/no-arbitrary-values': 'error',
    'shadcn/no-inline-styles': ['error', { allow: ['display'] }],
};

function lint(code, rules = RULES) {
    const linter = new Linter({ cwd: FIXTURE });

    return linter.verify(code, [{
        files: ['**/*.blade.php'],
        languageOptions: { parser: blade },
        plugins: { shadcn },
        rules,
    }], { filename: PAGE });
}

/** One line per finding: rule, position, and the quoted class or the message's first clause. */
function found(code, rules) {
    return lint(code, rules).map((message) => {
        const subject = /^"([^"]+)"/.exec(message.message)?.[1] ?? message.message.split(/[.:]/)[0];

        return `${message.ruleId ?? 'fatal'} ${message.line}:${message.column} ${subject}`;
    });
}

test('runs @shadcn/lint over a Livewire single-file component through its Vue reader', () => {
    const code = `<?php
use Livewire\\Component;
new class extends Component {
    public string $tone = 'red';
}; ?>

<div class="bg-pink-500 p-[13px] text-zinc-500 bg-accent" style="display: none; color: red">
    @if ($tone === 'red')
        {{ __('messages.title') }}
    @endif
</div>
`;

    assert.deepEqual(found(code), [
        'shadcn/no-raw-colors 7:12 bg-pink-500',
        'shadcn/no-arbitrary-values 7:12 p-[13px]',
        'shadcn/no-inline-styles 7:65 Inline style sets color',
    ]);
});

test('reads every Blade class channel: @class, :class as PHP, Alpine :class and x-bind:class, echoes in class', () => {
    const code = `<flux:button :class="$flush ? 'p-0! bg-red-500' : ''" @class(['font-medium', 'text-amber-900' => $tone === 'amber'])>x</flux:button>
<span :class="{ 'bg-blue-500': open }" x-bind:class="dirty ? '' : 'rounded-[3px]'">y</span>
<a class="mt-2 {{ $active ? 'bg-emerald-500' : '' }}">z</a>
`;

    assert.deepEqual(found(code), [
        'shadcn/no-raw-colors 1:31 bg-red-500',
        'shadcn/no-raw-colors 1:78 text-amber-900',
        'shadcn/no-raw-colors 2:17 bg-blue-500',
        'shadcn/no-arbitrary-values 2:67 rounded-[3px]',
        'shadcn/no-raw-colors 3:29 bg-emerald-500',
    ]);
});

test('follows a class string assigned in @php one hop into {{ $attributes->class() }}', () => {
    const code = `@php
    $classes = 'block w-full ' . 'text-[#706f6c]';
@endphp
<a {{ $attributes->class($classes) }}>z</a>
`;

    assert.deepEqual(found(code), ['shadcn/no-arbitrary-values 2:16 text-[#706f6c]']);
});

test('a class merged through $attributes->merge() is a class site too', () => {
    const code = `<div {{ $attributes->merge(['class' => 'p-4 bg-pink-500']) }}></div>`;

    assert.deepEqual(found(code), ['shadcn/no-raw-colors 1:40 bg-pink-500']);
});

test('a Blade comment is an ESLint directive comment', () => {
    const code = `{{-- eslint-disable-next-line shadcn/no-raw-colors -- the one legacy tint --}}
<div class="bg-pink-500"></div>
<div class="bg-pink-500"></div>
`;

    assert.deepEqual(found(code), ['shadcn/no-raw-colors 3:12 bg-pink-500']);
});

test('suggestions rewrite the class inside the markup or the PHP string, quotes intact', () => {
    const code = `<div class="p-[13px]"></div>
<a class="mt-2 {{ $active ? 'bg-emerald-500' : '' }}">z</a>
`;
    const [arbitrary, color] = lint(code);

    assert.equal(arbitrary.suggestions[0].fix.text, '"p-3.25"');
    assert.equal(code.slice(...arbitrary.suggestions[0].fix.range), '"p-[13px]"');
    assert.equal(color.suggestions[0].fix.text, "'bg-brand'");
    assert.equal(code.slice(...color.suggestions[0].fix.range), "'bg-emerald-500'");
});

test('color="red" on a Flux component is a prop, not an SVG paint attribute', () => {
    const code = `<flux:badge color="red">x</flux:badge>
<flux:callout color="green" />
<svg><rect fill="red" /></svg>
`;

    assert.deepEqual(found(code), ['shadcn/no-raw-colors 3:12 fill="red" hardcodes a color']);
});

test('an inline style on a component and a dynamic :style are judged like Vue', () => {
    const code = `<flux:card style="padding: 4px"></flux:card>
<div :style="'width: ' + progress + '%'"></div>
<div :style="dark ? 'filter: invert(1)' : ''"></div>
`;

    assert.deepEqual(found(code), [
        'shadcn/no-inline-styles 1:18 Inline style sets padding',
        'shadcn/no-inline-styles 2:14 Dynamic style object cannot be checked',
        'shadcn/no-inline-styles 3:21 Inline style sets filter',
    ]);
});

test('declared tokens, allowed families and layout values pass', () => {
    const code = `<div class="text-zinc-500 bg-accent border-brand text-red-600 dark:text-red-400 md:w-[26rem] grid-cols-[auto_1fr]"></div>`;
    const rules = {
        'shadcn/no-raw-colors': ['error', { allow: ['*-red-*'] }],
        'shadcn/no-arbitrary-values': ['error', { allow: ['layout'] }],
    };

    assert.deepEqual(found(code, rules), []);
});

test('malformed markup never produces a fatal parse error', () => {
    for (const code of ['<div class="bg-pink-500', '<div @class([', '{{ $open', '<?php echo 1;', '']) {
        const fatal = lint(code).filter((message) => message.fatal);
        assert.deepEqual(fatal, [], code);
    }

    assert.deepEqual(found('<div class="bg-pink-500'), ['shadcn/no-raw-colors 1:12 bg-pink-500']);
});
