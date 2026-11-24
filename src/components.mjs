/**
 * Stand-ins for Blade components, so @shadcn/lint can tell which tag is one.
 *
 * `no-restyle` and `require-static-classes` act on a design-system component, which the plugin finds as
 * a file in its `ui` directory: .tsx, .jsx, .ts, .js, .vue or .svelte. A Blade component has none.
 * bladeComponents() writes one small .vue file per component view, named like the tag the parser hands
 * over (`x-card.vue` for <x-card>, `flux-table-cell.vue` for <flux:table.cell>), and returns the
 * directory to give `settings.shadcn.ui`.
 *
 *   // eslint.config.mjs
 *   import { bladeComponents } from '@itscark/shadcn-lint-blade/components'
 *   const ui = bladeComponents([
 *       { prefix: 'x', dir: 'resources/views/components' },
 *       { prefix: 'x-acme', dir: 'packages/acme/resources/views/components' }, // <x-acme::card>
 *       { prefix: 'flux', dir: 'vendor/livewire/flux/stubs/resources/views/flux' },
 *   ])
 *   { settings: { shadcn: { ui } } }
 */

import fs from 'node:fs';
import path from 'node:path';

const VIEW = '.blade.php';

/** The .blade.php files below `dir`, as their path segments without the extension. */
function viewsIn(dir, parents = []) {
    const views = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) {
            views.push(...viewsIn(path.join(dir, entry.name), [...parents, entry.name]));
        } else if (entry.name.endsWith(VIEW)) {
            views.push({ file: path.join(dir, entry.name), segments: [...parents, entry.name.slice(0, -VIEW.length)] });
        }
    }

    return views;
}

/**
 * The component tag of every view below `dir`, spelled the way the parser hands it to the plugin:
 * the prefix and the path joined by dashes. `index.blade.php` and a file named like its directory
 * stand for the directory, as they do in Blade.
 *
 * @returns {{ tag: string, file: string }[]}
 */
export function componentTags(dir, prefix) {
    return viewsIn(dir).flatMap(({ file, segments }) => {
        const last = segments.at(-1);
        const kept = last === 'index' || last === segments.at(-2) ? segments.slice(0, -1) : segments;

        return kept.length === 0 ? [] : [{ tag: [prefix, ...kept].join('-'), file }];
    });
}

/**
 * Writes the stubs and returns the directory holding them.
 *
 * @param {{ prefix: string, dir: string }[]} roots  `prefix` is the tag up to the component's own name:
 *   `x`, `x-acme` for <x-acme::card>, `flux`. `dir` is where its views live.
 * @param {{ cwd?: string, outDir?: string }} [options]  `outDir` defaults to
 *   `node_modules/.cache/shadcn-lint-blade/components` below `cwd`, which is the current directory.
 */
export function bladeComponents(roots, { cwd = process.cwd(), outDir } = {}) {
    const target = path.resolve(cwd, outDir ?? 'node_modules/.cache/shadcn-lint-blade/components');
    const stubs = new Map();

    for (const { prefix, dir } of roots) {
        const root = path.resolve(cwd, dir);

        // A mistyped directory would leave its components unchecked without a word.
        if (!fs.existsSync(root)) {
            throw new Error(`@itscark/shadcn-lint-blade: the components directory ${root} does not exist.`);
        }

        for (const { tag, file } of componentTags(root, prefix)) {
            if (!stubs.has(tag)) {
                const view = path.relative(cwd, file).split(path.sep).join('/');

                stubs.set(`${tag}.vue`, `<!-- Stands in for ${view} so @shadcn/lint knows the component. Written by @itscark/shadcn-lint-blade; edits are overwritten. -->\n<template><div><slot /></div></template>\n`);
            }
        }
    }

    fs.mkdirSync(target, { recursive: true });

    for (const name of fs.readdirSync(target)) {
        if (name.endsWith('.vue') && !stubs.has(name)) {
            fs.rmSync(path.join(target, name));
        }
    }

    for (const [name, content] of stubs) {
        const file = path.join(target, name);

        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
            fs.writeFileSync(file, content);
        }
    }

    return target;
}
