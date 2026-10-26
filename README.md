# @itscark/shadcn-lint-blade

An ESLint parser that lets [`@shadcn/lint`](https://github.com/shadcn-ui/lint) lint Laravel Blade
views, Livewire single-file components and Flux markup. The plugin's own rules, options, messages
and editor suggestions run unchanged; there is no fork of the plugin.

`@shadcn/lint` reads JSX, Vue and Svelte, and it picks its template reader from the parser's
services: a parser that offers `defineTemplateBodyVisitor` gets the Vue reader. This parser builds
exactly the AST that reader walks (`VElement`, `VAttribute`, `VLiteral`, `VExpressionContainer`
holding ESTree) from a Blade file. It was built against the Vue reader of `@shadcn/lint` 0.2.3; a
plugin release that changes that reader may need a release here.

## Install

The package is not on npm. Install it from GitHub, pinned to a tag:

```bash
npm install --save-dev eslint @shadcn/lint github:itscark/shadcn-lint-blade#v0.1.0
```

## Usage

```js
// eslint.config.mjs
import { plugin as shadcn } from '@shadcn/lint';
import { defineConfig } from 'eslint/config';
import * as blade from '@itscark/shadcn-lint-blade';

export default defineConfig([
    {
        files: ['**/*.blade.php'],
        languageOptions: { parser: blade },
        plugins: { shadcn },
        rules: {
            'shadcn/no-raw-colors': 'error',
            'shadcn/no-arbitrary-values': ['error', { allow: ['layout'] }],
            'shadcn/no-inline-styles': 'error',
            'shadcn/no-unknown-classes': 'warn',
        },
    },
]);
```

```bash
npx eslint resources/views
```

A Blade comment is an ESLint directive comment, inside a tag's attribute list too:
`{{-- eslint-disable-next-line shadcn/no-inline-styles -- why --}}`. HTML comments are not
directives; they ship to the browser.

## What it reads

| Blade | AST handed to the Vue reader |
| --- | --- |
| `class="p-4"` | `VAttribute` + `VLiteral` whose range includes the quotes, so markup suggestions rewrite inside them |
| `class="mt-2 {{ $x ? 'a' : '' }}"` | `v-bind:class` with a `TemplateLiteral`: text chunks are classes, each echo a hole |
| `@class([...])` | `v-bind:class` with the array; keyed entries' keys are classes |
| `:class="…"` on `<x-*>`, `<flux:*>`, `<livewire:*>` | `v-bind:class`, value parsed as PHP |
| `:class="…"` on a plain element, `x-bind:class`, `::class` | `v-bind:class`, value parsed as JavaScript (Alpine) |
| `{{ $attributes->class([...])->merge(['class' => …]) }}` in a tag | `v-bind="{ class: … }"` spread; a bag that sets no class is left alone |
| `style="…"`, `:style`, `@style([...])` | the same, as `style` |
| `@php $x = …; @endphp`, `@php($x = …)`, `<?php $x = …; ?>`, `[$a, $b] = …` | `const $x = …` (or `const [$a, $b] = …`) in `Program.body`, resolved one hop from the template |
| `match ($v) { 'a' => '…', default => '…' }` | a chain of `ConditionalExpression`s: every arm's value is read, the conditions stay opaque |
| `{{-- … --}}` | a `Block` comment, so ESLint directive comments work |
| `<flux:badge>` | `rawName` kebab-cased (`flux-badge`), so it counts as a component and `color="red"` is a prop |
| echoes in text, control directives, `<!-- -->`, the `<?php new class … ?>` block of a Livewire SFC | skipped |

PHP the walker cannot use (a method call, a comparison, a closure) becomes one opaque
`PhpExpression` node, which the plugin reports as dynamic and never guesses at. Malformed markup
never throws: the tree is as good as the markup allows.

## Limits

- `no-restyle` and `require-static-classes` report nothing on Blade. They act on a design-system
  component resolved from the exports of `.tsx/.jsx/.ts/.js/.vue/.svelte` files, and a Blade or
  Flux component has no export. Configuring them reads as coverage that does not exist.
- `no-unknown-classes` builds the theme from your stylesheet's full import graph. If that graph
  imports Flux's CSS from `vendor/`, install the PHP dependencies before linting; otherwise the
  plugin warns once and answers from its bundled grammar, which knows fewer classes.
- Classes passed as data are not followed: `@include('x', ['class' => …])`, `@props` defaults,
  `<x-foo class="…">` forwarded into the component's root.
- Blade inside `<script>` and plain CSS are outside the rules, as they are for Vue.
- The plugin offers suggestions only; `--fix` applies nothing.

## How it works

Notes for changing the parser; each one cost a debugging session.

- **Component tags are kebab-cased.** The Vue reader decides "component" from `rawName`'s spelling
  (a dash, a dot or a capital). `<flux:badge>` has none, so its `color="red"` read as a hard-coded
  SVG paint. Component tags are handed over with `:`/`::` replaced by `-` (`flux-badge`,
  `x-mail-message`); `name` keeps the real tag for matching the close tag. A message placeholder
  `{{component}}` therefore shows the kebab spelling.
- **A colon attribute is PHP or Alpine.** Blade compiles `:prop="…"` only on component tags; on a
  plain element `:class` is Alpine's `x-bind:` shorthand and the value is JavaScript, parsed with
  espree. `x-bind:` and `::` are JavaScript on every tag. A value that does not parse in its
  language becomes one opaque node.
- **The template is walked once, from `Program:exit`.** ESLint and eslint-scope descend only
  through the visitor keys (`Program: ["body"]`), so `templateBody` is invisible to both. Every
  rule's template visitors join one registry and the first rule's `Program:exit` walks the tree,
  dispatching type selectors and their `:exit` form, the only selectors the plugin uses. Every node
  carries `range`, `loc` and `parent`: `getText`, `report` and `getScope` read them, and the
  reader's `elementOf(attribute)` is `attribute.parent.parent`.
- **`@php` assignments are `const` declarations.** ESLint's own scope analysis then lets the plugin
  follow `$x` from the template, the one hop a Vue `<script setup>` constant gets. A block
  statement ends at its `}`: without that, the assignment after an `if (…) { … }` is lost.
- **Concatenation is a template literal.** `'bg-' . $tone` keeps `$tone` in a hole, so the glued
  chunk is dropped as a class rather than read as `bg-`. Flattening it would let half-classes pass.
- **Opaque means unchecked.** `match` used to be one opaque node and a list destructuring was not
  declared, so the classes inside both went unreported and the lint looked clean. Any PHP shape
  that can carry a class string and reads as opaque is a silent blind spot; the only guard is a
  test that expects a finding from inside it.

## Tests

```bash
npm test
```

`test/parser.test.mjs` lints through ESLint's `Linter` and the plugin against
`test/fixtures/project`, a project of its own so the plugin discovers that theme.

## License

MIT
