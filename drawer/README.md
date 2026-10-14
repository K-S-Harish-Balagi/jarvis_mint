# Jarvis Drawer

A full-screen **application launcher**, opened with `Super`. Source is
`jarvis-drawer@harish/`.

![Jarvis Drawer](../screenshots/drawer.png)

## Why it was written from scratch

Cinnamenu could not be configured into the design's shape — its categories are a
left sidebar and its search sits at the bottom, and both are structural rather
than themeable. Cinnamenu is still installed and still works from its panel icon;
only its `overlay-key` was cleared so `Super` was free for this.

## Shape

Top to bottom: search pill (460×44, radius 22) with session controls beside it,
category chips, the app grid, then page dots. Covers the whole screen including
the dock — the drawer owns the screen while it is open.

Paged, **not scrolled** — the Ubuntu app-grid lineage. Swipe/scroll, arrow keys,
Page Up/Down, and clickable dots all move between pages.

## The grid is derived, not fixed

The board's *6 columns across 900px* was a figure from a 1440px-wide artboard,
not a specification. Both axes now fit the actual display:

```js
let margin = Math.max(72, Math.round(areaW * 0.10));
let cols = Math.floor((areaW - margin * 2 + GAP) / (TILE_W + GAP));   // clamp 4..10
let rows = Math.floor((areaH - CHROME_H) / TILE_H);                   // clamp 2..6
```

Tile size stays at the board's values (140px tile, 60px icon, 12px gap) — only
the *count* changes, so tiles never stretch or shrink. The side margin is
proportional because the board's own grid sits well inside the screen edge.

| Display | Grid | Per page |
|---|---|---|
| 1024×768 | 5 × 4 | 20 |
| 1280×800 | 6 × 4 | 24 |
| **1366×768 (this machine)** | **7 × 4** | **28** |
| 1600×900 | 8 × 5 | 40 |
| 1920×1080 | 10 × 6 | 60 |
| 2560×1440 and up | 10 × 6 | 60 (clamped) |

The `columns` setting is a combobox where **0 = Auto (fit display)**; pick a
number to override it.

## Two-line labels

Names wrap to two lines rather than truncating, so *Advanced Network
Configuration* and *Darktable Photo Workflow Software* (33 chars, the longest
installed) read in full.

Two things this needed:

**Pango turns wrapping off whenever ellipsize is set** — they are mutually
exclusive. Setting `line_wrap(true)` did nothing at all until `set_ellipsize(3)`
was changed to `set_ellipsize(0)`. That single fact was the whole bug.

**The label box is pinned** to `LABEL_H`, so a one-word name occupies the same
height as a two-line one and rows stay on a grid. `LABEL_H` is 36px, *measured*
— wrapped text is 36px against 18px for a single line. An initial guess of 34
would have clipped descenders. `clip_to_allocation` guards the case of a future
name needing three lines, since Clutter does not clip on its own.

## Getting out without the keyboard

`Super` toggles, but a drawer opened by **clicking the panel icon** had no mouse
way out — only `Escape`. The cause is not a broken toggle: `Main.pushModal()`
grabs every event while the drawer is open, so the second click on the panel
icon never reaches `on_applet_clicked` at all. Verified by clicking it twice and
watching `_open` stay `true`.

Two ways out were added:

- **Click any blank area.** What the GNOME overview, the Windows start menu and
  macOS Launchpad all do, so people try it by instinct. No new chrome.
- **A × button** in the top-right corner, for when instinct isn't enough.

The blank-space handler cannot simply close on any click that reaches the
overlay. Tiles, chips, session buttons and page dots consume their own presses,
but **`St.Entry` does not** — a click on the search pill bubbled straight up and
dismissed the drawer mid-typing. So the handler walks up from `event.get_source()`
and bails if it passes anything flagged `_isChrome` (the search row, chip box,
dot row and the close button's row).

Two St traps showed up placing the button:

**`St.Bin` — and therefore `St.Button` — shadows Clutter's `x_align` with
`StAlign`,** which only runs 0–2. Assigning `Clutter.ActorAlign.END` (3) throws
`3 is not a valid value for enumeration StAlign`, and because it threw inside
`show()` the drawer stopped opening entirely. `St.BoxLayout` does *not* shadow
it.

**`BinLayout` silently centres a child whose alignment it can't honour** rather
than erroring, which is how the button ended up in the middle of the screen
looking deliberate. The fix is the same expanding-spacer trick that centres the
grid.

Closing now also **nulls every actor reference** (`_entry`, `_chipBox`,
`_gridBox`, `_dots`, `_chipBtns`). They pointed at destroyed children of the
overlay, and touching a destroyed Clutter actor **takes the whole shell down
rather than throwing** — it killed Cinnamon outright during testing.

## Findings

**The app list must come from `CMenu`, not `Gio.AppInfo.get_all()`.** They
disagree, and the disagreement is not cosmetic: `org.gnome.Terminal.desktop`
ships `OnlyShowIn=GNOME;Unity;`, so under `X-Cinnamon` `should_show()` correctly
hides it and **searching "term" found nothing at all**. Cinnamon's own menu walks
`cinnamon-applications.menu`, which overrides that. Launching and icons still go
through `Gio.DesktopAppInfo.new(desktop_file_id)`.

This was found by testing, not by looking — the grid looked perfectly fine.

**`x_align` is ignored on a `ScrollView` inside a vertical `BoxLayout`.** The
grid rendered flush left until expanding `St.Widget` spacers were put either
side.

**A single-line `St.Entry` eats Left/Right** as text-cursor keys before any
parent handler sees them. Arrows are handled on `entry.clutter_text` itself.

**The page pills were invisible** — the full-screen overlay had no bottom
padding, so `y_expand` on the grid pushed them onto the screen edge where the
dock bled through. Fixed with `padding: 34px 0 64px 0`.

**Plank's window is 140px tall but only ~68px visible** (the rest is a
transparent hover-zoom band), so cutting the overlay at the dock's window top
left a strip of bare wallpaper. Moot now that the drawer covers everything.

**`Main.layoutManager.getWorkAreaForMonitor` does not exist** on this build — it
is on the workspace. A `try/catch` swallowed the error silently.

## Test results — 2026-09-27

**43 passed, 0 failed** (`tests/test_drawer.js`), plus real input events.

- **App list** — 118 apps, no duplicates, alphabetical, every entry has an icon
  and is launchable, Terminal present.
- **Search** — empty, case-insensitive, mid-word, executable match, nonsense
  query, whitespace-only.
- **Categories** — all six chips non-empty; chips combine with search.
- **Paging** — page size equals cols × rows, dot count equals page count, no
  running past either end, last page holds the remainder, empty state builds no
  tiles and no dots.
- **Geometry** — sane at seven resolutions from 1024×768 to 3840×2160, plus a
  200×200 absurd case that clamps instead of producing garbage.
- **Tiles** — all exactly 130px, none wider than its slot, long names wrap
  rather than truncate, label box fits the wrapped text.
- **Input** — `Super` opens, `Escape` closes, Page Up/Down, scroll wheel,
  arrows (`Down` moved the selection by exactly 7, confirming the column count),
  `Enter` launched Calculator and closed the drawer.

## Possible next steps

- Filter `Settings`-category entries out, so control panels don't sit beside
  real applications.
- Volume names like `5988-32DB` could use a friendlier fallback.

## Tests

`tests/test_drawer.js`, run through `org.Cinnamon.Eval` — see the
[root README](../README.md). The drawer must be **open** when the suite runs;
the grid only exists while it is shown.
