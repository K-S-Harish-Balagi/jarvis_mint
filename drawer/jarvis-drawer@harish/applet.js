/*
 * Jarvis Drawer - a full-screen application drawer for Cinnamon.
 *
 * Built to match page 12 of the Mint desktop canvas: search on top,
 * category chips under it, then a 6-column grid of icons. Cinnamenu could
 * not be configured into that shape - its categories are a left sidebar and
 * its search sits at the bottom, both structural - so this is its own applet
 * rather than a patched copy of a third-party spice that updates overwrite.
 *
 * Colours are painted in this applet's own stylesheet rather than inherited
 * from the shell theme, so the drawer matches the design whether the desktop
 * is on WhiteSur-Dark-purple or anything else.
 */

const Applet = imports.ui.applet;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const CMenu = imports.gi.CMenu;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Lang = imports.lang;
const Util = imports.misc.util;

// ---- search scoring ------------------------------------------------------
// Same idea as Cinnamenu's own search (name, description, keywords and id are
// all scored, whole-word hits beat substring hits, fuzzy hits trail), so a
// query that finds an app in the start menu finds it here too. "vs" reaches
// Visual Studio Code through its Keywords=vscode entry, which a name-only
// match can never do.
const SEARCH_THRESHOLD = 0.45;

function _norm(str) {
    return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleUpperCase();
}

function _escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

// q and str are already _norm()ed
function _searchPart(q, str, fuzzy) {
    if (!str || !q) return 0;
    if (new RegExp('\\b' + _escapeRe(q)).test(str)) return str.indexOf(q) === 0 ? 1.21 : 1.2;
    if (str.indexOf(q) !== -1) return 1.1;
    if (!fuzzy) return 0;
    let found = str.match(new RegExp('[' + _escapeRe(q) + ']+', 'g'));
    if (!found) return 0;
    let longest = '';
    for (let i = 0; i < found.length; i++) if (found[i].length > longest.length) longest = found[i];
    let bigrams = 1;
    if (q.length >= 2) {
        let hit = 0;
        for (let i = 0; i < q.length - 1; i++) if (longest.indexOf(q[i] + q[i + 1]) >= 0) hit++;
        bigrams = Math.min(hit / (q.length - 1), 1);
    }
    return Math.min(longest.length / q.length, 1.0) * bigrams;
}

function _search(q, str) {
    // fuzzy matching on one or two letters would match nearly every app
    let fuzzy = q.length >= 3;
    let sp = q.indexOf(' ');
    if (sp < 1) return _searchPart(q, str, fuzzy);
    return (_searchPart(q.slice(0, sp), str, fuzzy) + _searchPart(q.slice(sp + 1), str, fuzzy)) / 2.0;
}

// Categories shown as chips, in this order. "All" is synthesised.
// Exactly the six the board shows, in its order.
const CHIPS = [
    ['All apps', null],
    ['Development', 'Development'],
    ['Graphics', 'Graphics'],
    ['Internet', 'Network'],
    ['Multimedia', 'AudioVideo'],
    ['System', 'System']
];

function JarvisDrawer(metadata, orientation, panelHeight, instanceId) {
    this._init(metadata, orientation, panelHeight, instanceId);
}

JarvisDrawer.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function (metadata, orientation, panelHeight, instanceId) {
        Applet.IconApplet.prototype._init.call(this, orientation, panelHeight, instanceId);
        this.set_applet_icon_symbolic_name('view-grid');
        this.set_applet_tooltip('Applications');

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bindProperty(Settings.BindingDirection.IN, 'columns', 'columns',
            Lang.bind(this, function () { this._destroyOverlay(); }), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, 'iconSize', 'iconSize',
            Lang.bind(this, function () { this._destroyOverlay(); }), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, 'hotkey', 'hotkey', this._bindHotkey, null);

        this._open = false;
        this._overlay = null;
        this._tiles = [];
        this._sel = 0;
        this._page = 0;
        this._filter = '';
        this._category = null;
        this._apps = null;          // cached; dropped when installed apps change
        this._gridKey = null;       // what the drawn grid currently shows

        this._bindHotkey();

        this._appMonitor = Gio.AppInfoMonitor.get();
        this._appMonitorId = this._appMonitor.connect('changed', Lang.bind(this, function () {
            this._apps = null;
        }));

        // Build the drawer once, shortly after login, so the first open is
        // as quick as every later one.
        this._prebuildId = Mainloop.timeout_add(2500, Lang.bind(this, function () {
            this._prebuildId = 0;
            try {
                if (!this._apps) this._apps = this._loadApps();
                if (!this._overlay) { this._buildOverlay(); this._rebuildGrid(); }
            } catch (e) {
                global.logError('jarvis-drawer: prebuild failed: ' + e);
            }
            return false;
        }));
    },

    _bindHotkey: function () {
        try {
            Main.keybindingManager.addHotKey('jarvis-drawer-open',
                this.hotkey || 'Super_L', Lang.bind(this, this.toggle));
        } catch (e) {
            global.logError('jarvis-drawer: could not bind hotkey: ' + e);
        }
    },

    on_applet_clicked: function () { this.toggle(); },

    on_applet_removed_from_panel: function () {
        if (this._prebuildId) { Mainloop.source_remove(this._prebuildId); this._prebuildId = 0; }
        if (this._appMonitorId) { this._appMonitor.disconnect(this._appMonitorId); this._appMonitorId = 0; }
        this._destroyOverlay();
        try { Main.keybindingManager.removeHotKey('jarvis-drawer-open'); } catch (e) {}
        this.settings.finalize();
    },

    toggle: function () { this._open ? this.close() : this.show(); },

    // ---- app list -------------------------------------------------------

    // Source the list from CMenu, the same tree Cinnamon's own menu walks -
    // not Gio.AppInfo.get_all(). They disagree: Gio honours OnlyShowIn, so
    // org.gnome.Terminal.desktop (OnlyShowIn=GNOME;Unity;) is invisible under
    // X-Cinnamon and the drawer could not find Terminal at all. Cinnamon's
    // menu file overrides that, and matching it is what a launcher should do.
    _loadApps: function () {
        let out = [], seen = {};

        let push = Lang.bind(this, function (info, id) {
            if (!info || seen[id]) return;
            let name = info.get_display_name() || info.get_name() || '';
            if (!name) return;
            seen[id] = true;
            let kw = '';
            try { kw = (info.get_keywords() || []).join(' '); } catch (e) {}
            let shortId = id.replace('.desktop', '');
            shortId = shortId.substring(shortId.lastIndexOf('.') + 1).replace('cinnamon-settings-', '');
            let words = name.split(/[\s\-_]+/).filter(function (w) { return w.length; });
            out.push({
                info: info,
                name: name,
                lower: name.toLowerCase(),
                exec: (info.get_executable() || '').toLowerCase(),
                cats: (info.get_categories() || ''),
                nameU: _norm(name),
                descU: _norm((info.get_generic_name() || '') + ' ' + (info.get_description() || '')),
                kwU: _norm(kw),
                idU: _norm(shortId),
                initials: _norm(words.map(function (w) { return w[0]; }).join(''))
            });
        });

        try {
            let tree = new CMenu.Tree({ menu_basename: 'cinnamon-applications.menu',
                                        flags: CMenu.TreeFlags.NONE });
            tree.load_sync();
            let walk = function (dir) {
                let it = dir.iter(), t;
                while ((t = it.next()) !== CMenu.TreeItemType.INVALID) {
                    if (t === CMenu.TreeItemType.ENTRY) {
                        let e = it.get_entry();
                        if (e.get_app_info().get_nodisplay()) continue;
                        let id = e.get_desktop_file_id();
                        // launch and icon still come from a real Gio.AppInfo
                        push(Gio.DesktopAppInfo.new(id), id);
                    } else if (t === CMenu.TreeItemType.DIRECTORY) {
                        walk(it.get_directory());
                    }
                }
            };
            walk(tree.get_root_directory());
        } catch (e) {
            global.logError('jarvis-drawer: CMenu unavailable, falling back: ' + e);
        }

        if (!out.length) {                       // last resort
            let all = Gio.AppInfo.get_all();
            for (let i = 0; i < all.length; i++) {
                if (all[i].should_show()) push(all[i], all[i].get_id() || String(i));
            }
        }

        out.sort(function (x, y) { return x.lower.localeCompare(y.lower); });
        return out;
    },

    _score: function (q, app) {
        let score = Math.max(
            _search(q, app.nameU),
            _search(q, app.descU) * 0.95,
            _search(q, app.kwU) * 0.8,
            _search(q, app.idU));
        if (q.length >= 2 && app.initials.indexOf(q) === 0) score = Math.max(score, 1.15);
        if (app.exec.indexOf(q.toLowerCase()) !== -1) score = Math.max(score, 1.0);
        return score;
    },

    _visible: function () {
        let q = _norm(this._filter.trim());
        let cat = this._category;
        let list = this._apps.filter(function (app) {
            return !cat || app.cats.indexOf(cat) !== -1;
        });
        if (!q) return list;
        let hits = [];
        for (let i = 0; i < list.length; i++) {
            let sc = this._score(q, list[i]);
            if (sc > SEARCH_THRESHOLD) hits.push({ app: list[i], score: sc });
        }
        hits.sort(function (a, b) { return b.score - a.score; });   // stable: ties stay A-Z
        return hits.map(function (h) { return h.app; });
    },

    // ---- ui -------------------------------------------------------------

    _stateKey: function () {
        return this._filter + '|' + this._category + '|' + this._page;
    },

    show: function () {
        if (this._open) return;
        if (!this._apps) { this._apps = this._loadApps(); this._gridKey = null; }

        let mon = Main.layoutManager.primaryMonitor;
        if (this._overlay && (this._areaW !== mon.width || this._areaH !== mon.height)) {
            this._destroyOverlay();                 // resolution changed: re-measure
        }
        if (!this._overlay) this._buildOverlay();

        this._filter = '';
        this._category = null;
        this._sel = 0;
        this._page = 0;
        this._syncChips();
        this._entry.set_text('');                   // fires a rebuild only if text was left behind
        if (this._gridKey !== this._stateKey()) this._rebuildGrid();
        else this._select(0);

        this._overlay.show();
        this._open = true;

        // grab the keyboard so arrows/Escape reach us, not the desktop
        Main.pushModal(this._overlay);
        global.stage.set_key_focus(this._entry);
        this._keyId = this._overlay.connect('key-press-event', Lang.bind(this, this._onKey));
        // The entry holds key focus so typing goes straight to search, but a
        // single-line St.Entry eats Left/Right as text-cursor keys, so the
        // grid never saw them. Handle arrows on the entry itself and stop
        // them there; everything else still falls through to the search box.
        this._entryKeyId = this._entry.clutter_text.connect('key-press-event',
            Lang.bind(this, this._onKey));
    },

    // Built once and then only shown and hidden: creating the overlay and all
    // its tiles on every open was most of the delay.
    _buildOverlay: function () {
        // Full screen, including behind the top panel. The dock is the one
        // thing left uncovered, so it reads as sitting on top of the drawer.
        let mon = Main.layoutManager.primaryMonitor;
        let area = { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
        // Covers everything, dock included - the drawer owns the screen while
        // it is open.

        this._areaH = area.height;
        this._areaW = area.width;
        global.log('[jarvis-drawer] display ' + area.width + 'x' + area.height
            + ' -> ' + this._colsPerPage() + ' cols x ' + this._rowsPerPage() + ' rows'
            + ' = ' + this._pageSize() + '/page, grid ' + this._gridWidth() + 'px'
            + ', side margin ' + Math.round((area.width - this._gridWidth()) / 2) + 'px');
        // The root is a BinLayout rather than the content box itself, so the
        // close button can sit in the corner *over* the column instead of
        // being pushed into the vertical flow.
        this._overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'jarvis-drawer-root',
            reactive: true,
            width: area.width,
            height: area.height
        });
        this._overlay.set_position(area.x, area.y);
        this._column = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        this._overlay.add_child(this._column);
        // St.BoxLayout takes no "spacing" constructor property on this
        // Cinnamon build - it has to go through the style.
        // Exact spec from page 12: content column centred, 64px from the
        // top, 18px between blocks. Ubuntu's app grid is the ancestor here -
        // a narrow centred search pill over a fixed-width grid, not the
        // edge-to-edge layout this applet had first.
        this._column.set_style('spacing: 16px; padding: 34px 0 64px 0;');

        // search row
        this._entry = new St.Entry({
            style_class: 'jarvis-drawer-search',
            hint_text: 'Type to search apps, files and settings',
            can_focus: true,
            width: 460,
            height: 44
        });
        this._entry.clutter_text.connect('text-changed', Lang.bind(this, function () {
            this._filter = this._entry.get_text();
            this._sel = 0;
            this._page = 0;
            this._rebuildGrid();
        }));
        this._entry.clutter_text.connect('activate', Lang.bind(this, function () {
            this._launchSelected();
        }));

        // search pill plus the session controls, as one centred cluster
        let searchRow = new St.BoxLayout({ vertical: false });
        searchRow.set_style('spacing: 10px;');
        searchRow.x_align = Clutter.ActorAlign.CENTER;
        searchRow.add_child(this._entry);

        let session = [
            ['Suspend', 'weather-clear-night-symbolic', 'systemctl suspend', ''],
            ['Restart', 'system-reboot-symbolic', 'cinnamon-session-quit --reboot', ''],
            ['Power off', 'system-shutdown-symbolic', 'cinnamon-session-quit --power-off', '-danger']
        ];
        session.forEach(Lang.bind(this, function (s) {
            let b = new St.Button({
                style_class: 'jarvis-drawer-session' + s[3],
                can_focus: true
            });
            b.set_child(new St.Icon({ icon_name: s[1], icon_size: 18 }));
            b.accessible_name = s[0];
            b._cmd = s[2];
            b.connect('clicked', Lang.bind(this, function (btn) {
                // reboot and power off raise Cinnamon's own confirm dialog, so
                // a mis-click here is recoverable
                this.close();
                Util.spawnCommandLine(btn._cmd);
                return true;
            }));
            searchRow.add_child(b);
        }));

        searchRow._isChrome = true;
        this._column.add_child(searchRow);

        // category chips
        this._chipBox = new St.BoxLayout({ vertical: false });
        this._chipBox.set_style('spacing: 8px;');
        this._chipBox.x_align = Clutter.ActorAlign.CENTER;
        this._chipBtns = [];
        for (let i = 0; i < CHIPS.length; i++) {
            let label = CHIPS[i][0], cat = CHIPS[i][1];
            let btn = new St.Button({
                label: label,
                style_class: cat === this._category ? 'jarvis-drawer-chip-on' : 'jarvis-drawer-chip'
            });
            btn._cat = cat;
            btn.connect('clicked', Lang.bind(this, function (b) {
                this._category = b._cat;
                this._sel = 0;
                this._page = 0;
                this._syncChips();
                this._rebuildGrid();
                return true;
            }));
            this._chipBtns.push(btn);
            this._chipBox.add_child(btn);
        }
        this._chipBox._isChrome = true;
        this._column.add_child(this._chipBox);

        // grid holder, scrollable so a long list never clips
        // x_align is not honoured on a ScrollView inside a vertical
        // BoxLayout here - it renders flush left - so the 900px grid gets
        // centred by expanding spacers instead, which is reliable.
        // Paged, not scrolled: one screenful of apps at a time, swipe or
        // arrow between pages, dots underneath. Matches how Ubuntu's grid
        // behaves rather than a scrolling list.
        let gridRow = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: true });
        gridRow.add_child(new St.Widget({ x_expand: true }));
        this._gridBox = new St.BoxLayout({ vertical: true, width: this._gridWidth(), y_expand: true });
        this._gridBox.set_style('spacing: 2px;');
        gridRow.add_child(this._gridBox);
        gridRow.add_child(new St.Widget({ x_expand: true }));
        this._column.add_child(gridRow);

        this._dots = new St.BoxLayout({ vertical: false });
        this._dots.set_style('spacing: 8px;');
        this._dots.x_align = Clutter.ActorAlign.CENTER;
        this._dots._isChrome = true;
        this._column.add_child(this._dots);

        // --- getting out without the keyboard ----------------------------
        // Super toggles, but a drawer opened from the panel icon had no way
        // out but Escape: Main.pushModal grabs every event, so a second click
        // on the panel icon never reaches the applet.

        // 1. a visible way out
        this._closeBtn = new St.Button({ style_class: 'jarvis-drawer-close', can_focus: true });
        this._closeBtn.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 18 }));
        this._closeBtn.accessible_name = 'Close';
        this._closeBtn.connect('clicked', Lang.bind(this, function () {
            this.close();
            return true;
        }));
        // Corner placement by expanding spacers, not by alignment: St.Bin
        // (so St.Button) shadows Clutter's x_align with StAlign, which only
        // runs 0-2, and BinLayout just centres a child whose align it cannot
        // honour. Spacers are the same trick that centres the grid.
        let closeWrap = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        let closeRow = new St.BoxLayout({ vertical: false, x_expand: true });
        closeRow.set_style('margin: 20px 24px 0 0;');
        closeRow.add_child(new St.Widget({ x_expand: true }));
        closeRow.add_child(this._closeBtn);
        closeRow._isChrome = true;
        closeWrap.add_child(closeRow);
        closeWrap.add_child(new St.Widget({ y_expand: true }));
        this._overlay.add_child(closeWrap);

        // 2. clicking blank space, the way the GNOME overview and the Windows
        // start menu behave. Tiles, chips, the entry and the session buttons
        // all consume their own clicks, so only genuinely empty space gets
        // here - the content column is not reactive and lets events through.
        this._overlay.connect('button-press-event', Lang.bind(this, function (a, e) {
            if (e.get_button() !== 1) return false;
            // Tiles and buttons consume their own clicks, but St.Entry does
            // NOT - a click on the search pill bubbles up here and would have
            // dismissed the drawer mid-typing. So walk up from whatever was
            // actually hit and bail if it sits inside any chrome.
            let node = e.get_source();
            while (node && node !== this._overlay) {
                if (node._isChrome) return false;
                node = node.get_parent();
            }
            this.close();
            return true;
        }));

        // two-finger horizontal swipe on the touchpad arrives as a scroll
        this._overlay.connect('scroll-event', Lang.bind(this, function (a, e) {
            let dir = e.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.RIGHT || dir === Clutter.ScrollDirection.DOWN) {
                this._turnPage(1);
            } else if (dir === Clutter.ScrollDirection.LEFT || dir === Clutter.ScrollDirection.UP) {
                this._turnPage(-1);
            }
            return true;
        }));

        Main.uiGroup.add_child(this._overlay);
        this._overlay.hide();
    },

    close: function () {
        if (!this._open) return;
        this._open = false;
        try { Main.popModal(this._overlay); } catch (e) {}
        if (this._keyId) { try { this._overlay.disconnect(this._keyId); } catch (e) {} this._keyId = 0; }
        if (this._entryKeyId) {
            try { this._entry.clutter_text.disconnect(this._entryKeyId); } catch (e) {}
            this._entryKeyId = 0;
        }
        this._overlay.hide();
    },

    _destroyOverlay: function () {
        if (this._open) this.close();
        if (!this._overlay) return;
        this._overlay.destroy();
        // Everything below was a child of the overlay and is now destroyed.
        // Leaving the references behind is a real hazard: calling anything on
        // a destroyed Clutter actor can take the whole shell down, not throw.
        this._overlay = null;
        this._column = null;
        this._closeBtn = null;
        this._entry = null;
        this._chipBox = null;
        this._chipBtns = [];
        this._gridBox = null;
        this._dots = null;
        this._tiles = [];
        this._gridKey = null;
    },

    _syncChips: function () {
        for (let i = 0; i < this._chipBtns.length; i++) {
            let b = this._chipBtns[i];
            b.set_style_class_name(b._cat === this._category ? 'jarvis-drawer-chip-on' : 'jarvis-drawer-chip');
        }
    },

    ROWS_PER_PAGE: 4,          // fallback until the overlay is measured

    // tile = 60px icon + 10 gap + ~17 label + 26 padding, plus 2px row spacing
    LABEL_H: 36,               // two lines of the 13px label, measured not guessed
    TILE_H: 130,               // 14 pad + 60 icon + 8 gap + 36 label + 12 pad
    // search pill 44 + chips 32 + dots 8, their three 18px gaps, and the
    // overlay's own 28px top padding
    CHROME_H: 214,   // search + chips + pills, their gaps, and the 34/64 insets

    TILE_W: 140,
    TILE_GAP: 12,
    SIDE_MARGIN: 72,           // floor for the breathing room either side
    SIDE_MARGIN_PCT: 0.10,     // the board's own grid sits well inside the edge

    _colsPerPage: function () {
        if (this.columns) return this.columns;   // explicit override from settings
        if (!this._areaW) return 6;              // before the overlay is measured
        let margin = Math.max(this.SIDE_MARGIN,
                              Math.round(this._areaW * this.SIDE_MARGIN_PCT));
        let usable = this._areaW - (margin * 2);
        let cols = Math.floor((usable + this.TILE_GAP) / (this.TILE_W + this.TILE_GAP));
        return Math.max(4, Math.min(10, cols));
    },

    _gridWidth: function () {
        let c = this._colsPerPage();
        return c * this.TILE_W + (c - 1) * this.TILE_GAP;
    },

    _rowsPerPage: function () {
        if (!this._areaH) return this.ROWS_PER_PAGE;
        let rows = Math.floor((this._areaH - this.CHROME_H) / this.TILE_H);
        return Math.max(2, Math.min(6, rows));
    },

    _pageSize: function () {
        return this._colsPerPage() * this._rowsPerPage();
    },

    _pageCount: function () {
        let n = this._visible().length;
        return Math.max(1, Math.ceil(n / this._pageSize()));
    },

    _turnPage: function (delta) {
        let pages = this._pageCount();
        let p = Math.min(Math.max(this._page + delta, 0), pages - 1);
        if (p === this._page) return;
        this._page = p;
        this._sel = 0;
        this._rebuildGrid();
    },

    _renderDots: function () {
        this._dots.destroy_all_children();
        let pages = this._pageCount();
        if (pages < 2) return;            // one page needs no indicator
        for (let i = 0; i < pages; i++) {
            let on = i === this._page;
            let dot = new St.Button({ style_class: on ? 'jarvis-drawer-dot-on' : 'jarvis-drawer-dot' });
            dot._page = i;
            dot.connect('clicked', Lang.bind(this, function (b) {
                this._page = b._page; this._sel = 0; this._rebuildGrid(); return true;
            }));
            this._dots.add_child(dot);
        }
    },

    _rebuildGrid: function () {
        this._gridBox.destroy_all_children();
        this._tiles = [];

        let all = this._visible();
        let pages = Math.max(1, Math.ceil(all.length / this._pageSize()));
        if (this._page > pages - 1) this._page = pages - 1;

        if (!all.length) {
            let empty = new St.Label({ text: 'No applications match', style_class: 'jarvis-drawer-empty' });
            empty.set_style('margin: 40px 6px;');
            this._gridBox.add_child(empty);
            this._renderDots();
            this._gridKey = this._stateKey();
            return;
        }

        let cols = this._colsPerPage();
        let gw = this._gridWidth();
        let size = this.iconSize || 60;
        let from = this._page * this._pageSize();
        let apps = all.slice(from, from + this._pageSize());
        let row = null;

        for (let i = 0; i < apps.length; i++) {
            if (i % cols === 0) {
                row = new St.BoxLayout({ vertical: false, width: gw });
                row.set_style('spacing: ' + this.TILE_GAP + 'px;');
                this._gridBox.add_child(row);
            }
            let app = apps[i];

            // 6 columns across 900px with five 12px gaps -> 140px each
            let tile = new St.BoxLayout({ vertical: true, reactive: true, width: this.TILE_W,
                                          style_class: 'jarvis-drawer-tile' });
            tile.set_style('spacing: 8px;');

            let icon = new St.Icon({ gicon: app.info.get_icon(), icon_size: size });
            icon.x_align = Clutter.ActorAlign.CENTER;
            tile.add_child(icon);

            // Two lines rather than one truncated one: at 140px a tile fits
            // ~18 characters a line, so "Advanced Network Configuration" reads
            // in full instead of dying at "Advanced Network ...". The box is
            // pinned to two lines so a one-word name still occupies the same
            // height and the rows stay on a grid.
            let label = new St.Label({ text: app.name, style_class: 'jarvis-drawer-label' });
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(2);   // PANGO_WRAP_WORD_CHAR
            // Pango turns wrapping OFF whenever ellipsize is set, which is why
            // the single-line version truncated - the two are exclusive.
            label.clutter_text.set_ellipsize(0);        // PANGO_ELLIPSIZE_NONE
            label.clutter_text.set_line_alignment(1);   // PANGO_ALIGN_CENTER
            label.height = this.LABEL_H;
            // Clutter does not clip: without this a hypothetical three-line
            // name would draw straight into the row beneath it.
            label.clip_to_allocation = true;
            label.x_align = Clutter.ActorAlign.CENTER;
            label.y_align = Clutter.ActorAlign.START;
            tile.add_child(label);

            tile._index = i;
            tile._app = app;
            tile.connect('button-press-event', Lang.bind(this, function (actor) {
                this._launch(actor._app); return true;
            }));
            tile.connect('enter-event', Lang.bind(this, function (actor) {
                this._select(actor._index); return false;
            }));

            row.add_child(tile);
            this._tiles.push(tile);
        }

        let rem = apps.length % cols;
        if (rem) {
            for (let k = rem; k < cols; k++) row.add_child(new St.Widget({ width: this.TILE_W }));
        }
        // keep short pages from collapsing upward
        this._gridBox.add_child(new St.Widget({ y_expand: true }));

        this._renderDots();
        this._select(Math.min(this._sel, this._tiles.length - 1));
        this._gridKey = this._stateKey();
    },

    _select: function (i) {
        if (!this._tiles.length) return;
        if (i < 0) i = 0;
        if (i > this._tiles.length - 1) i = this._tiles.length - 1;
        for (let k = 0; k < this._tiles.length; k++) {
            this._tiles[k].set_style_class_name(k === i ? 'jarvis-drawer-tile-on' : 'jarvis-drawer-tile');
        }
        this._sel = i;
    },

    _launchSelected: function () {
        if (this._tiles.length) this._launch(this._tiles[this._sel]._app);
    },

    _launch: function (app) {
        this.close();
        try { app.info.launch([], null); }
        catch (e) { global.logError('jarvis-drawer: launch failed: ' + e); }
    },

    _onKey: function (actor, event) {
        let sym = event.get_key_symbol();
        let cols = this._colsPerPage();

        if (sym === Clutter.KEY_Escape) { this.close(); return true; }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            this._launchSelected(); return true;
        }
        if (sym === Clutter.KEY_Page_Down) { this._turnPage(1); return true; }
        if (sym === Clutter.KEY_Page_Up)   { this._turnPage(-1); return true; }
        if (sym === Clutter.KEY_Right) {
            // at the right-hand edge, step onto the next page instead of stopping
            if (this._sel >= this._tiles.length - 1 || this._sel % cols === cols - 1) {
                if (this._page < this._pageCount() - 1) { this._turnPage(1); return true; }
            }
            this._select(this._sel + 1); return true;
        }
        if (sym === Clutter.KEY_Left) {
            if (this._sel % cols === 0) {
                if (this._page > 0) { this._turnPage(-1); return true; }
            }
            this._select(this._sel - 1); return true;
        }
        if (sym === Clutter.KEY_Down)  { this._select(this._sel + cols); return true; }
        if (sym === Clutter.KEY_Up)    { this._select(this._sel - cols); return true; }
        return false; // anything else keeps typing into the search box
    }
};

function main(metadata, orientation, panelHeight, instanceId) {
    return new JarvisDrawer(metadata, orientation, panelHeight, instanceId);
}
