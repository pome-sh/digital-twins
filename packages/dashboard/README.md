# @pome-sh/dashboard

The local twin dashboard: a browser view of a running twin's tape, served by
`pome twin start`.

Not published. This package builds a static page straight into
`cli/assets/dashboard/`, which `@pome-sh/cli` ships via its `files` list and
resolves at runtime with `assetPath("dashboard", "index.html")`.

## What it is for

A twin records every request an agent makes. That record is the **tape**, and
until now it was only readable after the fact, as a table in a terminal. This
page makes it readable while it happens, and it has exactly one job:

> Someone who has never used Pome opens it while an agent is working and says
> out loud which write did not land.

Every hierarchy decision serves that sentence. Reads recede so a failure is the
loudest thing on screen; the verdict and the world stay put while only the tape
scrolls; the count of failed writes steps through them.

## Stack

Vite + React + TypeScript, styled with Tailwind v4 and
[shadcn/ui](https://ui.shadcn.com) components on Radix primitives, Phosphor icons,
and the Pome design system's three faces (Source Serif 4, Geist, Geist Mono)
from fontsource. Everything is a devDependency: the output is static files, and
`dependencies` stays empty so nothing here reaches the CLI's install.

## Layout

| path | what lives there |
|---|---|
| `src/api.ts` | the render contract with `cli/src/dashboard/`, imported type-only by the server so a drift reds the CLI's typecheck |
| `src/model/` | pure, DOM-free, unit-tested: what an entry is, which fields lead a detail, which collections earn a line |
| `src/ui/` | the page, built from `src/components/ui/` |
| `src/components/ui/` | shadcn/ui components — see below |
| `src/app.css` | the design system as Tailwind tokens, with shadcn's variables mapped onto it |
| `src/useSnapshot.ts` | one poll, both halves, 500 ms, paused when the tab is hidden |

Logic lives in `model/` and the `.tsx` stays thin on purpose: this repo runs
every vitest project under `environment: "node"`, and the split keeps it that
way. Add a DOM environment the first time a component grows a branch that
cannot sink into a `.ts` module — not before.

## The design system in Tailwind

`src/app.css` holds the system's values under `--pome-*`, exactly as its
`colors_and_type.css` declares them, and points shadcn's semantic variables
(`--primary`, `--muted`, `--card`…) at those. The prefix exists because the two
systems use the same words for different things: the design system's `--muted`
is a text colour, shadcn's is a surface.

Tailwind's default palette is removed (`--color-*: initial`). The design system
bans cool greys, and with the palette gone a stray `text-gray-500` builds to
nothing instead of shipping.

## shadcn/ui components

The files in `src/components/ui/` are shadcn/ui (MIT, Copyright (c) 2023
shadcn) at `shadcn@4.21.0`, each carrying that notice. They were changed where
the design system disagrees with shadcn's defaults:

- **card** — no shadow, no border, `rounded-lg`. "Cards never lift."
- **button** — the primary fill is fixed on hover and darkens on press; the
  outline variant has no shadow; transitions are 120 ms on the system's easing.
- **tabs** — no shadow on the active trigger. One shadow ships, on the nav.
- **tooltip** — a fade and nothing else ("no spring, no bounce"); body and
  arrow share one `--tip` colour so a use can lift both off a dark surface.
- **scroll-area** — `viewportRef` and `onViewportScroll`, so the tape can follow
  its newest row and stop when the reader scrolls up.

To add one, do **not** run `shadcn add` directly: its registry lists a
dependency named `cn`, and the CLI would install an unrelated npm package of
that name. Print the source instead and write it yourself:

```bash
npx shadcn@4.21.0 add <name> --view
```

then replace `from "cn"` with `from "@/lib/utils"`, keep the MIT header, and
align it with the design system as above.

## Things another tool cannot see

- **knip** cannot read CSS, so `tailwindcss`, `tw-animate-css` and the three
  fontsource packages — imported only from `app.css` and `fonts.css` — are
  listed under this workspace's `ignoreDependencies` in `knip.json`.
- **The content security policy** in `cli/src/dashboard/server.ts` admits one
  inline `<style>`: the one Radix's ScrollArea injects, by the hash of its text.
  `server.test.ts` recomputes that hash from the installed Radix, so an upgrade
  that rewords it fails a test rather than shipping a doubled scrollbar.
- **Fonts** are the latin subsets only, inlined into `app.css` so the server's
  three-file list stays the whole of what it serves.

## Working on it

```bash
npm run dev   -w @pome-sh/dashboard   # vite, with the CLI serving /api elsewhere
npm run build -w @pome-sh/dashboard   # writes cli/assets/dashboard/
npx vitest run --project dashboard
```

`npm run build` at the repo root builds this first: it depends only on
`@pome-sh/wire`, so the workspace's topological sort puts it in layer 1 and the
CLI in layer 3. The CLI is always built after the assets it ships exist.
