# Light and dark themes, and the shadcn component layer

The renderer has one palette with a light and a dark theme, and a set of shadcn-style component
primitives built on Tailwind CSS v4. Both themes are driven by the same tokens, so a screen that
uses the tokens is correct in either theme without a second stylesheet.

## Tokens

`src/renderer/src/tokens.css` holds everything theme-related:

- `@layer theme, base, components, utilities` establishes the cascade order, then Tailwind's theme
  and utility layers are imported. Tailwind's preflight is deliberately **not** imported, because
  `styles.css` already carries this application's element reset; the `base` layer adds only the
  border and button normalization that the component primitives rely on.
- `:root` defines the light palette and `.dark` the dark one, in oklch: `background`, `foreground`,
  `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `success`, `warning`,
  `border`, `input`, `ring`, `surface`, `overlay`, the `sidebar-*` group, and five chart colors.
- `@theme inline` maps each token to a Tailwind color so `bg-card`, `text-muted-foreground`,
  `border-border` and friends resolve to the active theme.

`src/renderer/src/styles.css` holds the hand-written rules that have not been rebuilt as components.
It no longer contains a single hard-coded color — every declaration reads a token — and the whole
file lives in `@layer components`, below Tailwind's `utilities` layer, so a utility class on an
element always wins over a legacy rule for the same property.

## Choosing a theme

`ThemeProvider` (`src/renderer/src/theme/`) keeps a preference of `light`, `dark` or `system`,
saved under `agent-matrix:theme` in localStorage and mirrored across windows through the `storage`
event. `system` follows `prefers-color-scheme` live. The resolved appearance toggles the `dark`
class on `<html>`, which switches both the token palette and every `dark:` utility, and sets
`color-scheme` so native controls and scrollbars match.

The toggle sits in the top bar and in **Settings → Appearance**. Storage that is unavailable or
blocked degrades to the system preference for the current window instead of failing.

The Electron window's `backgroundColor` follows `nativeTheme.shouldUseDarkColors`. That is the
pre-paint color only: the renderer applies the saved preference as soon as it loads, so a window
opened while the operating system is light and the preference is dark flashes light once.

## Components

`src/renderer/src/components/ui/` contains the shadcn primitives: `button` (with `buttonVariants`
for elements that must stay plain tags), `card`, `badge`, `input` (with `Textarea` and a native
`Select`), `label`, `separator`, `alert`, `skeleton`, `tabs`, and `dropdown-menu`. `cn()` in
`src/renderer/src/lib/utils.ts` merges classes.

Shared form fields (`ConfigurationFields.tsx`) render these primitives, so every editor that uses
`TextField`, `NumberField`, `SelectField` or `JsonField` picks up the same styling. Selects stay
native `<select>` elements on purpose: the desktop acceptance tests drive them with real
`selectOption` calls, and a native listbox keeps platform keyboard behavior.

Dialogs keep the native `<dialog>` element and its `::backdrop`, styled from the tokens, rather than
moving to a portal-based dialog; the existing focus and close behavior is unchanged.

## Adding a screen

Use the primitives and Tailwind utilities with token colors (`bg-card`, `text-muted-foreground`,
`border-border`). Avoid raw hex values: a literal color is correct in at most one theme. If a rule
belongs in `styles.css`, keep it inside `@layer components` and read a token.
