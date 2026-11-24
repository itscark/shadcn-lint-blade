import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import { plugin as shadcn } from '@shadcn/lint';

import * as blade from '../src/parser.mjs';
import { bladeComponents, componentTags } from '../src/components.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/project');
const PAGE = path.join(FIXTURE, 'resources/views/page.blade.php');
const COMPONENTS = path.join(FIXTURE, 'resources/views/components');
const FLUX = path.join(FIXTURE, 'resources/views/flux');

const ROOTS = [
    { prefix: 'x', dir: COMPONENTS },
    { prefix: 'x-ui', dir: COMPONENTS },
    { prefix: 'flux', dir: FLUX },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadcn-lint-blade-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tagsOf = (components) => components.map(({ tag }) => tag).sort();

/** One line per finding: rule, line, and the quoted class or the message's first clause. */
function found(code, ui) {
    const linter = new Linter({ cwd: FIXTURE });
    const messages = linter.verify(code, [{
        files: ['**/*.blade.php'],
        languageOptions: { parser: blade },
        plugins: { shadcn },
        settings: { shadcn: { ui } },
        rules: {
            'shadcn/no-restyle': ['error', { allow: ['layout'] }],
            'shadcn/require-static-classes': 'error',
        },
    }], { filename: PAGE });

    return messages.map((message) => {
        const subject = /^"([^"]+)"/.exec(message.message)?.[1] ?? message.message.split(/[.:]/)[0];

        return `${message.ruleId ?? 'fatal'} ${message.line} ${subject}`;
    });
}

test('maps a component file to the tag the parser hands over', () => {
    // index.blade.php and a file named like its directory both stand for the directory.
    assert.deepEqual(tagsOf(componentTags(COMPONENTS, 'x')), ['x-card', 'x-forms-input', 'x-panel']);
    assert.deepEqual(tagsOf(componentTags(FLUX, 'flux')), ['flux-button', 'flux-table-cell']);
    assert.deepEqual(tagsOf(componentTags(COMPONENTS, 'x-ui')), ['x-ui-card', 'x-ui-forms-input', 'x-ui-panel']);
});

test('writes one stub per component and removes the ones that no longer have a view', () => {
    const outDir = path.join(tmp, 'stubs');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'x-gone.vue'), '<template><div /></template>');
    fs.writeFileSync(path.join(outDir, 'notes.txt'), 'not ours');

    assert.equal(bladeComponents(ROOTS, { outDir }), outDir);
    assert.deepEqual(fs.readdirSync(outDir).sort(), [
        'flux-button.vue', 'flux-table-cell.vue', 'notes.txt',
        'x-card.vue', 'x-forms-input.vue', 'x-panel.vue',
        'x-ui-card.vue', 'x-ui-forms-input.vue', 'x-ui-panel.vue',
    ]);
    assert.match(fs.readFileSync(path.join(outDir, 'x-card.vue'), 'utf8'), /resources\/views\/components\/card\.blade\.php/);
});

test('no-restyle reads a Blade component once it has a stub: layout passes, the rest does not', () => {
    const ui = bladeComponents(ROOTS, { outDir: path.join(tmp, 'restyle') });
    const code = [
        '<x-card class="mt-4 p-10">a</x-card>',
        '<x-forms.input class="rounded-full" />',
        '<x-ui::card class="p-10">b</x-ui::card>',
        '<flux:button class="p-10">c</flux:button>',
        '<flux:table.cell class="p-10">d</flux:table.cell>',
        '<div class="p-10">a plain element is nobody\'s component</div>',
        '<x-unknown class="p-10" />',
    ].join('\n');

    assert.deepEqual(found(code, ui), [
        'shadcn/no-restyle 1 p-10',
        'shadcn/no-restyle 2 rounded-full',
        'shadcn/no-restyle 3 p-10',
        'shadcn/no-restyle 4 p-10',
        'shadcn/no-restyle 5 p-10',
    ]);
});

test('require-static-classes reports a class it cannot read on a known component only', () => {
    const ui = bladeComponents(ROOTS, { outDir: path.join(tmp, 'static') });
    const code = '<x-card :class="$dynamic">a</x-card>\n<x-unknown :class="$dynamic" />\n';

    assert.deepEqual(found(code, ui), ['shadcn/require-static-classes 1 Dynamically built className on <XCard> cannot be checked']);
});

test('without a stub directory the rules stay silent on Blade components', () => {
    assert.deepEqual(found('<x-card class="p-10" :class="$dynamic">a</x-card>', undefined), []);
});
