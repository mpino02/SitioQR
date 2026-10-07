/* Panel PY QR */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { DEFAULT_DESIGN, buildSvg, svgToDataUrl, download } = window.QRRender;

  const state = { config: null, view: 'active', folder: null, search: '', sort: 'created', folders: [], templates: [], editing: null, design: null };

  // ---------- API ----------
  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'X-CSRFToken': csrfToken() }, opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Sesión expirada'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
    return data;
  }

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  const fmtDate = iso => iso ? new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const shortUrl = code => `${state.config.baseUrl}/r/${code}`;

  // ---------- Inicio ----------
  async function init() {
    state.config = await fetch('/api/config').then(r => r.json());
    document.title = state.config.appName;
    $$('.app-name').forEach(e => (e.textContent = state.config.appName));
    $('#prefixBase').textContent = state.config.baseUrl.replace(/^https?:\/\//, '') + '/r/';
    if (state.config.authenticated) showApp(); else showLogin();
  }

  function showLogin() {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginUser').focus();
  }

  async function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#userName').textContent = state.config.user || '';
    $('#adminLink').classList.toggle('hidden', !state.config.isAdmin);
    await Promise.all([loadFolders(), loadTemplates()]);
    render();
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try { await api('/login', { method: 'POST', body: { username: $('#loginUser').value.trim(), password: $('#loginPw').value } }); $('#loginPw').value = '';
      state.config = await fetch('/api/config').then(r => r.json()); showApp(); }
    catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#logoutBtn').addEventListener('click', async () => { await api('/logout', { method: 'POST' }); location.reload(); });
  $('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---------- Navegación ----------
  $$('.nav-item[data-view]').forEach(a => a.addEventListener('click', () => {
    state.view = a.dataset.view; state.folder = null; $('#sidebar').classList.remove('open'); render();
  }));
  $('[data-action="create"]').addEventListener('click', () => openEditor(null));
  $('#newFolderBtn').addEventListener('click', () => promptDialog('Nueva carpeta', 'Nombre de la carpeta', '', async name => {
    await api('/folders', { method: 'POST', body: { name } }); await loadFolders(); toast('Carpeta creada');
  }));

  async function loadFolders() {
    state.folders = await api('/folders');
    $('#folderList').innerHTML = state.folders.map(f => `
      <div class="folder-item ${state.folder === f.id ? 'active' : ''}" data-id="${f.id}">
        <span class="fname">📁 ${esc(f.name)}</span><span class="count">${f.count}</span>
        <button class="icon-btn tiny" data-fmenu="${f.id}" title="Opciones">⋮</button>
      </div>`).join('');
    $$('#folderList .folder-item').forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-fmenu]')) return;
      state.view = 'active'; state.folder = el.dataset.id; $('#sidebar').classList.remove('open'); render();
    }));
    $$('#folderList [data-fmenu]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const f = state.folders.find(x => x.id === b.dataset.fmenu);
      showMenu(b, [
        ['Renombrar', () => promptDialog('Renombrar carpeta', 'Nombre', f.name, async name => {
          await api('/folders/' + f.id, { method: 'PUT', body: { name } }); await loadFolders(); render();
        })],
        ['Eliminar carpeta', () => confirmDialog(`¿Eliminar la carpeta "${f.name}"? Los QR no se borran, quedan sin carpeta.`, async () => {
          await api('/folders/' + f.id, { method: 'DELETE' }); if (state.folder === f.id) state.folder = null; await loadFolders(); render();
        }), true],
      ]);
    }));
  }

  async function loadTemplates() {
    state.templates = await api('/templates');
    $('#f_template').innerHTML = '<option value="">— Aplicar diseño guardado —</option>' +
      state.templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }

  function setActiveNav() {
    $$('.nav-item').forEach(a => a.classList.toggle('active', !state.folder && a.dataset.view === state.view));
    $$('.folder-item').forEach(el => el.classList.toggle('active', el.dataset.id === state.folder));
  }

  async function render() {
    setActiveNav();
    if (state.view === 'stats') return renderStats();
    if (state.view === 'templates') return renderTemplates();
    return renderList();
  }

  // ---------- Lista de QR ----------
  async function renderList() {
    const archived = state.view === 'archived';
    const folderName = state.folder ? (state.folders.find(f => f.id === state.folder) || {}).name : null;
    const title = folderName ? `📁 ${esc(folderName)}` : archived ? 'QR archivados' : 'QR activos';
    const params = new URLSearchParams({ archived: archived ? '1' : '0', sort: state.sort });
    if (state.folder) params.set('folder', state.folder);
    if (state.search) params.set('q', state.search);
    const list = await api('/qrs?' + params);
    const main = $('#main');
    main.innerHTML = `
      <div class="page-head">
        <h1>${title} <span class="muted">(${list.length})</span></h1>
      </div>
      <div class="toolbar">
        <form class="search" id="searchForm">
          <input id="searchInput" placeholder="Buscar por nombre, URL o código" value="${esc(state.search)}">
          <button class="btn blue" type="submit">Buscar</button>
        </form>
        <div class="spacer"></div>
        <select id="sortSel">
          <option value="created">Más recientes</option><option value="updated">Últimos editados</option>
          <option value="name">Nombre (A-Z)</option><option value="scans">Más escaneados</option>
        </select>
        <button class="btn primary" id="createBtn2">＋ Crear código QR</button>
      </div>
      <div class="grid" id="grid">${list.length ? '' : `<div class="empty">${archived ? 'No hay códigos archivados.' : 'Aún no hay códigos QR. Crea el primero con “Crear código QR”.'}</div>`}</div>`;
    $('#sortSel').value = state.sort;
    $('#sortSel').addEventListener('change', e => { state.sort = e.target.value; renderList(); });
    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); state.search = $('#searchInput').value.trim(); renderList(); });
    $('#createBtn2').addEventListener('click', () => openEditor(null));

    const grid = $('#grid');
    for (const q of list) {
      const folder = state.folders.find(f => f.id === q.folderId);
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-left">
          <div class="thumb"><img alt="QR ${esc(q.name)}"></div>
          <button class="btn outline-blue small block" data-act="stats">📈 ${q.scans || 0} escaneos</button>
          <button class="btn primary small block" data-act="download">⬇ Descargar</button>
        </div>
        <div class="card-right">
          <button class="icon-btn kebab" data-act="menu" title="Más opciones">⋮</button>
          <div class="type">🔗 URL dinámica</div>
          <h3 class="qname"><span>${esc(q.name)}</span> <button class="icon-btn tiny brand" data-act="rename" title="Renombrar">✎</button></h3>
          <div class="muted small">Actualizado ${fmtDate(q.updatedAt)}</div>
          <div class="meta">📁 ${folder ? esc(folder.name) : '<span class="muted">Sin carpeta</span>'}</div>
          <div class="meta"><a href="${esc(q.shortUrl)}" target="_blank" rel="noopener">🔗 ${esc(q.shortUrl.replace(/^https?:\/\//, ''))}</a>
            <button class="icon-btn tiny" data-act="copy" title="Copiar URL corta">⧉</button></div>
          <div class="meta dest"><span class="trunc" title="${esc(q.url)}">↗ ${esc(q.url)}</span>
            <button class="icon-btn tiny brand" data-act="editurl" title="Editar URL de destino">✎</button></div>
          <div class="meta link" data-act="content">✎ Editar contenido</div>
          <div class="meta link" data-act="design">🎨 Editar diseño</div>
        </div>`;
      grid.appendChild(card);
      buildSvg(q.shortUrl, q.design).then(svg => { $('.thumb img', card).src = svgToDataUrl(svg); }).catch(() => {});
      card.addEventListener('click', e => onCardAction(e, q));
    }
  }

  async function onCardAction(e, q) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'stats') return showQrStats(q);
    if (act === 'download') return showMenu(btn, ['png', 'jpg', 'webp', 'svg', 'pdf'].map(f => [f.toUpperCase(), () => download(f, q.shortUrl, q.design, q.name, { size: 1024, pdfCm: 10 })]));
    if (act === 'copy') { await navigator.clipboard.writeText(q.shortUrl).catch(() => {}); return toast('URL corta copiada'); }
    if (act === 'rename') return promptDialog('Renombrar QR', 'Nombre', q.name, async name => {
      await api('/qrs/' + q.id, { method: 'PUT', body: { name } }); toast('Nombre actualizado'); renderList();
    });
    if (act === 'editurl') return promptDialog('Editar URL de destino', 'Nueva URL (el QR impreso seguirá funcionando)', q.url, async url => {
      await api('/qrs/' + q.id, { method: 'PUT', body: { url } }); toast('URL de destino actualizada'); renderList();
    }, 'url');
    if (act === 'content') return openEditor(q, 'content');
    if (act === 'design') return openEditor(q, 'design');
    if (act === 'menu') {
      return showMenu(btn, [
        ['Editar', () => openEditor(q, 'content')],
        ['Duplicar', async () => { await api(`/qrs/${q.id}/duplicate`, { method: 'POST' }); toast('QR duplicado'); render(); }],
        ['Mover a carpeta', () => moveDialog(q)],
        [q.archived ? 'Restaurar (activar)' : 'Archivar (desactivar)', async () => {
          await api('/qrs/' + q.id, { method: 'PUT', body: { archived: !q.archived } });
          toast(q.archived ? 'QR activado' : 'QR archivado: dejará de redirigir'); await loadFolders(); render();
        }],
        ['Eliminar', () => confirmDialog(`¿Eliminar "${q.name}" definitivamente? El QR impreso dejará de funcionar.`, async () => {
          await api('/qrs/' + q.id, { method: 'DELETE' }); toast('QR eliminado'); await loadFolders(); render();
        }), true],
      ]);
    }
  }

  function moveDialog(q) {
    const opts = '<option value="">Sin carpeta</option>' + state.folders.map(f => `<option value="${f.id}" ${f.id === q.folderId ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    openDialog('Mover a carpeta', `<label>Carpeta<select id="moveSel">${opts}</select></label>`, async () => {
      await api('/qrs/' + q.id, { method: 'PUT', body: { folderId: $('#moveSel').value || null } });
      toast('QR movido'); await loadFolders(); render();
    }, 'Mover');
  }

  // ---------- Estadísticas ----------
  function barChart(days) {
    const max = Math.max(1, ...days.map(d => d.scans));
    const W = 900, H = 200, bw = W / days.length;
    const bars = days.map((d, i) => {
      const h = Math.round((d.scans / max) * (H - 24));
      return `<rect x="${i * bw + 2}" y="${H - 18 - h}" width="${bw - 4}" height="${h}" rx="3" class="bar"><title>${d.day}: ${d.scans}</title></rect>` +
        (i % 5 === 4 ? `<text x="${i === days.length - 1 ? W : i * bw + bw / 2}" y="${H - 4}" text-anchor="${i === days.length - 1 ? 'end' : 'middle'}" class="axis">${d.day.slice(8)}/${d.day.slice(5, 7)}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Escaneos por día">${bars}</svg>`;
  }
  function deviceList(devices) {
    const total = Object.values(devices).reduce((a, b) => a + b, 0) || 1;
    const rows = Object.entries(devices).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<p class="muted">Sin datos todavía.</p>';
    return rows.map(([k, v]) => `<div class="dev"><span>${esc(k)}</span><div class="devbar"><i style="width:${(v / total) * 100}%"></i></div><b>${v}</b></div>`).join('');
  }

  async function showQrStats(q) {
    const s = await api(`/qrs/${q.id}/stats`);
    openDialog(`Escaneos · ${esc(q.name)}`, `
      <div class="kpis"><div><b>${s.total}</b><span>Total</span></div><div><b>${s.days.reduce((a, d) => a + d.scans, 0)}</b><span>Últimos 30 días</span></div>
      <div><b class="smallb">${s.lastScanAt ? fmtDate(s.lastScanAt) : '—'}</b><span>Último escaneo</span></div></div>
      <h4>Últimos 30 días</h4>${barChart(s.days)}<h4>Dispositivos</h4>${deviceList(s.devices)}`, null, null, true);
  }

  async function renderStats() {
    const s = await api('/stats');
    $('#main').innerHTML = `
      <div class="page-head"><h1>Estadísticas</h1></div>
      <div class="kpis big"><div><b>${s.totalQrs}</b><span>QR activos</span></div><div><b>${s.totalScans}</b><span>Escaneos totales</span></div>
        <div><b>${s.days.reduce((a, d) => a + d.scans, 0)}</b><span>Últimos 30 días</span></div></div>
      <div class="panel"><h3>Escaneos por día (30 días)</h3>${barChart(s.days)}</div>
      <div class="two-col">
        <div class="panel"><h3>Dispositivos</h3>${deviceList(s.devices)}</div>
        <div class="panel"><h3>Más escaneados</h3>${s.top.length ? s.top.map((t, i) => `<div class="dev"><span>${i + 1}. ${esc(t.name)}</span><b>${t.scans}</b></div>`).join('') : '<p class="muted">Sin datos.</p>'}</div>
      </div>`;
  }

  // ---------- Plantillas ----------
  async function renderTemplates() {
    await loadTemplates();
    const main = $('#main');
    main.innerHTML = `<div class="page-head"><h1>Diseños guardados <span class="muted">(${state.templates.length})</span></h1></div>
      <p class="muted">Guarda un diseño desde el editor (pestaña Diseño → “Guardar como plantilla”) para reutilizar logo, colores y marco en nuevos QR.</p>
      <div class="tgrid" id="tgrid"></div>`;
    for (const t of state.templates) {
      const el = document.createElement('div');
      el.className = 'tcard';
      el.innerHTML = `<img alt=""><div class="tname">${esc(t.name)}</div>
        <div class="row"><button class="btn small primary" data-use>Usar</button><button class="btn small danger-text" data-del>Eliminar</button></div>`;
      $('#tgrid').appendChild(el);
      buildSvg(state.config.baseUrl + '/r/ejemplo', t.design).then(svg => { $('img', el).src = svgToDataUrl(svg); });
      $('[data-use]', el).addEventListener('click', () => openEditor(null, 'content', t.design));
      $('[data-del]', el).addEventListener('click', () => confirmDialog(`¿Eliminar la plantilla "${t.name}"?`, async () => {
        await api('/templates/' + t.id, { method: 'DELETE' }); renderTemplates();
      }));
    }
  }

  // ---------- Editor ----------
  const DESIGN_FIELDS = ['dotType', 'dotColor', 'gradOn', 'dotColor2', 'gradType', 'cornerSq', 'cornerSqColor', 'cornerDot', 'cornerDotColor',
    'bgColor', 'bgTransparent', 'margin', 'ecl', 'logoSize', 'logoMargin', 'logoHideDots',
    'frameOn', 'frameText', 'frameColor', 'frameTextColor', 'frameFont', 'frameRadius'];

  function fillDesignForm(d) {
    DESIGN_FIELDS.forEach(k => {
      const el = $('#d_' + k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!d[k]; else el.value = d[k];
    });
    $('#logoPreview').src = d.logo || '';
    $('#logoPreview').classList.toggle('hidden', !d.logo);
  }
  function readDesignForm() {
    const d = Object.assign({}, state.design);
    DESIGN_FIELDS.forEach(k => {
      const el = $('#d_' + k);
      if (!el) return;
      d[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
    });
    return d;
  }

  function currentData() {
    if (state.editing) return state.editing.shortUrl;
    const code = $('#f_code').value.trim();
    return shortUrl(code || 'nuevo');
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      state.design = readDesignForm();
      const data = currentData();
      $('#previewUrl').textContent = 'Codifica: ' + data;
      try { $('#previewImg').src = svgToDataUrl(await buildSvg(data, state.design)); }
      catch (e) { console.error(e); }
    }, 120);
  }

  function openEditor(q, tab = 'content', presetDesign) {
    state.editing = q;
    state.design = Object.assign({}, DEFAULT_DESIGN, presetDesign || (q && q.design) || {});
    $('#editorTitle').textContent = q ? 'Editar código QR' : 'Crear código QR';
    $('#editorErr').textContent = '';
    $('#f_name').value = q ? q.name : '';
    $('#f_url').value = q ? q.url : 'https://';
    $('#f_code').value = q ? q.code : '';
    $('#f_code').disabled = !!q;
    $('#f_folder').innerHTML = '<option value="">Sin carpeta</option>' + state.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('#f_folder').value = q ? (q.folderId || '') : (state.folder || '');
    $('#f_template').value = '';
    fillDesignForm(state.design);
    switchTab(tab);
    $('#editor').classList.remove('hidden');
    schedulePreview();
  }

  function switchTab(tab) {
    $$('#editor .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $$('#editor .tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
  }
  $$('#editor .tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#editor').addEventListener('input', e => { if (e.target.closest('.editor-form')) schedulePreview(); });
  $('#editor').addEventListener('change', e => { if (e.target.closest('.editor-form')) schedulePreview(); });

  $('#f_template').addEventListener('change', e => {
    const t = state.templates.find(x => x.id === e.target.value);
    if (!t) return;
    state.design = Object.assign({}, DEFAULT_DESIGN, t.design);
    fillDesignForm(state.design); schedulePreview(); toast('Plantilla aplicada');
  });
  $('#saveTemplateBtn').addEventListener('click', () => promptDialog('Guardar diseño como plantilla', 'Nombre de la plantilla', '', async name => {
    await api('/templates', { method: 'POST', body: { name, design: readDesignForm() } });
    await loadTemplates(); toast('Plantilla guardada');
  }));

  // Logo
  $('#logoPick').addEventListener('click', () => $('#logoFile').click());
  $('#logoRemove').addEventListener('click', () => { state.design.logo = null; fillDesignForm(readDesignForm()); schedulePreview(); });
  $('#logoFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('El logo debe pesar menos de 2 MB', true);
    const dataUrl = await resizeImage(file, 600);
    state.design = readDesignForm();
    state.design.logo = dataUrl;
    if (state.design.ecl === 'L' || state.design.ecl === 'M') state.design.ecl = 'H';
    fillDesignForm(state.design);
    schedulePreview();
  });
  const logoDrop = $('#logoDrop');
  logoDrop.addEventListener('dragover', e => { e.preventDefault(); logoDrop.classList.add('drag'); });
  logoDrop.addEventListener('dragleave', () => logoDrop.classList.remove('drag'));
  logoDrop.addEventListener('drop', e => {
    e.preventDefault(); logoDrop.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) { const dt = new DataTransfer(); dt.items.add(f); $('#logoFile').files = dt.files; $('#logoFile').dispatchEvent(new Event('change')); }
  });

  function resizeImage(file, max) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (file.type === 'image/svg+xml') return resolve(reader.result);
        const img = new Image();
        img.onload = () => {
          const s = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Guardar
  $('#saveQrBtn').addEventListener('click', async () => {
    $('#editorErr').textContent = '';
    const body = {
      name: $('#f_name').value.trim(), url: $('#f_url').value.trim(),
      folderId: $('#f_folder').value || null, design: readDesignForm(),
    };
    if (!state.editing && $('#f_code').value.trim()) body.code = $('#f_code').value.trim();
    try {
      const btn = $('#saveQrBtn'); btn.disabled = true;
      const saved = state.editing
        ? await api('/qrs/' + state.editing.id, { method: 'PUT', body })
        : await api('/qrs', { method: 'POST', body });
      btn.disabled = false;
      state.editing = saved;
      $('#f_code').value = saved.code; $('#f_code').disabled = true;
      $('#editorTitle').textContent = 'Editar código QR';
      schedulePreview();
      toast('QR guardado');
      await loadFolders();
      if (state.view !== 'active' && state.view !== 'archived') state.view = 'active';
      render();
    } catch (err) { $('#saveQrBtn').disabled = false; $('#editorErr').textContent = err.message; }
  });

  // Descargas desde el editor
  $$('[data-dl]').forEach(b => b.addEventListener('click', async () => {
    const name = $('#f_name').value.trim() || 'codigo-qr';
    b.disabled = true;
    try { await download(b.dataset.dl, currentData(), readDesignForm(), name, { size: $('#dlSize').value, pdfCm: $('#dlPdfCm').value }); }
    catch (e) { toast('No se pudo generar la descarga', true); console.error(e); }
    b.disabled = false;
  }));

  // ---------- Modales / menús ----------
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
  }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $$('.modal').forEach(m => m.classList.add('hidden')); closeMenu(); } });

  function openDialog(title, bodyHtml, onOk, okLabel = 'Guardar', wide = false, danger = false) {
    $('#dialogTitle').innerHTML = title;
    $('#dialogBody').innerHTML = bodyHtml;
    $('#dialog .modal-card').classList.toggle('wide', !!wide);
    const foot = $('#dialogFoot');
    foot.innerHTML = onOk ? `<p class="error" id="dlgErr"></p><button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="dlgOk">${okLabel}</button>`
      : '<button class="btn" data-close>Cerrar</button>';
    $('#dialog').classList.remove('hidden');
    if (onOk) {
      const ok = async () => {
        try { await onOk(); $('#dialog').classList.add('hidden'); }
        catch (err) { $('#dlgErr').textContent = err.message; }
      };
      $('#dlgOk').addEventListener('click', ok);
      const input = $('#dialogBody input');
      if (input) { input.focus(); input.select(); input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); }); }
    }
  }
  function promptDialog(title, label, value, onOk, type = 'text') {
    openDialog(title, `<label>${esc(label)}<input id="dlgInput" type="${type}" value="${esc(value)}"></label>`, async () => {
      const v = $('#dlgInput').value.trim();
      if (!v) throw new Error('Este campo es obligatorio');
      await onOk(v);
    });
  }
  function confirmDialog(msg, onOk) { openDialog('Confirmar', `<p>${esc(msg)}</p>`, onOk, 'Confirmar', false, true); }

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(anchor, items) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'popmenu';
    items.forEach(([label, fn, danger]) => {
      const b = document.createElement('button');
      b.textContent = label; if (danger) b.className = 'danger-text';
      b.addEventListener('click', e => { e.stopPropagation(); closeMenu(); fn(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
    menuEl.style.top = (r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4) + window.scrollY + 'px';
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }

  init();
})();
