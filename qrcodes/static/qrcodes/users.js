/* Sección "Usuarios y áreas": perfiles y áreas (solo super administrador) */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const { api, toast, esc, fmtDate, promptDialog, confirmDialog, reloadSession, ROLE_LABELS } = window.PYQR;

  const ROLE_OPTIONS = ['superadmin', 'admin', 'viewer', 'pending'];
  const ROLE_HELP = {
    superadmin: 'Acceso total: todas las áreas, usuarios y áreas',
    admin: 'Crea, edita y elimina en su área',
    viewer: 'Solo ve y descarga en su área',
    pending: 'No ve nada hasta que se le asigne un perfil',
  };
  const up = { users: [], areas: [], filter: '', tab: 'users' };

  const roleSelect = sel => ROLE_OPTIONS.map(r => `<option value="${r}" ${r === sel ? 'selected' : ''} title="${ROLE_HELP[r]}">${ROLE_LABELS[r]}</option>`).join('');
  const areaSelect = sel => '<option value="">General</option>' +
    up.areas.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');

  async function render() {
    [up.users, up.areas] = await Promise.all([api('/users'), api('/areas')]);
    $('#main').innerHTML = `
      <div class="page-head"><h1>Usuarios y áreas</h1></div>
      <div class="tabs page-tabs">
        <button class="tab" data-utab="users">Usuarios <span class="muted">(${up.users.length})</span>${
          up.users.some(u => u.role === 'pending') ? ` <span class="pending-tag">${up.users.filter(u => u.role === 'pending').length} pendiente(s)</span>` : ''}</button>
        <button class="tab" data-utab="areas">Áreas <span class="muted">(${up.areas.length})</span></button>
      </div>

      <section data-upane="users">
        <form class="panel admin-form" id="addUserForm">
          <h3>Agregar usuario</h3>
          <div class="admin-form-row">
            <label>Correo<input id="nuEmail" type="email" placeholder="correo@py.cl" required></label>
            <label>Perfil<select id="nuRole">${roleSelect('viewer')}</select></label>
            <label>Área<select id="nuArea">${areaSelect(null)}</select></label>
            <button class="btn primary" type="submit">Agregar</button>
          </div>
          <p class="hint">Entrará con su cuenta Microsoft y quedará con este perfil y área.
            <b>Super admin</b>: todo · <b>Administrador</b>: crea, edita y elimina en su área · <b>Visualización</b>: solo ve y descarga.</p>
        </form>
        <div class="toolbar"><input id="userFilter" type="search" placeholder="Buscar usuario por nombre o correo" value="${esc(up.filter)}"></div>
        <div id="userList" class="admin-list"></div>
      </section>

      <section data-upane="areas">
        <form class="panel admin-form" id="addAreaForm">
          <h3>Nueva área</h3>
          <div class="admin-form-row">
            <label>Nombre<input id="naName" placeholder="Ej: Recursos Humanos" required></label>
            <button class="btn primary" type="submit">Crear área</button>
          </div>
          <p class="hint">Los usuarios de un área solo ven los QR, carpetas, fichas y plantillas de esa área. Sin área = “General”.</p>
        </form>
        <div id="areaList" class="admin-list"></div>
      </section>
      <p class="hint"><a href="/admin/" target="_blank">Administración avanzada ↗</a></p>`;

    renderUsers();
    renderAreas();
    switchTab(up.tab);
    bind();
  }

  function switchTab(tab) {
    up.tab = tab;
    $$('[data-utab]').forEach(t => t.classList.toggle('active', t.dataset.utab === tab));
    $$('[data-upane]').forEach(p => p.classList.toggle('hidden', p.dataset.upane !== tab));
  }

  // ---------- Usuarios ----------
  function renderUsers() {
    const f = up.filter.toLowerCase();
    // Los pendientes de autorización van primero
    const list = up.users.filter(u => !f || [u.username, u.email, u.name].some(x => (x || '').toLowerCase().includes(f)))
      .sort((a, b) => (b.role === 'pending') - (a.role === 'pending'));
    $('#userList').innerHTML = list.length ? list.map(u => `
      <div class="urow ${u.active ? '' : 'inactive'} ${u.role === 'pending' ? 'is-pending' : ''}" data-uid="${u.id}">
        <div class="uinfo">
          <div class="uname">${esc(u.name || u.username)}${u.role === 'pending' ? ' <span class="pending-tag">Pendiente</span>' : ''}</div>
          <div class="umail">${esc(u.email || u.username)}</div>
          <div class="muted small" title="Último ingreso">${u.lastLogin ? 'Último ingreso: ' + fmtDate(u.lastLogin) : 'Nunca ha entrado'}</div>
        </div>
        <label>Perfil<select data-field="role">${roleSelect(u.role)}</select></label>
        <label>Área<select data-field="areaId">${areaSelect(u.areaId)}</select></label>
        <label class="uactive"><input type="checkbox" data-field="active" ${u.active ? 'checked' : ''}> Activo</label>
      </div>`).join('') : '<div class="empty">No hay usuarios.</div>';
  }

  // ---------- Áreas ----------
  function renderAreas() {
    $('#areaList').innerHTML = up.areas.length ? up.areas.map(a => `
      <div class="arow" data-aid="${a.id}">
        <span class="aname">${esc(a.name)}</span>
        <span class="muted small">${a.users} usuario${a.users === 1 ? '' : 's'} · ${a.qrs} QR</span>
        <button class="btn small" data-aact="rename">Renombrar</button>
        <button class="btn small danger-text" data-aact="delete">Eliminar</button>
      </div>`).join('') : '<div class="empty">Aún no hay áreas. Todo está en “General”.</div>';
  }

  // Tras crear/renombrar/eliminar un área se recarga la sesión: actualiza el selector de área de la barra superior
  // y vuelve a pintar esta sección.
  async function areasChanged(msg) { toast(msg); await reloadSession(); }

  function bind() {
    $$('[data-utab]').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.utab)));

    $('#userList').addEventListener('change', async e => {
      const field = e.target.dataset.field;
      const row = e.target.closest('[data-uid]');
      if (!field || !row) return;
      const value = field === 'active' ? e.target.checked : e.target.value || null;
      try {
        const saved = await api('/users/' + row.dataset.uid, { method: 'PUT', body: { [field]: value } });
        up.users = up.users.map(u => (u.id === saved.id ? saved : u));
        toast('Usuario actualizado');
      } catch (err) { toast(err.message, true); }
      renderUsers();
    });

    $('#userFilter').addEventListener('input', e => { up.filter = e.target.value.trim(); renderUsers(); });

    $('#addUserForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/users', { method: 'POST', body: { email: $('#nuEmail').value.trim(), role: $('#nuRole').value, areaId: $('#nuArea').value || null } });
        toast('Usuario agregado');
        await render();
      } catch (err) { toast(err.message, true); }
    });

    $('#areaList').addEventListener('click', e => {
      const btn = e.target.closest('[data-aact]');
      if (!btn) return;
      const a = up.areas.find(x => x.id === btn.closest('[data-aid]').dataset.aid);
      if (btn.dataset.aact === 'rename') return promptDialog('Renombrar área', 'Nombre', a.name, async name => {
        await api('/areas/' + a.id, { method: 'PUT', body: { name } }); await areasChanged('Área renombrada');
      });
      confirmDialog(`¿Eliminar el área "${a.name}"? Solo se puede si no tiene usuarios ni contenido.`, async () => {
        await api('/areas/' + a.id, { method: 'DELETE' }); await areasChanged('Área eliminada');
      });
    });

    $('#addAreaForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api('/areas', { method: 'POST', body: { name: $('#naName').value.trim() } });
        await areasChanged('Área creada');
      } catch (err) { toast(err.message, true); }
    });
  }

  window.PYUsers = { render };
})();
