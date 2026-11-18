# Pobots design system

How the app looks, moves and speaks. The files in `project/` are the source; the app builds its styles from them.

Neutral and dark first, with no borders: surfaces are told apart by lightness and shadow. Bots have faces whose eyes show their state.

## What is here

| Path | What |
| --- | --- |
| `project/README.md` | The brand book: principles, voice, colour, status, type, space, motion, layout. Read this first. |
| `project/tokens.json` | Every colour (light and dark), type style, spacing step, radius, shadow, duration and easing. |
| `project/components/bundle.css` | The component styles, written only with tokens. |
| `project/components/<Name>/preview.html` | A live example of each component. |
| `project/components/<Name>/README.md` | When and how to use it. |
| `project/components/AppShell/` | The whole app window, built from the other components. |
| `project/components/Cover/` | The cover of the design system's page. |
| `project/design-system.json` | The index of the components and their groups. |
| `build.mjs` | Builds `dist/tokens.css` and stand-alone preview pages for looking at locally. |

## Look at it locally

```
node design-system/build.mjs
open design-system/dist/preview/AppShell.light.html
```

`dist/` is not committed. The app loads `dist/tokens.css` and `project/components/bundle.css`.

## Change it

1. Edit files under `project/`. Use tokens; add a token before using a new value.
2. Run `node design-system/build.mjs` and check the previews in light and dark.
3. When a component changes in the app, change its `README.md` and `preview.html` here in the same commit.
