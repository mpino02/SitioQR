/* Fichas PDF: subir planos, posicionar códigos QR encima y descargar el PDF modificado */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { state, api, toast, esc, fmtDate, openDialog, promptDialog, confirmDialog, showMenu } = window.PYQR;
  const { buildSvg, svgToDataUrl, svgSize, rasterize, downloadUrl, safeName } = window.QRRender;

  pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDFJS_WORKER;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

  // Estado del editor
  const fe = {
    ficha: null, pdf: null, bytes: null, page: 1, zoom: null, scale: 1, pageW: 1, pageH: 1,
    placements: [], selected: -1, dirty: false, qrs: [], qrMap: new Map(), lastW: 0.06, renderId: 0,
  };
  const listState = { search: '', folder: '' };

  // ---------- QR ----------
  async function loadQrs() {
    const [active, archived] = await Promise.all([api('/qrs?archived=0&sort=name'), api('/qrs?archived=1&sort=name')]);
    fe.qrs = active;
    fe.qrMap = new Map([...active, ...archived].map(q => [q.id, q]));
  }

  const qrCache = new Map();
  function qrImage(q) {
    const key = q.id + '|' + q.updatedAt;
    if (!qrCache.has(key)) {
      qrCache.set(key, buildSvg(q.shortUrl, q.design).then(svg => {
        const s = svgSize(svg);
        return { svg, url: svgToDataUrl(svg), aspect: s.h / s.w };
      }));
    }
    return qrCache.get(key);
  }

  async function fetchBytes(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(res.status === 404 ? 'No se encontró el archivo PDF' : 'No se pudo descargar el PDF');
    return res.arrayBuffer();
  }

  // pdf.js transfiere el buffer al worker, por eso siempre recibe una copia
  const openPdf = bytes => pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;

  // ---------- Lista de fichas ----------
  async function renderList() {
    const params = new URLSearchParams();
    if (listState.folder) params.set('folder', listState.folder);
    if (listState.search) params.set('q', listState.search);
    const list = await api('/fichas?' + params);
    const folderOpts = '<option value="">Todas las carpetas</option>' +
      state.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    const main = $('#main');
    main.innerHTML = `
      <div class="page-head">
        <h1>Fichas PDF <span class="muted">(${list.length})</span></h1>
        <p class="muted">Sube un plano o ficha en PDF, posiciona los códigos QR encima y descarga el PDF con los QR incluidos.</p>
      </div>
      <div class="toolbar">
        <form class="search" id="fSearchForm">
          <input id="fSearch" placeholder="Buscar ficha por nombre" value="${esc(listState.search)}">
          <button class="btn blue" type="submit">Buscar</button>
        </form>
        <select id="fFolder" aria-label="Carpeta">${folderOpts}</select>
        <div class="spacer"></div>
        <input type="file" id="fUpload" accept="application/pdf,.pdf" multiple hidden>
        <button class="btn primary" id="fUploadBtn">⤒ Subir PDF</button>
      </div>
      <div class="drop-zone" id="fDrop">Arrastra aquí uno o más archivos PDF para subirlos${listState.folder ? ' a esta carpeta' : ''}</div>
      <div class="flist" id="fList">${list.length ? '' : '<div class="empty">Aún no hay fichas. Sube el primer PDF con “Subir PDF”.</div>'}</div>`;

    $('#fFolder').value = listState.folder;
    $('#fFolder').addEventListener('change', e => { listState.folder = e.target.value; renderList(); });
    $('#fSearchForm').addEventListener('submit', e => { e.preventDefault(); listState.search = $('#fSearch').value.trim(); renderList(); });
    $('#fUploadBtn').addEventListener('click', () => $('#fUpload').click());
    $('#fUpload').addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; uploadFiles(files); });
    const drop = $('#fDrop');
    main.ondragover = e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); drop.classList.add('drag'); } };
    main.ondragleave = e => { if (!main.contains(e.relatedTarget)) drop.classList.remove('drag'); };
    main.ondrop = e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); drop.classList.remove('drag'); uploadFiles([...e.dataTransfer.files]); };

    const box = $('#fList');
    for (const f of list) {
      const folder = state.folders.find(x => x.id === f.folderId);
      const card = document.createElement('div');
      card.className = 'fcard';
      card.innerHTML = `
        <div class="ficon" aria-hidden="true">PDF</div>
        <div class="fbody">
          <h3 class="qname"><span>${esc(f.name)}</span></h3>
          <div class="muted small">Actualizado ${fmtDate(f.updatedAt)} · ${fmtSize(f.size)}</div>
          <div class="meta">📁 ${folder ? esc(folder.name) : '<span class="muted">Sin carpeta</span>'}</div>
          <div class="meta">▦ ${f.qrCount} QR posicionado${f.qrCount === 1 ? '' : 's'}</div>
        </div>
        <div class="factions">
          <button class="btn primary small" data-act="open">Posicionar QR</button>
          <button class="btn outline small" data-act="download">⬇ PDF con QR</button>
          <button class="icon-btn" data-act="menu" title="Más opciones">⋮</button>
        </div>`;
      card.addEventListener('click', e => onCardAction(e, f));
      box.appendChild(card);
    }
  }

  async function onCardAction(e, f) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'open') return openEditor(f.id);
    if (act === 'download') return downloadFromList(f, btn);
    if (act === 'menu') {
      return showMenu(btn, [
        ['Renombrar', () => promptDialog('Renombrar ficha', 'Nombre', f.name, async name => {
          await api('/fichas/' + f.id, { method: 'PUT', body: { name } }); toast('Ficha renombrada'); renderList();
        })],
        ['Mover a carpeta', () => {
          const opts = '<option value="">Sin carpeta</option>' + state.folders.map(x => `<option value="${x.id}" ${x.id === f.folderId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
          openDialog('Mover a carpeta', `<label>Carpeta<select id="fMoveSel">${opts}</select></label>`, async () => {
            await api('/fichas/' + f.id, { method: 'PUT', body: { folderId: $('#fMoveSel').value || null } }); toast('Ficha movida'); renderList();
          }, 'Mover');
        }],
        ['Descargar PDF original', () => downloadUrl(f.fileUrl, f.originalName || safeName(f.name) + '.pdf')],
        ['Eliminar', () => confirmDialog(`¿Eliminar la ficha "${f.name}"? Se borra el PDF subido; los códigos QR no se modifican.`, async () => {
          await api('/fichas/' + f.id, { method: 'DELETE' }); toast('Ficha eliminada'); renderList();
        }), true],
      ]);
    }
  }

  async function uploadFiles(files) {
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) return toast('Selecciona archivos PDF', true);
    let last = null;
    for (const [i, file] of pdfs.entries()) {
      toast(pdfs.length > 1 ? `Subiendo ${i + 1} de ${pdfs.length}: ${file.name}…` : `Subiendo ${file.name}…`);
      const fd = new FormData();
      fd.append('file', file);
      if (listState.folder) fd.append('folderId', listState.folder);
      try { last = await api('/fichas', { method: 'POST', body: fd }); }
      catch (err) { toast(`${file.name}: ${err.message}`, true); await renderList(); return; }
    }
    toast(pdfs.length > 1 ? `${pdfs.length} fichas subidas` : 'Ficha subida');
    await renderList();
    if (pdfs.length === 1 && last) openEditor(last.id);
  }

  async function downloadFromList(f, btn) {
    btn.disabled = true;
    let pdf = null;
    try {
      toast('Generando PDF…');
      const [ficha, bytes] = await Promise.all([api('/fichas/' + f.id), fetchBytes(f.fileUrl), loadQrs()]);
      pdf = await openPdf(bytes);
      await exportPdf(ficha.name, ficha.placements, bytes, pdf);
    } catch (err) { console.error(err); toast(err.message || 'No se pudo generar el PDF', true); }
    if (pdf) pdf.destroy();
    btn.disabled = false;
  }

  // ---------- Exportar PDF con QR ----------
  async function exportPdf(name, placements, bytes, pjDoc) {
    const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
    let doc;
    try { doc = await PDFDocument.load(bytes.slice(0)); }
    catch (err) {
      if (/encrypt/i.test(err.message)) throw new Error('El PDF está protegido. Expórtalo de nuevo sin contraseña ni restricciones.');
      throw new Error('No se pudo leer el PDF');
    }
    const pages = doc.getPages();
    const embedded = new Map();
    let count = 0;
    for (const p of placements) {
      const q = fe.qrMap.get(p.qrId);
      const page = pages[p.page - 1];
      if (!q || !page) continue;
      const img = await qrImage(q);
      if (!embedded.has(q.id)) {
        const { dataUrl } = await rasterize(img.svg, 1600, 'image/png', false);
        embedded.set(q.id, await doc.embedPng(dataUrl));
      }
      // Misma geometría que en pantalla: pdf.js entrega la conversión de la página visible (rotación y recorte incluidos) a coordenadas PDF
      const vp = (await pjDoc.getPage(p.page)).getViewport({ scale: 1 });
      const [ox, oy] = vp.convertToPdfPoint(0, 0);
      const [ax, ay] = vp.convertToPdfPoint(1, 0);
      const [bx, by] = vp.convertToPdfPoint(0, 1);
      const ux = ax - ox, uy = ay - oy, vx = bx - ox, vy = by - oy;
      const w = p.w * vp.width, h = w * img.aspect;
      const left = p.x * vp.width, bottom = p.y * vp.height + h;
      page.node.normalize();
      const xName = page.node.newXObject('QR', embedded.get(q.id).ref);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(ux * w, uy * w, -vx * h, -vy * h, ox + ux * left + vx * bottom, oy + uy * left + vy * bottom),
        drawObject(xName),
        popGraphicsState(),
      );
      count++;
    }
    const out = await doc.save();
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    downloadUrl(url, safeName(name) + '_con_QR.pdf');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(count ? `PDF descargado con ${count} QR` : 'PDF descargado (sin QR posicionados)');
  }

  // ---------- Editor ----------
  async function openEditor(id) {
    toast('Abriendo ficha…');
    let ficha, bytes, pdf;
    try {
      [ficha, bytes] = await Promise.all([api('/fichas/' + id), fetchBytes(`/api/fichas/${id}/file`), loadQrs()]);
      pdf = await openPdf(bytes);
    } catch (err) { console.error(err); return toast(err.message || 'No se pudo abrir el PDF', true); }

    const placements = ficha.placements.filter(p => fe.qrMap.has(p.qrId) && p.page <= pdf.numPages);
    const removed = ficha.placements.length - placements.length;
    Object.assign(fe, { ficha, pdf, bytes, page: 1, zoom: null, placements, selected: -1, dirty: removed > 0 });
    if (placements.length) fe.lastW = placements[placements.length - 1].w;

    $('#feTitle').textContent = ficha.name;
    $('#feFolder').innerHTML = '<option value="">Todas las carpetas</option><option value="none">Sin carpeta</option>' +
      state.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('#feFolder').value = ficha.folderId || '';
    $('#feSearch').value = '';
    $('#fichaEditor').classList.remove('hidden');
    document.body.classList.add('no-scroll');
    $('#toast').classList.add('hidden');
    updateStatus(); renderQrList(); updateSelPanel();
    await renderPage();
    if (removed) toast(`Se quitaron ${removed} QR que ya no existen. Guarda para confirmar.`, true);
  }

  function closeEditor(force) {
    if (fe.dirty && !force) return confirmDialog('Hay cambios sin guardar. ¿Cerrar sin guardar?', async () => closeEditor(true));
    $('#fichaEditor').classList.add('hidden');
    document.body.classList.remove('no-scroll');
    if (fe.pdf) fe.pdf.destroy();
    Object.assign(fe, { ficha: null, pdf: null, bytes: null, placements: [], selected: -1, dirty: false });
    $('#feOverlay').innerHTML = '';
    if (state.view === 'fichas') renderList();
  }

  const editorOpen = () => !$('#fichaEditor').classList.contains('hidden');

  function markDirty() { fe.dirty = true; updateStatus(); }
  function updateStatus() {
    $('#feStatus').textContent = fe.dirty ? '● Cambios sin guardar' : 'Guardado';
    $('#feStatus').classList.toggle('dirty', fe.dirty);
  }

  async function renderPage() {
    const id = ++fe.renderId;
    const page = await fe.pdf.getPage(fe.page);
    if (id !== fe.renderId) return;
    const base = page.getViewport({ scale: 1 });
    fe.pageW = base.width; fe.pageH = base.height;
    const box = $('#feViewport');
    const fit = Math.max(0.05, (box.clientWidth - 48) / base.width);
    fe.scale = fe.zoom || fit;
    const vp = page.getViewport({ scale: fe.scale });
    const pageEl = $('#fePage');
    pageEl.style.width = vp.width + 'px';
    pageEl.style.height = vp.height + 'px';

    // Lienzo nuevo en cada render (pdf.js no permite reutilizar uno ocupado); resolución limitada para planos grandes
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(30e6 / (vp.width * vp.height)));
    const canvas = document.createElement('canvas');
    canvas.className = 'fe-canvas';
    canvas.width = Math.floor(vp.width * ratio); canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    const old = $('.fe-canvas', pageEl);
    if (old) old.replaceWith(canvas); else pageEl.prepend(canvas);
    pageEl.classList.add('loading');

    renderPlacements();
    updateToolbar();
    try {
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    } catch (err) { console.error(err); }
    if (id === fe.renderId) pageEl.classList.remove('loading');
  }

  function updateToolbar() {
    const n = fe.pdf.numPages;
    const onPage = fe.placements.filter(p => p.page === fe.page).length;
    $('#fePageLbl').textContent = `Página ${fe.page} de ${n} · ${onPage} QR`;
    $('#fePrev').disabled = fe.page <= 1;
    $('#feNext').disabled = fe.page >= n;
    $('#feZoomLbl').textContent = Math.round(fe.scale * 100) + '%';
  }

  function placementStyle(el, p) {
    el.style.left = p.x * 100 + '%';
    el.style.top = p.y * 100 + '%';
    el.style.width = p.w * 100 + '%';
  }

  function renderPlacements() {
    const ov = $('#feOverlay');
    ov.innerHTML = '';
    fe.placements.forEach((p, i) => {
      if (p.page !== fe.page) return;
      const q = fe.qrMap.get(p.qrId);
      const el = document.createElement('div');
      el.className = 'pl' + (i === fe.selected ? ' sel' : '') + (q.archived ? ' archived' : '');
      el.dataset.i = i;
      el.title = q.name + (q.archived ? ' (archivado: no redirige)' : '');
      el.innerHTML = `<img alt="" draggable="false"><span class="pl-name">${esc(q.name)}</span>
        <button class="pl-del" data-del title="Quitar" aria-label="Quitar">✕</button><span class="pl-handle" data-resize title="Cambiar tamaño"></span>`;
      placementStyle(el, p);
      ov.appendChild(el);
      qrImage(q).then(r => { $('img', el).src = r.url; el.style.aspectRatio = `1 / ${r.aspect}`; });
    });
  }

  function select(i) {
    fe.selected = i;
    $$('#feOverlay .pl').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === i));
    updateSelPanel();
  }

  function updateSelPanel() {
    const p = fe.placements[fe.selected];
    $('#feSel').classList.toggle('hidden', !p);
    if (!p) return;
    $('#feSelName').textContent = fe.qrMap.get(p.qrId).name;
    $('#feSize').value = (p.w * 100).toFixed(1);
    const cm = p.w * fe.pageW / 72 * 2.54;
    $('#feSizeLbl').textContent = `≈ ${cm.toFixed(1).replace('.', ',')} cm de ancho`;
  }

  async function addPlacement(qrId, cx, cy) {
    const q = fe.qrMap.get(qrId);
    if (!q) return;
    const { aspect } = await qrImage(q);
    const w = fe.lastW;
    const hf = w * aspect * fe.pageW / fe.pageH;
    if (cx == null) {
      // Centro de la zona visible del plano
      const box = $('#feViewport').getBoundingClientRect();
      const r = $('#fePage').getBoundingClientRect();
      cx = clamp((box.left + box.width / 2 - r.left) / r.width, 0, 1);
      cy = clamp((box.top + box.height / 2 - r.top) / r.height, 0, 1);
    }
    fe.placements.push({ qrId, page: fe.page, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - hf / 2, 0, Math.max(0, 1 - hf)), w });
    fe.selected = fe.placements.length - 1;
    markDirty(); renderPlacements(); renderQrList(); updateSelPanel(); updateToolbar();
  }

  function removePlacement(i) {
    if (!fe.placements[i]) return;
    fe.placements.splice(i, 1);
    fe.selected = -1;
    markDirty(); renderPlacements(); renderQrList(); updateSelPanel(); updateToolbar();
  }

  function renderQrList() {
    const s = $('#feSearch').value.trim().toLowerCase();
    const folder = $('#feFolder').value;
    const counts = {};
    fe.placements.forEach(p => { counts[p.qrId] = (counts[p.qrId] || 0) + 1; });
    const list = fe.qrs.filter(q =>
      (!folder || (folder === 'none' ? !q.folderId : q.folderId === folder)) &&
      (!s || q.name.toLowerCase().includes(s) || q.code.toLowerCase().includes(s)));
    const box = $('#feQrList');
    box.innerHTML = list.length ? list.map(q => `
      <button class="fe-qr" draggable="true" data-id="${q.id}" title="Agregar “${esc(q.name)}” a la página">
        <img alt="" draggable="false"><span class="fe-qr-name">${esc(q.name)}</span>
        ${counts[q.id] ? `<span class="badge" title="Veces posicionado en esta ficha">✓ ${counts[q.id]}</span>` : ''}
      </button>`).join('') : '<p class="muted small">No hay códigos QR activos en esta carpeta.</p>';
    $$('.fe-qr', box).forEach(el => qrImage(fe.qrMap.get(el.dataset.id)).then(r => { $('img', el).src = r.url; }));
  }

  async function save() {
    const btn = $('#feSave');
    btn.disabled = true;
    try {
      fe.ficha = await api('/fichas/' + fe.ficha.id, { method: 'PUT', body: { placements: fe.placements } });
      fe.dirty = false; updateStatus(); toast('Ficha guardada');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  }

  function setZoom(z) {
    fe.zoom = z;
    renderPage();
  }

  // ---------- Eventos del editor ----------
  $('#feClose').addEventListener('click', () => closeEditor());
  $('#feSave').addEventListener('click', save);
  $('#feDownload').addEventListener('click', async () => {
    const btn = $('#feDownload');
    btn.disabled = true;
    toast('Generando PDF…');
    try { await exportPdf(fe.ficha.name, fe.placements, fe.bytes, fe.pdf); }
    catch (err) { console.error(err); toast(err.message || 'No se pudo generar el PDF', true); }
    btn.disabled = false;
  });
  $('#fePrev').addEventListener('click', () => { if (fe.page > 1) { fe.page--; select(-1); renderPage(); } });
  $('#feNext').addEventListener('click', () => { if (fe.page < fe.pdf.numPages) { fe.page++; select(-1); renderPage(); } });
  $('#feZoomIn').addEventListener('click', () => setZoom(ZOOMS.find(z => z > fe.scale + 0.001) || ZOOMS[ZOOMS.length - 1]));
  $('#feZoomOut').addEventListener('click', () => setZoom([...ZOOMS].reverse().find(z => z < fe.scale - 0.001) || ZOOMS[0]));
  $('#feZoomFit').addEventListener('click', () => setZoom(null));
  $('#feFolder').addEventListener('change', renderQrList);
  $('#feSearch').addEventListener('input', renderQrList);

  // Lista de QR: clic agrega, arrastrar suelta sobre el plano
  $('#feQrList').addEventListener('click', e => { const el = e.target.closest('.fe-qr'); if (el) addPlacement(el.dataset.id); });
  $('#feQrList').addEventListener('dragstart', e => {
    const el = e.target.closest('.fe-qr');
    if (!el) return;
    e.dataTransfer.setData('application/x-pyqr', el.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });
  const pageEl = $('#fePage');
  pageEl.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-pyqr')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  pageEl.addEventListener('drop', e => {
    const id = e.dataTransfer.getData('application/x-pyqr');
    if (!id) return;
    e.preventDefault();
    const r = pageEl.getBoundingClientRect();
    addPlacement(id, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });

  // Mover / redimensionar QR posicionados
  let drag = null;
  const ov = $('#feOverlay');
  ov.addEventListener('pointerdown', e => {
    const el = e.target.closest('.pl');
    if (!el) return select(-1);
    const i = Number(el.dataset.i);
    if (e.target.closest('[data-del]')) return removePlacement(i);
    e.preventDefault();
    select(i);
    const r = ov.getBoundingClientRect();
    const p = fe.placements[i];
    drag = { i, el, resize: !!e.target.closest('[data-resize]'), sx: e.clientX, sy: e.clientY, x: p.x, y: p.y, w: p.w,
      rw: r.width, rh: r.height, hf: el.offsetHeight / r.height, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  ov.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = fe.placements[drag.i];
    const dx = (e.clientX - drag.sx) / drag.rw, dy = (e.clientY - drag.sy) / drag.rh;
    if (drag.resize) {
      p.w = clamp(drag.w + dx, 0.005, 1 - p.x);
      fe.lastW = p.w;
    } else {
      p.x = clamp(drag.x + dx, 0, 1 - p.w);
      p.y = clamp(drag.y + dy, 0, Math.max(0, 1 - drag.hf));
    }
    placementStyle(drag.el, p);
    drag.moved = true;
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) { markDirty(); updateSelPanel(); }
    drag = null;
  };
  ov.addEventListener('pointerup', endDrag);
  ov.addEventListener('pointercancel', endDrag);

  // Panel del QR seleccionado
  $('#feSize').addEventListener('input', e => {
    const p = fe.placements[fe.selected];
    if (!p) return;
    p.w = clamp(Number(e.target.value) / 100, 0.005, 1);
    p.x = clamp(p.x, 0, 1 - p.w);
    fe.lastW = p.w;
    const el = $(`#feOverlay .pl[data-i="${fe.selected}"]`);
    if (el) placementStyle(el, p);
    markDirty(); updateSelPanel();
  });
  $('#feDup').addEventListener('click', () => {
    const p = fe.placements[fe.selected];
    if (!p) return;
    fe.placements.push(Object.assign({}, p, { x: clamp(p.x + 0.02, 0, 1 - p.w), y: clamp(p.y + 0.02, 0, 1) }));
    fe.selected = fe.placements.length - 1;
    markDirty(); renderPlacements(); renderQrList(); updateSelPanel(); updateToolbar();
  });
  $('#feSameSize').addEventListener('click', () => {
    const p = fe.placements[fe.selected];
    if (!p) return;
    fe.placements.forEach(o => { if (o.page === p.page) { o.w = p.w; o.x = clamp(o.x, 0, 1 - o.w); } });
    markDirty(); renderPlacements(); toast('Tamaño aplicado a todos los QR de la página');
  });
  $('#feRemove').addEventListener('click', () => removePlacement(fe.selected));

  document.addEventListener('keydown', e => {
    if (!editorOpen() || !$('#dialog').classList.contains('hidden')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.target.closest?.('input, select, textarea')) return;
    const p = fe.placements[fe.selected];
    if (e.key === 'Escape') return select(-1);
    if (!p) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removePlacement(fe.selected); return; }
    const step = e.shiftKey ? 0.01 : 0.001;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    p.x = clamp(p.x + moves[e.key][0], 0, 1 - p.w);
    p.y = clamp(p.y + moves[e.key][1], 0, 1);
    const el = $(`#feOverlay .pl[data-i="${fe.selected}"]`);
    if (el) placementStyle(el, p);
    markDirty();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!editorOpen() || fe.zoom) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPage, 200);
  });
  window.addEventListener('beforeunload', e => { if (editorOpen() && fe.dirty) { e.preventDefault(); e.returnValue = ''; } });

  window.PYFichas = { renderList };
})();
