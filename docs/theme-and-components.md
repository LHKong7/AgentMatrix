# Light and dark themes, and the shadcn component layer

The renderer has one palette with a light and a dark theme, and a set of shadcn-style component
primitives built on Tailwind CSS v4. Both themes are driven by the same tokens, so a screen that
uses the tokens is correct in either theme without a second stylesheet.

## Tokens

`src/renderer/src/tokens.css` holds everything theme-related:

- Tailwind is imported whole, preflight included, followed by a short element baseline.
- `:root` defines the light palette and `.dark` the dark one, in oklch. Both are neutral: white or
  near-black surfaces, grey borders and a near-black (light) or near-white (dark) primary. The
  tokens are `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`,
  `accent`, `destructive`, `success`, `warning`, `border`, `input`, `ring`, `surface`, `overlay`,
  the `sidebar-*` group, five chart colors, and `brand` — the product green, used for the mark and
  the eyebrow dot only, so the interface itself stays neutral.
- `@theme inline` maps each token to a Tailwind color so `bg-card`, `text-muted-foreground`,
  `border-border` and friends resolve to the active theme.

There is no second stylesheet: every screen is built from the primitives in `components/ui` and
Tailwind utilities that read these tokens. `tokens.css` imports Tailwind with its preflight and adds
a short element baseline (headings, paragraphs, `code`, `small`, lists and definition lists) so
plain content stays readable without a class on every tag.

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
`Select`), `checkbox`, `label`, `separator`, `alert`, `skeleton`, `tabs`, `table`, `disclosure`,
`dialog` and `dropdown-menu`. `cn()` in `src/renderer/src/lib/utils.ts` merges classes.

Shared form fields (`ConfigurationFields.tsx`) render these primitives, so every editor that uses
`TextField`, `NumberField`, `SelectField` or `JsonField` picks up the same styling. Selects stay
native `<select>` elements on purpose: the desktop acceptance tests drive them with real
`selectOption` calls, and a native listbox keeps platform keyboard behavior.

The `dialog` primitive keeps the native `<dialog>` element and its `::backdrop` rather than moving
to a portal, so the platform focus trap, top-layer stacking and Escape handling stay as they were;
`checkbox` and `Select` stay real form controls for the same reason — the desktop tests drive them
with `check()` and `selectOption()`. `disclosure` styles `<details>`/`<summary>`, which keeps the
open state and the `summary` hooks those tests use.

## Adding a screen

Use the primitives and Tailwind utilities with token colors (`bg-card`, `text-muted-foreground`,
`border-border`). Avoid raw hex values: a literal color is correct in at most one theme. Reach for
`brand` only for the product mark.
