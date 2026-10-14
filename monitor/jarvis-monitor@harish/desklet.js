// Jarvis Monitor - Cinnamon desklet port of the KDE Plasma "Jarvis Monitor"
// widget (github.com/K-S-Harish-Balagi/JARVIS_widget). Same HUD idea, but
// Plasma's ksysguard sensor tree doesn't exist here - every number below is
// read straight from /proc, /sys and Gio's filesystem-info API on a plain
// timer instead of subscribed sensors.
//
// Visual language is a from-scratch redesign (2026-09-02) of the first pass:
// a CPU spectrum-bar meter instead of tiny illegible per-core rings, rings
// whose label/value/detail no longer collide with the stroke, a glowing
// track/fill treatment instead of a near-invisible one, and a Rajdhani +
// JetBrains Mono pairing instead of one flat monospace everywhere. See
// OPERATIONS.log in this repo folder for the build/measurement history.

const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cairo = imports.cairo;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const ByteArray = imports.byteArray;

const SIGNAL = [0.796, 0.651, 0.969];   // #cba6f7 mauve - primary accent
const AMBER  = [0.976, 0.886, 0.686];   // #f9e2af yellow - warning severity
const RED    = [0.953, 0.545, 0.659];   // #f38ba8 red - critical severity
const TRACK_ALPHA = 0.16; // was 0.08 in the first pass - too faint to read as "how full"

// Per-metric identity colors, restored from the KDE original - the Cinnamon
// port had collapsed every stat ring to the same SIGNAL cyan, so nothing
// was distinguishable by color alone until it hit a warning threshold.
const RAM_RGB  = [0.537, 0.706, 0.980]; // #89b4fa blue
const ZRAM_RGB = [0.976, 0.886, 0.686]; // #f9e2af yellow
const SWAP_RGB = [0.580, 0.886, 0.835]; // #94e2d5 teal
// Was #5e96c7 - only 2 degrees of hue away from RAM's blue, i.e.
// functionally the same color. A desaturated neutral reads as clearly
// different at a glance without landing near the amber/red severity hues.
const DISK_RGB = [0.455, 0.780, 0.925]; // #74c7ec sky
const GPU_RGB  = [0.706, 0.745, 0.996]; // #b4befe lavender

function rgbToHex(rgb) {
    return '#' + rgb.map(function (c) {
        return Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0');
    }).join('');
}

// Real filesystems only - keeps gvfs/portal/rofiles-fuse/tmpfs/proc/sysfs
// noise out of /proc/mounts without hardcoding any particular device.
const FS_WHITELIST = ['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs',
    'ntfs', 'ntfs3', 'fuseblk', 'vfat', 'exfat', 'jfs', 'iso9660'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function compactBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return "—";
    let units = ["B", "K", "M", "G", "T"];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    // The board writes "5.1G / 7.0G" but "125G / 648G" - one decimal only
    // below 10. Always carrying a decimal overflowed the ring columns and
    // ran neighbouring captions into each other.
    return (v >= 10 ? Math.round(v).toString() : v.toFixed(1)) + units[i];
}

function severityRGB(percent, normalRGB) {
    if (percent >= 90) return RED;
    if (percent >= 70) return AMBER;
    return normalRGB;
}

// Accepts the "#rrggbb" a colorchooser setting stores, or a Clutter-style
// "rgb(r,g,b)" string - whichever this Cinnamon version hands back.
function parseColor(str, fallback) {
    if (!str) return fallback;
    let m = str.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (m) {
        return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
    }
    m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return [parseInt(m[1]) / 255, parseInt(m[2]) / 255, parseInt(m[3]) / 255];
    return fallback;
}

function JarvisMonitorDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

JarvisMonitorDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this.metadata = metadata;

        this.settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
        this.settings.bindProperty(Settings.BindingDirection.IN, "accentColor", "accentColor", this._onEffectSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "showEffects", "showEffects", this._onEffectSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "showBattery", "showBattery", this._onLayoutSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "showNetwork", "showNetwork", this._onLayoutSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "showZram", "showZram", this._onLayoutSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "showGpu", "showGpu", this._onLayoutSettingChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "minDiskSizeGiB", "minDiskSizeGiB", null, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "updateIntervalMs", "updateIntervalMs", this._onIntervalChanged, null);

        // /proc/stat snapshot from the previous poll, per core - a single
        // reading can't give a percentage, only the delta between two can.
        this._prevCoreStat = null;
        this._prevNet = null; // {bytes, time}
        this._diskGauges = {}; // mountpoint -> row actors, rebuilt only when the volume list changes
        this._knownVolumeKey = "";

        this._buildUI();
        this._scheduleTimer();
        // Deferred rather than called inline: right after _buildUI() the
        // widget tree isn't attached to the stage yet, so anything reading
        // theme-dependent text metrics (the ring value labels' manual
        // centering) would resolve against an unrealized actor and warn.
        // One idle-loop tick later, the tree is live and metrics are real.
        Mainloop.idle_add(Lang.bind(this, function () {
            this._tick();
            this._updateStorageVolumes();
            this._fitPanelToContent();
            // the first measurement can land before text metrics settle, so
            // take one more pass shortly after
            Mainloop.timeout_add(1200, Lang.bind(this, function () {
                this._fitPanelToContent();
                return false;
            }));
            return false; // GLib.SOURCE_REMOVE - run once
        }));
    },

    // Storage volumes get their own slower timer. Every tick used to reparse
    // /proc/mounts and run a Gio filesystem-info query per candidate device
    // even though the set of mounted volumes almost never changes second to
    // second - real work for no real benefit on a machine that's already
    // tight on memory/CPU headroom. 12s is frequent enough to notice a USB
    // stick shortly after plugging it in without paying that cost every tick.
    SLOW_INTERVAL_MS: 12000,

    _scheduleTimer: function () {
        if (this._timeoutId) Mainloop.source_remove(this._timeoutId);
        this._timeoutId = Mainloop.timeout_add(this.updateIntervalMs || 3000, Lang.bind(this, function () {
            this._tick();
            return true; // GLib.SOURCE_CONTINUE
        }));
        // gpu_busy_percent is an instantaneous reading that spikes for a
        // fraction of a second and sits at 0 in between, so one read per
        // tick almost always catches a 0 and the ring never moved. Sample it
        // four times a second (a single tiny sysfs read) and report the
        // average over each tick instead.
        if (this._gpuSampleId) Mainloop.source_remove(this._gpuSampleId);
        this._gpuSampleId = Mainloop.timeout_add(250, Lang.bind(this, this._sampleGpu));
        if (this._slowTimeoutId) Mainloop.source_remove(this._slowTimeoutId);
        this._slowTimeoutId = Mainloop.timeout_add(this.SLOW_INTERVAL_MS, Lang.bind(this, function () {
            this._updateStorageVolumes();
            return true;
        }));
    },

    _onIntervalChanged: function () { this._scheduleTimer(); },

    _onEffectSettingChanged: function () {
        this._accentRGB = parseColor(this.accentColor, SIGNAL);
        if (this._grid) this._grid.visible = this.showEffects;
        if (this._brackets) this._brackets.forEach(b => b.visible = this.showEffects);
        if (this._titleLabel) this._titleLabel.set_style('color: ' + this.accentColor + ';');
        if (this._sectionLabel) this._sectionLabel.set_style('color: #a6adc8;');
        // battery keeps its own state colour (see _updateBattery), not the accent
    },

    _onLayoutSettingChanged: function () {
        if (this._batteryRow) this._batteryRow.visible = this.showBattery;
        if (this._netRow) this._netRow.visible = this.showNetwork;
        if (this._zramRing) this._zramRing.actor.visible = this.showZram;
        // GPU stays hidden regardless of the setting if no supported sysfs
        // sensor was found at build time - the setting only controls whether
        // to show it when one *is* available.
        if (this._gpuRing) this._gpuRing.actor.visible = this.showGpu && !!this._gpuPaths;
    },

    on_desklet_removed: function () {
        if (this._timeoutId) Mainloop.source_remove(this._timeoutId);
        if (this._slowTimeoutId) Mainloop.source_remove(this._slowTimeoutId);
        if (this._gpuSampleId) Mainloop.source_remove(this._gpuSampleId);
    },

    // St.Label ellipsizes by default whenever its allocation ends up even
    // slightly under its text's natural width - which several labels here
    // hit despite there being real room to spare, cutting "SWAP" to "SW…"
    // and "CPU · 8 THREADS" to "CPU · 8 THREAD…". None of this HUD's labels
    // should ever truncate, so this is applied unconditionally rather than
    // trusted to available space.
    _noEllipsis: function (label) {
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(0); // Pango.EllipsizeMode.NONE
        return label;
    },

    // Manual centering: get_preferred_width/height on a Clutter.Text-backed
    // actor is computable synchronously from font metrics alone, so this
    // works without waiting on a layout pass - the same "plain fixed
    // positioning" approach used throughout, since no BinLayout per-child
    // alignment path proved reliable on this Cinnamon/St build (see the
    // corner-bracket note in _buildUI).
    _centerInBox: function (actor, boxW, boxH) {
        let [, natW] = actor.get_preferred_width(-1);
        let [, natH] = actor.get_preferred_height(-1);
        actor.set_position(Math.round((boxW - natW) / 2), Math.round((boxH - natH) / 2));
    },

    // ---- gauge ring: label above, value centered inside the ring only, ---
    // ---- detail below - nothing overlaps the stroke anymore. -------------

    // boxWidth lets the column be wider than the ring itself, so detail text
    // like "953.9G / 297.0G" has room to fit instead of ellipsizing - the
    // ring's visual diameter and the text column's width are deliberately
    // decoupled, same principle as the KDE original's statBoxWidth.
    _makeRing: function (size, thickness, label, showDetail, boxWidth) {
        let col = new St.BoxLayout({ vertical: true, width: boxWidth || size });
        col.set_style('spacing: 6px;');

        // Design order is ring first, then caption, then detail - the
        // caption used to sit above the ring.
        let ringBox = new St.Widget({ width: size, height: size });
        ringBox.x_align = Clutter.ActorAlign.CENTER;
        col.add_child(ringBox);

        let nameLabel = this._noEllipsis(new St.Label({ text: label, style_class: 'jarvis-ring-label' }));
        nameLabel.x_align = Clutter.ActorAlign.CENTER;

        let area = new St.DrawingArea();
        area.set_size(size, size);
        area._percent = 0;
        area._colorRGB = SIGNAL;
        area._thickness = thickness;
        area.connect('repaint', Lang.bind(this, this._paintRing));
        ringBox.add_child(area);

        // Not centered yet here deliberately - get_preferred_width() can't
        // resolve a theme node until this actor is actually in the stage,
        // which it isn't until the whole tree this belongs to is attached.
        // The deferred first tick in _init() does the real initial centering.
        let valueLabel = new St.Label({ text: "0%", style_class: showDetail ? 'jarvis-value' : 'jarvis-value-small' });
        ringBox.add_child(valueLabel);
        col.add_child(nameLabel);

        let detailLabel = null;
        if (showDetail) {
            detailLabel = this._noEllipsis(new St.Label({ text: "", style_class: 'jarvis-detail' }));
            detailLabel.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(detailLabel);
        }

        return { actor: col, area: area, valueLabel: valueLabel, detailLabel: detailLabel, size: size };
    },

    _paintRing: function (area) {
        let cr = area.get_context();
        let [w, h] = [area.width, area.height];
        let cx = w / 2, cy = h / 2;
        let t = area._thickness;
        let r = Math.min(w, h) / 2 - t / 2 - 2;
        let start = -Math.PI / 2;
        let full = start + Math.PI * 2;

        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setLineWidth(t);
        cr.setSourceRGBA(1, 1, 1, TRACK_ALPHA);
        cr.arc(cx, cy, r, start, full);
        cr.stroke();

        let pct = clamp(area._percent || 0, 0, 100);
        if (pct > 0) {
            let end = start + Math.PI * 2 * (pct / 100);
            let [rr, gg, bb] = area._colorRGB;
            // soft glow pass underneath, then a crisp pass on top - Cairo has
            // no blur primitive, so a wider low-alpha stroke fakes it cheaply.
            cr.setLineWidth(t + 5);
            cr.setSourceRGBA(rr, gg, bb, 0.18);
            cr.arc(cx, cy, r, start, end);
            cr.stroke();
            cr.setLineWidth(t);
            cr.setSourceRGBA(rr, gg, bb, 0.95);
            cr.arc(cx, cy, r, start, end);
            cr.stroke();
        }
        cr.$dispose();
    },

    // Only redraws when something actually changed. The arc is drawn to
    // whole-percent precision, so a fractional wobble that rounds to the
    // same integer is invisible - repainting it (and re-measuring text to
    // re-centre a label whose string is identical) was pure waste every tick.
    _updateRing: function (ring, percent, colorRGB, valueText, detailText) {
        let rounded = Math.round(percent);
        let colorChanged = ring.area._colorRGB !== colorRGB;
        if (rounded !== ring._lastPct || colorChanged) {
            ring._lastPct = rounded;
            ring.area._percent = percent;
            ring.area._colorRGB = colorRGB;
            ring.area.queue_repaint();
        }
        // Tint the number only for an actual alarm state (amber/red) - an
        // easy-to-miss thin ring going red should be reinforced by the digits
        // too. Tried tinting it to the per-metric normal color as well, but
        // those are soft/pastel by design (fine for a thin stroke, not for
        // bold 26px body text) and made the numbers noticeably harder to
        // read at rest - reverting to the bright default color there instead.
        if (colorChanged) {
            // set_style("") isn't valid - St's CSS parser asserts on an empty
            // buffer (St-CRITICAL, non-fatal but spams the log) - so the
            // "reset" case sets the class default explicitly instead of
            // clearing the inline style.
            let isAlarm = colorRGB === AMBER || colorRGB === RED;
            ring.valueLabel.set_style('color: ' + (isAlarm ? rgbToHex(colorRGB) : '#cdd6f4') + ';');
        }
        if (valueText !== ring._lastValueText) {
            ring._lastValueText = valueText;
            ring.valueLabel.set_text(valueText);
            this._centerInBox(ring.valueLabel, ring.size, ring.size);
        }
        if (ring.detailLabel && detailText !== undefined && detailText !== ring._lastDetailText) {
            ring._lastDetailText = detailText;
            ring.detailLabel.set_text(detailText);
        }
    },

    // ---- CPU per-core rings ------------------------------------------------
    // Second attempt at this - the very first version of this desklet (KDE
    // port) used small per-core rings and they were replaced with a bar
    // spectrum on 2026-09-02 for being "tiny illegible rings". Revisiting by
    // request, this time built on _makeRing (shared with the stat row) so it
    // gets the same centering/no-ellipsis/box-width fixes that didn't exist
    // yet for the first attempt - a fairer test of whether rings themselves
    // were the problem, or just how they were built the first time.
    // Ring itself is deliberately smaller than the stat rings (44 vs 68) -
    // cores are supporting detail, not the headline numbers. Packed tightly
    // (60, not stretched to match the stat row) on purpose now - the gap
    // that leaves to the right of the 4-column grid is deliberate: it's
    // where the STORAGE placeholder ring lives (see _buildUI), not empty
    // space to be filled by stretching the cores themselves.
    CORE_RING_SIZE: 44,
    CORE_RING_BOX_W: 60,

    // Groups cpu indices sharing a physical core (SMT siblings), reading
    // /sys/.../topology/core_id at runtime rather than assuming a numbering
    // scheme - this machine happens to pair consecutively (cpu0+1, cpu2+3,
    // ...) but that's not universal across CPUs/kernels. Falls back to one
    // thread per group (no visual pairing) if the topology file is missing.
    _discoverCoreTopology: function () {
        let groups = [];
        let indexOfCore = {};
        for (let i = 0; i < this._nproc; i++) {
            let raw = this._readFile("/sys/devices/system/cpu/cpu" + i + "/topology/core_id");
            let key = raw !== null ? raw.trim() : ("cpu" + i);
            if (indexOfCore[key] === undefined) {
                indexOfCore[key] = groups.length;
                groups.push([]);
            }
            groups[indexOfCore[key]].push(i);
        }
        return groups;
    },

    // ---- storage bar widget -----------------------------------------------

    // Fixed width instead of x_expand: the bar used to stretch to the full
    // 170px STORAGE column, landing flush against the panel's right border -
    // right where the corner-bracket decoration also sits - with no breathing
    // room at all (unlike every other edge in this HUD, which keeps a real
    // margin). First pass (150px) still read as cramped against the bracket;
    // 130px leaves a clearer ~40px gap, left-aligned like everything else in
    // the column.
    STORAGE_BAR_W: 215,

    _makeStorageBar: function () {
        let col = new St.BoxLayout({ vertical: true });
        col.set_style('spacing: 5px;');

        // Name + percent share a row (name left, percent right) - this used
        // to be the DISK ring's job for root only; now every volume gets its
        // own percent, not just root, which the ring never showed anyway.
        let labelRow = new St.BoxLayout({ vertical: false, width: this.STORAGE_BAR_W });
        let label = this._noEllipsis(new St.Label({ text: "", style_class: 'jarvis-storage-label' }));
        labelRow.add_child(label);
        // the board prints the device beside the name, e.g. "ROOT nvme0n1p5"
        let devLabel = this._noEllipsis(new St.Label({ text: "", style_class: 'jarvis-storage-detail' }));
        devLabel.y_align = Clutter.ActorAlign.CENTER;
        devLabel.set_style('margin-left: 6px;');
        labelRow.add_child(devLabel);
        let labelSpacer = new St.Widget({ x_expand: true });
        labelRow.add_child(labelSpacer);
        let percentLabel = new St.Label({ text: "", style_class: 'jarvis-storage-percent' });
        labelRow.add_child(percentLabel);
        col.add_child(labelRow);

        let track = new St.Widget({ layout_manager: new Clutter.BinLayout(), height: 8, width: this.STORAGE_BAR_W });
        let area = new St.DrawingArea({ height: 8, width: this.STORAGE_BAR_W });
        area._percent = 0;
        area._colorRGB = SIGNAL;
        area.connect('repaint', Lang.bind(this, this._paintBar));
        track.add_child(area);
        col.add_child(track);

        let detail = new St.Label({ text: "", style_class: 'jarvis-storage-detail' });
        col.add_child(detail);

        return { actor: col, label: label, devLabel: devLabel, percentLabel: percentLabel, area: area, detail: detail };
    },

    _paintBar: function (area) {
        let cr = area.get_context();
        let [w, h] = [area.width, area.height];
        cr.setSourceRGBA(1, 1, 1, TRACK_ALPHA);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        let pct = clamp(area._percent || 0, 0, 100);
        if (pct > 0) {
            let [rr, gg, bb] = area._colorRGB;
            let fw = w * (pct / 100);
            cr.setSourceRGBA(rr, gg, bb, 0.25);
            cr.rectangle(0, -2, fw, h + 4);
            cr.fill();
            cr.setSourceRGBA(rr, gg, bb, 0.9);
            cr.rectangle(0, 0, fw, h);
            cr.fill();
        }
        cr.$dispose();
    },

    // ---- CPU trend sparkline ------------------------------------------------
    // A single number can't say whether load is climbing or just spiked once.
    // This is real diagnostic value the HUD's existing footprint had room
    // for already, not an addition that needed new space.

    SPARK_W: 70,
    SPARK_H: 20,
    SPARK_SAMPLES: 40, // 40 * default 3000ms tick = last ~2 minutes

    _pushCpuHistory: function (avgPct) {
        if (!this._cpuHistory) this._cpuHistory = [];
        this._cpuHistory.push(avgPct);
        if (this._cpuHistory.length > this.SPARK_SAMPLES) this._cpuHistory.shift();
        if (this._sparkline) this._sparkline.queue_repaint();
    },

    _paintSparkline: function (area) {
        let cr = area.get_context();
        let [w, h] = [area.width, area.height];
        let hist = this._cpuHistory || [];

        // No track box behind the trend: the approved design has no
        // sparkline at all, so the line stays (it earns its place) but the
        // grey slab it used to sit on does not.

        if (hist.length >= 2) {
            let stepX = w / (this.SPARK_SAMPLES - 1);
            let startIdx = this.SPARK_SAMPLES - hist.length;
            cr.setLineWidth(1.5);
            cr.setSourceRGBA(SIGNAL[0], SIGNAL[1], SIGNAL[2], 0.9);
            hist.forEach(function (pct, i) {
                let x = (startIdx + i) * stepX;
                let y = h - (clamp(pct, 0, 100) / 100) * h;
                if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
            });
            cr.stroke();
        }
        cr.$dispose();
    },

    // ---- decorative canvas (grid) ------------------------------------------

    _paintGrid: function (area) {
        let cr = area.get_context();
        let [w, h] = [area.width, area.height];
        cr.setSourceRGBA(0.44, 0.82, 0.91, 0.05);
        cr.setLineWidth(1);
        let step = 26;
        for (let x = step; x < w; x += step) {
            cr.moveTo(x + 0.5, 0); cr.lineTo(x + 0.5, h); cr.stroke();
        }
        for (let y = step; y < h; y += step) {
            cr.moveTo(0, y + 0.5); cr.lineTo(w, y + 0.5); cr.stroke();
        }
        cr.$dispose();
    },

    // ---- UI build ------------------------------------------------------------

    _buildUI: function () {
        this._accentRGB = parseColor(this.accentColor, SIGNAL);
        this._nproc = GLib.get_num_processors() || 4;

        // Explicit size: BinLayout's natural-size negotiation under-measures
        // the real content on this build, so the HUD's footprint is pinned
        // here instead - same spirit as the original QML's hudMinWidth/
        // hudMinHeight constants. Narrowed 680->640 by tightening ring/box
        // sizes, gutters and padding proportionally (see PAD_X and the ring
        // row comments below) rather than just shrinking the number and
        // hoping - the STORAGE_BAR_W and stat-ring box-width margins that
        // fixed earlier truncation/crowding issues are still intact at 640.
        // HUD_H: was 464 while core rings matched the stat rings' size
        // (68px, needing 424px of content height); once cores were shrunk
        // back down to 44px (visually secondary to the stat row), the
        // measured natural height dropped to 374px, so this follows it back
        // down rather than leaving ~50px of dead space at the bottom.
        const HUD_W = 773, HUD_H = 456;
        this._hudW = HUD_W;
        this._hudH = HUD_H;
        let root = new St.Widget({ layout_manager: new Clutter.BinLayout(), width: HUD_W, height: HUD_H });
        this.setContent(root);

        let bg = new St.Bin({ style_class: 'jarvis-hud', x_expand: true, y_expand: true });
        root.add_child(bg);

        this._grid = new St.DrawingArea({ x_expand: true, y_expand: true, visible: this.showEffects });
        this._grid.connect('repaint', Lang.bind(this, this._paintGrid));
        root.add_child(this._grid);

        // Corner brackets and the scan line need one-off pixel placement that
        // BinLayout's per-child alignment wouldn't hold onto in this build
        // (every x_align/y_align path tried - actor property, constructor
        // arg, and the layout manager's own set_alignment() - either got
        // ignored or isn't a real method here). A plain St.Widget with no
        // layout_manager falls back to Clutter's classic fixed-position
        // behaviour, so children keep whatever set_position()/set_size() they
        // were given - the same trick the corner brackets rely on below.
        let overlay = new St.Widget({ x_expand: true, y_expand: true, width: HUD_W, height: HUD_H });
        root.add_child(overlay);

        // The sweeping scan line that used to live here was removed on
        // 2026-09-05 after measuring it: a 680x48 translucent bar animating
        // across the panel at 60fps cost ~13% of a CPU core continuously,
        // about two thirds of this widget's entire footprint (21.1% with it
        // vs 7.5% without, against a 3.3% Cinnamon baseline). Because it was
        // translucent, every frame forced a re-blend of everything beneath
        // it, which is expensive on this machine's integrated graphics.
        // The static grid and corner brackets cost nothing extra by
        // comparison, so the HUD look survives without it.

        // Corner brackets, drawn as two solid bars (like the original QML's
        // two Rectangles per corner) rather than CSS border-side shorthand,
        // which St's mini-CSS engine doesn't reliably render.
        this._brackets = [];
        const BRACKET = 20, MARGIN = 6;
        [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(Lang.bind(this, function (corner) {
            let isRight = corner[0] === 1, isBottom = corner[1] === 1;
            let box = new St.Widget({ visible: this.showEffects });
            box.set_size(BRACKET, BRACKET);
            box.set_position(isRight ? HUD_W - MARGIN - BRACKET : MARGIN, isBottom ? HUD_H - MARGIN - BRACKET : MARGIN);

            let hBar = new St.Widget({ style_class: 'jarvis-bracket-bar' });
            hBar.set_size(BRACKET, 2);
            hBar.set_position(0, isBottom ? BRACKET - 2 : 0);
            let vBar = new St.Widget({ style_class: 'jarvis-bracket-bar' });
            vBar.set_size(2, BRACKET);
            vBar.set_position(isRight ? BRACKET - 2 : 0, 0);
            box.add_child(hBar);
            box.add_child(vBar);

            overlay.add_child(box);
            this._brackets.push(box);
        }));

        // Explicit inset via position/size, not CSS padding: .jarvis-hud's
        // padding is set on `bg`, a decorative-only sibling with no children
        // - it was never actually applied to `content`'s layout (they're
        // independent children of the same BinLayout, not parent/child), so
        // content rendered flush to the panel edges and, with more content
        // than the old design, one whole row spilled past the visible border
        // (Clutter doesn't clip a child's overflow by default).
        const PAD_X = 20, PAD_TOP = 20, PAD_BOTTOM = 18;
        let outer = new St.BoxLayout({ vertical: true, x_expand: true });
        this._outer = outer;
        this._root = root;
        // .jarvis-hud's padding is on a sibling Bin, so it never insets this
        // content - the cards were sitting flush against the panel edge.
        outer.set_style('spacing: 10px; padding: 14px 16px 12px;');
        let content = new St.BoxLayout({ vertical: false });
        content.set_position(PAD_X, PAD_TOP);
        content.set_size(HUD_W - PAD_X * 2, HUD_H - PAD_TOP - PAD_BOTTOM);
        root.add_child(outer);

        let left = new St.BoxLayout({ vertical: true, x_expand: true });
        left.set_style('spacing: 8px;');
        this._left = left;
        content.add_child(left);

        // header row: brand (title + HP-MINT subtitle) and battery
        let header = new St.BoxLayout({ vertical: false, x_expand: true });
        header.set_style('spacing: 10px;');

        let brandRow = new St.BoxLayout({ vertical: false });
        brandRow.set_style('spacing: 8px;');
        this._boltIcon = new St.Icon({ icon_name: 'preferences-system-power-symbolic', icon_size: 16 });
        this._boltIcon.y_align = Clutter.ActorAlign.CENTER;
        this._boltIcon.set_style('color: ' + this.accentColor + ';');
        brandRow.add_child(this._boltIcon);

        let brand = new St.BoxLayout({ vertical: false });
        brand.set_style('spacing: 8px;');
        this._titleLabel = new St.Label({ text: "System monitor", style_class: 'jarvis-title' });
        this._titleLabel.set_style('color: ' + this.accentColor + ';');
        this._titleLabel.clutter_text.set_line_wrap(false);
        this._titleLabel.clutter_text.set_ellipsize(0); // Pango.EllipsizeMode.NONE
        brand.add_child(this._titleLabel);
        let subLabel = this._noEllipsis(new St.Label({ text: "hp-mint", style_class: 'jarvis-subtitle' }));
        // one inline meta label: "hp-mint · up 7d 17h", as on the board
        this._uptimeLabel = subLabel;
        brand.add_child(subLabel);
        brandRow.add_child(brand);
        header.add_child(brandRow);

        // Was a single flex spacer, leaving a dead gap between the title and
        // the battery cluster - splitting it in two around a real uptime
        // readout uses that space instead of just being empty.
        let leftSpacer = new St.Widget({ x_expand: true });
        header.add_child(leftSpacer);

        let rightSpacer = new St.Widget({ x_expand: true });
        header.add_child(rightSpacer);

        // y_align: CENTER on both - the row's cross-axis allocation is taller
        // than either child's natural size, and St doesn't center them in it
        // by default, so the icon and text sat at slightly different
        // baselines. The icon is also tinted to the accent color instead of
        // the icon theme's flat default gray, which was low-contrast enough
        // against the HUD background to nearly disappear.
        this._batteryRow = new St.BoxLayout({ vertical: false, visible: this.showBattery });
        this._batteryRow.set_style('spacing: 7px; padding: 3px 10px; border-radius: 12px;'
            + ' background-color: rgba(205, 214, 244, 0.08);');
        this._batteryIcon = new St.Icon({ icon_name: 'battery-full-symbolic', icon_size: 22 });
        this._batteryIcon.y_align = Clutter.ActorAlign.CENTER;
        this._batteryIcon.set_style('color: ' + this.accentColor + ';');
        this._batteryLabel = new St.Label({ text: "—", style_class: 'jarvis-battery-text' });
        this._batteryLabel.y_align = Clutter.ActorAlign.CENTER;
        this._batteryRow.add_child(this._batteryIcon);
        this._batteryRow.add_child(this._batteryLabel);
        header.add_child(this._batteryRow);
        this._header = header;
        outer.add_child(header);
        this._content = content;
        outer.add_child(content);

        // CPU spectrum: section label + live average, then one bar per core
        let cpuHead = new St.BoxLayout({ vertical: false, x_expand: true });
        cpuHead.set_style('spacing: 10px;');
        let cpuLabel = this._noEllipsis(new St.Label({ text: "PROCESSOR", style_class: 'jarvis-section-title-inline' }));
        cpuHead.add_child(cpuLabel);
        let cpuSpacer = new St.Widget({ x_expand: true });
        cpuHead.add_child(cpuSpacer);
        // the board has no trend line in the Processor header, so the
        // sparkline is not built (its painter stays for a later toggle)
        this._cpuAvgLabel = new St.Label({ text: "0% average", style_class: 'jarvis-cpu-avg' });
        cpuHead.add_child(this._cpuAvgLabel);

        // One column per physical core, its SMT threads stacked inside -
        // not just a layout trick: this is a 4-core/8-thread CPU, so "C1
        // over C5" (say) actually means something (same physical core)
        // rather than an arbitrary top-4/bottom-4 split.
        let coreGrid = new St.BoxLayout({ vertical: false });
        coreGrid.set_style('spacing: 8px;');
        this._coreRings = [];
        // The board runs Core 1-4 across the top and 5-8 underneath, in plain
        // numeric order, so the grid is built by column index rather than by
        // SMT sibling pairs the way it used to be.
        let perRow = 4;
        for (let c = 0; c < perRow; c++) {
            let col = new St.BoxLayout({ vertical: true });
            col.set_style('spacing: 8px;');
            for (let r = 0; r * perRow + c < this._nproc; r++) {
                let cpuIndex = r * perRow + c;
                let ring = this._makeRing(this.CORE_RING_SIZE, 5, "Core " + (cpuIndex + 1), false, this.CORE_RING_BOX_W);
                col.add_child(ring.actor);
                this._coreRings[cpuIndex] = ring;
            }
            coreGrid.add_child(col);
        }

        // (the old "SOON" reserve ring is gone - thermals took that job)

        // Processor and Thermals sit side by side, as laid out on page 11
        let procCard = new St.BoxLayout({ vertical: true, width: 293 });
        procCard.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 8px;');
        procCard.add_child(cpuHead);
        procCard.add_child(coreGrid);

        let procRow = new St.BoxLayout({ vertical: false });
        procRow.set_style('spacing: 8px;');
        procRow.x_align = Clutter.ActorAlign.START;
        procRow.add_child(procCard);
        // Thermals card, beside Processor
        this._thermRow = new St.BoxLayout({ vertical: true });
        this._thermRow.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 8px;');
        this._thermRow.width = 182;
        this._thermRow.add_child(this._noEllipsis(new St.Label({ text: "THERMALS AND LOAD", style_class: 'jarvis-net-label' })));
        // each sensor is a labelled row with a bar under it, like the board
        this._thermBars = {};
        let mkTherm = Lang.bind(this, function (key, name, color) {
            let box = new St.BoxLayout({ vertical: true, x_expand: true });
            box.set_style('spacing: 4px;');
            let top = new St.BoxLayout({ vertical: false, x_expand: true });
            top.add_child(this._noEllipsis(new St.Label({ text: name, style_class: 'jarvis-storage-label' })));
            top.add_child(new St.Widget({ x_expand: true }));
            let val = new St.Label({ text: "—", style_class: 'jarvis-net-value' });
            val.set_style('color: ' + color + ';');
            top.add_child(val);
            box.add_child(top);
            let track = new St.Widget({ height: 6, x_expand: true });
            track.set_style('background-color: rgba(205, 214, 244, 0.10); border-radius: 3px;');
            let fill = new St.Widget({ height: 6, width: 0 });
            fill.set_style('background-color: ' + color + '; border-radius: 3px;');
            track.add_child(fill);
            box.add_child(track);
            this._thermBars[key] = { value: val, fill: fill, track: track };
            this._thermRow.add_child(box);
        });
        mkTherm('cpu', 'CPU', '#a6e3a1');
        mkTherm('gpu', 'iGPU', '#94e2d5');
        mkTherm('nvme', 'NVMe', '#89b4fa');
        let thermFoot = new St.BoxLayout({ vertical: false, x_expand: true });
        thermFoot.set_style('spacing: 10px;');
        thermFoot.add_child(new St.Widget({ x_expand: true }));
        this._thermLoad = new St.Label({ text: "load —", style_class: 'jarvis-detail' });
        thermFoot.add_child(this._thermLoad);
        this._thermRow.add_child(new St.Widget({ y_expand: true }));
        this._thermRow.add_child(thermFoot);
        procRow.add_child(this._thermRow);
        left.add_child(procRow);

        // stat ring row - RAM / ZRAM / SWAP / GPU. DISK used to be here too,
        // but it only ever showed root's usage - duplicating the ROOT bar
        // already in STORAGE while saying nothing about /mnt/shared. Storage
        // now gets a percent readout per volume instead (see
        // _updateStorageVolumes). Sizes tightened (76->68, 100->92, 12->10)
        // as part of narrowing the whole HUD - still wide enough that detail
        // text doesn't ellipsize (92 has more margin than the 84 already
        // proven safe), just less of it than the row strictly needed.
        this._gpuPaths = this._discoverGpu();
        let statRow = new St.BoxLayout({ vertical: false });
        statRow.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 8px;');
        this._ramRing = this._makeRing(68, 6, "RAM", true, 91);
        this._zramRing = this._makeRing(68, 6, "ZRAM", true, 91);
        this._swapRing = this._makeRing(68, 6, "Swapfile", true, 91);
        this._rootRing = this._makeRing(68, 6, "ROOT", true, 91);
        this._gpuRing = this._makeRing(68, 6, "GPU", true, 91);
        statRow.add_child(this._ramRing.actor);
        statRow.add_child(this._zramRing.actor);
        statRow.add_child(this._swapRing.actor);
        statRow.add_child(this._rootRing.actor);
        statRow.add_child(this._gpuRing.actor);
        this._zramRing.actor.visible = this.showZram;
        this._gpuRing.actor.visible = this.showGpu && !!this._gpuPaths;
        // the board titles this card; it had none
        let memCard = new St.BoxLayout({ vertical: true, width: 483 });
        // a vertical BoxLayout stretches its children to full width unless the
        // child says otherwise, which was widening this card past the
        // Processor+Thermals row above it
        memCard.x_align = Clutter.ActorAlign.START;
        memCard.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 8px;');
        memCard.add_child(this._noEllipsis(new St.Label({ text: "MEMORY, DISK AND GRAPHICS", style_class: 'jarvis-net-label' })));
        statRow.set_style('spacing: 0px;');
        statRow.width = 459;   // 483 card - 24 padding; 5 x 91 columns
        memCard.add_child(statRow);
        left.add_child(memCard);



        // network + thermals are built as cards in the right column below


        // margin_left/margin_right silently had no effect here - explicit
        // spacer widgets on either side of the divider line, guaranteed to
        // reserve real layout width the way the fixed-size widgets do.
        content.add_child(new St.Widget({ width: 4 }));
        let vdivider = new St.Widget({ style_class: 'jarvis-divider', width: 1 });
        content.add_child(vdivider);
        content.add_child(new St.Widget({ width: 4 }));

        let right = new St.BoxLayout({ vertical: true, width: 245 });
        right.y_align = Clutter.ActorAlign.FILL;
        right.set_style('spacing: 8px;');
        let storageCard = new St.BoxLayout({ vertical: true });
        storageCard.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 10px;');
        this._sectionLabel = this._noEllipsis(new St.Label({ text: "STORAGE", style_class: 'jarvis-section-title' }));
        this._sectionLabel.set_style('color: #a6adc8;');
        storageCard.add_child(this._sectionLabel);
        this._storageColumn = new St.BoxLayout({ vertical: true });
        this._storageColumn.set_style('spacing: 12px;');
        storageCard.add_child(this._storageColumn);
        right.add_child(storageCard);

        // Network card (right column, as in the design)
        this._netRow = new St.BoxLayout({ vertical: true, visible: this.showNetwork });
        this._netRow.set_style('background-color: rgba(49, 50, 68, 0.5); border-radius: 14px; padding: 10px 12px; spacing: 8px;');
        this._netRow.add_child(this._noEllipsis(new St.Label({ text: "NETWORK", style_class: 'jarvis-net-label' })));
        let netVals = new St.BoxLayout({ vertical: false });
        netVals.set_style('spacing: 12px;');
        this._netDown = new St.Label({ text: "0 B/s", style_class: 'jarvis-net-value' });
        this._netUp = new St.Label({ text: "0 B/s", style_class: 'jarvis-net-value' });
        this._netDown.set_style('color: #a6e3a1;');
        this._netUp.set_style('color: #fab387;');
        netVals.add_child(this._netDown);
        netVals.add_child(this._netUp);
        this._netRow.add_child(netVals);
        right.add_child(this._netRow);



        this._right = right;
        content.add_child(right);
    },

    // ---- data collection -------------------------------------------------

    // The panel used to carry a hard-coded height, so the Network card spilled
    // out of the bottom whenever the content grew (an extra volume was enough).
    // Measuring the content and sizing the panel to it removes that whole class
    // of bug. get_preferred_height() needs the actor on the stage, which is why
    // every caller defers to an idle tick.
    // The panel sizes itself to its content so the cards never spill out and
    // no dead strip is left under them. It is computed from the parts rather
    // than asking the content row for its height: that row reports ~75px more
    // than its own tallest child here, which left the panel oversized.
    PANEL_PAD_TOP: 14,
    PANEL_PAD_BOTTOM: 12,
    PANEL_GAP: 10,

    _fitPanelToContent: function () {
        if (!this._root || !this._left || !this._right || !this._header) return;
        try {
            // The content row reports ~59px more than its tallest column needs,
            // and whatever it reports is what both columns get allocated - that
            // surplus was the empty strip along the bottom. So measure the two
            // columns, pin the row to the taller one, and size the panel to it.
            let [, lh] = this._left.get_preferred_height(487);
            let [, rh] = this._right.get_preferred_height(245);
            let [, hh] = this._header.get_preferred_height(this._hudW);
            let rowH = Math.ceil(Math.max(lh, rh));
            this._content.height = rowH;
            let h = Math.ceil(hh + this.PANEL_GAP + rowH
                              + this.PANEL_PAD_TOP + this.PANEL_PAD_BOTTOM);
            if (h > 0 && Math.abs(h - this._root.height) > 1) {
                this._root.height = h;
                this._hudH = h;
            }
        } catch (e) {
            global.logError('jarvis-monitor: could not fit panel: ' + e);
        }
    },

    // Some sysfs files are answered by the laptop's firmware (ACPI) and can
    // take a second to come back: BAT0/status measured 1040 ms here, the NVMe
    // temperature ~50 ms, everything else ~3 ms. A synchronous read of those on
    // the main loop freezes the entire desktop for that long, every tick.
    // load_contents_async does the read on a worker thread instead.
    _readFileAsync: function (path, callback) {
        try {
            Gio.File.new_for_path(path).load_contents_async(null, function (file, res) {
                let text = null;
                try {
                    let [ok, contents] = file.load_contents_finish(res);
                    if (ok) text = ByteArray.toString(contents);
                } catch (e) {}
                callback(text);
            });
        } catch (e) {
            callback(null);
        }
    },

    _readFile: function (path) {
        try {
            let [ok, contents] = GLib.file_get_contents(path);
            if (!ok) return null;
            return ByteArray.toString(contents);
        } catch (e) {
            return null;
        }
    },

    _tick: function () {
        this._updateCpu();
        this._updateMem();
        this._updateSwap();
        this._updateGpu();
        this._updateNetwork();
        this._updateUptime();
        if (this.showBattery) this._updateBattery();
        if (this._rootRing) {
            let fi = this._fsInfo('/');
            if (fi && fi.size > 0) {   // _fsInfo returns {size, used}, not total
                let pct = 100 * fi.used / fi.size;
                this._updateRing(this._rootRing, pct, DISK_RGB,
                    Math.round(pct) + "%", compactBytes(fi.used) + " / " + compactBytes(fi.size));
            }
        }
        this._updateThermals();
        // storage volumes are on their own slower timer - see SLOW_INTERVAL_MS
    },

    _updateUptime: function () {
        if (!this._uptimeLabel) return;
        let text = this._readFile("/proc/uptime");
        if (!text) return;
        let seconds = parseFloat(text.split(" ")[0]) || 0;
        let days = Math.floor(seconds / 86400);
        let hours = Math.floor((seconds % 86400) / 3600);
        let mins = Math.floor((seconds % 3600) / 60);
        let out = days > 0 ? ("up " + days + "d " + hours + "h") : ("up " + hours + "h " + mins + "m");
        if (out !== this._lastUptimeText) {
            this._lastUptimeText = out;
            this._uptimeLabel.set_text('hp-mint · ' + out);
        }
    },

    _updateCpu: function () {
        let text = this._readFile("/proc/stat");
        if (!text) return;
        let lines = text.split("\n");
        let cur = {};
        for (let line of lines) {
            let m = line.match(/^cpu(\d+)\s+(.*)$/);
            if (!m) continue;
            let idx = parseInt(m[1]);
            let fields = m[2].trim().split(/\s+/).map(Number);
            // user nice system idle iowait irq softirq steal
            let idle = fields[3] + (fields[4] || 0);
            let total = fields.reduce((a, b) => a + b, 0);
            cur[idx] = { idle: idle, total: total };
        }
        if (this._prevCoreStat) {
            let sum = 0, n = 0;
            for (let i = 0; i < this._nproc; i++) {
                let ring = this._coreRings[i];
                if (!ring || !cur[i] || !this._prevCoreStat[i]) continue;
                let dTotal = cur[i].total - this._prevCoreStat[i].total;
                let dIdle = cur[i].idle - this._prevCoreStat[i].idle;
                let pct = dTotal > 0 ? clamp(100 * (1 - dIdle / dTotal), 0, 100) : 0;
                // the board shows a bare number inside a core ring, no per-cent sign
                this._updateRing(ring, pct, SIGNAL, String(Math.round(pct)));
                sum += pct; n++;
            }
            if (n > 0 && this._cpuAvgLabel) {
                let avg = Math.round(sum / n);
                this._cpuAvgLabel.set_text(avg + "% average");
                this._pushCpuHistory(avg);
            }
        }
        this._prevCoreStat = cur;
    },

    _updateMem: function () {
        let text = this._readFile("/proc/meminfo");
        if (!text) return;
        let vals = {};
        text.split("\n").forEach(function (line) {
            let m = line.match(/^(\w+):\s+(\d+)/);
            if (m) vals[m[1]] = parseInt(m[2]) * 1024; // kB -> bytes
        });
        let memTotal = vals.MemTotal || 0;
        let memAvail = vals.MemAvailable !== undefined ? vals.MemAvailable : vals.MemFree || 0;
        let memUsed = Math.max(0, memTotal - memAvail);
        let memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
        this._updateRing(this._ramRing, memPct, RAM_RGB,
            Math.round(memPct) + "%", compactBytes(memUsed) + " / " + compactBytes(memTotal));
    },

    // /proc/swaps lists every active swap device separately (Size/Used in
    // KiB) - this machine has both /dev/zram0 (compressed RAM, high
    // priority, used first) and a disk-backed /swapfile (fallback), so
    // they're real distinct numbers here, not the fake 50/50 placeholder
    // split the original KDE version used before real per-device data existed.
    _updateSwap: function () {
        let text = this._readFile("/proc/swaps");
        if (!text) return;
        let zram = { total: 0, used: 0 };
        let disk = { total: 0, used: 0 };
        text.split("\n").slice(1).forEach(function (line) {
            let fields = line.trim().split(/\s+/);
            if (fields.length < 4) return;
            let sizeKb = parseInt(fields[2]) || 0;
            let usedKb = parseInt(fields[3]) || 0;
            let bucket = fields[0].indexOf("zram") !== -1 ? zram : disk;
            bucket.total += sizeKb * 1024;
            bucket.used += usedKb * 1024;
        });

        let zramPct = zram.total > 0 ? (zram.used / zram.total) * 100 : 0;
        this._updateRing(this._zramRing, zramPct, ZRAM_RGB,
            Math.round(zramPct) + "%",
            zram.total > 0 ? compactBytes(zram.used) + " / " + compactBytes(zram.total) : "—");

        let diskPct = disk.total > 0 ? (disk.used / disk.total) * 100 : 0;
        this._updateRing(this._swapRing, diskPct, SWAP_RGB,
            Math.round(diskPct) + "%",
            disk.total > 0 ? compactBytes(disk.used) + " / " + compactBytes(disk.total) : "—");
    },

    // Real amdgpu sysfs sensors - gpu_busy_percent plus VRAM (this Mendocino
    // APU exposes a small dedicated carveout, not just shared system RAM).
    // Not applied through severityColor: pegging the GPU at 100% is normal
    // load, not a problem, same reasoning the KDE version used for CPU cores.
    _discoverGpu: function () {
        for (let i = 0; i < 4; i++) {
            let base = "/sys/class/drm/card" + i + "/device";
            if (GLib.file_test(base + "/gpu_busy_percent", GLib.FileTest.EXISTS)) {
                return { busy: base + "/gpu_busy_percent",
                         vramUsed: base + "/mem_info_vram_used",
                         vramTotal: base + "/mem_info_vram_total" };
            }
        }
        return null;
    },

    _sampleGpu: function () {
        if (!this._gpuPaths) return true;
        let v = parseInt((this._readFile(this._gpuPaths.busy) || '').trim());
        if (!isNaN(v)) {
            this._gpuSum = (this._gpuSum || 0) + clamp(v, 0, 100);
            this._gpuN = (this._gpuN || 0) + 1;
        }
        return true; // GLib.SOURCE_CONTINUE
    },

    _updateGpu: function () {
        if (!this._gpuPaths) return;
        let pct;
        if (this._gpuN) {
            pct = Math.round(this._gpuSum / this._gpuN);     // average since last tick
            this._gpuSum = 0;
            this._gpuN = 0;
        } else {
            let busyStr = this._readFile(this._gpuPaths.busy);
            pct = busyStr ? clamp(parseInt(busyStr.trim()) || 0, 0, 100) : 0;
        }
        let vramUsed = parseInt(this._readFile(this._gpuPaths.vramUsed) || "0");
        let vramTotal = parseInt(this._readFile(this._gpuPaths.vramTotal) || "0");
        // the board reads "idle" under the GPU ring when nothing is running
        // on it, rather than a VRAM figure that never moves
        this._updateRing(this._gpuRing, pct, GPU_RGB, pct + "%",
            pct === 0 ? "idle"
                      : (vramTotal > 0 ? compactBytes(vramUsed) + " / " + compactBytes(vramTotal) : "—"));
    },

    _fsInfo: function (path) {
        try {
            let file = Gio.File.new_for_path(path);
            let info = file.query_filesystem_info("filesystem::size,filesystem::used", null);
            let size = info.get_attribute_uint64("filesystem::size");
            let used = info.get_attribute_uint64("filesystem::used");
            if (!size) return null;
            return { size: size, used: used };
        } catch (e) {
            return null;
        }
    },

    _updateNetwork: function () {
        let text = this._readFile("/proc/net/dev");
        if (!text) return;
        let rx = 0, tx = 0;
        text.split("\n").slice(2).forEach(function (line) {
            let parts = line.trim().split(":");
            if (parts.length < 2) return;
            let iface = parts[0].trim();
            if (iface === "lo" || iface === "") return;
            let fields = parts[1].trim().split(/\s+/).map(Number);
            rx += fields[0] || 0;
            tx += fields[8] || 0;
        });
        let now = GLib.get_monotonic_time() / 1e6;
        if (this._prevNet) {
            let dt = now - this._prevNet.time;
            if (dt > 0) {
                let downSpeed = Math.max(0, (rx - this._prevNet.rx) / dt);
                let upSpeed = Math.max(0, (tx - this._prevNet.tx) / dt);
                if (this.showNetwork) {
                    this._netDown.set_text("▼ " + compactBytes(downSpeed) + "/s");
                    this._netUp.set_text("▲ " + compactBytes(upSpeed) + "/s");
                }
            }
        }
        this._prevNet = { rx: rx, tx: tx, time: now };
    },

    // hwmon names move between boots, so resolve them by name once.
    _discoverThermals: function () {
        this._thermPaths = {};
        let dir = Gio.File.new_for_path('/sys/class/hwmon');
        let en;
        try { en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null); }
        catch (e) { return; }
        let info;
        while ((info = en.next_file(null)) !== null) {
            let base = '/sys/class/hwmon/' + info.get_name();
            let name = this._readFile(base + '/name');
            if (!name) continue;
            name = name.trim();
            let input = base + '/temp1_input';
            if (name === 'k10temp') this._thermPaths.cpu = input;
            else if (name === 'amdgpu') this._thermPaths.gpu = input;
            else if (name === 'nvme') this._thermPaths.nvme = input;
        }
    },

    _updateThermals: function () {
        if (!this._thermPaths) this._discoverThermals();
        let read = (p) => {
            if (!p) return null;
            let raw = this._readFile(p);
            if (!raw) return null;
            let v = parseInt(raw.trim());
            return isNaN(v) ? null : Math.round(v / 1000);
        };
        // bars run 20-95 degrees, the range these sensors actually live in;
        // 0-100 would leave every bar looking permanently half empty
        let setBar = (key, v) => {
            let b = this._thermBars && this._thermBars[key];
            if (!b) return;
            if (v === null) { b.value.set_text("—"); b.fill.width = 0; return; }
            b.value.set_text(v + "°C");
            let w = b.track.get_width();
            b.fill.width = Math.round((w > 0 ? w : 150) * clamp((v - 20) / 75, 0, 1));
        };
        let la = this._readFile('/proc/loadavg');
        if (la && this._thermLoad) this._thermLoad.set_text('load ' + la.trim().split(/\s+/)[0]);
        setBar('cpu', read(this._thermPaths.cpu));
        setBar('gpu', read(this._thermPaths.gpu));
        // NVMe temperature takes ~50 ms to read: fetch it off the main loop at
        // most every 5 s and draw the last known value in between.
        let nvNow = GLib.get_monotonic_time();
        if (this._thermPaths.nvme && !this._nvmeBusy && (!this._nvmeLast || nvNow - this._nvmeLast > 5000000)) {
            this._nvmeBusy = true;
            this._nvmeLast = nvNow;
            this._readFileAsync(this._thermPaths.nvme, Lang.bind(this, function (raw) {
                this._nvmeBusy = false;
                let v = raw ? parseInt(raw.trim()) : NaN;
                this._nvmeTemp = isNaN(v) ? null : Math.round(v / 1000);
            }));
        }
        setBar('nvme', this._nvmeTemp === undefined ? null : this._nvmeTemp);
    },

    // Battery moves slowly and its status read is the slowest file on the
    // machine, so ask at most every 20 s and never wait for the answer.
    _updateBattery: function () {
        let now = GLib.get_monotonic_time();
        if (this._battBusy || (this._battLast && now - this._battLast < 20000000)) return;
        this._battBusy = true;
        this._battLast = now;
        this._readFileAsync("/sys/class/power_supply/BAT0/capacity", Lang.bind(this, function (capacity) {
            this._readFileAsync("/sys/class/power_supply/BAT0/status", Lang.bind(this, function (status) {
                this._battBusy = false;
                if (this._batteryRow) this._applyBattery(capacity, status);
            }));
        }));
    },

    _applyBattery: function (capacity, status) {
        if (!capacity) { this._batteryRow.visible = false; return; }
        let pct = parseInt(capacity.trim());
        let charging = status && status.trim() === "Charging";
        this._batteryLabel.set_text(pct + "%  " + (charging ? "charging" : "discharging"));
        let iconName = charging ? "battery-full-charging-symbolic" :
            pct >= 80 ? "battery-full-symbolic" :
            pct >= 40 ? "battery-good-symbolic" :
            pct >= 15 ? "battery-low-symbolic" : "battery-caution-symbolic";
        this._batteryIcon.icon_name = iconName;
        // Approved states: charging (or >=50%) green, under 50% yellow,
        // under 30% red. Charging always wins, so a low battery on the
        // charger reads as recovering rather than as an alarm.
        let battColor = (charging || pct >= 50) ? '#a6e3a1'
            : (pct < 30 ? '#f38ba8' : '#f9e2af');
        this._batteryIcon.set_style('color: ' + battColor + ';');
        this._batteryLabel.set_style('color: ' + battColor + ';');
        // pill tint tracks the same state, like the design's battery chip
        let tint = (charging || pct >= 50) ? 'rgba(166, 227, 161, 0.14)'
            : (pct < 30 ? 'rgba(243, 139, 168, 0.14)' : 'rgba(249, 226, 175, 0.14)');
        this._batteryRow.set_style('spacing: 7px; padding: 3px 10px; border-radius: 12px;'
            + ' background-color: ' + tint + ';');
    },

    // Storage volumes are re-discovered on the slow timer from /proc/mounts
    // so a USB stick or SD card just appears without a restart, same intent
    // as the original's runtime sensor-tree rescan. A volume with no
    // filesystem label mounts at a path named after its raw UUID/serial
    // (e.g. /media/harish/78B806CDB8068A38) - that's unreadable in a HUD, so
    // anything that looks like a bare hex serial gets a friendly fallback
    // name instead of being shown verbatim.
    _updateStorageVolumes: function () {
        let text = this._readFile("/proc/mounts");
        if (!text) return;
        let minBytes = (this.minDiskSizeGiB || 0) * 1073741824;
        let seenDevices = {};
        let volumes = [];
        let externalCount = 0;

        text.split("\n").forEach(Lang.bind(this, function (line) {
            let fields = line.split(" ");
            if (fields.length < 3) return;
            let device = fields[0], mountpoint = fields[1], fstype = fields[2];
            mountpoint = mountpoint.replace(/\\040/g, " ");
            if (!device.startsWith("/dev/")) return;
            if (FS_WHITELIST.indexOf(fstype) === -1) return;
            if (seenDevices[device]) return;
            seenDevices[device] = true;

            let info = this._fsInfo(mountpoint);
            if (!info || info.size < minBytes) return;

            let label;
            if (mountpoint === "/") {
                label = "ROOT";
            } else {
                let raw = mountpoint.split("/").pop();
                if (/^[0-9A-Fa-f]{6,}$/.test(raw)) {
                    externalCount++;
                    label = externalCount === 1 ? "EXTERNAL" : "EXTERNAL " + externalCount;
                } else {
                    label = raw;
                }
            }
            volumes.push({ key: mountpoint, label: label, dev: device.replace('/dev/', ''), size: info.size, used: info.used });
        }));

        let key = volumes.map(v => v.key).join(",");
        if (key !== this._knownVolumeKey) {
            this._knownVolumeKey = key;
            this._storageColumn.destroy_all_children();
            this._diskGauges = {};
            volumes.forEach(Lang.bind(this, function (v) {
                let bar = this._makeStorageBar();
                this._storageColumn.add_child(bar.actor);
                this._diskGauges[v.key] = bar;
            }));
            // a drive appearing changes the column height, so refit the panel
            Mainloop.idle_add(Lang.bind(this, function () {
                this._fitPanelToContent();
                return false;
            }));
        }

        volumes.forEach(Lang.bind(this, function (v) {
            let bar = this._diskGauges[v.key];
            if (!bar) return;
            let pct = (v.used / v.size) * 100;
            // DISK_RGB (neutral gray) instead of SIGNAL cyan - gives STORAGE
            // its own identity color now that it's the only place disk usage
            // is shown at all, same reasoning as the stat rings' colors.
            let color = severityRGB(pct, DISK_RGB);
            bar.label.set_text(v.label);
            if (bar.devLabel) bar.devLabel.set_text(v.dev || '');
            bar.area._percent = pct;
            bar.area._colorRGB = color;
            bar.area.queue_repaint();
            bar.detail.set_text(compactBytes(v.used) + " / " + compactBytes(v.size));

            let pctText = Math.round(pct) + "%";
            if (pctText !== bar._lastPctText) {
                bar._lastPctText = pctText;
                bar.percentLabel.set_text(pctText);
                let isAlarm = color === AMBER || color === RED;
                bar.percentLabel.set_style('color: ' + (isAlarm ? rgbToHex(color) : '#cdd6f4') + ';');
            }
        }));
    }
};

function main(metadata, desklet_id) {
    return new JarvisMonitorDesklet(metadata, desklet_id);
}
