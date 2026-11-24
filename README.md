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

The package is not on npm. Install it from GitHub, pinned to a
[release](https://github.com/itscark/shadcn-lint-blade/releases) tag:

```bash
npm install --save-dev eslint @shadcn/lint github:itscark/shadcn-lint-blade#v0.2.0
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

**Keep JavaScript rules off Blade files.** A config object without `files`, such as
`js.configs.recommended`, also applies to `*.blade.php`; give it `files` or
`ignores: ['**/*.blade.php']`. Core rules see only the `@php` assignments, without tokens and
without the template that uses them: `no-unused-vars` reports every `@php` variable, `no-undef`
every variable the controller passes in, and some rules throw.

A Blade comment is an ESLint directive comment, inside a tag's attribute list too:
`{{-- eslint-disable-next-line shadcn/no-inline-styles -- why --}}`. HTML comments are not
directives; they ship to the browser.

## Components: `no-restyle` and `require-static-classes`

These two rules act on a design-system component, which the plugin finds as a file in its `ui`
directory (`.tsx`, `.ts`, `.jsx`, `.js`, `.vue`, `.svelte`). A Blade component has none, so they
report nothing until `bladeComponents()` writes a stand-in `.vue` file per component view and
`settings.shadcn.ui` points at them:

```js
import { bladeComponents } from '@itscark/shadcn-lint-blade/components';

const ui = bladeComponents([
    { prefix: 'x', dir: 'resources/views/components' }, // <x-card>, <x-forms.input>
    { prefix: 'x-acme', dir: 'packages/acme/resources/views/components' }, // <x-acme::card>
    { prefix: 'flux', dir: 'vendor/livewire/flux/stubs/resources/views/flux' }, // <flux:table.cell>
]);

export default defineConfig([
    {
        files: ['**/*.blade.php'],
        languageOptions: { parser: blade },
        plugins: { shadcn },
        settings: { shadcn: { ui } },
        rules: {
            'shadcn/no-restyle': ['error', { allow: ['layout'] }],
            'shadcn/require-static-classes': 'error',
        },
    },
]);
```

`prefix` is the tag up to the component's own name: `x`, `x-acme` for `<x-acme::card>`, `flux`. The
view's path follows, joined by dashes; `index.blade.php` and a file named like its directory
(`panel/panel.blade.php`) stand for the directory. The stubs go to
`node_modules/.cache/shadcn-lint-blade/components`; `{ outDir }` moves them. Every run of the config
rewrites them and deletes the `.vue` files whose view is gone. A `dir` that does not exist throws, so a
typo cannot switch the rules off unnoticed.

The plugin names a component after its stub: `<x-acme::card>` is `XAcmeCard`, so its contract is
`{ pattern: '^XAcmeCard$', allow: [...] }`, and a message says where to add a variant: in the stub. The
stubs hold no variants or sizes. Every component owns its appearance, spacing and shape, and `allow` and
`contracts` open what a page may pass it.

Point these rules at the code that uses components, not at the views of the design system itself:
`no-restyle` is off inside the component directory, as the plugin's docs say.

## What it reads

| Blade | AST handed to the Vue reader |
| --- | --- |
| `class="p-4"` | `VAttribute` + `VLiteral` whose range includes the quotes, so markup suggestions rewrite inside them |
| `class="mt-2 {{ $x ? 'a' : '' }}"` | `v-bind:class` with a `TemplateLiteral`: text chunks are classes, each echo a hole |
| `@class([...])` | `v-bind:class` with the array; keyed entries' keys are classes |
| `:class="…"` on `<x-*>`, `<flux:*>`, `<livewire:*>` | `v-bind:class`, value parsed as PHP |
| `:class="…"` on a plain element, `x-bind:class`, `::class` | `v-bind:class`, value parsed as JavaScript (Alpine) |
| `{{ $attributes->class([...])->merge(['class' => …]) }}` in a tag, a slot's `{{ $heading->attributes->class(…) }}` | `v-bind="{ class: … }"` spread; a bag that sets no class is left alone |
| `style="…"`, `:style`, `@style([...])` | the same, as `style` |
| `@php $x = …; @endphp`, `@php($x = …)`, `<?php $x = …; ?>`, `[$a, $b] = …` | `const $x = …` (or `const [$a, $b] = …`) in `Program.body`, resolved one hop from the template |
| `$x = …; $x .= …; if (…) { $x = …; }` | one `const $x` whose value is every assignment, joined by `\|\|` |
| `match ($v) { 'a' => '…', default => '…' }` | a chain of `ConditionalExpression`s: every arm's value is read, the conditions stay opaque |
| `{{-- … --}}` | a `Block` comment, so ESLint directive comments work |
| `<flux:badge>`, `<x-forms.input>` | `rawName` kebab-cased (`flux-badge`, `x-forms-input`), so it counts as a component and `color="red"` is a prop |
| echoes in text, control directives, `<!-- -->`, the `<?php new class … ?>` block of a Livewire SFC | skipped |

PHP the walker cannot use (a method call, a comparison, a closure) becomes one opaque
`PhpExpression` node, which the plugin reports as dynamic and never guesses at. Malformed markup
never throws: the tree is as good as the markup allows.

## Limits

- `no-restyle` and `require-static-classes` report nothing on Blade until its components have stubs
  (see [Components](#components-no-restyle-and-require-static-classes)): the plugin resolves a
  design-system component from `.tsx/.jsx/.ts/.js/.vue/.svelte` files, and a Blade or Flux component
  has none. Configured without stubs they read as coverage that does not exist. With them, a component
  has no variants or sizes to suggest, and `<livewire:*>` tags have no stub.
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
  SVG paint. Component tags are handed over with `:`, `::` and `.` replaced by `-` (`flux-badge`,
  `x-mail-message`, `x-forms-input`); `name` keeps the real tag for matching the close tag. A dot would
  read as a member of a namespace, and a stub file in `components.mjs` is found by this name. A message
  placeholder `{{component}}` therefore shows the kebab spelling.
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
  follow `$x` from the template, the one hop a Vue `<script setup>` constant gets. The plugin
  reads a variable from its first declaration only, so a variable gets one `const` across all PHP
  blocks, holding every value assigned to it joined by `||`.
- **A control block is opened, any other brace is not.** The statements inside `if`, `switch` or
  `foreach` braces are read on their own. The brace of a `match` or a closure belongs to an
  expression, which runs on to its `;`; a function or class body is skipped.
- **Concatenation is a template literal.** `'bg-' . $tone` keeps `$tone` in a hole, so the glued
  chunk is dropped as a class rather than read as `bg-`. Flattening it would let half-classes pass.
  A hole whose strings all bring their own space (`'p-4' . ($x ? ' flex' : '')`,
  `class="nav{{ $on ? ' active' : '' }}"`) glues nothing: the space moves into the neighbouring
  chunk's cooked text.
- **A bare `@word` in an attribute value is a directive.** `@else`, `@endif` and `@enderror` take
  no parentheses; left in the text they read as class names. `@container` is Tailwind's class and
  stays one.
- **Opaque means unchecked.** Any PHP shape that can carry a class string and reads as opaque is a
  silent blind spot; the only guard is a test that expects a finding from inside it. An array
  entry or `match` arm that cannot be read (a cast, `throw`) is opaque on its own, so the entries
  around it are still read.

## Tests

```bash
npm test
```

`test/parser.test.mjs` lints through ESLint's `Linter` and the plugin against
`test/fixtures/project`, a project of its own so the plugin discovers that theme.

## Releases

CI cuts the releases. Every push to `main` that passes the tests runs
[semantic-release](https://semantic-release.gitbook.io), which reads the
[Conventional Commits](https://www.conventionalcommits.org) since the last tag: `fix:` is a patch,
`feat:` a minor, a `BREAKING CHANGE:` footer a major. It commits the new version to
`package.json` and to the install line above, tags it `vX.Y.Z` and publishes a GitHub release
with the notes. A push without a `fix` or `feat` commit releases nothing.

## License

MIT
