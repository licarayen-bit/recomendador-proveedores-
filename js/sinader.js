/* ============================================================
   SINADER: destinatarios autorizados (RETC)
   - Lee la pestaña Sinader del Sheet espejo (gviz). Es una copia limpia y fija
     de la descarga SINADER del 8-10-26 (una fila por establecimiento x tratamiento).
   - Solo lectura. Se cruza con los proveedores solo por RUT.
   - Depende de globales de index.html: gvizFetch, MIRROR_SHEET_ID, SUPPLIERS,
     esc, norm, render; y de js/tarifas.js: lsGet, lsSet.
   ============================================================ */
const SINADER_GID = "1661520673";
const SIN_PAGINA = 100;

let SINADER = [];             // establecimientos: { codigo, rut, rk, razon, nombre, region, comuna, trat: [{ c1, n1, c2, n2, c3, n3, activo }] }
let SINADER_POR_RUT = {};     // rk -> [establecimientos]
let SINADER_STATUS = "no cargado";
let SIN_MOSTRAR = SIN_PAGINA;

/** RUT comparable: solo dígitos y K, sin ceros a la izquierda ("76.404.335-9" = "76404335-9"). */
function rutClave(s) { return String(s || "").toUpperCase().replace(/[^0-9K]/g, "").replace(/^0+/, ""); }

async function loadSinader() {
  if (!SINADER_GID) { SINADER_STATUS = "sin configurar"; return; }
  try {
    const rows = await gvizFetch(MIRROR_SHEET_ID, SINADER_GID, true);
    const H = (rows.shift() || []).map(h => String(h || "").trim().toLowerCase());
    const c = n => H.indexOf(n);
    const ix = {
      codigo: c("codigo_retc"), rut: c("rut"), razon: c("razon_social"), nombre: c("establecimiento"),
      region: c("region"), comuna: c("comuna"), c1: c("nivel_1_cod"), n1: c("nivel_1"), c2: c("nivel_2_cod"), n2: c("nivel_2"),
      c3: c("nivel_3_cod"), n3: c("nivel_3"), activo: c("activo")
    };
    const g = (r, k) => (ix[k] >= 0 && r[ix[k]] != null ? String(r[ix[k]]).trim() : "");
    const porCodigo = {};
    rows.forEach(r => {
      const codigo = g(r, "codigo");
      if (!codigo) return;
      let e = porCodigo[codigo];
      if (!e) {
        e = porCodigo[codigo] = {
          codigo, rut: g(r, "rut"), rk: rutClave(g(r, "rut")), razon: g(r, "razon"), nombre: g(r, "nombre"),
          region: g(r, "region"), comuna: g(r, "comuna"), trat: []
        };
      }
      e.trat.push({
        c1: g(r, "c1"), n1: g(r, "n1"), c2: g(r, "c2"), n2: g(r, "n2"), c3: g(r, "c3"), n3: g(r, "n3"),
        activo: g(r, "activo").toLowerCase() === "si"
      });
    });
    SINADER = Object.values(porCodigo).sort((a, b) => a.razon.localeCompare(b.razon) || a.nombre.localeCompare(b.nombre));
    SINADER_POR_RUT = {};
    SINADER.forEach(e => { if (e.rk) (SINADER_POR_RUT[e.rk] = SINADER_POR_RUT[e.rk] || []).push(e); });
    SINADER_STATUS = SINADER.length + " establecimientos";
  } catch (e) {
    SINADER_STATUS = "error: " + ((e && e.message) || e);
  }
}

/* ---------------- cruce con proveedores ---------------- */
function rutsEcosistema() {
  const set = new Set();
  (SUPPLIERS || []).forEach(s => { const k = rutClave(s.rut); if (k) set.add(k); });
  return set;
}
function sinaderDeProveedor(s) { const k = rutClave(s && s.rut); return (k && SINADER_POR_RUT[k]) || []; }
/** "18 Reciclaje de plásticos" (código + nombre de un nivel). */
const conCod = (cod, nom) => (cod && nom ? cod + " " + nom : nom || "");
function tratTexto(t) { return [conCod(t.c1, t.n1), conCod(t.c2, t.n2), conCod(t.c3, t.n3)].filter(Boolean).join(" › "); }
/** Etiqueta con los 3 niveles y sus códigos; el más específico en negrita. */
function tratChip(t) {
  const niv = [[t.c1, t.n1], [t.c2, t.n2], [t.c3, t.n3]].filter(x => x[1]).map(x => esc(conCod(x[0], x[1])));
  if (niv.length) niv[niv.length - 1] = '<b>' + niv[niv.length - 1] + '</b>';
  return '<span class="chip sin-trat' + (t.activo ? '' : ' sin-inact') + '">' + niv.join(' <span class="sin-sep">›</span> ') +
    (t.activo ? '' : ' (inactivo)') + '</span>';
}
/** Nivel más específico con su código. */
function tratCorto(t) { return t.n3 ? conCod(t.c3, t.n3) : t.n2 ? conCod(t.c2, t.n2) : conCod(t.c1, t.n1); }
/** Tratamientos activos distintos (nivel más específico) de una lista de establecimientos. */
function tratsActivos(estabs) {
  const set = new Set();
  estabs.forEach(e => e.trat.forEach(t => { if (t.activo) set.add(tratCorto(t)); }));
  return [...set].filter(Boolean);
}

/** Etiqueta para la tarjeta de un proveedor ("" si no calza). */
function sinaderBadgeProveedor(s) {
  const es = sinaderDeProveedor(s);
  if (!es.length) return "";
  const tr = tratsActivos(es);
  return '<span class="badge b-sinader" title="' + esc(tr.length ? tr.join(" · ") : "Sin tratamientos activos") + '">DF Autorizado SINADER</span>';
}

/** Bloque para el detalle de un proveedor ("" si no calza). */
function sinaderDetalleProveedor(s) {
  const es = sinaderDeProveedor(s);
  if (!es.length) return "";
  return '<div class="meta" style="margin-top:10px;"><b>DF Autorizado SINADER</b> (' + es.length + ' establecimiento' + (es.length > 1 ? 's' : '') + ')</div>' +
    es.map(e => '<div class="sin-det"><div class="meta"><b>' + esc(e.nombre || e.razon) + '</b> · ' + esc([e.comuna, e.region].filter(Boolean).join(", ")) + ' · RETC ' + esc(e.codigo) + '</div>' +
      '<div class="chips">' + e.trat.map(t => tratChip(t)).join('') + '</div></div>').join('');
}

/* ---------------- vista Sinader ---------------- */
const sinVal = id => (document.getElementById(id) || {}).value || "";
function opciones(sel, valores, todos, etiqueta) {
  const el = document.getElementById(sel); if (!el) return;
  const cur = el.value;
  el.innerHTML = '<option value="">' + todos + '</option>' + valores.map(v => '<option value="' + esc(v) + '">' + esc(etiqueta ? etiqueta(v) : v) + '</option>').join('');
  el.value = valores.indexOf(cur) >= 0 ? cur : "";
}
const unicos = arr => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));

/** Rellena los selects dependientes según lo ya elegido (región → comuna, nivel 1 → 2 → 3). */
function sinaderOpciones() {
  const reg = sinVal("sfRegion"), n1 = sinVal("sfN1"), n2 = sinVal("sfN2");
  opciones("sfRegion", unicos(SINADER.map(e => e.region)), "Todas");
  opciones("sfComuna", unicos(SINADER.filter(e => !reg || e.region === reg).map(e => e.comuna)), "Todas");
  const ts = SINADER.flatMap(e => e.trat);
  const cod = {}; ts.forEach(t => { cod["1" + t.n1] = t.c1; cod["2" + t.n2] = t.c2; cod["3" + t.n3] = t.c3; });
  const porCod = nv => (a, b) => (Number(cod[nv + a]) || 0) - (Number(cod[nv + b]) || 0) || a.localeCompare(b, "es");
  const et = nv => v => conCod(cod[nv + v], v);
  opciones("sfN1", unicos(ts.map(t => t.n1)).sort(porCod(1)), "Todos", et(1));
  opciones("sfN2", unicos(ts.filter(t => !n1 || t.n1 === n1).map(t => t.n2)).sort(porCod(2)), "Todos", et(2));
  opciones("sfN3", unicos(ts.filter(t => (!n1 || t.n1 === n1) && (!n2 || t.n2 === n2)).map(t => t.n3)).sort(porCod(3)), "Todos", et(3));
}

/** sinEco=true ignora el filtro "En ecosistema" (lo usa el resumen, que siempre muestra ambos lados). */
function sinaderFiltrados(sinEco) {
  const txt = norm(sinVal("sfTexto")), txtRut = rutClave(sinVal("sfTexto")), reg = sinVal("sfRegion"), com = sinVal("sfComuna");
  const n1 = sinVal("sfN1"), n2 = sinVal("sfN2"), n3 = sinVal("sfN3"), eco = sinEco ? "" : sinVal("sfEco");
  const soloAct = (document.getElementById("sfActivos") || {}).checked;
  const ruts = rutsEcosistema();
  const out = [];
  SINADER.forEach(e => {
    if (reg && e.region !== reg) return;
    if (com && e.comuna !== com) return;
    const en = !!e.rk && ruts.has(e.rk);
    if (eco === "si" && !en) return;
    if (eco === "no" && en) return;
    if (txt && norm(e.razon + " " + e.nombre).indexOf(txt) === -1 && !(txtRut.length >= 4 && e.rk.indexOf(txtRut) !== -1)) return;
    const trat = e.trat.filter(t => (!soloAct || t.activo) && (!n1 || t.n1 === n1) && (!n2 || t.n2 === n2) && (!n3 || t.n3 === n3));
    if (!trat.length) return;
    out.push({ e, trat, en });
  });
  return out;
}

/** Agrupa los establecimientos filtrados por empresa (RUT; si no hay RUT, por razón social). */
function sinaderAgrupar(rows) {
  const grupos = {}, orden = [];
  rows.forEach(r => {
    const k = r.e.rk || "RS:" + norm(r.e.razon);
    if (!grupos[k]) { grupos[k] = { k, razon: r.e.razon, rut: r.e.rut, en: r.en, estabs: [] }; orden.push(grupos[k]); }
    grupos[k].estabs.push(r);
  });
  return orden;
}
let SIN_GRUPOS = [];

function estabHtml({ e, trat }) {
  return '<div class="sin-det">' +
    '<div class="meta"><b>' + esc(e.nombre || e.razon) + '</b> · <span class="chip loc">' + esc(e.comuna || "¿?") + '</span> ' +
      '<span style="color:#475467">' + esc(e.region) + '</span> · RETC ' + esc(e.codigo) + '</div>' +
    '<div class="chips">' + trat.map(t => tratChip(t)).join('') + '</div>' +
  '</div>';
}

function renderSinader() {
  const list = document.getElementById("sinList"), cnt = document.getElementById("sinCount");
  if (!list) return;
  if (!SINADER.length) { cnt.textContent = ""; list.innerHTML = '<div class="empty">SINADER ' + esc(SINADER_STATUS) + '.</div>'; return; }
  sinaderOpciones();
  const rows = sinaderFiltrados();
  SIN_GRUPOS = sinaderAgrupar(rows);
  renderSinaderResumen();
  cnt.textContent = SIN_GRUPOS.length + " empresa(s) · " + rows.length + " establecimiento(s) de " + SINADER.length + " · fuente: descarga SINADER 8-10-26";
  if (!rows.length) { list.innerHTML = '<div class="empty">Sin resultados para el filtro actual.</div>'; return; }
  list.innerHTML = SIN_GRUPOS.slice(0, SIN_MOSTRAR).map((g, i) => {
    const total = g.estabs[0].e.rk ? (SINADER_POR_RUT[g.estabs[0].e.rk] || []).length : g.estabs.length;
    const n = g.estabs.length;
    return '<div class="card">' +
      '<div class="card-head" style="cursor:default">' +
        '<div><p class="name">' + esc(g.razon) + '</p>' +
          '<div class="badges">' + (g.en ? '<span class="badge b-sinader">En ecosistema</span> ' : '') +
            '<span class="badge b-sit">RUT ' + esc(g.rut || "sin RUT") + '</span> ' +
            '<span class="badge b-sit">' + n + (n < total ? ' de ' + total : '') + ' establecimiento' + (total > 1 ? 's' : '') + '</span></div></div>' +
        '<button class="cbtn sec mini" onclick="copiarSinader(' + i + ', this)">Copiar datos</button>' +
      '</div>' +
      g.estabs.map(estabHtml).join('') +
    '</div>';
  }).join('') +
    (SIN_GRUPOS.length > SIN_MOSTRAR ? '<div style="text-align:center"><button class="cbtn sec" onclick="SIN_MOSTRAR+=' + SIN_PAGINA + ';renderSinader()">Mostrar más (' + (SIN_GRUPOS.length - SIN_MOSTRAR) + ' empresas restantes)</button></div>' : '');
}

/** Resumen en ecosistema / fuera según los filtros actuales (salvo "En ecosistema"). Clic = filtrar ese lado. */
function renderSinaderResumen() {
  const el = document.getElementById("sinResumen"); if (!el) return;
  const rows = sinaderFiltrados(true);
  const grupos = sinaderAgrupar(rows);
  const lado = en => ({ emp: grupos.filter(g => g.en === en).length, est: rows.filter(r => r.en === en).length });
  const si = lado(true), no = lado(false), tot = si.emp + no.emp;
  const pct = n => tot ? Math.round(n * 100 / tot) + "%" : "–";
  const eco = sinVal("sfEco");
  const tile = (v, cls, titulo, d) =>
    '<button class="sin-tile ' + cls + (eco === v ? ' on' : '') + '" onclick="filtrarEcoSinader(\'' + v + '\')" title="' + (eco === v ? 'Quitar filtro' : 'Ver solo estos') + '">' +
      '<div class="sin-tile-lbl">' + titulo + '</div>' +
      '<div class="sin-tile-num">' + d.emp.toLocaleString("es-CL") + ' <span>gestores · ' + pct(d.emp) + '</span></div>' +
      '<div class="sin-tile-sub">' + d.est.toLocaleString("es-CL") + ' establecimiento' + (d.est === 1 ? '' : 's') + '</div>' +
    '</button>';
  const filtros = [sinVal("sfComuna") || sinVal("sfRegion")].filter(Boolean);
  el.innerHTML = tile("si", "in", "En nuestro ecosistema", si) + tile("no", "out", "Fuera del ecosistema", no) +
    '<div class="sin-tile-nota">' + tot.toLocaleString("es-CL") + ' gestores' + (filtros.length ? ' en ' + esc(filtros[0]) : ' en todo Chile') +
    ' · cruce por RUT: un proveedor sin RUT en ClickUp cuenta como "fuera"</div>';
}
function filtrarEcoSinader(v) {
  const sel = document.getElementById("sfEco");
  sel.value = sel.value === v ? "" : v;
  sel.dispatchEvent(new Event("change"));
}

/** Copia los datos de la empresa y sus establecimientos (los que cumplen el filtro) para ClickUp o la skill de bienvenida. */
function copiarSinader(i, btn) {
  const g = SIN_GRUPOS[i]; if (!g) return;
  const lineas = ["Razón social: " + g.razon, "RUT: " + (g.rut || "sin RUT"), "Establecimientos SINADER (" + g.estabs.length + "):"];
  g.estabs.forEach(({ e }) => {
    const activos = e.trat.filter(t => t.activo).map(tratTexto);
    lineas.push("- " + (e.nombre || e.razon) + " · " + [e.comuna, e.region].filter(Boolean).join(", ") + " · RETC " + e.codigo);
    lineas.push("  Tratamientos autorizados: " + (activos.length ? activos.join("; ") : "sin tratamientos activos"));
  });
  const texto = lineas.join("\n");
  const ok = () => { const t = btn.textContent; btn.textContent = "Copiado ✓"; setTimeout(() => { btn.textContent = t; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(ok, () => window.prompt("Copia los datos:", texto));
  else window.prompt("Copia los datos:", texto);
}

function sinaderInit() {
  ["sfRegion", "sfComuna", "sfN1", "sfN2", "sfN3", "sfEco", "sfActivos"].forEach(id =>
    document.getElementById(id).addEventListener("change", () => { SIN_MOSTRAR = SIN_PAGINA; renderSinader(); }));
  document.getElementById("sfTexto").addEventListener("input", () => { SIN_MOSTRAR = SIN_PAGINA; renderSinader(); });
}
