# Theming the rest of the desktop

Jarvis and the drawer paint their own colours, so they match the design no matter
what the system theme is. **Terminal and Nemo don't work that way** — they take
their look from elsewhere, and right now that elsewhere is not Catppuccin.

## What controls what

| Thing | Controlled by | Change affects |
|---|---|---|
| Terminal colours | its own profile (dconf) | that terminal only |
| Terminal font | same profile | that terminal only |
| Nemo window, sidebar, toolbar | **GTK theme** | *every* GTK app |
| Folder icons | icon theme | every app that shows folders |
| Panel, menu, tooltips | Cinnamon theme | the shell |
| Title bars | window manager theme | every window |

The important asymmetry: **the terminal is independent, the file manager is not.**
There is no per-app colour setting for Nemo — its greys come from the GTK theme,
so matching it means changing the theme that every GTK application uses.

## Where things stand

```
GTK theme      WhiteSur-Dark-purple      (dark, but neutral grey — not #1e1e2e)
WM theme       WhiteSur-Dark-purple
Cinnamon       Orchidea
Icons          Papirus-Dark              (blue folders)
Terminal       Tango palette, Monospace 12, uses theme colours
```

The terminal is the worst mismatch — the stock Tango palette is a harsh
green/red/blue on `#2E3436` grey, nothing like the design.

## Target palette — Catppuccin Mocha

Same values Jarvis and the drawer already use.

| Role | Hex |
|---|---|
| Background | `#1e1e2e` |
| Foreground | `#cdd6f4` |
| Cursor / accent | `#cba6f7` |
| Selection | `#585b70` |

ANSI 0–15:

```
#45475a  #f38ba8  #a6e3a1  #f9e2af  #89b4fa  #f5c2e7  #94e2d5  #bac2de
#585b70  #f38ba8  #a6e3a1  #f9e2af  #89b4fa  #f5c2e7  #94e2d5  #a6adc8
```

Font: **JetBrains Mono 11**, matching the figures in Jarvis.

## What was applied — 2026-09-27

Full coherence was chosen. Back up dconf first (see the notes at the end) and
everything below is reversible.

| | Before | After |
|---|---|---|
| GTK theme | `WhiteSur-Dark-purple` | `catppuccin-mocha-mauve-standard+default` |
| Window borders | `WhiteSur-Dark-purple` | same Catppuccin theme |
| Cinnamon shell | `Orchidea` | same Catppuccin theme |
| Plank dock | `Default` | `Catppuccin` |
| Icons | `Papirus-Dark` | `Papirus-Mauve` (see below) |
| Terminal | Tango on `#2E3436`, Monospace 12 | Catppuccin Mocha, JetBrains Mono 11 |

**One theme covered almost everything.** The `catppuccin/gtk` v1.0.3 release
ships `gtk-3.0`, `gtk-4.0`, `cinnamon`, `metacity-1` *and* `plank` in a single
package, so the shell, window borders and dock all came from the same source
rather than being matched by hand.

**Folder icons without sudo.** `papirus-folders` would need write access to
`/usr/share/icons`, and sudo wants a password here. Instead
`~/.local/share/icons/Papirus-Mauve` is a small icon theme that
`Inherits=Papirus-Dark` and symlinks Papirus's own `folder-violet-*` variants
over the default folder names — 78 icons per size, 8 sizes, no copying of the
full theme and no root.

**Inter was never actually installed.** Both stylesheets ask for
`font-family: "Inter"` and had been falling back to the default sans silently
since they were written. `rsms/inter` v4.1 went into
`~/.local/share/fonts/Inter/`, but it registers its family as **"Inter
Variable"** — so `fc-match Inter` still resolved to Noto Sans and nothing
changed. The fix is a fontconfig alias at
`~/.config/fontconfig/conf.d/60-inter-alias.conf` mapping `Inter` →
`Inter Variable`, which also helps anything else asking for Inter by its usual
name.

With the real font in place the desklet re-fitted itself from 417px to 408px
tall (Inter is slightly more compact), row still pinned, nothing overflowing;
the drawer's wrapped labels measure 34px against the 36px box. Both suites still
pass.

**The Files icon was still stock Papirus.** Recolouring folders only covered the
`folder-*` and `user-*` icon families — app icons were untouched, so the file
manager kept Papirus's grey cabinet with `#5294e2` blue, `#89e058` green and
`#ffcd54` yellow tabs, none of which are Catppuccin. Replaced with Mint-Y-Purple's
flat folder, hue-shifted from its native `#a27ae4` onto `#cba6f7` so it lands on
the exact accent, at all 8 sizes.

Because `Papirus-Mauve` *inherits* Papirus-Dark, this overrides one icon and
leaves the other ~10,000 alone — no need to swap the whole icon set. The override
lives in `<size>/{categories,places,apps}/system-file-manager.png`; all three
contexts are populated because different shells look the name up in different
ones, and `index.theme` has to declare every directory or the lookup silently
falls through to the parent theme.

**Verified by sampling the rendered pixels**, not by eye:

| Surface | Sampled | Catppuccin Mocha |
|---|---|---|
| Terminal body | `#1e1e2e` | `base` ✓ |
| Nemo body | `#1e1e2e` | `base` ✓ |
| Nemo title bar | `#1e1e2e` | `base` ✓ |

## The options considered

**1. Terminal only.** Set the profile colours and font. Instant, reversible in
one command, affects nothing else. Nemo stays as it is.

**2. Terminal + Catppuccin GTK theme.** Nemo matches, and so does every other
GTK app — Settings, text editor, dialogs. This is the coherent choice, but it is
also the biggest visual change: WhiteSur goes away everywhere.

**3. Everything.** The above plus the Cinnamon panel theme and mauve folder
icons, so the panel, menus and folders line up too.

**4. Terminal + a Nemo-only CSS override** in `~/.config/gtk-3.0/gtk.css`,
keeping WhiteSur elsewhere. Possible, but it means fighting the theme rule by
rule and the result is always partial — scrollbars, menus and dialogs keep
leaking the old colours.

## Notes for implementation

- Every setting is in dconf; back up first with
  `dconf dump /org/cinnamon/ > cinnamon-settings.bak` and
  `dconf dump /org/gnome/terminal/ > terminal.bak`, so reverting is one command.
- The Catppuccin GTK theme is not installed; it comes from the
  `catppuccin/gtk` GitHub releases into `~/.themes`. 
- `papirus-folders` recolours Papirus folders in one command; Papirus ships many
  colour variants and is already installed (20240201).
- Cinnamon reads the GTK theme live, but some apps need restarting to pick it up.
