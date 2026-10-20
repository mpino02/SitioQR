/* Historial de cambios: sección del super administrador e historial de un QR */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const { api, esc, openDialog } = window.PYQR;

  const fmtShort = iso => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
  const TYPES = { qr: 'QR', carpeta: 'Carpeta', ficha: 'Ficha', plantilla: 'Plantilla', usuario: 'Usuario', area: 'Área' };
  const fmtVal = v => v === null || v === undefined || v === '' ? '—' : v === true ? 'Sí' : v === false ? 'No' : esc(v);
  const fmtChanges = changes => Object.entries(changes || {}).map(([k, [a, b]]) =>
    `<div class="au-ch"><b>${esc(k)}</b>: ${a === '' && b === 'modificado' ? 'modificado' : `${fmtVal(a)} → ${fmtVal(b)}`}</div>`).join('');

  function rows(list, { showObject = true, showIp = false } = {}) {
    if (!list.length) return '<div class="empty">Sin cambios registrados.</div>';
    return list.map(e => `
      <div class="au-row">
        <div class="au-when">${fmtShort(e.at)}</div>
        <div class="au-main">
          <div><span class="au-act au-${esc(e.action)}">${esc(e.action)}</span>
            ${showObject ? `<span class="au-type">${esc(TYPES[e.objectType] || e.objectType)}</span> <b>${esc(e.objectName)}</b>` : ''}
            ${e.area ? `<span class="muted small">· ${esc(e.area)}</span>` : ''}</div>
          ${fmtChanges(e.changes)}
        </div>
        <div class="au-who">${esc(e.user)}${showIp && e.ip ? `<div class="muted small">${esc(e.ip)}</div>` : ''}</div>
      </div>`).join('');
  }

  const filters = { type: '', q: '' };

  async function render() {
    const params = new URLSearchParams({ limit: 300 });
    if (filters.type) params.set('type', filters.type);
    if (filters.q) params.set('q', filters.q);
    const list = await api('/audit?' + params);
    $('#main').innerHTML = `
      <div class="page-head"><h1>Historial de cambios <span class="muted">(${list.length})</span></h1>
        <p class="muted">Quién creó, editó o eliminó QR, carpetas, fichas, plantillas, usuarios y áreas. Los registros no se pueden modificar.</p></div>
      <form class="toolbar" id="auForm">
        <input id="auQ" placeholder="Buscar por nombre, usuario o código" value="${esc(filters.q)}" style="max-width:340px">
        <select id="auType"><option value="">Todos los tipos</option>
          ${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${filters.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="btn blue" type="submit">Filtrar</button>
      </form>
      <div class="au-list">${rows(list, { showIp: true })}</div>`;
    $('#auForm').addEventListener('submit', e => { e.preventDefault(); filters.q = $('#auQ').value.trim(); filters.type = $('#auType').value; render(); });
    $('#auType').addEventListener('change', e => { filters.type = e.target.value; render(); });
  }

  async function showForQr(q) {
    const list = await api('/audit?' + new URLSearchParams({ qr: q.id }));
    openDialog(`Historial · ${esc(q.name)}`, `<div class="au-list">${rows(list, { showObject: false })}</div>`, null, null, true);
  }

  window.PYAudit = { render, showForQr };
})();
