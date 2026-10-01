/* ──────────────────────────────────────────────────────────────
   Power Gym — clean "Save as PDF" layout for Analytics reports.

   Used by BOTH the Admin and Staff dashboards (window.printReport).
   Instead of window.print()-ing the whole dark dashboard (which left
   the big blank gap and the cut-off layout), this builds a separate,
   light, print-only document from the report data and prints that.
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const COLORS = {
    Active: '#1baf7a', Scheduled: '#2a78d6', Pending: '#eda100', Expired: '#e34948',
    Declined: '#898781', 'No Plan': '#898781', Cash: '#2a78d6', GCash: '#4a3aa7'
  };
  const PALETTE = ['#3d7dd4', '#1baf7a', '#eda100', '#e34948', '#4a3aa7', '#2fb5c9', '#d6689a', '#8c8c1a'];

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const isNumCol = h => /amount|total|txns|₱|\u20b1/i.test(h);

  function statCards(stats) {
    return `<div class="stats" style="grid-template-columns:repeat(${stats.length},1fr)">
      ${stats.map(s => `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`).join('')}
    </div>`;
  }

  function breakdown(report) {
    const series = report.chart_series || [];
    if (!series.length) return '';
    const isMoney = /revenue/i.test(report.title);
    const isAttendance = /attendance/i.test(report.title);
    if (isAttendance && series.length > 12) return '';
    const total = series.reduce((a, s) => a + Number(s.value || 0), 0) || 1;
    const max = Math.max.apply(null, series.map(s => Number(s.value || 0))) || 1;
    const fmt = v => isMoney ? '\u20b1' + Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                             : Number(v).toLocaleString();
    return `<div class="block">
      <div class="h2">${esc(report.chart_label || 'Breakdown')}</div>
      <table class="bars">${series.map((s, i) => {
        const color = COLORS[s.label] || PALETTE[i % PALETTE.length];
        const w = Math.max(2, Math.round((Number(s.value || 0) / max) * 100));
        const pct = isAttendance ? '' : Math.round((Number(s.value || 0) / total) * 100) + '%';
        return `<tr>
          <td class="bl">${esc(s.label)}</td>
          <td class="bb"><div class="bar" style="width:${w}%;background:${color}"></div></td>
          <td class="bv">${esc(fmt(s.value))}</td><td class="bp">${pct}</td></tr>`;
      }).join('')}</table></div>`;
  }

  function table(sec) {
    const heads = sec.headers || [];
    const num = heads.map(isNumCol);
    const body = (sec.rows && sec.rows.length)
      ? sec.rows.map(r => `<tr>${r.map((c, i) => `<td class="${num[i] ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${heads.length || 1}">No records.</td></tr>`;
    const foot = sec.footer
      ? `<tfoot><tr>${sec.footer.map((c, i) => `<td class="${num[i] ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr></tfoot>` : '';
    return `<table class="data">
      <thead><tr>${heads.map((h, i) => `<th class="${num[i] ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>${foot}</table>`;
  }

  function sections(report) {
    const secs = (report.print_sections && report.print_sections.length)
      ? report.print_sections
      : [{ title: report.title.replace(/ Report$/, '') + ' Records', headers: report.headers || [], rows: report.rows || [] }];
    let html = '';
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].layout === 'half') {
        const group = [];
        while (i < secs.length && secs[i].layout === 'half') group.push(secs[i++]);
        i--;
        html += `<div class="row">${group.map(g =>
          `<div class="col"><div class="h2">${esc(g.title)}</div>${table(g)}</div>`).join('')}</div>`;
      } else {
        const count = (secs[i].rows || []).length;
        html += `<div class="block"><div class="h2">${esc(secs[i].title)} <span class="n">(${count})</span></div>${table(secs[i])}</div>`;
      }
    }
    return html;
  }

  function buildDocument(report) {
    const maxCols = Math.max.apply(null, [(report.headers || []).length].concat(
      (report.print_sections || []).map(s => (s.headers || []).length)));
    const landscape = maxCols >= 7;
    const prepared = report.prepared_by
      ? `${esc(report.prepared_role || '')} \u2014 ${esc(report.prepared_by)}` : esc(report.prepared_role || '');
    const generated = esc(report.generated_at || new Date().toLocaleString());
    const logo = location.origin + '/static/images/logo.png';

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Power Gym - ${esc(report.title)}</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: 'Segoe UI', Arial, Helvetica, sans-serif; font-size: 9.5pt; }
  table.shell { width: 100%; border-collapse: collapse; }
  table.shell > thead > tr > td > .sp { height: 12mm; }
  table.shell > tfoot > tr > td > .sp { height: 16mm; }
  table.shell > tbody > tr > td { padding: 0 12mm; }
  .head { display: flex; align-items: center; justify-content: space-between; border-bottom: 2.5px solid #e61e25; padding-bottom: 8px; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand img { height: 42px; width: auto; }
  .brand .gym { font-size: 9pt; letter-spacing: 2px; font-weight: 700; color: #e61e25; }
  .brand .title { font-size: 19pt; font-weight: 800; line-height: 1.1; text-transform: uppercase; letter-spacing: .5px; }
  .meta { text-align: right; font-size: 8.5pt; color: #444; line-height: 1.6; }
  .meta b { color: #111; }
  .stats { display: grid; gap: 8px; margin-bottom: 14px; }
  .stat { border: 1px solid #cfd3da; border-radius: 6px; padding: 8px 10px; text-align: center; background: #f7f8fa; }
  .stat .v { font-size: 16pt; font-weight: 800; line-height: 1.1; }
  .stat .l { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .8px; color: #555; margin-top: 2px; }
  .block { margin-bottom: 14px; }
  .h2 { font-size: 10pt; font-weight: 800; text-transform: uppercase; letter-spacing: .6px; margin: 0 0 5px; color: #111; break-after: avoid; }
  .h2 .n { font-weight: 500; color: #666; letter-spacing: 0; text-transform: none; }
  .row { display: flex; gap: 14px; margin-bottom: 14px; align-items: flex-start; break-inside: avoid; }
  .col { flex: 1; min-width: 0; }
  table.data { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.data th { background: #1b1f27; color: #fff; text-align: left; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .6px; padding: 5px 6px; }
  table.data td { padding: 5px 6px; border-bottom: 1px solid #dfe2e7; vertical-align: top; word-break: break-word; }
  table.data tbody tr:nth-child(even) td { background: #f5f6f8; }
  table.data thead { display: table-header-group; }
  table.data tfoot { display: table-row-group; }
  table.data tfoot td { border-top: 2px solid #1b1f27; border-bottom: none; font-weight: 800; background: #fff; }
  table.data tr { break-inside: avoid; }
  .r { text-align: right !important; white-space: nowrap; }
  .empty { text-align: center; color: #777; padding: 10px; font-style: italic; }
  table.bars { width: 100%; border-collapse: collapse; }
  table.bars td { padding: 3px 4px; vertical-align: middle; }
  .bl { width: 110px; font-weight: 600; } .bb { width: auto; } .bv { width: 110px; text-align: right; font-weight: 700; } .bp { width: 42px; text-align: right; color: #555; }
  .bar { height: 11px; border-radius: 3px; }
  .foot { position: fixed; left: 12mm; right: 12mm; bottom: 6mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #777; border-top: 1px solid #ccc; padding-top: 3px; background: #fff; }
</style></head><body>
<table class="shell">
  <thead><tr><td><div class="sp"></div></td></tr></thead>
  <tfoot><tr><td><div class="sp"></div></td></tr></tfoot>
  <tbody><tr><td>
    <div class="head">
      <div class="brand">
        <img src="${logo}" alt="" onerror="this.style.display='none'">
        <div><div class="gym">POWER GYM</div><div class="title">${esc(report.title)}</div></div>
      </div>
      <div class="meta">
        <div><b>Period:</b> ${esc(report.range_label)}</div>
        <div><b>Generated:</b> ${generated}</div>
        <div><b>Prepared by:</b> ${prepared}</div>
      </div>
    </div>
    ${statCards(report.stats || [])}
    ${breakdown(report)}
    ${sections(report)}
  </td></tr></tbody>
</table>
<div class="foot"><span>POWER GYM \u2014 ${esc(report.title)}</span><span>Generated ${generated}</span></div>
</body></html>`;
  }

  /** Print a report payload (the JSON from /api/{admin|staff}/reports/<type>). */
  function printReport(report) {
    if (!report) return;
    const old = document.getElementById('tr-print-frame');
    if (old) old.remove();

    const frame = document.createElement('iframe');
    frame.id = 'tr-print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);

    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(buildDocument(report));
    doc.close();

    const imgs = Array.prototype.slice.call(doc.images || []);
    const ready = Promise.all(imgs.map(img => img.complete ? null :
      new Promise(res => { img.onload = img.onerror = res; })));
    const timeout = new Promise(res => setTimeout(res, 2500));

    Promise.race([ready, timeout]).then(() => {
      setTimeout(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        setTimeout(() => { if (frame.parentNode) frame.remove(); }, 60000);
      }, 150);
    });
  }

  window.printReport = printReport;
})();
