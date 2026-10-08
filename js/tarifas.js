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
const SUCURSALES_GID = "1371080297";
const LOGIN_URL = "https://script.google.com/a/macros/recylink.com/s/AKfycbxIZsEsEJCFUgNEtvlUaAGKVWiB-lgGm8Q4G-1hMDARDJte2n0-QzzgqSgWvh5aAbsg/exec";
const UF_API = "https://mindicador.cl/api/uf";

let TARIFAS = [];           // todas (activas y dadas de baja)
let TARIFAS_STATUS = "no cargadas";
let CATS = { residuo: [], unidad: [], contenedor: [], estado_cliente: ["activo", "inactivo", "prospecto"], estado_servicio: ["Activo", "Cotizado", "No tomado", "Terminado", "Valor general"], fuente: ["cotizacion", "plataforma", "informal", "carga inicial"], moneda: ["CLP", "UF"] };
let UF = { valor: null, fecha: "", origen: "" };
let SUCURSALES = []; // lista maestra: { empresa, sucursal, direccion, comuna, region }

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

/* ---------------- nombres de proveedores y empresas ---------------- */
/** Clave para comparar nombres sin razón social: "Vuelta Verde Ltda." = "VUELTA VERDE" = "Vuelta Verde SpA". */
function claveNombre(s) {
  return norm(String(s || "").replace(/\b(s\.?\s?p\.?\s?a\.?|ltda\.?|limitada|s\.?\s?a\.?|e\.?i\.?r\.?l\.?|y\s+c[ií]a\.?)\s*$/i, ""));
}
/** Busca el proveedor en ClickUp: nombre exacto sin razón social, o un parecido parcial fuerte. */
function buscarProveedorClickUp(nombre) {
  const k = claveNombre(nombre); if (!k) return null;
  const candidatos = SUPPLIERS.filter(s => !s.sheetOnly);
  return candidatos.find(s => claveNombre(s.name) === k)
    || candidatos.find(s => {
      // Parecido parcial solo si es fuerte: el corto es al menos la mitad del largo,
      // o el largo empieza con el corto ("ECOPORTUARIA..." / "ECOPORT"). Evita "RECIC" en "RECICLAJES...".
      const c = claveNombre(s.name);
      const [corto, largo] = c.length < k.length ? [c, k] : [k, c];
      if (corto.length < 6 || largo.indexOf(corto) === -1) return false;
      return corto.length / largo.length >= 0.5 || largo.indexOf(corto) === 0;
    })
    || null;
}
/** Usa el nombre de empresa ya registrado si es la misma ("Euro Constructora SpA" -> "Euro Constructora"). */
function empresaCanonica(nombre) {
  const k = claveNombre(nombre); if (!k) return String(nombre || "").trim();
  const existentes = unicosOrdenados(TARIFAS.map(t => t.cliente));
  return existentes.find(e => claveNombre(e) === k) || String(nombre).trim();
}

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
  if (_puertaResolve) { _puertaResolve(AUTH); _puertaResolve = null; }
  ocultarPuerta();
  cerrarModal("loginModal");
  return AUTH;
}

function cerrarSesion() { AUTH = null; lsDel("rp_auth"); renderAuthBox(); mostrarPuerta(); }

/* ---------------- pantalla de acceso obligatoria ----------------
   Tapa la web hasta iniciar sesión con @recylink.com. Ojo: mientras los Sheets
   sean públicos esto no protege los datos, solo el uso de la web. */
let _puertaResolve = null;

/** Resuelve cuando hay sesión válida; si no la hay, muestra la pantalla de acceso. */
function exigirSesion() {
  if (sesionActiva()) return Promise.resolve(AUTH);
  return new Promise(resolve => { _puertaResolve = resolve; mostrarPuerta(); });
}

function mostrarPuerta(msg) {
  const p = document.getElementById("puerta"); if (!p) return;
  p.innerHTML =
    '<div class="puerta-card" role="dialog" aria-modal="true" aria-labelledby="puertaTit">' +
      '<h2 id="puertaTit">Recomendador de Proveedores</h2>' +
      '<p>Ingresa con tu cuenta <b>@recylink.com</b> para continuar.</p>' +
      (msg ? '<p class="warn small">' + esc(msg) + '</p>' : '') +
      '<button class="cbtn puerta-btn" onclick="abrirVentanaLogin()">Iniciar sesión con Google</button>' +
      '<p id="puertaAyuda" class="small muted">Se abrirá una ventana de Google; al terminar se cierra sola.</p>' +
      '<details class="small"><summary>¿La ventana no se cierra sola?</summary>' +
        '<p>Copia el código que aparece en ella y pégalo aquí:</p>' +
        '<textarea id="puertaPaste" rows="3"></textarea>' +
        '<button class="cbtn" onclick="try{guardarSesion(document.getElementById(\'puertaPaste\').value)}catch(e){alert(e.message)}">Usar código</button>' +
      '</details>' +
    '</div>';
  p.style.display = "flex";
  document.body.classList.add("con-puerta");
}

function ocultarPuerta() {
  const p = document.getElementById("puerta"); if (!p) return;
  p.style.display = "none"; p.innerHTML = "";
  document.body.classList.remove("con-puerta");
}

function abrirVentanaLogin() {
  const url = LOGIN_URL + "?origin=" + encodeURIComponent(location.origin);
  const w = window.open(url, "rp_login", "width=480,height=620");
  const ayuda = document.getElementById("puertaAyuda");
  if (!w && ayuda) ayuda.innerHTML = 'Tu navegador bloqueó la ventana. <a href="' + esc(url) + '" target="_blank" rel="noopener">Ábrela aquí</a>.';
}

// Si la sesión vence con la web abierta, se vuelve a pedir.
setInterval(() => { if (AUTH && AUTH.exp <= Date.now()) { AUTH = null; lsDel("rp_auth"); renderAuthBox(); mostrarPuerta("Tu sesión expiró."); } }, 60000);

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
  const body = Object.assign({ action, reqId: nuevoReqId() }, payload || {});
  if (conSesion) {
    if (!sesionActiva()) await iniciarSesion();
    body.auth = AUTH.token;
  }
  // Google a veces pierde la respuesta de Apps Script (devuelve HTML o el navegador corta por CORS).
  // Se reintenta con el mismo reqId: el backend devuelve la respuesta guardada sin repetir la acción.
  let data = null;
  for (let intento = 1; intento <= 3 && !data; intento++) {
    try {
      const resp = await fetch(APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
      data = JSON.parse(await resp.text());
    } catch (e) { // HTML en vez de JSON, o el navegador corta por CORS al rebotar
      data = null;
      if (intento < 3) await new Promise(r => setTimeout(r, 800 * intento));
    }
  }
  if (!data) throw new Error("El servidor no respondió bien. Revisa si el cambio quedó guardado antes de reintentar.");
  if (!data.ok) {
    if (data.auth) cerrarSesion();
    throw new Error((data.error || "Error desconocido").replace(/^AUTH:\s*/, ""));
  }
  return data.data || {};
}

function nuevoReqId() {
  try { return crypto.randomUUID(); } catch (e) { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12); }
}

/* ---------------- carga de datos ---------------- */
function filasAObjetos(rows) {
  if (!rows || rows.length < 1) return [];
  const head = rows[0].map(h => String(h || "").trim());
  return rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i] == null ? "" : r[i]; }); return o; });
}

/* Google entrega el Sheet con unos segundos de atraso: los cambios recién guardados se
   aplican en pantalla con la fila que devuelve el servidor y se mantienen hasta que el
   Sheet los muestre (máx. 10 min). Evita que parezca que "no pasó nada" y se guarde dos veces. */
const PENDIENTES = {};
function aplicarPendientes() {
  const ahora = Date.now();
  Object.keys(PENDIENTES).forEach(id => {
    const p = PENDIENTES[id];
    if (ahora - p.t > 600000) { delete PENDIENTES[id]; return; }
    const i = TARIFAS.findIndex(t => t.id === id);
    if (i !== -1 && tget(TARIFAS[i], "actualizado_el") >= tget(p.fila, "actualizado_el")) { delete PENDIENTES[id]; return; }
    const t = prepararTarifa(Object.assign({}, p.fila));
    if (i === -1) TARIFAS.push(t); else TARIFAS[i] = t;
  });
}
/** Muestra de inmediato lo que devolvió el servidor y luego relee el Sheet. */
async function refrescarTrasGuardar(filas) {
  (filas || []).filter(f => f && f.id).forEach(f => { PENDIENTES[f.id] = { fila: f, t: Date.now() }; });
  aplicarPendientes(); calcularAlertas(); poblarFiltrosTarifas(); renderTarifas();
  if (typeof render === "function" && SUPPLIERS.length) { aplicarTarifasAProveedores(); render(); }
  loadTarifas(); // en segundo plano
}

async function loadTarifas() {
  try {
    const [rows, cats] = await Promise.all([
      gvizFetch(MIRROR_SHEET_ID, TARIFAS_GID, true, true),
      gvizFetch(MIRROR_SHEET_ID, CATALOGOS_GID, true, true).catch(() => null),
      gvizFetch(MIRROR_SHEET_ID, SUCURSALES_GID, true, true).then(filasAObjetos).then(l => { SUCURSALES = l.filter(x => x.empresa && x.sucursal); }).catch(() => null)
    ]);
    TARIFAS = filasAObjetos(rows).filter(t => tget(t, "id")).map(prepararTarifa);
    aplicarPendientes();
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
  if (typeof render === "function" && SUPPLIERS.length) { aplicarTarifasAProveedores(); refreshProvDL(); populateFilters(); render(); }
}

function prepararTarifa(t) {
  t.precio_num = numDe(t.precio);
  t.cantidad_min_num = numDe(t.cantidad_min);
  t.cantidad_max_num = numDe(t.cantidad_max);
  t.moneda = (tget(t, "moneda") || "CLP").toUpperCase();
  t.activo = tget(t, "activo") !== "no";
  // Regla (2026-10-08): si no se indica lo contrario, el servicio incluye transporte y disposición final.
  t.incluye_transporte = siNo(t.incluye_transporte) || "si";
  t.incluye_disposicion = siNo(t.incluye_disposicion) || "si";
  if (!t.region && t.comuna) t.region = regionDeComuna(t.comuna);
  t.provKey = tget(t, "proveedor_id") || "n:" + norm(t.proveedor_nombre);
  t.tipo = tget(t, "tipo_transaccion").toLowerCase() === "paga" ? "paga" : "cobra";
  t.sucursal = tget(t, "sucursal");
  t.estado_servicio = tget(t, "estado_servicio");
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
  // "cobra" y "paga" nunca se comparan entre sí
  return [t.tipo, norm(t.residuo), norm(t.unidad), norm(t.contenedor), t.incluye_transporte, t.incluye_disposicion, t.region || ""].join("|");
}

/** Por grupo comparable y por (proveedor, empresa, sucursal), la más reciente es la vigente. */
function marcarVigentes(lista) {
  const ult = {};
  lista.forEach(t => {
    const k = grupoKey(t) + "|" + t.provKey + "|" + norm(t.cliente) + "|" + norm(t.sucursal);
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
  return TARIFAS.filter(t => t.activo && (tget(t, "proveedor_id") && !s.sheetOnly ? t.proveedor_id === s.id : norm(t.proveedor_nombre) === norm(s.name)));
}

/* ---------------- controles: selector con "Otro" y multiselector ---------------- */
function selOtroHtml(id, opciones, val, vacio, alCambiar) {
  const opts = (opciones || []).slice();
  if (val && !opts.some(o => o.toLowerCase() === String(val).toLowerCase())) opts.push(val);
  return '<select id="' + id + '" onchange="selOtroCambio(\'' + id + '\')' + (alCambiar ? ';' + alCambiar + '()' : '') + '">' +
    (vacio != null ? '<option value="">' + esc(vacio) + '</option>' : '') +
    opts.map(o => '<option value="' + esc(o) + '"' + (val && o.toLowerCase() === String(val).toLowerCase() ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
    '<option value="__otro">Otro (escribir)…</option></select>' +
    '<input id="' + id + '_otro" class="otro-inp" placeholder="Escribe el nuevo valor" style="display:none">';
}
function selOtroCambio(id) {
  const otro = document.getElementById(id).value === "__otro";
  const i = document.getElementById(id + "_otro");
  i.style.display = otro ? "" : "none";
  if (otro) i.focus();
}
function selOtroVal(id) {
  const s = document.getElementById(id);
  return s.value === "__otro" ? document.getElementById(id + "_otro").value.trim() : s.value;
}

/* Multiselector: chips + desplegable. cfg = { opciones, valores, otro, unico, placeholder, onChange } */
const MSEL = {};
function mselHtml(id, cfg) {
  MSEL[id] = Object.assign({ opciones: [], valores: [], otro: false, unico: false, placeholder: "+ agregar", onChange: null }, cfg);
  MSEL[id].valores = (MSEL[id].valores || []).filter(Boolean);
  return '<div class="msel" id="' + id + '">' + mselInner(id) + '</div>';
}
function mselInner(id) {
  const m = MSEL[id];
  const usados = m.valores.map(v => v.toLowerCase());
  const disp = m.opciones.filter(o => usados.indexOf(o.toLowerCase()) === -1);
  return '<div class="msel-chips">' + m.valores.map((v, i) => '<span class="mchip">' + esc(v) + '<button type="button" onclick="mselQuitar(\'' + id + '\',' + i + ')" aria-label="Quitar ' + esc(v) + '">×</button></span>').join('') + '</div>' +
    '<select onchange="mselElegir(\'' + id + '\',this)" aria-label="' + esc(m.placeholder) + '"><option value="">' + esc(m.unico && m.valores.length ? "Cambiar…" : m.placeholder) + '</option>' +
    disp.map(o => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('') +
    (m.otro ? '<option value="__otro">Otro (escribir)…</option>' : '') + '</select>' +
    (m.otro ? '<span class="msel-otro" style="display:none"><input placeholder="Nuevo valor" onkeydown="if(event.key===\'Enter\'){event.preventDefault();mselAgregarOtro(\'' + id + '\')}"><button type="button" class="lnk" onclick="mselAgregarOtro(\'' + id + '\')">Agregar</button></span>' : '');
}
function mselRender(id) { const el = document.getElementById(id); if (el && MSEL[id]) el.innerHTML = mselInner(id); }
function mselElegir(id, selEl) {
  const v = selEl.value; if (!v) return;
  if (v === "__otro") { const sp = selEl.parentNode.querySelector(".msel-otro"); sp.style.display = ""; sp.querySelector("input").focus(); selEl.value = ""; return; }
  mselAgregar(id, v);
}
function mselAgregar(id, v) {
  const m = MSEL[id]; v = String(v || "").trim(); if (!v) return;
  const canon = m.opciones.find(o => o.toLowerCase() === v.toLowerCase()) || v;
  if (m.unico) m.valores = [canon];
  else if (!m.valores.some(x => x.toLowerCase() === canon.toLowerCase())) m.valores.push(canon);
  mselRender(id); if (m.onChange) m.onChange();
}
function mselAgregarOtro(id) { const i = document.querySelector("#" + id + " .msel-otro input"); if (i) mselAgregar(id, i.value); }
function mselQuitar(id, i) { MSEL[id].valores.splice(i, 1); mselRender(id); if (MSEL[id].onChange) MSEL[id].onChange(); }
function mselValores(id) { return MSEL[id] ? MSEL[id].valores.slice() : []; }
function mselOpciones(id, opciones) { if (!MSEL[id]) return; MSEL[id].opciones = opciones; mselRender(id); }

/* ---------------- render: vista Tarifas ---------------- */
function precioHtml(t) {
  if (t.precio_num == null) return '<span class="muted">sin precio</span>';
  const paga = t.tipo === "paga";
  const orig = (paga ? "+" : "") + (t.moneda === "UF" ? fmtNum(t.precio_num) + " UF" : fmtCLP(t.precio_num));
  const clp = clpDe(t);
  const conv = t.moneda === "UF" ? (clp != null ? '<div class="muted small">≈ ' + (paga ? "+" : "") + fmtCLP(clp) + '</div>' : '<div class="muted small">UF no disponible</div>') : "";
  return '<b class="' + (paga ? "t-paga" : "") + '">' + orig + '</b>' + (t.unidad ? ' <span class="muted">/ ' + esc(t.unidad) + '</span>' : '') + conv +
    (paga ? '<div class="t-paga small">recibe el cliente</div>' : '');
}

function alertaHtml(t) {
  return t.alertas && t.alertas.length ? '<span class="t-alerta" title="' + esc(t.alertas.join("\n")) + '">⚠ ' + t.alertas.length + '</span>' : '';
}

function siNoTxt(v, txt) { return v === "si" ? "con " + txt : v === "no" ? "sin " + txt : txt + " ¿?"; }

const esGeneral = t => norm(t.estado_servicio) === "VALORGENERAL";
function estadoServicioPill(t) {
  return t.estado_servicio ? '<span class="pill es-' + norm(t.estado_servicio).toLowerCase() + '">' + esc(t.estado_servicio) + '</span>' : '';
}
function empresaHtml(t) {
  if (esGeneral(t)) return estadoServicioPill(t) + '<div class="muted small">precio de lista, sin cliente</div>';
  return estadoServicioPill(t) + (t.estado_servicio ? ' ' : '') + (t.cliente ? '<b>' + esc(t.cliente) + '</b>' : '<span class="muted">sin empresa</span>') +
    (t.sucursal ? '<div class="small">' + esc(t.sucursal) + '</div>' : '') +
    (t.estado_cliente ? ' <span class="pill p-' + esc(t.estado_cliente) + '">' + esc(t.estado_cliente) + '</span>' : '');
}

function filaTarifaHtml(t, opts) {
  opts = opts || {};
  const cant = [t.cantidad_min_num, t.cantidad_max_num].some(v => v != null)
    ? (t.cantidad_min_num != null ? fmtNum(t.cantidad_min_num) : "") + "–" + (t.cantidad_max_num != null ? fmtNum(t.cantidad_max_num) : "") : "";
  const lugar = [t.comuna || "", t.direccion && t.direccion !== t.comuna ? t.direccion : ""].filter(Boolean).join(" · ");
  return '<tr class="' + (t.activo ? "" : "t-baja ") + (t.vigente || !t.activo ? "" : "t-anterior ") + (opts.best ? "best" : "") + (opts.sub ? " t-sub" : "") + '"' + (opts.sub ? ' data-grp="' + opts.sub + '" style="display:none"' : '') + '>' +
    (opts.sinProveedor ? '' : '<td><b>' + esc(t.proveedor_nombre || "-") + '</b>' + (opts.best ? ' <span class="t-best">★ ' + (t.tipo === "paga" ? "paga más" : "menor") + '</span>' : '') + '</td>') +
    '<td>' + empresaHtml(t) + '</td>' +
    (opts.conServicio ? '<td>' + esc(t.residuo || "-") + (t.tipo === "paga" ? ' <span class="pill p-paga">paga</span>' : '') + '<div class="muted small">' + esc([t.contenedor, siNoTxt(t.incluye_transporte, "transp."), siNoTxt(t.incluye_disposicion, "disp.")].filter(Boolean).join(" · ")) + '</div></td>' : '') +
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

/* ---------- filas agrupadas: mismas condiciones en varias sucursales y/o residuos ---------- */
/** Condiciones que deben coincidir para juntar tarifas (varían residuo, contenedor, sucursal, lugar, fecha y detalle). */
function condKey(t) {
  return [t.provKey, norm(t.cliente), norm(t.unidad), t.precio_num ?? "", t.moneda,
    t.incluye_transporte, t.incluye_disposicion, t.tipo, norm(t.estado_servicio), t.cantidad_min_num ?? "", t.cantidad_max_num ?? ""].join("|");
}
/** Junta una lista en grupos por condiciones (más vigencia/baja, para no mezclar históricos). */
function agruparPorCondiciones(ts) {
  const g = {}, orden = [];
  ts.forEach(t => {
    const k = condKey(t) + "|" + t.activo + "|" + t.vigente;
    if (!g[k]) { g[k] = []; orden.push(k); }
    g[k].push(t);
  });
  return orden.map(k => g[k]);
}
function listaCorta(vals, max) {
  const u = unicosOrdenados(vals);
  if (!u.length) return "";
  return esc(u.slice(0, max).join(", ")) + (u.length > max ? ' <span class="muted">+' + (u.length - max) + '</span>' : '');
}
let GRUPO_SEQ = 0;
/** Fila resumen de un grupo; las filas individuales quedan ocultas debajo ("Ver"). */
function filaGrupoHtml(ts, opts) {
  if (ts.length === 1) return filaTarifaHtml(ts[0], opts);
  opts = opts || {};
  const gid = "g" + (++GRUPO_SEQ);
  const t0 = ts.slice().sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))[0];
  const alertas = [...new Set(ts.flatMap(t => t.alertas || []))];
  const pdfs = unicosOrdenados(ts.map(t => t.pdf_url));
  const sucursales = ts.map(t => t.sucursal), residuos = ts.map(t => t.residuo);
  const nSuc = unicosOrdenados(sucursales).length, nRes = unicosOrdenados(residuos).length;
  const fila = '<tr class="t-grupo ' + (t0.activo ? "" : "t-baja ") + (t0.vigente || !t0.activo ? "" : "t-anterior ") + (opts.best ? "best" : "") + '">' +
    (opts.sinProveedor ? '' : '<td><b>' + esc(t0.proveedor_nombre || "-") + '</b>' + (opts.best ? ' <span class="t-best">★ ' + (t0.tipo === "paga" ? "paga más" : "menor") + '</span>' : '') + '</td>') +
    '<td>' + estadoServicioPill(t0) + (t0.estado_servicio ? ' ' : '') + (t0.cliente ? '<b>' + esc(t0.cliente) + '</b>' : '<span class="muted">sin empresa</span>') +
      (nSuc ? '<div class="small">' + listaCorta(sucursales, 4) + '</div>' : '') + '</td>' +
    (opts.conServicio ? '<td>' + listaCorta(residuos, 4) + (t0.tipo === "paga" ? ' <span class="pill p-paga">paga</span>' : '') + '<div class="muted small">' + [listaCorta(ts.map(t => t.contenedor), 3), esc(siNoTxt(t0.incluye_transporte, "transp.")), esc(siNoTxt(t0.incluye_disposicion, "disp."))].filter(Boolean).join(" · ") + '</div></td>' : '') +
    '<td>' + (listaCorta(ts.map(t => t.comuna), 3) || "-") + '</td>' +
    '<td class="num">' + precioHtml(t0) + '</td>' +
    '<td><span class="small">' + esc(t0.fecha || "-") + '</span><div class="muted small">' + esc(t0.fuente || "") + (pdfs.length === 1 ? ' · <a href="' + esc(pdfs[0]) + '" target="_blank" rel="noopener">PDF</a>' : pdfs.length ? ' · ' + pdfs.length + ' PDF' : '') + '</div></td>' +
    '<td>' + (alertas.length ? '<span class="t-alerta" title="' + esc(alertas.join("\n")) + '">⚠ ' + alertas.length + '</span>' : '') + '</td>' +
    '<td class="acc">' +
      (t0.activo ? '<button class="lnk" onclick="abrirFormGrupo(\'' + esc(t0.id) + '\')">Editar grupo</button>' : '') +
      '<button class="lnk" onclick="verGrupo(\'' + gid + '\', this)">Ver ' + ts.length + '</button>' +
      '<div class="muted small">' + ts.length + ' tarifas' + (nSuc > 1 ? ' · ' + nSuc + ' sucursales' : '') + (nRes > 1 ? ' · ' + nRes + ' residuos' : '') + '</div>' +
    '</td></tr>';
  return fila + ts.map(t => filaTarifaHtml(t, Object.assign({}, opts, { best: false, sub: gid }))).join('');
}
function verGrupo(gid, btn) {
  const filas = document.querySelectorAll('tr[data-grp="' + gid + '"]');
  const abrir = filas.length && filas[0].style.display === "none";
  filas.forEach(f => { f.style.display = abrir ? "" : "none"; });
  btn.textContent = (abrir ? "Ocultar " : "Ver ") + filas.length;
}

/** Valores únicos sin distinguir mayúsculas/tildes; gana la forma más usada ("Euro Constructora" sobre "Euro constructora"). */
function unicosOrdenados(vals) {
  const formas = {};
  vals.map(v => String(v || "").trim()).filter(Boolean).forEach(v => {
    const k = norm(v); formas[k] = formas[k] || {}; formas[k][v] = (formas[k][v] || 0) + 1;
  });
  return Object.values(formas).map(f => Object.keys(f).sort((a, b) => f[b] - f[a])[0]).sort((a, b) => a.localeCompare(b, "es"));
}

function sucursalesDe(empresa) {
  const ne = norm(empresa);
  return unicosOrdenados(SUCURSALES.filter(x => !ne || norm(x.empresa) === ne).map(x => x.sucursal)
    .concat(TARIFAS.filter(t => !ne || norm(t.cliente) === ne).map(t => t.sucursal)));
}

/** Dirección conocida de una sucursal: primero la lista maestra, si no, alguna tarifa que la tenga. */
function sucursalInfo(empresa, sucursal) {
  const k = norm(empresa) + "|" + norm(sucursal);
  const m = SUCURSALES.find(x => norm(x.empresa) + "|" + norm(x.sucursal) === k);
  if (m) return { enLista: true, direccion: m.direccion || "", comuna: m.comuna || "", region: m.region || regionDeComuna(m.comuna) };
  const t = TARIFAS.find(x => norm(x.cliente) + "|" + norm(x.sucursal) === k && (x.direccion || x.comuna));
  return t ? { enLista: false, direccion: t.direccion || "", comuna: t.comuna || "", region: t.region || regionDeComuna(t.comuna) } : null;
}

function poblarFiltrosTarifas() {
  const set = (id, vals, todos) => {
    const el = document.getElementById(id); if (!el) return;
    const prev = el.value;
    el.innerHTML = '<option value="">' + todos + '</option>' + unicosOrdenados(vals).map(v => '<option>' + esc(v) + '</option>').join('');
    el.value = prev;
  };
  set("tfRegion", TARIFAS.map(t => t.region), "Todas");
  set("tfUnidad", TARIFAS.map(t => t.unidad), "Todas");
  set("tfServicio", (CATS.estado_servicio || []).concat(TARIFAS.map(t => t.estado_servicio)), "Todos");
  mselOpciones("tfResiduo", unicosOrdenados(TARIFAS.map(t => t.residuo)));
  mselOpciones("tfComuna", unicosOrdenados(TARIFAS.map(t => t.comuna)));
  const dl = document.getElementById("clienteDL");
  if (dl) dl.innerHTML = unicosOrdenados(TARIFAS.map(t => t.cliente)).map(c => '<option value="' + esc(c) + '">').join('');
  actualizarSucursalDL("tfSucursalDL", (document.getElementById("tfEmpresa") || {}).value);
}

function actualizarSucursalDL(dlId, empresa) {
  const dl = document.getElementById(dlId);
  if (dl) dl.innerHTML = sucursalesDe(empresa).map(s => '<option value="' + esc(s) + '">').join('');
}

function renderTarifas() {
  const box = document.getElementById("tarList"); if (!box) return;
  const g = id => (document.getElementById(id) || {}).value || "";
  const chk = id => !!(document.getElementById(id) || {}).checked;
  const fRes = mselValores("tfResiduo").map(norm), fCom = mselValores("tfComuna").map(norm);
  const fReg = g("tfRegion"), fUni = g("tfUnidad"), fEst = g("tfEstado"), fTipo = g("tfTipo"), fServ = norm(g("tfServicio"));
  const fEmp = norm(g("tfEmpresa")), fSuc = norm(g("tfSucursal")), fTxt = norm(g("tfTexto"));
  const verAnt = chk("tfAnteriores"), verBaja = chk("tfBajas"), soloAl = chk("tfAlertas");

  const ufInfo = document.getElementById("ufInfo");
  if (ufInfo) ufInfo.textContent = UF.valor ? "UF " + fmtCLP(UF.valor) + " (" + UF.fecha + ", " + UF.origen + ")" : "UF no disponible: los precios en UF no se convierten";

  const lista = TARIFAS.filter(t => (t.activo || verBaja)
    && (!fRes.length || fRes.indexOf(norm(t.residuo)) !== -1)
    && (!fCom.length || fCom.indexOf(norm(t.comuna)) !== -1)
    && (!fReg || t.region === fReg) && (!fUni || t.unidad === fUni)
    && (!fEst || t.estado_cliente === fEst) && (!fTipo || t.tipo === fTipo) && (!fServ || norm(t.estado_servicio) === fServ)
    && (!fEmp || norm(t.cliente).indexOf(fEmp) !== -1) && (!fSuc || norm(t.sucursal).indexOf(fSuc) !== -1)
    && (!fTxt || norm(t.proveedor_nombre + " " + t.cliente + " " + t.sucursal).indexOf(fTxt) !== -1)
    && (!soloAl || (t.alertas && t.alertas.length))
    && (t.vigente || !t.activo || verAnt));

  document.getElementById("tarCount").textContent = lista.length + " tarifa(s) · " + TARIFAS_STATUS;
  if (!lista.length) { box.innerHTML = '<div class="empty">' + (TARIFAS.length ? "Sin tarifas para el filtro actual." : "Aún no hay tarifas cargadas. Usa “+ Nueva tarifa” o “Pegar desde Claude”.") + '</div>'; return; }

  const grupos = {};
  lista.forEach(t => { (grupos[grupoKey(t)] = grupos[grupoKey(t)] || []).push(t); });
  const claves = Object.keys(grupos).sort((a, b) => {
    const ta = grupos[a][0], tb = grupos[b][0];
    return (ta.tipo || "").localeCompare(tb.tipo || "") || (ta.residuo || "").localeCompare(tb.residuo || "", "es") || (ta.unidad || "").localeCompare(tb.unidad || "", "es");
  });

  box.innerHTML = claves.map(k => {
    const ts = grupos[k];
    const t0 = ts[0];
    const paga = t0.tipo === "paga";
    const vals = ts.filter(t => t.vigente && t.activo).map(clpDe).filter(v => v != null && v > 1);
    // "Mejor": el más barato si el proveedor cobra; el que más paga si el proveedor paga.
    const mejor = vals.length ? (paga ? Math.max(...vals) : Math.min(...vals)) : null;
    ts.sort((a, b) => (b.vigente - a.vigente) || (paga ? (clpDe(b) ?? -1) - (clpDe(a) ?? -1) : (clpDe(a) ?? 1e15) - (clpDe(b) ?? 1e15)) || String(b.fecha).localeCompare(String(a.fecha)));
    const titulo = [paga ? "PAGA" : "", t0.residuo || "(sin residuo)", t0.unidad ? "por " + t0.unidad : "(sin unidad)", t0.contenedor, siNoTxt(t0.incluye_transporte, "transporte"), siNoTxt(t0.incluye_disposicion, "disposición"), t0.region || "(sin región)"].filter(Boolean).join(" · ");
    const stats = vals.length ? '<span class="stat">mín ' + fmtCLP(Math.min(...vals)) + '</span><span class="stat">mediana ' + fmtCLP(mediana(vals)) + '</span><span class="stat">máx ' + fmtCLP(Math.max(...vals)) + '</span><span class="stat muted">' + vals.length + ' vigente(s)</span>' : '';
    return '<div class="tgrupo' + (paga ? " tg-paga" : "") + '"><div class="tg-head"><div class="tg-tit">' + esc(titulo) + '</div><div class="tg-stats">' + stats + '</div></div>' +
      '<div class="tscroll"><table class="ttar"><tr><th>Proveedor</th><th>Empresa / sucursal</th><th>Lugar</th><th>' + (paga ? "Paga al cliente" : "Precio") + '</th><th>Fecha / fuente</th><th></th><th></th></tr>' +
      agruparPorCondiciones(ts).map(gr => filaGrupoHtml(gr, { best: vals.length > 1 && gr[0].vigente && gr[0].activo && clpDe(gr[0]) === mejor })).join('') +
      '</table></div></div>';
  }).join('');
}

/* ---------------- integración con la lista de proveedores ----------------
   Reemplaza al antiguo cruce con el Excel del ecosistema: los clientes de cada
   proveedor y los gestores sin ficha en ClickUp salen de las tarifas activas. */
function clientesDeProveedor(s) {
  const vistos = {}, out = [];
  tarifasDeProveedor(s).forEach(t => {
    if (!t.cliente) return;
    const k = norm(t.cliente) + "|" + norm(t.sucursal);
    if (vistos[k]) return; vistos[k] = 1;
    out.push([t.cliente, t.sucursal || ""]);
  });
  return out.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1], "es"));
}

/** Aplica tarifas a SUPPLIERS: clientes y residuos, más los gestores que solo existen en tarifas. */
function aplicarTarifasAProveedores() {
  if (typeof SUPPLIERS === "undefined") return;
  SUPPLIERS = SUPPLIERS.filter(s => !s.sheetOnly);
  const conocidos = {};
  SUPPLIERS.forEach(s => { conocidos[s.id] = s; conocidos["n:" + norm(s.name)] = s; });
  const extra = {};
  TARIFAS.filter(t => t.activo).forEach(t => {
    if ((t.proveedor_id && conocidos[t.proveedor_id]) || conocidos["n:" + norm(t.proveedor_nombre)]) return;
    const k = norm(t.proveedor_nombre); if (!k) return;
    const e = extra[k] || (extra[k] = { name: t.proveedor_nombre, residuos: new Set() });
    if (t.residuo) e.residuos.add(t.residuo);
  });
  Object.keys(extra).forEach(k => {
    const e = extra[k], residuos = [...e.residuos];
    SUPPLIERS.push({
      id: "tar-" + k, name: e.name, url: "", estado: "planilla",
      residuos, residuoTxt: "", areas: [], ubicTxt: "", direccion: "", cobertura: "",
      ubicAll: "", residuosAll: residuos, estrellas: 0, puntaje: null,
      situacion: "", movimiento: "", correo: "", telefono: "", web: "", rut: "",
      clientes: [], score: 30, sheetOnly: true
    });
  });
  SUPPLIERS.forEach(s => {
    s.clientes = clientesDeProveedor(s);
    const set = {}; (s.residuos || []).forEach(r => { set[norm(r)] = r; });
    tarifasDeProveedor(s).forEach(t => { if (t.residuo && !set[norm(t.residuo)] && norm(t.residuo) !== "SINESPECIFICAR") set[norm(t.residuo)] = t.residuo; });
    s.residuos = Object.values(set);
  });
}

/** Empresas con tarifas activas (para el informe por empresa). */
function empresasConTarifas() { return unicosOrdenados(TARIFAS.filter(t => t.activo).map(t => t.cliente)); }

function tarifasResumenProveedor(s) {
  const ts = tarifasDeProveedor(s);
  if (!ts.length) return "";
  const n = ts.filter(t => t.alertas && t.alertas.length).length;
  const res = unicosOrdenados(ts.map(t => t.residuo)).slice(0, 4).join(", ");
  return '<div class="meta"><b>Tarifas:</b> ' + ts.length + ' registrada(s)' + (res ? ' · ' + esc(res) : '') + (n ? ' · <span class="t-alerta">⚠ ' + n + '</span>' : '') + '</div>';
}

function tarifasDetalleProveedor(s) {
  const ts = tarifasDeProveedor(s);
  marcarVigentes(TARIFAS.filter(t => t.activo));
  const head = '<div class="meta" style="margin-top:10px;"><b>Tarifas</b> <button class="lnk" onclick="abrirFormTarifa(null,{proveedor_nombre:' + esc(JSON.stringify(s.name)) + '})">+ Agregar tarifa</button></div>';
  if (!ts.length) return head + '<span class="toggle-hint">Sin tarifas registradas.</span>';
  ts.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return head + '<div class="tscroll"><table class="ttar"><tr><th>Empresa / sucursal</th><th>Servicio</th><th>Lugar</th><th>Precio</th><th>Fecha / fuente</th><th></th><th></th></tr>' +
    agruparPorCondiciones(ts).map(gr => filaGrupoHtml(gr, { sinProveedor: true, conServicio: true })).join('') + '</table></div>';
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
let FORM_GRUPO = null; // tarifas que se editan juntas ("Editar grupo")
let FORM_COLA = null; // líneas pendientes de "Pegar desde Claude"

function campo(id, label, html, cls) { return '<div class="tf-campo ' + (cls || "") + '"><label for="' + id + '">' + label + '</label>' + html + '</div>'; }
function inp(id, val, extra) { return '<input id="' + id + '" value="' + esc(val == null ? "" : val) + '" ' + (extra || "") + '>'; }
function sel(id, opts, val) { return '<select id="' + id + '">' + opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (String(v) === String(val || "") ? " selected" : "") + '>' + esc(t) + '</option>'; }).join('') + '</select>'; }

/** Edita juntas todas las tarifas activas con las mismas condiciones que la indicada (todas sus sucursales y residuos). */
function abrirFormGrupo(id) {
  const t = TARIFAS.find(x => x.id === id); if (!t) return;
  const k = condKey(t);
  const grupo = TARIFAS.filter(x => x.activo && condKey(x) === k);
  abrirFormTarifa(null, Object.assign({}, t, {
    residuos: unicosOrdenados(grupo.map(x => x.residuo)), sucursales: unicosOrdenados(grupo.map(x => x.sucursal)),
    contenedores: unicosOrdenados(grupo.map(x => x.contenedor)),
    precio: t.precio_num == null ? "" : t.precio_num, cantidad_min: t.cantidad_min_num ?? "", cantidad_max: t.cantidad_max_num ?? "", tipo_transaccion: t.tipo
  }), grupo);
}

function abrirFormTarifa(id, prefill, grupo) {
  const t = id ? TARIFAS.find(x => x.id === id) : null;
  FORM_ORIG = t || null;
  FORM_GRUPO = grupo && grupo.length ? grupo : null;
  const v = Object.assign({ moneda: "CLP", fuente: "cotizacion", estado_cliente: "activo", estado_servicio: "Cotizado", tipo_transaccion: "cobra", fecha: new Date().toISOString().slice(0, 10) }, t || {}, prefill || {});
  if (t) { v.precio = t.precio_num == null ? "" : t.precio_num; v.cantidad_min = t.cantidad_min_num ?? ""; v.cantidad_max = t.cantidad_max_num ?? ""; v.tipo_transaccion = t.tipo; }
  const residuos = [].concat(v.residuos || v.residuo || []).filter(Boolean);
  const comunas = [].concat(v.comunas || v.comuna || []).filter(Boolean).map(comunaCanonica);
  const sn = [["si", "Sí"], ["no", "No"]]; // por defecto Sí, salvo que la cotización lo excluya
  if (!t && !FORM_GRUPO) { v.incluye_transporte = siNo(v.incluye_transporte) || "si"; v.incluye_disposicion = siNo(v.incluye_disposicion) || "si"; }
  const sucursales = [].concat(v.sucursales || v.sucursal || []).filter(Boolean);
  const contenedores = [].concat(v.contenedores || v.contenedor || []).filter(Boolean);
  const multi = !t; // al crear o editar un grupo se eligen varios residuos/sucursales (una tarifa por combinación)
  const enGrupo = !!FORM_GRUPO;
  abrirModal("tarifaModal",
    '<h3>' + (t ? "Editar tarifa" : enGrupo ? "Editar grupo (" + FORM_GRUPO.length + " tarifas)" : "Nueva tarifa") + (FORM_COLA && FORM_COLA.length ? ' <span class="muted small">(' + FORM_COLA.length + ' pendiente(s) desde Claude)</span>' : '') + '</h3>' +
    (t ? '<div class="muted small">' + esc(t.id) + ' · creada por ' + esc(t.creado_por) + ' el ' + esc(t.creado_el) + '</div>' : '') +
    (enGrupo ? '<div class="muted small">Los cambios se aplican a todas. Agregar una sucursal, residuo o contenedor crea sus tarifas; quitarlo las da de baja. La dirección y comuna de cada sucursal se mantienen.</div>' : '') +
    '<div class="tf-grid">' +
      campo("f_proveedor", "Proveedor *", inp("f_proveedor", v.proveedor_nombre, 'list="provDL" autocomplete="off"'), "span2") +
      campo("f_tipo", "Tipo de transacción", sel("f_tipo", [["cobra", "Cobra: el cliente paga al proveedor"], ["paga", "Paga: el proveedor paga al cliente"]], v.tipo_transaccion)) +
      campo("f_estado_servicio", "Estado del servicio", selOtroHtml("f_estado_servicio", CATS.estado_servicio, v.estado_servicio, "-", "ajustarPorEstadoServicio")) +
      campo("f_estado_cliente", "Estado del cliente", selOtroHtml("f_estado_cliente", CATS.estado_cliente, v.estado_cliente, "-"), "dep-cliente") +
      campo("f_cliente", "Empresa", inp("f_cliente", v.cliente, 'list="clienteDL" autocomplete="off" placeholder="Ej: COPEC" oninput="mselOpciones(\'f_sucursales\', sucursalesDe(this.value))"'), "dep-cliente") +
      campo("f_sucursales", multi ? "Sucursal(es) <span class=\"muted\">· varias = una tarifa por cada una</span>" : "Sucursal", mselHtml("f_sucursales", { opciones: sucursalesDe(v.cliente), valores: sucursales, otro: true, unico: !multi, placeholder: "+ elegir sucursal", onChange: alCambiarSucursales }) + '<div id="f_suc_info" class="small muted"></div>', "dep-cliente span2") +
      campo("f_residuos", multi ? "Residuo(s) * <span class=\"muted\">· varios = una tarifa por cada uno</span>" : "Residuo *", mselHtml("f_residuos", { opciones: CATS.residuo || [], valores: residuos, otro: true, unico: !multi, placeholder: "+ elegir residuo" }), "span2") +
      campo("f_contenedores", multi ? "Contenedor(es) / vehículo(s) <span class=\"muted\">· varios = una tarifa por cada uno</span>" : "Contenedor / vehículo", mselHtml("f_contenedores", { opciones: CATS.contenedor || [], valores: contenedores, otro: true, unico: !multi, placeholder: "+ elegir contenedor o vehículo" }), "span2") +
      campo("f_unidad", "Unidad de cobro", selOtroHtml("f_unidad", CATS.unidad, v.unidad, "-")) +
      (enGrupo ? '' :
      campo("f_direccion", "Dirección del servicio", inp("f_direccion", v.direccion, 'placeholder="Calle, número, comuna" oninput="autoComuna()"'), "span2") +
      campo("f_comunas", multi ? "Comuna(s) <span class=\"muted\">· varias = una tarifa por cada una</span>" : "Comuna", mselHtml("f_comunas", { opciones: COMUNAS_LISTA, valores: comunas, unico: !multi, placeholder: "+ elegir comuna", onChange: autoRegion })) +
      campo("f_region", "Región", '<input id="f_region" readonly tabindex="-1">')) +
      campo("f_precio", "Monto neto (sin IVA)", inp("f_precio", v.precio, 'inputmode="decimal" placeholder="Ej: 192000 o 3,5"')) +
      campo("f_moneda", "Moneda", sel("f_moneda", CATS.moneda, v.moneda)) +
      campo("f_cant", "Cantidad mín. – máx.", '<div class="tf-dos">' + inp("f_cantidad_min", v.cantidad_min, 'inputmode="decimal" placeholder="mín"') + inp("f_cantidad_max", v.cantidad_max, 'inputmode="decimal" placeholder="máx"') + '</div>') +
      campo("f_fecha", "Fecha de la tarifa", '<input id="f_fecha" type="date" value="' + esc(v.fecha) + '">') +
      campo("f_incluye_transporte", "¿Incluye transporte?", sel("f_incluye_transporte", sn, v.incluye_transporte)) +
      campo("f_incluye_disposicion", "¿Incluye disposición?", sel("f_incluye_disposicion", sn, v.incluye_disposicion)) +
      campo("f_fuente", "Fuente", selOtroHtml("f_fuente", CATS.fuente, v.fuente)) +
      campo("f_detalle", "Detalle del cobro (por qué cobra eso, condiciones)", '<textarea id="f_detalle" rows="3">' + esc(v.detalle || "") + '</textarea>', "span2") +
      campo("f_pdf", "PDF de la cotización", (v.pdf_url ? '<div class="small"><a href="' + esc(v.pdf_url) + '" target="_blank" rel="noopener">Ver PDF actual</a> · subir otro reemplaza el enlace</div>' : '') + '<input id="f_pdf" type="file" accept="application/pdf">' + '<input id="f_pdf_url" type="hidden" value="' + esc(v.pdf_url || "") + '">', "span2") +
    '</div>' +
    '<div class="tf-acc"><span id="f_status" class="muted small"></span>' +
      (FORM_COLA && FORM_COLA.length ? '<button class="lnk" onclick="siguienteDeCola()">Saltar esta</button>' : '') +
      '<button class="cbtn" id="f_guardar" onclick="guardarTarifa()">' + (t ? "Guardar cambios" : "Guardar") + '</button></div>',
    () => { FORM_ORIG = null; FORM_COLA = null; FORM_GRUPO = null; });
  autoRegion();
  ajustarPorEstadoServicio();
  alCambiarSucursales(true);
}

/** Muestra la dirección conocida de cada sucursal elegida y, si es una sola, llena dirección y comuna. */
function alCambiarSucursales(inicial) {
  const info = document.getElementById("f_suc_info"); if (!info) return;
  const empresa = ((document.getElementById("f_cliente") || {}).value || "").trim();
  const sucs = mselValores("f_sucursales");
  if (!sucs.length) { info.innerHTML = ""; return; }
  const lineas = sucs.map(su => {
    const d = sucursalInfo(empresa, su);
    return '<div>📍 <b>' + esc(su) + ':</b> ' + (d && (d.direccion || d.comuna) ? esc([d.direccion, d.comuna].filter(Boolean).join(", ")) : '<span class="warn">sin dirección registrada: se usará la que ingreses abajo y quedará guardada</span>') + '</div>';
  });
  info.innerHTML = lineas.join("") + (sucs.length > 1 ? '<div>Cada tarifa toma la dirección de su sucursal.</div>' : '');
  if (sucs.length === 1 && !inicial) {
    const d = sucursalInfo(empresa, sucs[0]);
    const dir = document.getElementById("f_direccion");
    if (d && dir) {
      dir.value = d.direccion || "";
      if (MSEL.f_comunas) { MSEL.f_comunas.valores = d.comuna ? [comunaCanonica(d.comuna)] : []; mselRender("f_comunas"); autoRegion(); }
    }
  }
}

/** "Valor general" es un precio de lista sin cliente: se ocultan empresa, sucursal y estado del cliente. */
function ajustarPorEstadoServicio() {
  const general = norm(selOtroVal("f_estado_servicio")) === "VALORGENERAL";
  document.querySelectorAll("#tarifaModal .dep-cliente").forEach(el => { el.style.display = general ? "none" : ""; });
}

/** Empresa y sucursal requeridas según el estado del servicio (los estados nuevos no exigen nada). */
function validarEstadoServicio(d) {
  const e = norm(d.estado_servicio);
  if (e === "ACTIVO" && (!d.cliente || !d.sucursal)) throw new Error("Un servicio Activo necesita empresa y sucursal.");
  if (["COTIZADO", "NOTOMADO", "TERMINADO"].indexOf(e) !== -1 && !d.cliente) throw new Error("Indica la empresa a la que se cotizó o prestó el servicio.");
}

function autoComuna() {
  if (!document.getElementById("f_direccion")) return;
  const c = detectarComuna(document.getElementById("f_direccion").value);
  if (c && !mselValores("f_comunas").length) mselAgregar("f_comunas", c);
}
function autoRegion() {
  const el = document.getElementById("f_region");
  if (el) el.value = unicosOrdenados(mselValores("f_comunas").map(regionDeComuna)).join(", ");
}

/** Devuelve una tarifa por cada combinación residuo × sucursal × comuna. */
function leerFormulario() {
  const g = id => ((document.getElementById(id) || {}).value || "").trim();
  const nombre = g("f_proveedor");
  const sup = buscarProveedorClickUp(nombre);
  const base = {
    proveedor_id: sup ? sup.id : "", proveedor_nombre: sup ? sup.name : nombre,
    tipo_transaccion: g("f_tipo"), estado_servicio: selOtroVal("f_estado_servicio"),
    cliente: g("f_cliente"), estado_cliente: selOtroVal("f_estado_cliente"),
    unidad: selOtroVal("f_unidad"),
    direccion: g("f_direccion"),
    precio: g("f_precio") === "" ? "" : numDe(g("f_precio")), moneda: g("f_moneda"),
    cantidad_min: g("f_cantidad_min") === "" ? "" : numDe(g("f_cantidad_min")),
    cantidad_max: g("f_cantidad_max") === "" ? "" : numDe(g("f_cantidad_max")),
    incluye_transporte: g("f_incluye_transporte"), incluye_disposicion: g("f_incluye_disposicion"),
    fecha: g("f_fecha"), fuente: selOtroVal("f_fuente"), detalle: g("f_detalle"), pdf_url: g("f_pdf_url")
  };
  ["precio", "cantidad_min", "cantidad_max"].forEach(k => { if (base[k] === null) throw new Error("Revisa el número en " + k.replace("_", " ") + "."); });
  if (!base.proveedor_nombre) throw new Error("Falta el proveedor.");
  const general = norm(base.estado_servicio) === "VALORGENERAL";
  if (general) { base.cliente = ""; base.estado_cliente = ""; }
  const sucursales = general ? [] : mselValores("f_sucursales");
  validarEstadoServicio(Object.assign({}, base, { sucursal: sucursales[0] || "" }));
  const residuos = mselValores("f_residuos");
  const contenedores = mselValores("f_contenedores");
  const conts = contenedores.length ? contenedores : [""];
  if (!residuos.length) throw new Error("Elige al menos un residuo.");
  const comunas = mselValores("f_comunas");
  const lista = [], nuevasSucursales = [];
  if (sucursales.length) {
    // Una tarifa por residuo × sucursal; la dirección sale de la sucursal (o del formulario si no la tiene).
    const comunaForm = comunas[0] || "";
    sucursales.forEach(su => {
      const d = sucursalInfo(base.cliente, su);
      const conocida = !FORM_ORIG && d && (d.direccion || d.comuna); // al editar una tarifa manda lo que se escribe
      const lugar = conocida ? { direccion: d.direccion, comuna: d.comuna, region: d.region }
                             : { direccion: base.direccion, comuna: comunaForm, region: regionDeComuna(comunaForm) };
      if (!d || !d.enLista) nuevasSucursales.push(Object.assign({ empresa: base.cliente, sucursal: su }, lugar));
      residuos.forEach(r => conts.forEach(co => lista.push(Object.assign({}, base, lugar, { residuo: r, contenedor: co, sucursal: su }))));
    });
  } else {
    residuos.forEach(r => conts.forEach(co => (comunas.length ? comunas : [""]).forEach(c => {
      lista.push(Object.assign({}, base, { residuo: r, contenedor: co, sucursal: "", comuna: c, region: regionDeComuna(c) }));
    })));
  }
  return { lista, enClickUp: !!sup, residuos, sucursales, contenedores, nuevasSucursales };
}

async function asegurarCatalogos(datos) {
  for (const c of ["residuo", "unidad", "contenedor", "estado_cliente", "estado_servicio", "fuente"]) {
    const v = datos[c]; if (!v) continue;
    const existe = (CATS[c] || []).find(x => x.toLowerCase() === String(v).toLowerCase());
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
    const { lista, enClickUp, residuos, sucursales, contenedores, nuevasSucursales } = leerFormulario();
    const sinDir = nuevasSucursales.filter(x => !x.direccion && !x.comuna);
    const conDirForm = nuevasSucursales.filter(x => x.direccion || x.comuna);
    if (conDirForm.length > 1 && !FORM_ORIG && !confirm("Las sucursales nuevas " + conDirForm.map(x => x.sucursal).join(", ") + " quedarán con la dirección " + [conDirForm[0].direccion, conDirForm[0].comuna].filter(Boolean).join(", ") + ". ¿Continuar? (Si son distintas, cárgalas de a una.)")) return;
    if (sinDir.length && !FORM_ORIG && !confirm("No hay dirección para: " + sinDir.map(x => x.sucursal).join(", ") + ". ¿Guardar igual? (La puedes completar después en Sucursales.)")) return;
    if (FORM_GRUPO) return await guardarGrupo(lista[0], residuos, sucursales, contenedores, st, btn);
    if (!enClickUp && !FORM_ORIG && !confirm("“" + lista[0].proveedor_nombre + "” no está en ClickUp. ¿Guardar igual solo con el nombre?")) return;
    if (lista.length > 1 && !confirm("Se crearán " + lista.length + " tarifas (una por cada residuo, contenedor, sucursal y comuna). ¿Continuar?")) return;
    btn.disabled = true; st.textContent = "Guardando…";
    if (!sesionActiva()) await iniciarSesion();
    for (const d of lista) await asegurarCatalogos(d);
    const url = await subirPdfSiHay("f_pdf"); if (url) lista.forEach(d => { d.pdf_url = url; });
    if (FORM_ORIG) {
      const datos = lista[0], cambios = {};
      Object.keys(datos).forEach(k => {
        const antes = k === "precio" ? FORM_ORIG.precio_num : k === "cantidad_min" ? FORM_ORIG.cantidad_min_num : k === "cantidad_max" ? FORM_ORIG.cantidad_max_num : k === "tipo_transaccion" ? FORM_ORIG.tipo : tget(FORM_ORIG, k);
        if (String(antes ?? "") !== String(datos[k] ?? "")) cambios[k] = datos[k];
      });
      const r = await api("tarifa_editar", { id: FORM_ORIG.id, cambios }, true);
      st.textContent = r.cambios ? "Guardado (" + r.cambios + " cambio(s))." : "Sin cambios.";
      await refrescarTrasGuardar([r.tarifa]);
    } else if (lista.length === 1) {
      const r = await api("tarifa_crear", { tarifa: lista[0] }, true);
      st.textContent = "Tarifa guardada.";
      await refrescarTrasGuardar([r.tarifa]);
    } else {
      const r = await api("tarifa_crear_lote", { tarifas: lista }, true);
      st.textContent = r.ids.length + " tarifas guardadas.";
      await refrescarTrasGuardar(r.tarifas);
    }
    await registrarSucursales(nuevasSucursales);
    if (FORM_COLA && FORM_COLA.length) siguienteDeCola(); else setTimeout(() => cerrarModal("tarifaModal"), 500);
  } catch (e) {
    st.textContent = "Error: " + e.message;
  } finally { if (btn) btn.disabled = false; }
}

/** Edición en grupo: aplica los datos comunes a todas, crea las combinaciones nuevas y da de baja las quitadas. */
async function guardarGrupo(base, residuos, sucursales, contenedores, st, btn) {
  const grupo = FORM_GRUPO;
  const clave = (r, co, su) => norm(r) + "|" + norm(co) + "|" + norm(su);
  const deseadas = {};
  residuos.forEach(r => (contenedores.length ? contenedores : [""]).forEach(co => (sucursales.length ? sucursales : [""]).forEach(su => { deseadas[clave(r, co, su)] = { r, co, su }; })));
  const comunes = Object.assign({}, base);
  ["residuo", "contenedor", "sucursal", "direccion", "comuna", "region"].forEach(k => delete comunes[k]);
  const antes = (t, k) => k === "precio" ? t.precio_num : k === "cantidad_min" ? t.cantidad_min_num : k === "cantidad_max" ? t.cantidad_max_num : k === "tipo_transaccion" ? t.tipo : tget(t, k);
  const editar = [], baja = [], crear = [], existentes = {};
  grupo.forEach(t => {
    const k = clave(t.residuo, t.contenedor, t.sucursal);
    if (!deseadas[k]) { baja.push(t.id); return; }
    existentes[k] = true;
    const cambios = {};
    Object.keys(comunes).forEach(c => { if (String(antes(t, c) ?? "") !== String(comunes[c] ?? "")) cambios[c] = comunes[c]; });
    if (Object.keys(cambios).length) editar.push({ id: t.id, cambios });
  });
  Object.keys(deseadas).forEach(k => {
    if (existentes[k]) return;
    const { r, co, su } = deseadas[k];
    const ref = sucursalInfo(comunes.cliente, su) || grupo.find(t => norm(t.sucursal) === norm(su)) || {}; // dirección conocida de la sucursal
    crear.push(Object.assign({}, comunes, { residuo: r, contenedor: co, sucursal: su, direccion: tget(ref, "direccion"), comuna: tget(ref, "comuna"), region: tget(ref, "region") }));
  });
  if (!editar.length && !baja.length && !crear.length) { st.textContent = "Sin cambios."; return; }
  const resumen = [editar.length && editar.length + " se actualizan", crear.length && crear.length + " se crean", baja.length && baja.length + " se dan de baja"].filter(Boolean).join(", ");
  if (!confirm("Grupo: " + resumen + ". ¿Continuar?")) return;
  btn.disabled = true; st.textContent = "Guardando…";
  if (!sesionActiva()) await iniciarSesion();
  await asegurarCatalogos(comunes);
  for (const d of crear) await asegurarCatalogos(d);
  const url = await subirPdfSiHay("f_pdf");
  if (url) {
    crear.forEach(d => { d.pdf_url = url; });
    grupo.forEach(t => {
      if (baja.includes(t.id) || t.pdf_url === url) return;
      const e = editar.find(x => x.id === t.id);
      if (e) e.cambios.pdf_url = url; else editar.push({ id: t.id, cambios: { pdf_url: url } });
    });
  }
  const r = await api("tarifa_lote", { lote: { editar, baja, crear } }, true);
  st.textContent = "Listo: " + resumen + ".";
  await refrescarTrasGuardar(r.tarifas);
  setTimeout(() => cerrarModal("tarifaModal"), 700);
}

/* ---------------- lista maestra de sucursales ---------------- */
/** Guarda en la lista las sucursales que se usaron por primera vez (no rompe el guardado si falla). */
async function registrarSucursales(nuevas) {
  for (const n of (nuevas || [])) {
    if (!n.empresa || !n.sucursal) continue;
    if (SUCURSALES.some(x => norm(x.empresa) === norm(n.empresa) && norm(x.sucursal) === norm(n.sucursal))) continue;
    try { const r = await api("sucursal_guardar", { sucursal: n, propagar: false }, true); SUCURSALES.push(r.sucursal); }
    catch (e) { console.warn("No se pudo registrar la sucursal", n.sucursal, e.message); }
  }
}

function abrirSucursales() {
  const empresas = unicosOrdenados(SUCURSALES.map(x => x.empresa).concat(TARIFAS.map(t => t.cliente)));
  abrirModal("sucModal",
    '<h3>Sucursales</h3>' +
    '<p class="small muted">La dirección y comuna de cada sucursal se usan al crear tarifas. Al guardar un cambio aquí también se actualizan sus tarifas activas.</p>' +
    '<div class="tf-grid">' +
      campo("s_emp", "Empresa", '<select id="s_emp" onchange="renderSucursales()">' + empresas.map(e => '<option>' + esc(e) + '</option>').join('') + '</select>') +
      campo("s_buscar", "Buscar sucursal", '<input id="s_buscar" oninput="renderSucursales()" placeholder="Nombre...">') +
    '</div>' +
    '<div id="s_status" class="small" style="margin-top:8px;font-weight:600;color:#047857"></div>' +
    '<div id="s_lista" style="margin-top:8px"></div>' +
    '<h3 style="margin-top:16px;font-size:15px">+ Nueva sucursal</h3>' +
    '<div class="tf-grid">' +
      campo("s_n_suc", "Sucursal", '<input id="s_n_suc">') +
      campo("s_n_com", "Comuna", '<input id="s_n_com" list="s_comDL">') +
      campo("s_n_dir", "Dirección", '<input id="s_n_dir">', "span2") +
    '</div><datalist id="s_comDL">' + COMUNAS_LISTA.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>' +
    '<div class="tf-acc"><button class="cbtn" data-txt="Agregar sucursal" onclick="guardarSucursal(null, this)">Agregar sucursal</button></div>');
  renderSucursales();
}

let SUC_GUARDADA = null; // { k, t, n } última sucursal guardada, para mostrar "✓ Guardado" en su fila

function renderSucursales() {
  const emp = (document.getElementById("s_emp") || {}).value || "";
  const q = norm((document.getElementById("s_buscar") || {}).value || "");
  const conocidas = {};
  SUCURSALES.forEach(x => { if (norm(x.empresa) === norm(emp)) conocidas[norm(x.sucursal)] = x; });
  // sucursales que solo existen en tarifas (aún no están en la lista)
  TARIFAS.forEach(t => { if (t.activo && norm(t.cliente) === norm(emp) && t.sucursal && !conocidas[norm(t.sucursal)]) conocidas[norm(t.sucursal)] = { empresa: emp, sucursal: t.sucursal, direccion: t.direccion || "", comuna: t.comuna || "", soloTarifas: true }; });
  const filas = Object.values(conocidas).filter(x => !q || norm(x.sucursal).indexOf(q) !== -1).sort((a, b) => a.sucursal.localeCompare(b.sucursal, "es"));
  document.getElementById("s_lista").innerHTML = filas.length
    ? '<div class="tscroll"><table class="ttar"><tr><th>Sucursal</th><th>Dirección</th><th>Comuna</th><th></th></tr>' + filas.map((x, i) =>
        '<tr><td><b>' + esc(x.sucursal) + '</b>' + (x.soloTarifas ? '<div class="muted small">no estaba en la lista</div>' : '') + '</td>' +
        '<td><input id="s_dir_' + i + '" value="' + esc(x.direccion) + '" data-suc="' + esc(x.sucursal) + '"></td>' +
        '<td><input id="s_com_' + i + '" value="' + esc(x.comuna) + '" list="s_comDL"></td>' +
        '<td class="acc">' + (SUC_GUARDADA && SUC_GUARDADA.k === norm(emp) + "|" + norm(x.sucursal) && Date.now() - SUC_GUARDADA.t < 15000
          ? '<span class="ok-msg">✓ Guardado' + (SUC_GUARDADA.n ? ' · ' + SUC_GUARDADA.n + ' tarifa(s)' : '') + '</span>'
          : '<button class="cbtn mini" onclick="guardarSucursal(' + i + ', this)">Guardar</button>') + '</td></tr>').join('') + '</table></div>'
    : '<p class="muted small">Sin sucursales para esta empresa.</p>';
}

async function guardarSucursal(i, btn) {
  const st = document.getElementById("s_status");
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = "Guardando…"; }
  const emp = (document.getElementById("s_emp") || {}).value || "";
  let d;
  if (i === null) d = { empresa: emp, sucursal: document.getElementById("s_n_suc").value.trim(), direccion: document.getElementById("s_n_dir").value.trim(), comuna: comunaCanonica(document.getElementById("s_n_com").value) };
  else { const dir = document.getElementById("s_dir_" + i); d = { empresa: emp, sucursal: dir.dataset.suc, direccion: dir.value.trim(), comuna: comunaCanonica(document.getElementById("s_com_" + i).value) }; }
  const fallo = msg => { st.textContent = msg; if (btn) { btn.disabled = false; btn.textContent = btn.dataset.txt || "Guardar"; } alert(msg); };
  if (!d.empresa || !d.sucursal) return fallo("Falta la empresa o la sucursal.");
  if (d.comuna && !regionDeComuna(d.comuna)) return fallo("No reconozco la comuna “" + d.comuna + "”. Elígela de la lista.");
  d.region = regionDeComuna(d.comuna);
  try {
    st.textContent = "Guardando…";
    const r = await api("sucursal_guardar", { sucursal: d, propagar: true }, true);
    const k = norm(d.empresa) + "|" + norm(d.sucursal);
    SUCURSALES = SUCURSALES.filter(x => norm(x.empresa) + "|" + norm(x.sucursal) !== k).concat([r.sucursal]);
    st.textContent = "✓ " + d.sucursal + " guardada" + (r.tarifas.length ? " · " + r.tarifas.length + " tarifa(s) actualizadas" : "") + ".";
    SUC_GUARDADA = { k: k, t: Date.now(), n: r.tarifas.length };
    if (btn && i === null) { btn.disabled = false; btn.textContent = "Agregar sucursal"; }
    setTimeout(() => { if (document.getElementById("s_lista")) renderSucursales(); }, 15500);
    if (r.tarifas.length) await refrescarTrasGuardar(r.tarifas);
    if (i === null) ["s_n_suc", "s_n_dir", "s_n_com"].forEach(id => { document.getElementById(id).value = ""; });
    renderSucursales();
  } catch (e) { fallo("Error: " + e.message); }
}

/* ---------------- baja / historial ---------------- */
async function cambiarActivo(id, activo) {
  const t = TARIFAS.find(x => x.id === id);
  if (!activo && !confirm("¿Dar de baja esta tarifa de " + (t ? t.proveedor_nombre : "") + "? Se puede restaurar después.")) return;
  try { const r = await api(activo ? "tarifa_restaurar" : "tarifa_baja", { id }, true); await refrescarTrasGuardar([r.tarifa]); }
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
  ["proveedor_nombre", "proveedor", "cliente", "empresa", "sucursal", "tipo_transaccion", "estado_servicio", "estado_cliente", "direccion", "comuna", "fecha", "fuente", "moneda", "detalle", "incluye_transporte", "incluye_disposicion"].forEach(k => { if (base[k] != null && base[k] !== "") comun[k === "proveedor" ? "proveedor_nombre" : k] = base[k]; });
  // Una línea puede traer listas en "residuo", "contenedor" y "comuna": una tarifa por combinación.
  const expandidas = [];
  lineas.forEach(l => {
    const res = [].concat(l.residuo == null ? "" : l.residuo);
    const com = [].concat(l.comuna == null || l.comuna === "" ? (comun.comuna || "") : l.comuna);
    const con = [].concat(l.contenedor == null ? "" : l.contenedor);
    res.forEach(r => con.forEach(co => com.forEach(c => expandidas.push(Object.assign({}, l, { residuo: r, contenedor: co, comuna: c })))));
  });
  return expandidas.map(l => {
    const d = Object.assign({}, comun, l);
    if (d.proveedor && !d.proveedor_nombre) d.proveedor_nombre = d.proveedor; delete d.proveedor;
    if (d.empresa && !d.cliente) d.cliente = d.empresa; delete d.empresa;
    if (d.cliente) d.cliente = empresaCanonica(d.cliente);
    d.tipo_transaccion = String(d.tipo_transaccion || "cobra").toLowerCase() === "paga" ? "paga" : "cobra";
    if (base.detalle && l.detalle && l.detalle !== base.detalle) d.detalle = l.detalle + "\n" + base.detalle;
    const sup = buscarProveedorClickUp(d.proveedor_nombre);
    if (sup) { d._nombre_doc = d.proveedor_nombre; d.proveedor_id = sup.id; d.proveedor_nombre = sup.name; }
    if (d.sucursal && !d.direccion && !d.comuna) { const si = sucursalInfo(d.cliente, d.sucursal); if (si) { d.direccion = si.direccion; d.comuna = si.comuna; } }
    if (!d.comuna && d.direccion) d.comuna = detectarComuna(d.direccion);
    d.comuna = comunaCanonica(d.comuna); d.region = regionDeComuna(d.comuna);
    d.precio = numDe(d.precio); d.cantidad_min = numDe(d.cantidad_min); d.cantidad_max = numDe(d.cantidad_max);
    d.moneda = String(d.moneda || "CLP").toUpperCase();
    d.incluye_transporte = siNo(d.incluye_transporte === true ? "si" : d.incluye_transporte === false ? "no" : d.incluye_transporte) || "si";
    d.incluye_disposicion = siNo(d.incluye_disposicion === true ? "si" : d.incluye_disposicion === false ? "no" : d.incluye_disposicion) || "si";
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
      '<div class="tscroll"><table class="ttar"><tr><th>Proveedor</th><th>Empresa / sucursal</th><th>Servicio</th><th>Lugar</th><th>Precio</th><th></th></tr>' +
      conAlerta.map(t => '<tr><td>' + esc(t.proveedor_nombre) + (t.proveedor_id ? (t._nombre_doc && claveNombre(t._nombre_doc) !== claveNombre(t.proveedor_nombre) ? '<div class="muted small">en la cotización: ' + esc(t._nombre_doc) + '</div>' : '') : ' <span class="t-alerta">no está en ClickUp</span>') + '</td><td>' + empresaHtml(t) + '</td><td>' + esc(t.residuo || "-") + '<div class="muted small">' + esc([t.contenedor, siNoTxt(t.incluye_transporte, "transp."), siNoTxt(t.incluye_disposicion, "disp.")].filter(Boolean).join(" · ")) + '</div></td><td>' + esc(t.comuna || t.direccion || "-") + '</td><td class="num">' + precioHtml(t) + '</td><td>' + alertaHtml(t) + '</td></tr>').join('') +
      '</table></div>' +
      campo("pegarPdf", "PDF de la cotización (se adjunta a todas)", '<input id="pegarPdf" type="file" accept="application/pdf">', "span2") +
      '<div class="tf-acc"><span id="pegarStatus2" class="muted small"></span>' +
      '<button class="lnk" onclick="revisarUnaPorUna()">Revisar una por una</button>' +
      '<button class="cbtn" onclick="guardarLoteClaude(this)">Guardar todas (' + FORM_COLA.length + ')</button></div>';
  } catch (e) {
    FORM_COLA = null; prev.innerHTML = ""; st.textContent = "No se pudo interpretar: " + e.message;
  }
}

async function guardarLoteClaude(btn) {
  const st = document.getElementById("pegarStatus2");
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try {
    if (!sesionActiva()) await iniciarSesion();
    st.textContent = "Guardando…";
    const url = await subirPdfSiHay("pegarPdf");
    for (const d of FORM_COLA) { await asegurarCatalogos(d); if (url) d.pdf_url = url; }
    const r = await api("tarifa_crear_lote", { tarifas: FORM_COLA }, true);
    st.textContent = r.ids.length + " tarifa(s) guardadas.";
    FORM_COLA = null;
    await refrescarTrasGuardar(r.tarifas);
    setTimeout(() => cerrarModal("pegarModal"), 700);
  } catch (e) { st.textContent = "Error: " + e.message; if (btn) btn.disabled = false; }
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
  document.getElementById("tfResiduoBox").innerHTML = mselHtml("tfResiduo", { placeholder: "Todos (+ agregar)", onChange: renderTarifas });
  document.getElementById("tfComunaBox").innerHTML = mselHtml("tfComuna", { placeholder: "Todas (+ agregar)", onChange: renderTarifas });
  ["tfRegion", "tfUnidad", "tfEstado", "tfTipo", "tfServicio", "tfAnteriores", "tfBajas", "tfAlertas"].forEach(id => document.getElementById(id).addEventListener("change", renderTarifas));
  ["tfTexto", "tfSucursal"].forEach(id => document.getElementById(id).addEventListener("input", renderTarifas));
  document.getElementById("tfEmpresa").addEventListener("input", e => { actualizarSucursalDL("tfSucursalDL", e.target.value); renderTarifas(); });
  if (lsGet("rp_vista") === "tar") mostrarVista("tar");
  loadUF();
}
