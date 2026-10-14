// Dump everything the Jarvis desklet is currently displaying, as JSON, so it
// can be diffed against what the system actually reports.
(function () {
  try {
    let D = imports.ui.deskletManager.definitions[0].desklet;
    let o = {};

    o.hud = { w: D._hudW, h: D._hudH };
    let [ax, ay] = D.actor.get_transformed_position();
    let alloc = D._root ? D._root.get_allocation_box() : null;
    o.panel = {
        x: Math.round(ax), y: Math.round(ay),
        rootW: alloc ? Math.round(alloc.x2 - alloc.x1) : null,
        rootH: alloc ? Math.round(alloc.y2 - alloc.y1) : null
    };
    let ca = D._content ? D._content.get_allocation_box() : null;
    o.content = ca ? { w: Math.round(ca.x2 - ca.x1), h: Math.round(ca.y2 - ca.y1),
                       forcedH: D._content.height } : null;
    let la = D._left.get_allocation_box(), ra = D._right.get_allocation_box();
    o.columns = {
        leftW: Math.round(la.x2 - la.x1), leftH: Math.round(la.y2 - la.y1),
        rightW: Math.round(ra.x2 - ra.x1), rightH: Math.round(ra.y2 - ra.y1)
    };

    o.text = {
        title: D._titleLabel ? D._titleLabel.get_text() : null,
        uptime: D._uptimeLabel ? D._uptimeLabel.get_text() : null,
        battery: D._batteryLabel ? D._batteryLabel.get_text() : null,
        cpuAvg: D._cpuAvgLabel ? D._cpuAvgLabel.get_text() : null,
        section: D._sectionLabel ? D._sectionLabel.get_text() : null,
        netDown: D._netDown ? D._netDown.get_text() : null,
        netUp: D._netUp ? D._netUp.get_text() : null
    };

    function ring(r) {
        return r ? { pct: r._lastPct, value: r._lastValueText, detail: r._lastDetailText,
                     size: r.size, onStage: !!r.actor.get_stage() } : null;
    }
    o.rings = {
        ram: ring(D._ramRing), zram: ring(D._zramRing), swap: ring(D._swapRing),
        root: ring(D._rootRing), gpu: ring(D._gpuRing)
    };
    o.cores = D._coreRings.map(function (r) { return { pct: r._lastPct, value: r._lastValueText }; });

    o.thermPaths = D._thermPaths;
    o.thermBars = {};
    for (let k in (D._thermBars || {})) {
        let b = D._thermBars[k];
        o.thermBars[k] = { value: b.value ? b.value.get_text() : null,
                           fillW: b.fill ? Math.round(b.fill.width) : null,
                           trackW: b.track ? Math.round(b.track.width) : null };
    }
    o.thermLoad = D._thermLoad ? D._thermLoad.get_text() : null;

    o.storage = {};
    for (let k in D._diskGauges) {
        let g = D._diskGauges[k];
        o.storage[k] = { label: g.label ? g.label.get_text() : null,
                         dev: g.devLabel ? g.devLabel.get_text() : null,
                         percent: g.percentLabel ? g.percentLabel.get_text() : null,
                         detail: g.detail ? g.detail.get_text() : null,
                         y: Math.round(g.actor.get_allocation_box().y1) };
    }
    o.storageChildren = D._storageColumn.get_n_children();
    o.knownVolumeKey = D._knownVolumeKey;

    // every visible child must sit inside the painted panel
    let bad = [];
    function scan(a, name, depth) {
        if (depth > 3) return;
        a.get_children().forEach(function (c, i) {
            let b = c.get_allocation_box();
            if (b.y2 > o.panel.rootH + 1 || b.x2 > o.panel.rootW + 1)
                bad.push(name + '[' + i + '] ' + Math.round(b.x2) + ',' + Math.round(b.y2));
            scan(c, name + '[' + i + ']', depth + 1);
        });
    }
    if (D._root) scan(D._root, 'root', 0);
    o.overflow = bad.slice(0, 6);

    o.timers = { fast: !!D._timeoutId, slow: !!D._slowTimeoutId };
    o.nproc = D._nproc;
    return JSON.stringify(o);
  } catch (e) { return 'ERROR: ' + e + ' @ ' + (e.stack||'').split('\n')[0]; }
})();
