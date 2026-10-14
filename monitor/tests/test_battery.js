// Drive every battery state through the real _updateBattery by swapping the
// file reader, then put the real one back.
(function () {
  try {
    let D = imports.ui.deskletManager.definitions[0].desklet;
    let real = D._readFile;
    let out = [], pass = 0, fail = 0;
    function t(n, ok, d) { (ok ? pass++ : fail++); out.push((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); }

    function drive(pct, status) {
        D._readFile = function (p) {
            if (p.indexOf('capacity') !== -1) return String(pct) + '\n';
            if (p.indexOf('status') !== -1) return status + '\n';
            return real.call(D, p);
        };
        D._updateBattery();
        let m = (D._batteryLabel.get_style() || '').match(/color:\s*(#[0-9a-fA-F]{6})/);
        let tint = (D._batteryRow.get_style() || '').match(/background-color:\s*(rgba\([^)]*\))/);
        return { color: m ? m[1].toLowerCase() : null,
                 tint: tint ? tint[1] : null,
                 text: D._batteryLabel.get_text(),
                 icon: D._batteryIcon.icon_name,
                 visible: D._batteryRow.visible };
    }

    const GREEN = '#a6e3a1', YELLOW = '#f9e2af', RED = '#f38ba8';

    let c = drive(20, 'Charging');
    t('charging at 20% is green (charging wins over low)', c.color === GREEN, c.color + ' "' + c.text + '"');
    t('charging says charging', c.text.indexOf('charging') !== -1 && c.text.indexOf('dis') === -1, c.text);
    t('charging uses the charging icon', c.icon.indexOf('charging') !== -1, c.icon);

    c = drive(100, 'Charging');
    t('charging at 100% is green', c.color === GREEN, c.color);

    c = drive(75, 'Discharging');
    t('discharging at 75% is green', c.color === GREEN, c.color);
    c = drive(50, 'Discharging');
    t('discharging at 50% is green (boundary)', c.color === GREEN, c.color);
    c = drive(49, 'Discharging');
    t('discharging at 49% turns yellow', c.color === YELLOW, c.color);
    c = drive(30, 'Discharging');
    t('discharging at 30% is still yellow (boundary)', c.color === YELLOW, c.color);
    c = drive(29, 'Discharging');
    t('discharging at 29% turns red', c.color === RED, c.color);
    c = drive(1, 'Discharging');
    t('discharging at 1% is red', c.color === RED, c.color);

    // the pill tint must track the same state, not lag it
    let g = drive(80, 'Discharging'), y = drive(40, 'Discharging'), r = drive(10, 'Discharging');
    t('pill tint is green when green', g.tint.indexOf('166, 227, 161') !== -1, g.tint);
    t('pill tint is yellow when yellow', y.tint.indexOf('249, 226, 175') !== -1, y.tint);
    t('pill tint is red when red', r.tint.indexOf('243, 139, 168') !== -1, r.tint);

    // icon ramp
    t('80% uses the full icon', drive(80, 'Discharging').icon.indexOf('full') !== -1);
    t('45% uses the good icon', drive(45, 'Discharging').icon.indexOf('good') !== -1);
    t('20% uses the low icon', drive(20, 'Discharging').icon.indexOf('low') !== -1);
    t('5% uses the caution icon', drive(5, 'Discharging').icon.indexOf('caution') !== -1);

    // never shows a time estimate, per the approved design
    let texts = [drive(90, 'Charging').text, drive(45, 'Discharging').text, drive(5, 'Discharging').text];
    t('no time-remaining anywhere', texts.every(function (x) {
        return x.indexOf(':') === -1 && x.toLowerCase().indexOf('left') === -1 &&
               x.toLowerCase().indexOf('hour') === -1 && x.toLowerCase().indexOf('min') === -1;
    }), texts.join(' / '));

    // a machine with no battery must hide the row rather than show 0%
    D._readFile = function (p) {
        if (p.indexOf('BAT0') !== -1) return null;
        return real.call(D, p);
    };
    D._batteryRow.visible = true;
    D._updateBattery();
    t('no battery hides the row', D._batteryRow.visible === false);

    // restore the real reader and the true state
    D._readFile = real;
    D._batteryRow.visible = true;
    D._updateBattery();
    out.push('restored: ' + D._batteryLabel.get_text());
    out.push('');
    out.push('RESULT  ' + pass + ' passed, ' + fail + ' failed');
    return out.join('\n');
  } catch (e) {
    let D = imports.ui.deskletManager.definitions[0].desklet;
    return 'ERROR: ' + e + ' @ ' + (e.stack || '').split('\n')[0];
  }
})();
