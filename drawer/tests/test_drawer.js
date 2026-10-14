// Drawer test suite - runs inside the live Cinnamon process via org.Cinnamon.Eval
(function () {
    let A = imports.ui.appletManager.definitions[14].applet;
    let out = [], pass = 0, fail = 0;
    function t(name, cond, detail) {
        (cond ? pass++ : fail++);
        out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
    }

    // ---- app list -------------------------------------------------------
    let apps = A._apps;
    t('app list populated', apps.length > 50, apps.length + ' apps');

    let names = apps.map(function (a) { return a.name; });
    let dupes = names.filter(function (n, i) { return names.indexOf(n) !== i; });
    t('no duplicate entries', dupes.length === 0, dupes.slice(0, 3).join(',') || 'none');

    t('sorted alphabetically',
      names.slice().sort(function (x, y) { return x.toLowerCase().localeCompare(y.toLowerCase()); })
           .join('|') === names.join('|'));

    let noIcon = apps.filter(function (a) { return !a.info.get_icon(); });
    t('every app has an icon', noIcon.length === 0,
      noIcon.map(function (a) { return a.name; }).slice(0, 3).join(',') || 'none');

    let noExec = apps.filter(function (a) { return !a.info.get_executable(); });
    t('every app is launchable', noExec.length === 0,
      noExec.map(function (a) { return a.name; }).slice(0, 3).join(',') || 'none');

    t('Terminal present (CMenu vs Gio)',
      names.indexOf('Terminal') !== -1);

    // ---- search ---------------------------------------------------------
    let savedFilter = A._filter, savedCat = A._category, savedPage = A._page;
    function search(q, cat) { A._filter = q; A._category = cat || null; return A._visible().length; }

    t('empty query returns all', search('') === apps.length);
    t('search matches Terminal', search('term') === 1, search('term') + ' hits');
    t('search is case insensitive', search('TERM') === search('term'));
    t('search matches mid-word', search('ettings') > 0, search('ettings') + ' hits');
    t('search matches executable too', search('nemo') > 0, search('nemo') + ' hits');
    t('nonsense query returns none', search('zzqqxx') === 0);
    t('whitespace-only query returns all', search('   ') === apps.length);

    // ---- categories -----------------------------------------------------
    let chips = [['All apps', null], ['Development', 'Development'], ['Graphics', 'Graphics'],
                 ['Internet', 'Network'], ['Multimedia', 'AudioVideo'], ['System', 'System']];
    chips.forEach(function (c) {
        let n = search('', c[1]);
        t('chip "' + c[0] + '" non-empty', n > 0, n + ' apps');
    });
    t('chip + search combine', search('code', 'Development') <= search('code', null));

    // ---- geometry across displays ---------------------------------------
    let savedW = A._areaW, savedH = A._areaH;
    [[1024, 768], [1280, 800], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]]
        .forEach(function (d) {
            A._areaW = d[0]; A._areaH = d[1];
            let c = A._colsPerPage(), r = A._rowsPerPage(), gw = A._gridWidth();
            let margin = Math.round((d[0] - gw) / 2);
            let fits = gw <= d[0] && margin >= 40 && c >= 4 && c <= 10 && r >= 2 && r <= 6;
            out.push('      ' + d[0] + 'x' + d[1] + ' -> ' + c + ' x ' + r + ' = ' + (c * r) +
                     '/page, grid ' + gw + 'px, margin ' + margin + 'px');
            t('geometry sane at ' + d[0] + 'x' + d[1], fits);
        });

    A._areaW = 200; A._areaH = 200;   // absurd display must not produce garbage
    t('clamps on a tiny display', A._colsPerPage() >= 4 && A._rowsPerPage() >= 2,
      A._colsPerPage() + 'x' + A._rowsPerPage());

    A._areaW = savedW; A._areaH = savedH;

    // ---- paging ---------------------------------------------------------
    A._filter = ''; A._category = null; A._page = 0; A._rebuildGrid();
    let total = A._visible().length, size = A._pageSize();
    let pages = Math.ceil(total / size);
    t('page size matches cols x rows', size === A._colsPerPage() * A._rowsPerPage(), size + '/page');
    t('dot count equals page count', A._dots.get_n_children() === pages,
      A._dots.get_n_children() + ' dots vs ' + pages + ' pages');

    A._turnPage(1);
    t('page forward works', A._page === 1);
    A._page = pages - 1; A._rebuildGrid();
    A._turnPage(1);
    t('does not run past the last page', A._page === pages - 1, 'page ' + A._page);
    A._page = 0; A._rebuildGrid();
    A._turnPage(-1);
    t('does not run before the first page', A._page === 0);

    let lastCount = (function () { A._page = pages - 1; A._rebuildGrid(); return A._tiles.length; })();
    t('last page holds the remainder', lastCount === (total % size || size),
      lastCount + ' tiles, expected ' + (total % size || size));

    // ---- empty state ----------------------------------------------------
    A._filter = 'zzqqxx'; A._page = 0; A._rebuildGrid();
    t('empty state builds no tiles', A._tiles.length === 0);
    t('empty state shows no page dots', A._dots.get_n_children() === 0,
      A._dots.get_n_children() + ' dots');

    // ---- tiles and labels ----------------------------------------------
    A._filter = ''; A._page = 0; A._rebuildGrid();
    let heights = A._tiles.map(function (x) { let [, h] = x.get_preferred_height(A.TILE_W); return Math.ceil(h); });
    let uniform = heights.every(function (h) { return h === heights[0]; });
    t('all tiles the same height', uniform, 'h=' + heights[0]);

    let widths = A._tiles.map(function (x) { let [, w] = x.get_preferred_width(-1); return Math.ceil(w); });
    t('no tile wider than its slot', Math.max.apply(null, widths) <= A.TILE_W,
      'max ' + Math.max.apply(null, widths) + ' vs ' + A.TILE_W);

    // Longest name must WRAP, not truncate. Measure clutter_text at the width
    // it actually gets - the St.Label wrapper has a forced height, and the
    // layout line count is meaningless before the actor is allocated.
    let longest = null;
    A._visible().forEach(function (a) { if (!longest || a.name.length > longest.name.length) longest = a; });
    let textW = A.TILE_W - 12;

    A._filter = ''; A._page = 0; A._rebuildGrid();
    function labelFor(n) {
        let found = null;
        A._tiles.forEach(function (x) { if (x._app.name === n) found = x; });
        return found ? found.get_children()[1] : null;
    }
    let shortLbl = labelFor('Blender') || labelFor(A._tiles[0]._app.name);
    let [, oneLine] = shortLbl.clutter_text.get_preferred_height(textW);

    A._filter = longest.name.split(' ')[0]; A._rebuildGrid();
    let lbl = A._tiles[0].get_children()[1];
    let [, twoLine] = lbl.clutter_text.get_preferred_height(textW);

    t('long name wraps rather than truncates', twoLine > oneLine * 1.5,
      '"' + longest.name + '" ' + Math.ceil(twoLine) + 'px vs one line ' + Math.ceil(oneLine) + 'px');
    t('label text is complete', lbl.get_text() === longest.name);
    t('wrapping stops at 2 lines', twoLine <= oneLine * 2.2, Math.ceil(twoLine) + 'px');
    t('label box fits the wrapped text (no clipped descenders)',
      Math.ceil(twoLine) <= A.LABEL_H, Math.ceil(twoLine) + 'px vs LABEL_H ' + A.LABEL_H);

    // grid must fit the vertical budget it was given
    A._filter = ''; A._rebuildGrid();
    let [, gh] = A._gridBox.get_preferred_height(A._gridWidth());
    t('grid fits its vertical budget', gh <= (A._areaH - A.CHROME_H),
      Math.ceil(gh) + 'px of ' + (A._areaH - A.CHROME_H) + 'px');

    // ---- restore --------------------------------------------------------
    A._filter = savedFilter; A._category = savedCat; A._page = savedPage;
    if (A._entry) A._entry.set_text('');
    A._rebuildGrid();

    out.push('');
    out.push('RESULT  ' + pass + ' passed, ' + fail + ' failed');
    return out.join('\n');
})();
