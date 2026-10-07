/* ============================================================
   TARIFAS DE PROVEEDORES
   - Lee las pestañas Tarifas / Catalogos / Historial del Sheet espejo (gviz).
   - Escribe a través del Apps Script (API), con sesión @recylink.com.
   - Depende de globales de index.html: gvizFetch, MIRROR_SHEET_ID,
     APPS_SCRIPT_URL, SUPPLIERS, esc, norm, fmtCLP, render.
   ============================================================ */
const TARIFAS_GID   = "1128661910";
const HISTORIAL_GID = "538405505";
const CATALOGOS_GID = "1478551931";
const LOGIN_URL = "https://script.google.com/a/macros/recylink.com/s/AKfycbxIZsEsEJCFUgNEtvlUaAGKVWiB-lgGm8Q4G-1hMDARDJte2n0-QzzgqSgWvh5aAbsg/exec";
const UF_API = "https://mindicador.cl/api/uf";

let TARIFAS = [];           // todas (activas y dadas de baja)
let TARIFAS_STATUS = "no cargadas";
let CATS = { residuo: [], unidad: [], contenedor: [], estado_cliente: ["activo", "inactivo", "prospecto"], fuente: ["cotizacion", "plataforma", "informal", "carga inicial"], moneda: ["CLP", "UF"] };
let UF = { valor: null, fecha: "", origen: "" };

/* ---------------- utilidades ---------------- */
const tget = (o, k) => (o && o[k] != null ? String(o[k]) : "");
const fmtNum = (n, dec) => Number(n).toLocaleString("es-CL", { maximumFractionDigits: dec == null ? 4 : dec });
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }
function numDe(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  // "192.000" / "1.234,5" (es-CL) o "192000" / "3.5"
  const n = /,/.test(s) || /\.\d{3}(\D|$)/.test(s) ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  return isFinite(n) ? n : null;
}
const siNo = v => { const s = String(v || "").toLowerCase(); return s === "si" || s === "sí" ? "si" : s === "no" ? "no" : ""; };

/* ---------------- sesión ---------------- */
let AUTH = lsGet("rp_auth");
if (AUTH && (!AUTH.exp || AUTH.exp < Date.now())) { AUTH = null; lsDel("rp_auth"); }
let _loginResolve = null;

function sesionActiva() { return AUTH && AUTH.exp > Date.now() ? AUTH : null; }

function renderAuthBox() {
  const box = document.getElementById("authBox"); if (!box) return;
  const a = sesionActiva();
  box.innerHTML = a
    ? '<span class="auth-mail" title="Sesión válida hasta ' + new Date(a.exp).toLocaleString("es-CL") + '">' + esc(a.email) + '</span> <button class="lnk" onclick="cerrarSesion()">Salir</button>'
    : '<button class="auth-btn" onclick="iniciarSesion().catch(()=>{})">Iniciar sesión</button>';
}

function guardarSesion(token) {
  const p = String(token || "").trim().split(".");
  if (p.length !== 2) throw new Error("Código de sesión inválido.");
  const datos = JSON.parse(decodeURIComponent(escape(atob(p[0].replace(/-/g, "+").replace(/_/g, "/")))));
  if (!datos.email || !datos.exp || datos.exp < Date.now()) throw new Error("El código de sesión expiró.");
  AUTH = { token: p.join("."), email: datos.email, exp: datos.exp };
  lsSet("rp_auth", AUTH);
  renderAuthBox();
  if (_loginResolve) { _loginResolve(AUTH); _loginResolve = null; }
  cerrarModal("loginModal");
  return AUTH;
}

function cerrarSesion() { AUTH = null; lsDel("rp_auth"); renderAuthBox(); }

/** Abre la ventana de Google y espera la credencial. */
function iniciarSesion() {
  return new Promise((resolve, reject) => {
    _loginResolve = resolve;
    const url = LOGIN_URL + "?origin=" + encodeURIComponent(location.origin);
    const w = window.open(url, "rp_login", "width=480,height=620");
    abrirModal("loginModal",
      '<h3>Iniciar sesión</h3>' +
      '<p>Se abrió una ventana de Google: entra con tu cuenta <b>@recylink.com</b>. Al terminar, esta pantalla se actualiza sola.</p>' +
      (w ? '' : '<p class="warn">Tu navegador bloqueó la ventana. <a href="' + esc(url) + '" target="_blank" rel="noopener">Ábrela aquí</a>.</p>') +
      '<details><summary>¿La ventana no se cierra sola?</summary>' +
      '<p>Copia el código que aparece en ella y pégalo aquí:</p>' +
      '<textarea id="loginPaste" rows="3" style="width:100%"></textarea>' +
      '<button class="cbtn" onclick="try{guardarSesion(document.getElementById(\'loginPaste\').value)}catch(e){alert(e.message)}">Usar código</button></details>',
      () => { if (_loginResolve) { _loginResolve = null; reject(new Error("Inicio de sesión cancelado.")); } });
  });
}

window.addEventListener("message", ev => {
  const okOrigen = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/.test(ev.origin) || ev.origin === "https://script.google.com";
  if (!okOrigen || !ev.data || ev.data.type !== "recomendador-auth") return;
  try { guardarSesion(ev.data.token); } catch (e) { alert(e.message); }
});

/* ---------------- API (Apps Script) ---------------- */
async function api(action, payload, conSesion) {
  const body = Object.assign({ action }, payload || {});
  if (conSesion) {
    if (!sesionActiva()) await iniciarSesion();
    body.auth = AUTH.token;
  }
  const resp = await fetch(APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
  const data = await resp.json();
  if (!data || !data.ok) {
    if (data && data.auth) cerrarSesion();
    throw new Error(((data && data.error) || "Error desconocido").replace(/^AUTH:\s*/, ""));
  }
  return data.data || {};
}

/* ---------------- carga de datos ---------------- */
function filasAObjetos(rows) {
  if (!rows || rows.length < 1) return [];
  const head = rows[0].map(h => String(h || "").trim());
  return rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i] == null ? "" : r[i]; }); return o; });
}

async function loadTarifas() {
  try {
    const [rows, cats] = await Promise.all([
      gvizFetch(MIRROR_SHEET_ID, TARIFAS_GID, true, true),
      gvizFetch(MIRROR_SHEET_ID, CATALOGOS_GID, true, true).catch(() => null)
    ]);
    TARIFAS = filasAObjetos(rows).filter(t => tget(t, "id")).map(prepararTarifa);
    if (cats && cats.length) {
      const head = cats[0];
      head.forEach((h, i) => {
        if (!h) return;
        const vals = cats.slice(1).map(r => String(r[i] || "").trim()).filter(Boolean);
        if (vals.length) CATS[h] = vals;
      });
    }
    calcularAlertas();
    TARIFAS_STATUS = "OK (" + TARIFAS.filter(t => t.activo).length + " tarifas)";
  } catch (e) {
    TARIFAS_STATUS = "error: " + ((e && e.message) || e);
  }
  poblarFiltrosTarifas();
  renderTarifas();
  if (typeof render === "function" && SUPPLIERS.length) render();
}

function prepararTarifa(t) {
  t.precio_num = numDe(t.precio);
  t.cantidad_min_num = numDe(t.cantidad_min);
  t.cantidad_max_num = numDe(t.cantidad_max);
  t.moneda = (tget(t, "moneda") || "CLP").toUpperCase();
  t.activo = tget(t, "activo") !== "no";
  t.incluye_transporte = siNo(t.incluye_transporte);
  t.incluye_disposicion = siNo(t.incluye_disposicion);
  if (!t.region && t.comuna) t.region = regionDeComuna(t.comuna);
  t.provKey = tget(t, "proveedor_id") || "n:" + norm(t.proveedor_nombre);
  return t;
}

async function loadUF() {
  const cache = lsGet("rp_uf");
  const hoy = new Date().toISOString().slice(0, 10);
  if (cache && cache.fecha === hoy && cache.valor) { UF = Object.assign(cache, { origen: "mindicador.cl" }); return; }
  try {
    const r = await fetch(UF_API);
    const j = await r.json();
    const v = j && j.serie && j.serie[0];
    if (!v || !v.valor) throw new Error("sin valor");
    UF = { valor: v.valor, fecha: String(v.fecha || "").slice(0, 10) || hoy, origen: "mindicador.cl" };
    lsSet("rp_uf", { valor: UF.valor, fecha: hoy });
  } catch (e) {
    if (cache && cache.valor) UF = { valor: cache.valor, fecha: cache.fecha, origen: "último valor guardado" };
  }
  renderTarifas();
}

/* ---------------- cálculo ---------------- */
function clpDe(t) {
  if (t.precio_num == null) return null;
  if (t.moneda === "UF") return UF.valor ? t.precio_num * UF.valor : null;
  return t.precio_num;
}

function grupoKey(t) {
  return [norm(t.residuo), norm(t.unidad), norm(t.contenedor), t.incluye_transporte, t.incluye_disposicion, t.region || ""].join("|");
}

/** Por grupo comparable y por (proveedor, cliente), la más reciente es la vigente. */
function marcarVigentes(lista) {
  const ult = {};
  lista.forEach(t => {
    const k = grupoKey(t) + "|" + t.provKey + "|" + norm(t.cliente);
    const sello = tget(t, "fecha") + " " + tget(t, "actualizado_el");
    if (!ult[k] || sello > ult[k].sello) ult[k] = { t, sello };
  });
  lista.forEach(t => { t.vigente = false; });
  Object.values(ult).forEach(x => { x.t.vigente = true; });
}

function mediana(arr) {
  const a = arr.slice().sort((x, y) => x - y); const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function calcularAlertas() {
  const activas = TARIFAS.filter(t => t.activo);
  marcarVigentes(activas);
  const grupos = {};
  activas.filter(t => t.vigente).forEach(t => { (grupos[grupoKey(t)] = grupos[grupoKey(t)] || []).push(t); });
  TARIFAS.forEach(t => {
    const a = [];
    if (t.precio_num == null) a.push("Sin precio");
    else if (t.precio_num <= 1) a.push("Precio de " + (t.moneda === "UF" ? t.precio_num + " UF" : fmtCLP(t.precio_num)) + ": posible valor de relleno");
    if (!tget(t, "unidad")) a.push("Falta la unidad");
    if (!tget(t, "direccion") && !tget(t, "comuna")) a.push("Falta la dirección o comuna");
    if (!t.incluye_transporte || !t.incluye_disposicion) a.push("No se indicó si incluye transporte y/o disposición");
    const pares = (grupos[grupoKey(t)] || []).filter(x => x !== t).map(clpDe).filter(v => v != null);
    const v = clpDe(t);
    if (pares.length >= 2 && v != null && v > 1) {
      const m = mediana(pares);
      if (m && Math.abs(v - m) / m > 0.5) a.push("Precio " + (v > m ? "más de 50% sobre" : "más de 50% bajo") + " la mediana de comparables (" + fmtCLP(m) + ")");
    }
    t.alertas = a;
  });
}

function tarifasDeProveedor(s) {
  return TARIFAS.filter(t => t.activo && (tget(t, "proveedor_id") ? t.proveedor_id === s.id : norm(t.proveedor_nombre) === norm(s.name)));
}

/* ---------------- render: vista Tarifas ---------------- */
function precioHtml(t) {
  if (t.precio_num == null) return '<span class="muted">sin precio</span>';
  const orig = t.moneda === "UF" ? fmtNum(t.precio_num) + " UF" : fmtCLP(t.precio_num);
  const clp = clpDe(t);
  const conv = t.moneda === "UF" ? (clp != null ? '<div class="muted small">≈ ' + fmtCLP(clp) + '</div>' : '<div class="muted small">UF no disponible</div>') : "";
  return '<b>' + orig + '</b>' + (t.unidad ? ' <span class="muted">/ ' + esc(t.unidad) + '</span>' : '') + conv;
}

function alertaHtml(t) {
  return t.alertas && t.alertas.length ? '<span class="t-alerta" title="' + esc(t.alertas.join("\n")) + '">⚠ ' + t.alertas.length + '</span>' : '';
}

function siNoTxt(v, txt) { return v === "si" ? "con " + txt : v === "no" ? "sin " + txt : txt + " ¿?"; }

function filaTarifaHtml(t, opts) {
  opts = opts || {};
  const cant = [t.cantidad_min_num, t.cantidad_max_num].some(v => v != null)
    ? (t.cantidad_min_num != null ? fmtNum(t.cantidad_min_num) : "") + "–" + (t.cantidad_max_num != null ? fmtNum(t.cantidad_max_num) : "") : "";
  const lugar = [t.comuna || "", t.direccion && t.direccion !== t.comuna ? t.direccion : ""].filter(Boolean).join(" · ");
  return '<tr class="' + (t.activo ? "" : "t-baja ") + (t.vigente || !t.activo ? "" : "t-anterior ") + (opts.best ? "best" : "") + '">' +
    (opts.sinProveedor ? '' : '<td><b>' + esc(t.proveedor_nombre || "-") + '</b>' + (opts.best ? ' <span class="t-best">★ menor</span>' : '') + '</td>') +
    '<td>' + (t.cliente ? esc(t.cliente) : '<span class="muted">sin cliente</span>') + (t.estado_cliente ? ' <span class="pill p-' + esc(t.estado_cliente) + '">' + esc(t.estado_cliente) + '</span>' : '') + '</td>' +
    (opts.conServicio ? '<td>' + esc(t.residuo || "-") + '<div class="muted small">' + esc([t.contenedor, siNoTxt(t.incluye_transporte, "transp."), siNoTxt(t.incluye_disposicion, "disp.")].filter(Boolean).join(" · ")) + '</div></td>' : '') +
    '<td>' + esc(lugar || "-") + (cant ? '<div class="muted small">cant. ' + esc(cant) + '</div>' : '') + '</td>' +
    '<td class="num">' + precioHtml(t) + '</td>' +
    '<td><span class="small">' + esc(t.fecha || "-") + '</span><div class="muted small">' + esc(t.fuente || "") + (t.pdf_url ? ' · <a href="' + esc(t.pdf_url) + '" target="_blank" rel="noopener">PDF</a>' : '') + '</div></td>' +
    '<td>' + alertaHtml(t) + (t.detalle ? ' <span class="t-det" title="' + esc(t.detalle) + '">ℹ</span>' : '') + '</td>' +
    '<td class="acc">' +
      '<button class="lnk" onclick="abrirFormTarifa(\'' + esc(t.id) + '\')">Editar</button>' +
      '<button class="lnk" onclick="verHistorial(\'' + esc(t.id) + '\')">Historial</button>' +
      (t.activo ? '<button class="lnk danger" onclick="cambiarActivo(\'' + esc(t.id) + '\',false)">Dar de baja</button>'
                : '<button class="lnk" onclick="cambiarActivo(\'' + esc(t.id) + '\',true)">Restaurar</button>') +
      '<div class="muted small">' + esc((t.actualizado_el || "").slice(0, 10)) + ' · ' + esc((t.actualizado_por || "").replace(/@.*/, "")) + '</div>' +
    '</td></tr>';
}

function poblarFiltrosTarifas() {
  const set = (id, vals, todos) => {
    const el = document.getElementById(id); if (!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="">' + todos + '</option>' + [...new Set(vals.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")).map(v => '<option>' + esc(v) + '</option>').join('');
    el.value = prev;
  };
  set("tfResiduo", TARIFAS.map(t => t.residuo), "Todos");
  set("tfRegion", TARIFAS.map(t => t.region), "Todas");
  set("tfUnidad", TARIFAS.map(t => t.unidad), "Todas");
  const dl = document.getElementById("clienteDL");
  if (dl) dl.innerHTML = [...new Set(TARIFAS.map(t => tget(t, "cliente").trim()).filter(Boolean))].sort().map(c => '<option value="' + esc(c) + '">').join('');
  ["residuo", "unidad", "contenedor"].forEach(c => {
    const d = document.getElementById("cat_" + c + "DL");
    if (d) d.innerHTML = (CATS[c] || []).map(v => '<option value="' + esc(v) + '">').join('');
  });
}

function renderTarifas() {
  const box = document.getElementById("tarList"); if (!box) return;
  const g = id => (document.getElementById(id) || {}).value || "";
  const chk = id => !!(document.getElementById(id) || {}).checked;
  const fRes = g("tfResiduo"), fReg = g("tfRegion"), fUni = g("tfUnidad"), fTxt = norm(g("tfTexto")), fEst = g("tfEstado");
  const verAnt = chk("tfAnteriores"), verBaja = chk("tfBajas"), soloAl = chk("tfAlertas");

  const ufInfo = document.getElementById("ufInfo");
  if (ufInfo) ufInfo.textContent = UF.valor ? "UF " + fmtCLP(UF.valor) + " (" + UF.fecha + ", " + UF.origen + ")" : "UF no disponible: los precios en UF no se convierten";

  let lista = TARIFAS.filter(t => (t.activo || verBaja)
    && (!fRes || t.residuo === fRes) && (!fReg || t.region === fReg) && (!fUni || t.unidad === fUni)
    && (!fEst || t.estado_cliente === fEst)
    && (!fTxt || norm(t.proveedor_nombre + " " + t.cliente).indexOf(fTxt) !== -1)
    && (!soloAl || (t.alertas && t.alertas.length))
    && (t.vigente || !t.activo || verAnt));

  document.getElementById("tarCount").textContent = lista.length + " tarifa(s) · " + TARIFAS_STATUS;
  if (!lista.length) { box.innerHTML = '<div class="empty">' + (TARIFAS.length ? "Sin tarifas para el filtro actual." : "Aún no hay tarifas cargadas. Usa “+ Nueva tarifa” o “Pegar desde Claude”.") + '</div>'; return; }

  const grupos = {};
  lista.forEach(t => { (grupos[grupoKey(t)] = grupos[grupoKey(t)] || []).push(t); });
  const claves = Object.keys(grupos).sort((a, b) => {
    const ta = grupos[a][0], tb = grupos[b][0];
    return (ta.residuo || "").localeCompare(tb.residuo || "", "es") || (ta.unidad || "").localeCompare(tb.unidad || "", "es");
  });

  box.innerHTML = claves.map(k => {
    const ts = grupos[k];
    const t0 = ts[0];
    const vig = ts.filter(t => t.vigente && t.activo);
    const vals = vig.map(clpDe).filter(v => v != null && v > 1);
    const min = vals.length ? Math.min(...vals) : null;
    ts.sort((a, b) => (b.vigente - a.vigente) || ((clpDe(a) ?? 1e15) - (clpDe(b) ?? 1e15)) || String(b.fecha).localeCompare(String(a.fecha)));
    const titulo = [t0.residuo || "(sin residuo)", t0.unidad ? "por " + t0.unidad : "(sin unidad)", t0.contenedor, siNoTxt(t0.incluye_transporte, "transporte"), siNoTxt(t0.incluye_disposicion, "disposición"), t0.region || "(sin región)"].filter(Boolean).join(" · ");
    const stats = vals.length ? '<span class="stat">mín ' + fmtCLP(min) + '</span><span class="stat">mediana ' + fmtCLP(mediana(vals)) + '</span><span class="stat">máx ' + fmtCLP(Math.max(...vals)) + '</span><span class="stat muted">' + vals.length + ' vigente(s)</span>' : '';
    return '<div class="tgrupo"><div class="tg-head"><div class="tg-tit">' + esc(titulo) + '</div><div class="tg-stats">' + stats + '</div></div>' +
      '<div class="tscroll"><table class="ttar"><tr><th>Proveedor</th><th>Cliente</th><th>Lugar</th><th>Precio</th><th>Fecha / fuente</th><th></th><th></th></tr>' +
      ts.map(t => filaTarifaHtml(t, { best: vals.length > 1 && t.vigente && t.activo && clpDe(t) === min })).join('') +
      '</table></div></div>';
  }).join('');
}

/* ---------------- integración con la lista de proveedores ---------------- */
function tarifasResumenProveedor(s) {
  const ts = tarifasDeProveedor(s);
  if (!ts.length) return "";
  const n = ts.filter(t => t.alertas && t.alertas.length).length;
  const res = [...new Set(ts.map(t => t.residuo).filter(Boolean))].slice(0, 4).join(", ");
  return '<div class="meta"><b>Tarifas:</b> ' + ts.length + ' registrada(s)' + (res ? ' · ' + esc(res) : '') + (n ? ' · <span class="t-alerta">⚠ ' + n + '</span>' : '') + '</div>';
}

function tarifasDetalleProveedor(s) {
  const ts = tarifasDeProveedor(s);
  marcarVigentes(TARIFAS.filter(t => t.activo));
  const head = '<div class="meta" style="margin-top:10px;"><b>Tarifas</b> <button class="lnk" onclick="abrirFormTarifa(null,{proveedor_nombre:' + esc(JSON.stringify(s.name)) + '})">+ Agregar tarifa</button></div>';
  if (!ts.length) return head + '<span class="toggle-hint">Sin tarifas registradas.</span>';
  ts.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return head + '<div class="tscroll"><table class="ttar"><tr><th>Cliente</th><th>Servicio</th><th>Lugar</th><th>Precio</th><th>Fecha / fuente</th><th></th><th></th></tr>' +
    ts.map(t => filaTarifaHtml(t, { sinProveedor: true, conServicio: true })).join('') + '</table></div>';
}

/* ---------------- modales ---------------- */
const _onCloseModal = {};
function abrirModal(id, html, onClose) {
  let m = document.getElementById(id);
  if (!m) {
    m = document.createElement("div"); m.id = id; m.className = "modal tmodal";
    m.addEventListener("click", e => { if (e.target === m) cerrarModal(id); });
    document.body.appendChild(m);
  }
  m.innerHTML = '<div class="modalinner"><button class="tm-x" onclick="cerrarModal(\'' + id + '\')" aria-label="Cerrar">✕</button>' + html + '</div>';
  m.style.display = "block";
  _onCloseModal[id] = onClose || null;
}
function cerrarModal(id) {
  const m = document.getElementById(id); if (m) m.style.display = "none";
  const f = _onCloseModal[id]; _onCloseModal[id] = null; if (f) f();
}

/* ---------------- formulario de tarifa ---------------- */
let FORM_ORIG = null;
let FORM_COLA = null; // líneas pendientes de "Pegar desde Claude"

function campo(id, label, html, cls) { return '<div class="tf-campo ' + (cls || "") + '"><label for="' + id + '">' + label + '</label>' + html + '</div>'; }
function inp(id, val, extra) { return '<input id="' + id + '" value="' + esc(val == null ? "" : val) + '" ' + (extra || "") + '>'; }
function sel(id, opts, val) { return '<select id="' + id + '">' + opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (String(v) === String(val || "") ? " selected" : "") + '>' + esc(t) + '</option>'; }).join('') + '</select>'; }

function abrirFormTarifa(id, prefill) {
  const t = id ? TARIFAS.find(x => x.id === id) : null;
  FORM_ORIG = t || null;
  const v = Object.assign({ moneda: "CLP", fuente: "cotizacion", estado_cliente: "activo", fecha: new Date().toISOString().slice(0, 10) }, t || {}, prefill || {});
  if (t) { v.precio = t.precio_num == null ? "" : t.precio_num; v.cantidad_min = t.cantidad_min_num ?? ""; v.cantidad_max = t.cantidad_max_num ?? ""; }
  const sn = [["", "No se sabe"], ["si", "Sí"], ["no", "No"]];
  abrirModal("tarifaModal",
    '<h3>' + (t ? "Editar tarifa" : "Nueva tarifa") + (FORM_COLA && FORM_COLA.length ? ' <span class="muted small">(' + FORM_COLA.length + ' pendiente(s) desde Claude)</span>' : '') + '</h3>' +
    (t ? '<div class="muted small">' + esc(t.id) + ' · creada por ' + esc(t.creado_por) + ' el ' + esc(t.creado_el) + '</div>' : '') +
    '<div class="tf-grid">' +
      campo("f_proveedor", "Proveedor *", inp("f_proveedor", v.proveedor_nombre, 'list="provDL" autocomplete="off"'), "span2") +
      campo("f_cliente", "Cliente", inp("f_cliente", v.cliente, 'list="clienteDL" autocomplete="off" placeholder="Ej: COPEC"')) +
      campo("f_estado_cliente", "Estado del cliente", sel("f_estado_cliente", [["", "-"]].concat(CATS.estado_cliente), v.estado_cliente)) +
      campo("f_residuo", "Residuo *", inp("f_residuo", v.residuo, 'list="cat_residuoDL" autocomplete="off"')) +
      campo("f_contenedor", "Contenedor / vehículo", inp("f_contenedor", v.contenedor, 'list="cat_contenedorDL" autocomplete="off"')) +
      campo("f_direccion", "Dirección del servicio", inp("f_direccion", v.direccion, 'placeholder="Calle, número, comuna" oninput="autoComuna()"'), "span2") +
      campo("f_comuna", "Comuna", inp("f_comuna", v.comuna, 'list="comunaDL" autocomplete="off" oninput="autoRegion()"')) +
      campo("f_region", "Región", '<input id="f_region" value="' + esc(v.region || regionDeComuna(v.comuna)) + '" readonly tabindex="-1">') +
      campo("f_precio", "Precio neto (sin IVA)", inp("f_precio", v.precio, 'inputmode="decimal" placeholder="Ej: 192000 o 3,5"')) +
      campo("f_moneda", "Moneda", sel("f_moneda", CATS.moneda, v.moneda)) +
      campo("f_unidad", "Unidad de cobro", inp("f_unidad", v.unidad, 'list="cat_unidadDL" autocomplete="off" placeholder="kg, ton, m3, retiro…"')) +
      campo("f_cant", "Cantidad mín. – máx.", '<div class="tf-dos">' + inp("f_cantidad_min", v.cantidad_min, 'inputmode="decimal" placeholder="mín"') + inp("f_cantidad_max", v.cantidad_max, 'inputmode="decimal" placeholder="máx"') + '</div>') +
      campo("f_incluye_transporte", "¿Incluye transporte?", sel("f_incluye_transporte", sn, v.incluye_transporte)) +
      campo("f_incluye_disposicion", "¿Incluye disposición?", sel("f_incluye_disposicion", sn, v.incluye_disposicion)) +
      campo("f_fecha", "Fecha de la tarifa", '<input id="f_fecha" type="date" value="' + esc(v.fecha) + '">') +
      campo("f_fuente", "Fuente", sel("f_fuente", CATS.fuente, v.fuente)) +
      campo("f_detalle", "Detalle del cobro (por qué cobra eso, condiciones)", '<textarea id="f_detalle" rows="3">' + esc(v.detalle || "") + '</textarea>', "span2") +
      campo("f_pdf", "PDF de la cotización", (v.pdf_url ? '<div class="small"><a href="' + esc(v.pdf_url) + '" target="_blank" rel="noopener">Ver PDF actual</a> · subir otro reemplaza el enlace</div>' : '') + '<input id="f_pdf" type="file" accept="application/pdf">' + '<input id="f_pdf_url" type="hidden" value="' + esc(v.pdf_url || "") + '">', "span2") +
    '</div>' +
    '<div class="tf-acc"><span id="f_status" class="muted small"></span>' +
      (FORM_COLA && FORM_COLA.length ? '<button class="lnk" onclick="siguienteDeCola()">Saltar esta</button>' : '') +
      '<button class="cbtn" id="f_guardar" onclick="guardarTarifa()">' + (t ? "Guardar cambios" : "Guardar tarifa") + '</button></div>',
    () => { FORM_ORIG = null; FORM_COLA = null; });
}

function autoComuna() {
  const c = detectarComuna(document.getElementById("f_direccion").value);
  const fc = document.getElementById("f_comuna");
  if (c && (!fc.value || fc.dataset.auto === "1")) { fc.value = c; fc.dataset.auto = "1"; autoRegion(); }
}
function autoRegion() {
  const fc = document.getElementById("f_comuna");
  document.getElementById("f_region").value = regionDeComuna(fc.value);
}

function leerFormulario() {
  const g = id => (document.getElementById(id).value || "").trim();
  const nombre = g("f_proveedor");
  const sup = SUPPLIERS.find(s => !s.sheetOnly && norm(s.name) === norm(nombre));
  const comuna = comunaCanonica(g("f_comuna"));
  const datos = {
    proveedor_id: sup ? sup.id : "", proveedor_nombre: sup ? sup.name : nombre,
    cliente: g("f_cliente"), estado_cliente: g("f_estado_cliente"),
    residuo: g("f_residuo"), contenedor: g("f_contenedor"),
    direccion: g("f_direccion"), comuna, region: regionDeComuna(comuna),
    precio: g("f_precio") === "" ? "" : numDe(g("f_precio")), moneda: g("f_moneda"), unidad: g("f_unidad"),
    cantidad_min: g("f_cantidad_min") === "" ? "" : numDe(g("f_cantidad_min")),
    cantidad_max: g("f_cantidad_max") === "" ? "" : numDe(g("f_cantidad_max")),
    incluye_transporte: g("f_incluye_transporte"), incluye_disposicion: g("f_incluye_disposicion"),
    fecha: g("f_fecha"), fuente: g("f_fuente"), detalle: g("f_detalle"), pdf_url: g("f_pdf_url")
  };
  ["precio", "cantidad_min", "cantidad_max"].forEach(k => { if (datos[k] === null) throw new Error("Revisa el número en " + k.replace("_", " ") + "."); });
  if (!datos.proveedor_nombre) throw new Error("Falta el proveedor.");
  if (!datos.residuo) throw new Error("Falta el residuo.");
  return { datos, enClickUp: !!sup };
}

async function asegurarCatalogos(datos) {
  for (const c of ["residuo", "unidad", "contenedor"]) {
    const v = datos[c]; if (!v) continue;
    const existe = (CATS[c] || []).find(x => x.toLowerCase() === v.toLowerCase());
    if (existe) { datos[c] = existe; continue; }
    const r = await api("catalogo_agregar", { catalogo: c, valor: v }, true);
    datos[c] = r.valor; (CATS[c] = CATS[c] || []).push(r.valor);
  }
}

function leerArchivoBase64(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error("No se pudo leer el archivo.")); fr.readAsDataURL(file); });
}
async function subirPdfSiHay(inputId) {
  const f = (document.getElementById(inputId) || {}).files;
  if (!f || !f[0]) return null;
  if (f[0].size > 10 * 1024 * 1024) throw new Error("El PDF supera 10 MB.");
  const r = await api("subir_pdf", { nombre: f[0].name, base64: await leerArchivoBase64(f[0]) }, true);
  return r.url;
}

async function guardarTarifa() {
  const st = document.getElementById("f_status"), btn = document.getElementById("f_guardar");
  try {
    const { datos, enClickUp } = leerFormulario();
    if (!enClickUp && !FORM_ORIG && !confirm("“" + datos.proveedor_nombre + "” no está en ClickUp. ¿Guardar igual solo con el nombre?")) return;
    btn.disabled = true; st.textContent = "Guardando…";
    if (!sesionActiva()) await iniciarSesion();
    await asegurarCatalogos(datos);
    const url = await subirPdfSiHay("f_pdf"); if (url) datos.pdf_url = url;
    if (FORM_ORIG) {
      const cambios = {};
      Object.keys(datos).forEach(k => {
        const antes = k === "precio" ? FORM_ORIG.precio_num : k === "cantidad_min" ? FORM_ORIG.cantidad_min_num : k === "cantidad_max" ? FORM_ORIG.cantidad_max_num : tget(FORM_ORIG, k);
        if (String(antes ?? "") !== String(datos[k] ?? "")) cambios[k] = datos[k];
      });
      const r = await api("tarifa_editar", { id: FORM_ORIG.id, cambios }, true);
      st.textContent = r.cambios ? "Guardado (" + r.cambios + " cambio(s))." : "Sin cambios.";
    } else {
      await api("tarifa_crear", { tarifa: datos }, true);
      st.textContent = "Tarifa guardada.";
    }
    await loadTarifas();
    if (FORM_COLA && FORM_COLA.length) siguienteDeCola(); else setTimeout(() => cerrarModal("tarifaModal"), 500);
  } catch (e) {
    st.textContent = "Error: " + e.message;
  } finally { if (btn) btn.disabled = false; }
}

/* ---------------- baja / historial ---------------- */
async function cambiarActivo(id, activo) {
  const t = TARIFAS.find(x => x.id === id);
  if (!activo && !confirm("¿Dar de baja esta tarifa de " + (t ? t.proveedor_nombre : "") + "? Se puede restaurar después.")) return;
  try { await api(activo ? "tarifa_restaurar" : "tarifa_baja", { id }, true); await loadTarifas(); }
  catch (e) { alert("No se pudo: " + e.message); }
}

async function verHistorial(id) {
  abrirModal("histModal", '<h3>Historial</h3><div class="spinner-row"><span class="spinner"></span> Cargando…</div>');
  try {
    const rows = filasAObjetos(await gvizFetch(MIRROR_SHEET_ID, HISTORIAL_GID, true, true)).filter(h => h.tarifa_id === id);
    rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    const nombreAccion = { crear: "Creó la tarifa", editar: "Editó", baja: "Dio de baja", restaurar: "Restauró" };
    abrirModal("histModal", '<h3>Historial de ' + esc(id) + '</h3>' + (rows.length
      ? '<div class="tscroll"><table class="ttar"><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Campo</th><th>Antes</th><th>Después</th></tr>' +
        rows.map(h => '<tr><td class="small">' + esc(h.fecha) + '</td><td class="small">' + esc(h.usuario) + '</td><td>' + esc(nombreAccion[h.accion] || h.accion) + '</td><td>' + (h.campo === "*" ? "" : esc(h.campo)) + '</td><td>' + (h.accion === "crear" ? "" : esc(h.valor_anterior)) + '</td><td>' + (h.accion === "crear" ? "" : esc(h.valor_nuevo)) + '</td></tr>').join('') + '</table></div>'
      : '<p class="muted">Sin registros (puede tardar unos segundos en aparecer después de guardar).</p>'));
  } catch (e) {
    abrirModal("histModal", '<h3>Historial</h3><p class="warn">No se pudo leer: ' + esc(e.message) + '</p>');
  }
}

/* ---------------- pegar desde Claude ---------------- */
function abrirPegarClaude() {
  abrirModal("pegarModal",
    '<h3>Pegar desde Claude</h3>' +
    '<p class="small">Pega el bloque que generó la skill “cargar-cotizacion” (empieza con <code>{"recomendador_tarifas"</code>).</p>' +
    '<textarea id="pegarTxt" rows="8" style="width:100%;font-family:monospace;font-size:12px"></textarea>' +
    '<div class="tf-acc"><span id="pegarStatus" class="muted small"></span><button class="cbtn" onclick="interpretarPegado()">Interpretar</button></div>' +
    '<div id="pegarPrev"></div>');
}

function parsearBloqueClaude(txt) {
  const s = String(txt || "").trim();
  const ini = s.indexOf("{"), iniA = s.indexOf("[");
  const desde = ini === -1 ? iniA : iniA === -1 ? ini : Math.min(ini, iniA);
  if (desde === -1) throw new Error("No encontré datos en el texto pegado.");
  const fin = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  const j = JSON.parse(s.slice(desde, fin + 1));
  const base = Array.isArray(j) ? {} : j;
  const lineas = Array.isArray(j) ? j : (j.tarifas || []);
  if (!lineas.length) throw new Error("El bloque no trae tarifas.");
  const comun = {};
  ["proveedor_nombre", "proveedor", "cliente", "estado_cliente", "direccion", "comuna", "fecha", "fuente", "moneda", "detalle", "incluye_transporte", "incluye_disposicion"].forEach(k => { if (base[k] != null && base[k] !== "") comun[k === "proveedor" ? "proveedor_nombre" : k] = base[k]; });
  return lineas.map(l => {
    const d = Object.assign({}, comun, l);
    if (d.proveedor && !d.proveedor_nombre) d.proveedor_nombre = d.proveedor; delete d.proveedor;
    if (base.detalle && l.detalle && l.detalle !== base.detalle) d.detalle = l.detalle + "\n" + base.detalle;
    const sup = SUPPLIERS.find(s => !s.sheetOnly && norm(s.name) === norm(d.proveedor_nombre))
      || SUPPLIERS.find(s => !s.sheetOnly && d.proveedor_nombre && norm(s.name).indexOf(norm(d.proveedor_nombre)) !== -1);
    if (sup) { d.proveedor_id = sup.id; d.proveedor_nombre = sup.name; }
    if (!d.comuna && d.direccion) d.comuna = detectarComuna(d.direccion);
    d.comuna = comunaCanonica(d.comuna); d.region = regionDeComuna(d.comuna);
    d.precio = numDe(d.precio); d.cantidad_min = numDe(d.cantidad_min); d.cantidad_max = numDe(d.cantidad_max);
    d.moneda = String(d.moneda || "CLP").toUpperCase();
    d.incluye_transporte = siNo(d.incluye_transporte === true ? "si" : d.incluye_transporte === false ? "no" : d.incluye_transporte);
    d.incluye_disposicion = siNo(d.incluye_disposicion === true ? "si" : d.incluye_disposicion === false ? "no" : d.incluye_disposicion);
    if (!d.fuente) d.fuente = "cotizacion";
    return d;
  });
}

function interpretarPegado() {
  const st = document.getElementById("pegarStatus"), prev = document.getElementById("pegarPrev");
  try {
    FORM_COLA = parsearBloqueClaude(document.getElementById("pegarTxt").value);
    const conAlerta = FORM_COLA.map(d => prepararTarifa(Object.assign({ id: "nuevo", activo: "si" }, d, { precio: d.precio })));
    const tmp = TARIFAS; TARIFAS = tmp.concat(conAlerta); calcularAlertas(); TARIFAS = tmp; calcularAlertas();
    st.textContent = FORM_COLA.length + " línea(s) encontradas.";
    const sinProv = FORM_COLA.filter(d => !d.proveedor_id).length;
    prev.innerHTML = (sinProv ? '<p class="warn small">' + sinProv + ' línea(s) con un proveedor que no encontré en ClickUp: se guardarán solo con el nombre.</p>' : '') +
      '<div class="tscroll"><table class="ttar"><tr><th>Proveedor</th><th>Cliente</th><th>Servicio</th><th>Lugar</th><th>Precio</th><th></th></tr>' +
      conAlerta.map(t => '<tr><td>' + esc(t.proveedor_nombre) + (t.proveedor_id ? '' : ' <span class="t-alerta">no está en ClickUp</span>') + '</td><td>' + esc(t.cliente || "-") + '</td><td>' + esc(t.residuo || "-") + '<div class="muted small">' + esc([t.contenedor, siNoTxt(t.incluye_transporte, "transp."), siNoTxt(t.incluye_disposicion, "disp.")].filter(Boolean).join(" · ")) + '</div></td><td>' + esc(t.comuna || t.direccion || "-") + '</td><td class="num">' + precioHtml(t) + '</td><td>' + alertaHtml(t) + '</td></tr>').join('') +
      '</table></div>' +
      campo("pegarPdf", "PDF de la cotización (se adjunta a todas)", '<input id="pegarPdf" type="file" accept="application/pdf">', "span2") +
      '<div class="tf-acc"><span id="pegarStatus2" class="muted small"></span>' +
      '<button class="lnk" onclick="revisarUnaPorUna()">Revisar una por una</button>' +
      '<button class="cbtn" onclick="guardarLoteClaude()">Guardar todas (' + FORM_COLA.length + ')</button></div>';
  } catch (e) {
    FORM_COLA = null; prev.innerHTML = ""; st.textContent = "No se pudo interpretar: " + e.message;
  }
}

async function guardarLoteClaude() {
  const st = document.getElementById("pegarStatus2");
  try {
    if (!sesionActiva()) await iniciarSesion();
    st.textContent = "Guardando…";
    const url = await subirPdfSiHay("pegarPdf");
    for (const d of FORM_COLA) { await asegurarCatalogos(d); if (url) d.pdf_url = url; }
    const r = await api("tarifa_crear_lote", { tarifas: FORM_COLA }, true);
    st.textContent = r.ids.length + " tarifa(s) guardadas.";
    FORM_COLA = null;
    await loadTarifas();
    setTimeout(() => cerrarModal("pegarModal"), 700);
  } catch (e) { st.textContent = "Error: " + e.message; }
}

async function revisarUnaPorUna() {
  try {
    if (!sesionActiva()) await iniciarSesion();
    const url = await subirPdfSiHay("pegarPdf");
    if (url) FORM_COLA.forEach(d => { d.pdf_url = url; });
  } catch (e) { alert(e.message); return; }
  const cola = FORM_COLA;
  cerrarModal("pegarModal");
  FORM_COLA = cola;
  siguienteDeCola();
}

/** Abre en el formulario la siguiente línea pendiente; cierra si no quedan. */
function siguienteDeCola() {
  if (!FORM_COLA || !FORM_COLA.length) { cerrarModal("tarifaModal"); return; }
  const cola = FORM_COLA;
  abrirFormTarifa(null, cola.shift());
  FORM_COLA = cola; // abrirFormTarifa no la toca; cerrar el modal la descarta
}

/* ---------------- pestañas e inicio ---------------- */
function mostrarVista(v) {
  document.getElementById("viewProv").style.display = v === "prov" ? "" : "none";
  document.getElementById("viewTar").style.display = v === "tar" ? "" : "none";
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  lsSet("rp_vista", v);
  if (v === "tar") renderTarifas();
}

function tarifasInit() {
  renderAuthBox();
  const dlc = document.getElementById("comunaDL");
  if (dlc) dlc.innerHTML = COMUNAS_LISTA.map(c => '<option value="' + esc(c) + '">').join('');
  ["tfResiduo", "tfRegion", "tfUnidad", "tfEstado"].forEach(id => document.getElementById(id).addEventListener("change", renderTarifas));
  document.getElementById("tfTexto").addEventListener("input", renderTarifas);
  ["tfAnteriores", "tfBajas", "tfAlertas"].forEach(id => document.getElementById(id).addEventListener("change", renderTarifas));
  if (lsGet("rp_vista") === "tar") mostrarVista("tar");
  loadUF();
}
