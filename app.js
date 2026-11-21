// Bandera de Seguridad · Regla 5.13
// Registra colocación y retiro de la bandera con foto tomada en el momento (marca de agua incrustada)
// y cuenta el tiempo que la bandera permanece colocada. Cada registro se guarda primero en este
// dispositivo (IndexedDB) y luego se envía a Shop Car a nombre del usuario que inició sesión; si no
// hay señal queda pendiente y se reintenta solo.
// Solo puede haber una bandera abierta por localidad y vía: para colocar otra, la abierta se retira
// o se cierra indicando el motivo por el que no se retiró (Shop Car lo hace cumplir también).

const $ = s => document.querySelector(s);
const FOLIO_KEY = 'bandera513-folio';
const LOCALIDAD_KEY = 'bandera513-localidad'; // última localidad usada, para no reescribirla
const CATALOGO_KEY = 'bandera513-localidades'; // catálogo de Localidades de Shop Car, para usarlo sin señal
const MAX_LADO = 1600;              // px del lado mayor de la foto guardada
const ANTIGUEDAD_MAX_MS = 10 * 60e3; // una foto más vieja que esto no se considera tomada en el momento

// ---------- Base de datos ----------
let db;
function abrirDB() {
  return new Promise((ok, mal) => {
    const r = indexedDB.open('bandera513', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('registros', { keyPath: 'id' });
    r.onsuccess = () => ok(db = r.result);
    r.onerror = () => mal(r.error);
  });
}
function tx(modo, fn) {
  return new Promise((ok, mal) => {
    const t = db.transaction('registros', modo), st = t.objectStore('registros');
    const r = fn(st);
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => mal(t.error);
  });
}
const todos = () => tx('readonly', st => st.getAll());
const guardar = reg => tx('readwrite', st => st.put(reg));
const borrar = id => tx('readwrite', st => st.delete(id));

// ---------- Utilidades ----------
const dos = n => String(n).padStart(2, '0');
function fechaHora(ms) {
  const d = new Date(ms);
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}
function duracion(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? `${d} d ` : '') + `${dos(h)}:${dos(m)}:${dos(s % 60)}`;
}
// Los registros anteriores guardaban vía y equipo juntos en `ubicacion` y no tenían "colocó".
const viaDe = r => r.via ?? r.ubicacion ?? '';
const colocoDe = r => r.coloco || r.colocacion.responsable || 'Sin nombre';
// Fotos de la colocación o del retiro (los registros viejos solo tienen una).
const fotosLocal = (r, tipo) => r[tipo]?.fotos ?? (r[tipo]?.foto ? [r[tipo].foto] : []);
const lugar = r => [r.localidad, viaDe(r), r.equipo].filter(Boolean).join(' · ');
const abierta = r => !r.retiro && !r.cierre;
const finDe = r => r.retiro?.ms ?? r.cierre?.ms;
// Igual que fn_bandera_clave de Shop Car: "Vía 3", "via 3" y " VÍA  3 " son la misma vía.
const clave = t => String(t ?? '').trim().replace(/\s+/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function avisar(txt, ms = 3200) {
  const a = $('#aviso'); a.textContent = txt; a.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => a.hidden = true, ms);
}
function siguienteFolio(ms) {
  const d = new Date(ms), dia = `${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}`;
  let n = parseInt(localStorage.getItem(FOLIO_KEY) || '0', 10) + 1;
  localStorage.setItem(FOLIO_KEY, String(n));
  return `B513-${dia}-${String(n).padStart(4, '0')}`;
}
function obtenerGPS() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise(ok => navigator.geolocation.getCurrentPosition(
    p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, prec: Math.round(p.coords.accuracy) }),
    () => ok(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }));
}

// ---------- Shop Car: sesión y envío ----------
const SESION_KEY = 'bandera513-sesion';
const BUCKET = 'banderas-fotos';
let sesion = (() => { try { return JSON.parse(localStorage.getItem(SESION_KEY)); } catch { return null; } })();

function guardarSesion(j, usuario) {
  sesion = {
    token: j.access_token, refresh: j.refresh_token, expira: Date.now() + j.expires_in * 1000,
    usuarioId: j.user.id, usuario: usuario ?? sesion?.usuario, nombre: sesion?.nombre,
  };
  localStorage.setItem(SESION_KEY, JSON.stringify(sesion));
}
async function pedirToken(tipo, cuerpo) {
  const r = await fetch(`${SHOPCAR.url}/auth/v1/token?grant_type=${tipo}`, {
    method: 'POST', headers: { apikey: SHOPCAR.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || 'No se pudo iniciar sesión'), { status: r.status });
  return j;
}
// Mismo criterio que el login de Shop Car: sin "@" se arma el correo interno <usuario>@shopcar.local.
async function iniciarSesion(usuario, password) {
  const email = usuario.includes('@') ? usuario.trim() : `${usuario.trim().toLowerCase()}@shopcar.local`;
  guardarSesion(await pedirToken('password', { email, password }), usuario.trim());
  await completarSesion();
}
// Nombre de Shop Car y registros sin dueño; común a iniciar sesión y al traspaso de sesión.
async function completarSesion() {
  const r = await api(`/rest/v1/usuario_perfil?select=nombre_completo&usuario_id=eq.${sesion.usuarioId}`);
  const perfil = r.ok ? (await r.json())[0] : null;
  sesion.nombre = perfil?.nombre_completo || sesion.usuario;
  localStorage.setItem(SESION_KEY, JSON.stringify(sesion));
  // Los reportes hechos antes de existir el inicio de sesión no tienen dueño: se envían
  // a nombre del primer usuario que entre en este teléfono.
  for (const r of await todos()) {
    if (r.usuarioId) continue;
    Object.assign(r, { remotoId: crypto.randomUUID(), usuarioId: sesion.usuarioId, enviado: { colocacion: false, retiro: false } });
    await guardar(r);
  }
}
// Las localidades salen del catálogo de Shop Car. Se guarda una copia para poder elegir sin señal.
async function cargarLocalidades() {
  if (sesion && navigator.onLine) {
    try {
      const r = await api('/rest/v1/localidades?select=id,nombre&order=nombre');
      if (r.ok) localStorage.setItem(CATALOGO_KEY, JSON.stringify(await r.json()));
    } catch { /* sin señal: se usa la copia guardada */ }
  }
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(CATALOGO_KEY)) || []; } catch { /* sin copia */ }
  const sel = $('#cLocalidad'), actual = sel.value;
  sel.innerHTML = '<option value="">Elige la localidad…</option>' +
    lista.map(l => `<option value="${esc(l.nombre)}" data-id="${l.id}">${esc(l.nombre)}</option>`).join('');
  sel.value = actual;
}
const localidadIdElegida = () => Number($('#cLocalidad').selectedOptions[0]?.dataset.id) || null;

function cerrarSesion() {
  sesion = null;
  localStorage.removeItem(SESION_KEY);
  mostrarLogin();
}
async function token() {
  if (!sesion) throw new Error('Sin sesión');
  if (sesion.expira - 60e3 > Date.now()) return sesion.token;
  try {
    guardarSesion(await pedirToken('refresh_token', { refresh_token: sesion.refresh }));
  } catch (err) {
    // Un refresh rechazado (no un fallo de red) significa que la sesión ya no vale.
    if (err.status >= 400 && err.status < 500) { cerrarSesion(); avisar('Tu sesión expiró. Vuelve a entrar.', 5000); }
    throw err;
  }
  return sesion.token;
}
async function api(ruta, opciones = {}) {
  const t = await token();
  return fetch(SHOPCAR.url + ruta, { ...opciones, headers: { apikey: SHOPCAR.anonKey, Authorization: `Bearer ${t}`, ...opciones.headers } });
}
async function rpc(nombre, args) {
  const r = await api(`/rest/v1/rpc/${nombre}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.message || `Error ${r.status}`), { code: j?.code, status: r.status });
  return j;
}
async function subirFoto(ruta, blob) {
  const r = await api(`/storage/v1/object/${BUCKET}/${ruta}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (r.ok) return;
  const j = await r.json().catch(() => ({}));
  // Ya estaba subida (un envío anterior que se cortó a la mitad).
  if (r.status === 409 || String(j.statusCode) === '409' || /duplicate|already exists/i.test(j.message || j.error || '')) return;
  throw new Error(j.message || j.error || `Error ${r.status} al subir la foto`);
}
const gpsCampos = (pre, g) => ({ [`${pre}_lat`]: g?.lat ?? null, [`${pre}_lon`]: g?.lon ?? null, [`${pre}_precision_m`]: g?.prec ?? null });
// Pendiente de enviar, sea de quien sea: en el cambio de turno, quien retira puede no ser quien colocó.
const pendiente = r => r.usuarioId && (!r.enviado?.colocacion || (r.retiro && !r.enviado?.retiro) || (r.cierre && !r.enviado?.cierre));

async function enviarRegistro(r) {
  if (!r.enviado.colocacion) {
    // Las fotos van en la carpeta de quien las envía (así lo pide Shop Car). Las de un reporte de
    // varias vías se suben una vez (mismo nombre) y todas sus banderas las comparten.
    const fotos = fotosLocal(r, 'colocacion');
    const rutas = r.reporteId
      ? fotos.map((_, i) => `${sesion.usuarioId}/${r.reporteId}_colocacion_${i + 1}.jpg`)
      : [`${sesion.usuarioId}/${r.remotoId}_colocacion.jpg`];
    for (const [i, ruta] of rutas.entries()) await subirFoto(ruta, fotos[i]);
    const ruta = rutas[0];
    const viejo = !('via' in r);
    const fila = {
      id: r.remotoId, folio: r.folio, responsable: colocoDe(r), ficha: r.colocacion.ficha || null,
      empresa: r.empresa || null, localidad: r.localidad || r.ubicacion, localidad_id: r.localidadId ?? null,
      via: viejo ? null : r.via, equipo: viejo ? null : (r.equipo || null),
      via_equipo: viejo ? ((r.localidad && r.ubicacion) || null) : null,
      observaciones: r.obs || null, colocada_at: new Date(r.colocacion.ms).toISOString(),
      ...gpsCampos('colocada', r.colocacion.gps), foto_colocacion: ruta,
      ...(r.reporteId ? { reporte_id: r.reporteId, fotos_colocacion: rutas } : {}),
    };
    const insertar = cuerpo => api('/rest/v1/banderas_azules', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(cuerpo),
    });
    let res = await insertar(fila);
    if (!res.ok && res.status === 400 && /fotos_colocacion|reporte_id/.test(await res.clone().text())) {
      // Shop Car todavía sin varias fotos (migración 244): va solo la primera.
      const { reporte_id, fotos_colocacion, ...sinFotos } = fila;
      res = await insertar(sinFotos);
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (/banderas_una_abierta_por_via/.test(j.message || '')) {
        // En Shop Car ya hay otra abierta en esa vía (de otro teléfono): hay que indicar el motivo.
        r.conflicto = true;
        await guardar(r);
        throw new Error('Ya hay una bandera abierta en esa vía en Shop Car');
      }
      // Otro 409 = ya existía (se había enviado y no llegó la respuesta).
      if (res.status !== 409) throw new Error(j.message || `Error ${res.status}`);
    }
    r.enviado.colocacion = true;
    r.conflicto = false;
    await guardar(r);
  }
  if (r.retiro && !r.enviado.retiro) {
    const fotos = fotosLocal(r, 'retiro');
    const prefijo = r.retiro.grupoId ?? r.remotoId; // un retiro de varias banderas sube las fotos una vez
    const rutas = r.retiro.fotos
      ? fotos.map((_, i) => `${sesion.usuarioId}/${prefijo}_retiro_${i + 1}.jpg`)
      : [`${sesion.usuarioId}/${r.remotoId}_retiro.jpg`];
    for (const [i, ruta] of rutas.entries()) await subirFoto(ruta, fotos[i]);
    try {
      await enviarRetiro(r, rutas);
    } catch (err) {
      // Ya estaba retirada o cerrada sin retiro (otro intento sí llegó, o la cerró alguien más).
      if (!/ya se registró como retirada|ya se cerró sin retiro/.test(err.message)) throw err;
    }
    r.enviado.retiro = true;
    await guardar(r);
  }
  if (r.cierre && !r.enviado.cierre) {
    try {
      await rpc('cerrar_bandera_sin_retiro', { p_id: r.remotoId, p_motivo: r.cierre.motivo });
    } catch (err) {
      if (!/ya no está abierta/.test(err.message)) throw err;
    }
    r.enviado.cierre = true;
    await guardar(r);
  }
}

// El retiro se registra con retirar_bandera (cualquier usuario con rol puede retirar). Si Shop Car
// aún no tiene esa función, se usa la actualización directa, pero confirmando que sí cambió la
// bandera: antes, si la base no la encontraba o no dejaba, la app lo daba por enviado.
async function enviarRetiro(r, rutas) {
  const g = r.retiro.gps, ruta = rutas[0];
  const args = {
    p_id: r.remotoId, p_retirada_at: new Date(r.retiro.ms).toISOString(), p_responsable: r.retiro.responsable || 'Sin nombre',
    p_foto: ruta, p_lat: g?.lat ?? null, p_lon: g?.lon ?? null, p_precision_m: g?.prec ?? null,
  };
  const noExiste = err => err.status === 404 && err.code === 'PGRST202'; // la función (o esa versión) aún no existe
  try {
    await rpc('retirar_bandera', { ...args, p_fotos: rutas });
    return;
  } catch (err) {
    if (!noExiste(err)) throw err;
  }
  try {
    await rpc('retirar_bandera', args); // Shop Car sin varias fotos (migración 244): va solo la primera
    return;
  } catch (err) {
    if (!noExiste(err)) throw err;
  }
  const res = await api(`/rest/v1/banderas_azules?id=eq.${r.remotoId}&select=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      retirada_at: new Date(r.retiro.ms).toISOString(), retirada_responsable: r.retiro.responsable || 'Sin nombre',
      ...gpsCampos('retirada', g), foto_retiro: ruta,
    }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.message || `Error ${res.status}`);
  if (!Array.isArray(j) || !j.length) {
    throw new Error('Shop Car no registró el retiro: la colocó otro usuario. Pide a tu supervisor que la retire.');
  }
}

// ---------- Banderas abiertas en Shop Car ----------
// La app solo guarda las banderas que se colocaron desde este teléfono. Si se colocaron desde otro
// teléfono, desde la dirección vieja de la app o antes de reinstalarla, no aparecían y no había
// forma de retirarlas. Ahora se descargan las abiertas de Shop Car y se pueden retirar con foto.
const ABIERTAS_KEY = 'bandera513-abiertas';
let remotas = (() => { try { return JSON.parse(localStorage.getItem(ABIERTAS_KEY)) || []; } catch { return []; } })();

async function cargarAbiertas() {
  if (!sesion || !navigator.onLine) return;
  let lista, completa = true;
  try {
    lista = await rpc('banderas_abiertas', {});
  } catch (err) {
    if (!(err.status === 404 && err.code === 'PGRST202')) return; // sin señal u otro error: se queda la copia
    // Shop Car aún sin banderas_abiertas: con las reglas de la tabla, cada quien ve las suyas
    // (un supervisor, todas). Sirve para las propias colocadas desde otro teléfono.
    const r = await api('/rest/v1/banderas_azules?select=id,folio,localidad,localidad_id,via,equipo,via_equipo,responsable,observaciones,colocada_at&retirada_at=is.null&cerrada_at=is.null&order=colocada_at');
    if (!r.ok) return;
    lista = await r.json();
    completa = false;
  }
  remotas = lista;
  localStorage.setItem(ABIERTAS_KEY, JSON.stringify(lista));
  if (!completa) return;
  // Las que en este teléfono siguen colocadas pero en Shop Car ya no (las retiró o cerró alguien
  // más): se dan por cerradas aquí, para que no estorben ni bloqueen la vía.
  const abiertasEnShopCar = new Set(lista.map(b => b.id));
  for (const r of await todos()) {
    if (!abierta(r) || pendiente(r) || !r.enviado?.colocacion || abiertasEnShopCar.has(r.remotoId)) continue;
    r.cierre = { ms: Date.now(), motivo: 'Ya estaba retirada o cerrada en Shop Car', responsable: '' };
    r.enviado = { ...r.enviado, cierre: true };
    r.cerradaFuera = true;
    await guardar(r);
  }
}
// Una bandera de Shop Car que se va a retirar desde este teléfono: se guarda como registro local
// (sin foto de colocación) para que el retiro use la misma cola de envío.
function registroDeRemota(b) {
  return {
    id: `R-${b.id}`, folio: b.folio, localidad: b.localidad, localidadId: b.localidad_id,
    via: b.via ?? b.via_equipo ?? '', equipo: b.equipo || '', coloco: b.responsable, obs: b.observaciones || '',
    colocacion: { ms: new Date(b.colocada_at).getTime(), foto: null, fotos: [], gps: null, responsable: null },
    retiro: null, cierre: null, remota: true,
    remotoId: b.id, usuarioId: sesion.usuarioId, enviado: { colocacion: true, retiro: false, cierre: false },
  };
}

const esFallaDeRed = err => /Failed to fetch|NetworkError|Load failed/i.test(err.message);
let enviando = false;
let ultimoError = null;
async function sincronizar(manual = false) {
  if (enviando || !sesion || !SHOPCAR.url) return;
  enviando = true;
  revisarMudanza(); // muestra "Enviando…" y no deja ver la pantalla de mudanza hasta que termine
  let error = null;
  try {
    // De la más vieja a la más nueva: el cierre de la anterior tiene que llegar antes que la nueva de esa vía.
    const lista = (await todos()).sort((a, b) => a.colocacion.ms - b.colocacion.ms);
    for (const r of lista) {
      if (!pendiente(r)) continue;
      try {
        await enviarRegistro(r);
        if (r.errorEnvio) { delete r.errorEnvio; await guardar(r); }
      } catch (err) {
        error = err;
        if (!sesion) break;
        if (!esFallaDeRed(err)) { r.errorEnvio = err.message; await guardar(r); }
      }
    }
  } finally {
    enviando = false;
  }
  try { await cargarAbiertas(); } catch { /* se queda la copia anterior */ }
  // Sin señal no es un error: se reintenta solo. Cualquier otra cosa se muestra.
  ultimoError = error && !esFallaDeRed(error) ? error.message : null;
  await pintar();
  if (manual) avisar(error ? `No se pudo enviar todo: ${error.message}` : 'Todo está enviado a Shop Car.', 4000);
}
setInterval(sincronizar, 60e3);
window.addEventListener('online', () => sincronizar());
// En el celular la app se duerme en segundo plano: al volver a abrirla se reintenta enseguida.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });

function mostrarLogin() {
  const sinSesion = !sesion;
  $('#vista-login').hidden = !sinSesion;
  document.querySelector('.pestanas').hidden = sinSesion;
  document.querySelector('main').hidden = sinSesion;
  $('#btnSalir').hidden = sinSesion;
  if (sinSesion) {
    $('#estadoEnvio').hidden = true;
    $('#loginError').hidden = true;
    if (!SHOPCAR.url) { $('#loginError').textContent = 'La conexión con Shop Car aún no está configurada.'; $('#loginError').hidden = false; }
  }
}
$('#formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  $('#btnEntrar').disabled = true; $('#loginError').hidden = true;
  try {
    await iniciarSesion($('#lUsuario').value, $('#lPassword').value);
    $('#lPassword').value = '';
    mostrarLogin();
    await cargarLocalidades();
    document.querySelector('[data-vista="activas"]').click();
    avisar(`Bienvenido, ${sesion.nombre}.`);
    await pintar(); sincronizar();
  } catch (err) {
    $('#loginError').textContent = /invalid/i.test(err.message) ? 'Usuario o contraseña incorrectos.' : err.message;
    $('#loginError').hidden = false;
  } finally { $('#btnEntrar').disabled = false; }
});
$('#btnSalir').addEventListener('click', async () => {
  const n = (await todos()).filter(pendiente).length;
  const msj = n
    ? `Tienes ${n} registro(s) sin enviar a Shop Car. Se enviarán cuando alguien vuelva a entrar en este teléfono. ¿Cerrar sesión?`
    : `¿Cerrar la sesión de ${sesion.nombre}?`;
  if (confirm(msj)) cerrarSesion();
});
$('#estadoEnvio').addEventListener('click', () => sincronizar(true));

// ---------- Marca de agua ----------
// "Vía: 3 · GMX 1" o, con varias, "Vías: 3 (GMX 1), 4, 5" partido en renglones si es largo.
function textoVias(vias) {
  const partes = vias.filter(v => v.via).map(v => v.equipo ? `${v.via} (${v.equipo})` : v.via);
  if (!partes.length) return [];
  if (partes.length === 1) return [`Vía: ${partes[0]}`];
  const renglones = [];
  let actual = 'Vías: ';
  for (const p of partes) {
    const pedazo = actual === 'Vías: ' || actual === '      ' ? p : `, ${p}`;
    if ((actual + pedazo).length > 46 && actual.trim() !== 'Vías:') { renglones.push(actual + ','); actual = '      ' + p; }
    else actual += pedazo;
  }
  renglones.push(actual);
  return renglones;
}
// "B513-20261121-0005" o "B513-20261121-0005 a 0007".
const textoFolios = f => f.length > 1 ? `${f[0]} a ${f[f.length - 1].split('-').pop()}` : f[0];
async function fotoConMarca(archivo, info) {
  const bmp = await createImageBitmap(archivo); // Chrome respeta la orientación EXIF
  const k = Math.min(1, MAX_LADO / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.drawImage(bmp, 0, 0, W, H);
  bmp.close && bmp.close();

  const base = Math.max(14, Math.round(Math.min(W, H) / 30));

  // Texto tenue repetido en diagonal (dificulta recortar o reutilizar la foto)
  c.save();
  c.translate(W / 2, H / 2); c.rotate(-Math.PI / 6);
  c.font = `700 ${base * 1.6}px system-ui, sans-serif`;
  c.fillStyle = 'rgba(255,255,255,0.13)';
  c.textAlign = 'center';
  const texto = `REGLA 5.13 · ${info.folios[0]}`;
  const paso = base * 6, ancho = c.measureText(texto).width + base * 4, diag = Math.hypot(W, H);
  for (let fila = 0, y = -diag / 2; y < diag / 2; fila++, y += paso)
    for (let x = -diag / 2; x < diag / 2 + ancho; x += ancho)
      c.fillText(texto, x + (fila % 2 ? ancho / 2 : 0), y);
  c.restore();

  // Franja inferior con los datos
  const lineas = [
    [`${info.tipo === 'colocacion' ? 'COLOCACIÓN' : 'RETIRO'} DE BANDERA · REGLA 5.13`, true],
    [`Fecha y hora: ${fechaHora(info.ms)}`],
    [`Localidad: ${info.localidad}`],
    ...textoVias(info.vias).map(t => [t]),
    [`Colocó: ${info.coloco}`],
  ];
  if (info.tipo === 'retiro') {
    lineas.push([`Retiró: ${info.reporta}`]);
    lineas.push([`Tiempo colocada: ${duracion(info.tiempo)}  (desde ${fechaHora(info.desde)})`, true]);
  } else if (info.reporta !== info.coloco) {
    lineas.push([`Reportó: ${info.reporta}`]);
  }
  lineas.push([info.gps ? `GPS: ${info.gps.lat.toFixed(6)}, ${info.gps.lon.toFixed(6)} ±${info.gps.prec} m` : 'GPS: no disponible']);
  lineas.push([`${info.folios.length > 1 ? 'Folios' : 'Folio'}: ${textoFolios(info.folios)} · Foto ${info.numero}`]);

  const alto = base * 1.45, pad = base * 0.8;
  const franja = lineas.length * alto + pad * 1.6;
  c.fillStyle = 'rgba(8, 18, 40, 0.72)';
  c.fillRect(0, H - franja, W, franja);
  c.fillStyle = info.tipo === 'colocacion' ? '#2f7cf6' : '#e53935';
  c.fillRect(0, H - franja, base * 0.45, franja);
  c.textBaseline = 'top'; c.textAlign = 'left';
  lineas.forEach(([t, negrita], i) => {
    c.font = `${negrita ? 700 : 500} ${negrita ? base * 1.08 : base}px system-ui, sans-serif`;
    c.fillStyle = negrita ? (info.tipo === 'colocacion' ? '#8fb8ff' : '#ff9a97') : '#ffffff';
    c.fillText(t, pad + base * 0.45, H - franja + pad + i * alto, W - pad * 2 - base * 0.45);
  });

  return new Promise(ok => cv.toBlob(ok, 'image/jpeg', 0.86));
}

// ---------- Una bandera abierta por vía ----------
// Revisa, para cada vía del reporte, las banderas abiertas de este teléfono y, si hay señal, las de
// Shop Car (de cualquier persona). Basta una ocupada para no dejar colocar.
let revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };

// Vías del formulario: [{ via, equipo }], sin las filas vacías.
function viasCapturadas() {
  return [...document.querySelectorAll('#cVias .fila-via')]
    .map(f => ({ via: f.querySelector('.c-via').value.trim(), equipo: f.querySelector('.c-equipo').value.trim() }))
    .filter(v => v.via);
}
const claveRevision = () => `${clave($('#cLocalidad').value)}|${viasCapturadas().map(v => clave(v.via)).join('|')}`;

async function revisarVia() {
  const loc = $('#cLocalidad').value.trim(), vias = viasCapturadas();
  const k = claveRevision();
  if (!loc || !vias.length) { revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] }; pintarBloqueo(); return revisionVia; }
  revisionVia = { clave: k, estado: 'verificando', locales: [], remotas: [] };
  const registrosLocales = await todos();
  const claves = new Set(vias.map(v => clave(v.via)));
  const locales = registrosLocales.filter(r => abierta(r) && clave(r.localidad) === clave(loc) && claves.has(clave(viaDe(r))));
  let remotas = [];
  if (navigator.onLine && sesion) {
    // Las de este teléfono se juzgan por lo que hay aquí (un cierre puede no haber llegado aún).
    const propias = new Set(registrosLocales.map(r => r.remotoId));
    for (const v of vias) {
      try {
        const lista = await rpc('banderas_abiertas_en_via', { p_localidad: loc, p_via: v.via });
        remotas.push(...lista.filter(b => !propias.has(b.id)).map(b => ({ ...b, via: v.via })));
      } catch { /* sin señal: solo cuenta lo de este teléfono; Shop Car lo vuelve a revisar al enviar */ }
    }
  }
  if (revisionVia.clave !== k) return revisionVia; // cambiaron los campos mientras se revisaba
  revisionVia = { clave: k, estado: locales.length || remotas.length ? 'bloqueada' : 'libre', locales, remotas };
  pintarBloqueo();
  return revisionVia;
}
function pintarBloqueo() {
  const b = revisionVia, bloqueada = b.estado === 'bloqueada';
  $('#capBloqueo').hidden = !bloqueada;
  if (!bloqueada) return;
  const lista = [
    ...b.locales.map(r => `Vía ${viaDe(r)}: ${r.folio}, colocada ${fechaHora(r.colocacion.ms)} por ${colocoDe(r)}`),
    ...b.remotas.map(r => `Vía ${r.via}: ${r.folio}, colocada ${fechaHora(new Date(r.colocada_at).getTime())} por ${r.responsable}`),
  ];
  const varias = lista.length > 1;
  $('#bloqueoTexto').innerHTML = `⚠ <b>Ya hay ${varias ? 'banderas abiertas' : 'una bandera abierta'} en ${varias ? 'estas vías' : 'esta vía'}.</b>
    No se puede colocar otra hasta que se retire o se indique por qué no se retiró:<br>${lista.map(esc).join('<br>')}`;
  $('#bloqueoRetirar').innerHTML = b.locales.map(r =>
    `<button type="button" class="btn-retirar" data-retirar="${esc(r.id)}">Retirar ${esc(r.folio)}</button>`).join('');
}
let revisionTimer;
function programarRevision() {
  revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };
  clearTimeout(revisionTimer); revisionTimer = setTimeout(revisarVia, 500);
}
$('#cLocalidad').addEventListener('input', programarRevision);
$('#cVias').addEventListener('input', e => { if (e.target.classList.contains('c-via')) programarRevision(); });

// Filas de vías: una al abrir; "+ Agregar otra vía" agrega más (hasta 10).
const MAX_VIAS = 10;
function agregarFilaVia(via = '', equipo = '') {
  const filas = $('#cVias');
  if (filas.children.length >= MAX_VIAS) { avisar(`Máximo ${MAX_VIAS} vías por reporte.`); return; }
  const f = document.createElement('div');
  f.className = 'fila-via';
  f.innerHTML = `<input class="c-via" placeholder="Vía. Ej. Vía 3" list="viasUsadas" autocomplete="off" value="${esc(via)}">
    <input class="c-equipo" placeholder="Equipo (opcional)" autocomplete="off" value="${esc(equipo)}">
    <button type="button" class="quitar-via" title="Quitar esta vía" aria-label="Quitar esta vía">✕</button>`;
  filas.appendChild(f);
  pintarFilasVia();
}
function pintarFilasVia() {
  const filas = [...document.querySelectorAll('#cVias .fila-via')];
  const bloqueadas = !!captura?.fotos?.length; // con fotos tomadas las vías ya no cambian (van en la marca de agua)
  filas.forEach(f => {
    f.querySelectorAll('input').forEach(i => { i.disabled = bloqueadas; });
    f.querySelector('.quitar-via').hidden = bloqueadas || filas.length === 1;
  });
  $('#btnAgregarVia').hidden = bloqueadas || filas.length >= MAX_VIAS;
  $('#notaVias').hidden = !bloqueadas;
}
$('#cVias').addEventListener('click', e => {
  if (!e.target.classList.contains('quitar-via')) return;
  e.target.closest('.fila-via').remove();
  pintarFilasVia();
  programarRevision();
});
$('#btnAgregarVia').addEventListener('click', () => { agregarFilaVia(); $('#cVias .fila-via:last-child .c-via').focus(); });

$('#btnCerrarSinRetiro').addEventListener('click', async () => {
  const motivo = $('#bMotivo').value.trim();
  if (!motivo) { avisar('Escribe el motivo por el que no se retiró la bandera.'); $('#bMotivo').focus(); return; }
  if (revisionVia.remotas.length && !navigator.onLine) { avisar('Se necesita señal para cerrar una bandera de otro teléfono.', 4500); return; }
  const btn = $('#btnCerrarSinRetiro'); btn.disabled = true;
  try {
    for (const b of revisionVia.remotas) {
      try { await rpc('cerrar_bandera_sin_retiro', { p_id: b.id, p_motivo: motivo }); }
      catch (err) { if (!/ya no está abierta/.test(err.message)) throw err; }
    }
    for (const r of revisionVia.locales) {
      r.cierre = { ms: Date.now(), motivo, responsable: sesion.nombre };
      r.enviado = { ...r.enviado, cierre: false };
      await guardar(r);
    }
    $('#bMotivo').value = '';
    await revisarVia();
    await pintar();
    sincronizar();
    avisar('Bandera(s) anterior(es) cerrada(s) sin retiro. Ya puedes tomar las fotos.', 4500);
  } catch (err) {
    avisar('No se pudo cerrar: ' + err.message, 5000);
  } finally { btn.disabled = false; }
});

// ---------- Captura (colocar / retirar) ----------
// Una colocación puede llevar varias vías (una bandera por vía, con las mismas fotos) y de 1 a 6
// fotos. Un retiro puede ser de una bandera o de todas las de un reporte, también con varias fotos.
const MAX_FOTOS = 6;
let captura = null; // { tipo, registros (retiro), fotos: [{ blob, ms, gps }], folios }

function abrirCaptura(tipo, registros) {
  if ($('#dlgCaptura').open) $('#dlgCaptura').close();
  registros = [].concat(registros || []);
  captura = { tipo, registros, fotos: [], folios: null };
  $('#formCaptura').reset();
  $('#btnGuardar').disabled = true;
  $('#capEstado').textContent = '';
  $('#capBloqueo').hidden = true;
  revisionVia = { clave: '', estado: 'pendiente', locales: [], remotas: [] };
  if (tipo === 'colocacion') {
    $('#capTitulo').textContent = 'Colocar bandera';
    $('#capDatos').hidden = false; $('#capResumen').hidden = true;
    ['#cLocalidad', '#cColoco'].forEach(s => $(s).required = true);
    $('#cLocalidad').value = localStorage.getItem(LOCALIDAD_KEY) || ''; // si ya no está en el catálogo, queda sin elegir
    $('#cColoco').value = sesion?.nombre || '';
    $('#cVias').innerHTML = '';
    agregarFilaVia();
  } else {
    $('#capTitulo').textContent = registros.length > 1 ? `Retirar ${registros.length} banderas` : 'Retirar bandera';
    $('#capDatos').hidden = true; $('#capResumen').hidden = false;
    ['#cLocalidad', '#cColoco'].forEach(s => $(s).required = false);
    const desde = Math.min(...registros.map(r => r.colocacion.ms));
    $('#capResumen').innerHTML = `<b>${esc(registros[0].localidad || registros[0].ubicacion)}</b><br>
      ${registros.map(r => `${esc([viaDe(r), r.equipo].filter(Boolean).join(' · ') || '—')} · ${esc(r.folio)}`).join('<br>')}<br>
      Colocada: ${fechaHora(desde)} por ${esc(colocoDe(registros[0]))}<br>
      Tiempo colocada: <b id="capTiempo" data-desde="${desde}">${duracion(Date.now() - desde)}</b>`;
  }
  pintarFotosCaptura();
  $('#dlgCaptura').showModal();
}

// Miniaturas de las fotos tomadas en el formulario, cada una con su ✕.
function pintarFotosCaptura() {
  const fotos = captura?.fotos || [];
  [...$('#capFotos').querySelectorAll('img')].forEach(i => URL.revokeObjectURL(i.src));
  $('#capFotos').innerHTML = fotos.map((f, i) => `<figure>
      <img src="${URL.createObjectURL(f.blob)}" alt="Foto ${i + 1}">
      <button type="button" class="quitar-foto" data-quitar-foto="${i}" aria-label="Quitar foto ${i + 1}">✕</button>
    </figure>`).join('');
  const palabra = captura?.tipo === 'retiro' ? 'del retiro' : 'de la bandera colocada';
  $('#lblFoto span').textContent = fotos.length ? `📷 Tomar otra foto (${fotos.length} de ${MAX_FOTOS})` : `📷 Tomar foto ${palabra}`;
  $('#lblFoto').hidden = fotos.length >= MAX_FOTOS;
  $('#btnGuardar').disabled = !fotos.length;
  if (captura?.tipo === 'colocacion') pintarFilasVia();
}
$('#capFotos').addEventListener('click', e => {
  const i = e.target.dataset.quitarFoto;
  if (i == null) return;
  captura.fotos.splice(Number(i), 1);
  if (!captura.fotos.length) captura.folios = null; // sin fotos se pueden volver a cambiar las vías
  pintarFotosCaptura();
});

// Antes de abrir la cámara para una colocación: datos completos y vías libres. La revisión de las
// vías es asíncrona y la cámara solo abre con un toque directo, así que si aún no está lista se
// pide volver a tocar.
$('#lblFoto').addEventListener('click', e => {
  if (captura?.tipo !== 'colocacion' || captura.fotos.length) return; // las vías ya se revisaron con la primera foto
  const vias = viasCapturadas();
  const faltaLoc = !$('#cLocalidad').value.trim(), faltaColoco = !$('#cColoco').value.trim();
  if (faltaLoc || !vias.length || faltaColoco) {
    e.preventDefault();
    avisar(`Primero indica ${faltaLoc ? 'la localidad' : !vias.length ? 'la vía' : 'quién colocó la bandera'}.`);
    (faltaLoc ? $('#cLocalidad') : !vias.length ? $('#cVias .c-via') : $('#cColoco')).focus();
    return;
  }
  const repetida = vias.find((v, i) => vias.findIndex(w => clave(w.via) === clave(v.via)) !== i);
  if (repetida) { e.preventDefault(); avisar(`La vía "${repetida.via}" está repetida.`); return; }
  if (revisionVia.clave !== claveRevision() || revisionVia.estado === 'verificando' || revisionVia.estado === 'pendiente') {
    e.preventDefault();
    $('#capEstado').textContent = 'Revisando si hay banderas abiertas en estas vías…';
    revisarVia().then(r => {
      $('#capEstado').textContent = r.estado === 'libre' ? 'Vías libres. Toca de nuevo "Tomar foto".' : '';
    });
    return;
  }
  if (revisionVia.estado === 'bloqueada') { e.preventDefault(); $('#capBloqueo').scrollIntoView({ behavior: 'smooth' }); }
});

$('#cFoto').addEventListener('change', async e => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo || !captura) return;
  const ms = Date.now();
  if (archivo.lastModified && ms - archivo.lastModified > ANTIGUEDAD_MAX_MS) {
    $('#capEstado').textContent = '⚠ Esa foto no es reciente. Toma la foto en este momento con la cámara.';
    return;
  }
  $('#capEstado').textContent = 'Procesando foto y ubicación…';
  $('#btnGuardar').disabled = true;
  try {
    const gps = await obtenerGPS();
    let info;
    if (captura.tipo === 'colocacion') {
      const vias = viasCapturadas();
      captura.folios ||= vias.map(() => siguienteFolio(ms));
      info = {
        localidad: $('#cLocalidad').value.trim(), vias, coloco: $('#cColoco').value.trim(), folios: captura.folios,
      };
    } else {
      const rs = captura.registros, desde = Math.min(...rs.map(r => r.colocacion.ms));
      info = {
        localidad: rs[0].localidad || rs[0].ubicacion, vias: rs.map(r => ({ via: r.localidad ? viaDe(r) : '', equipo: r.equipo })),
        coloco: colocoDe(rs[0]), folios: rs.map(r => r.folio), tiempo: ms - desde, desde,
      };
    }
    const blob = await fotoConMarca(archivo, {
      ...info, tipo: captura.tipo, ms, gps, reporta: sesion?.nombre || 'Sin nombre',
      numero: captura.fotos.length + 1,
    });
    captura.fotos.push({ blob, ms, gps });
    $('#capEstado').textContent = captura.fotos.length < MAX_FOTOS
      ? 'Puedes tomar otra foto o presionar Guardar.' : 'Ya tienes el máximo de fotos. Presiona Guardar.';
    pintarFotosCaptura();
  } catch (err) {
    console.error(err);
    $('#capEstado').textContent = 'No se pudo procesar la foto: ' + err.message;
    $('#btnGuardar').disabled = !captura.fotos.length;
  }
});

$('#btnGuardar').addEventListener('click', async () => {
  if (!captura?.fotos.length) return;
  const blobs = captura.fotos.map(f => f.blob), primera = captura.fotos[0];
  if (captura.tipo === 'colocacion') {
    // Pudieron colocar otra en alguna de las vías mientras se tomaban las fotos.
    if ((await revisarVia()).estado === 'bloqueada') { $('#capBloqueo').scrollIntoView({ behavior: 'smooth' }); return; }
    const vias = viasCapturadas(), reporteId = crypto.randomUUID();
    for (const [i, v] of vias.entries()) {
      const folio = captura.folios[i];
      await guardar({
        id: folio, folio, localidad: $('#cLocalidad').value.trim(), localidadId: localidadIdElegida(),
        via: v.via, equipo: v.equipo, coloco: $('#cColoco').value.trim(), obs: $('#cObs').value.trim(), reporteId,
        colocacion: { ms: primera.ms, foto: blobs[0], fotos: blobs, gps: primera.gps, responsable: sesion.nombre },
        retiro: null, cierre: null,
        remotoId: crypto.randomUUID(), usuarioId: sesion.usuarioId, enviado: { colocacion: false, retiro: false, cierre: false },
      });
    }
    localStorage.setItem(LOCALIDAD_KEY, $('#cLocalidad').value.trim());
    avisar(vias.length > 1 ? `${vias.length} banderas registradas como colocadas.` : 'Bandera registrada como colocada. El tiempo empieza a contar.');
  } else {
    const grupoId = crypto.randomUUID(); // las fotos del retiro se suben una vez para todas
    for (const r of captura.registros) {
      r.retiro = { ms: primera.ms, foto: blobs[0], fotos: blobs, gps: primera.gps, responsable: sesion.nombre, grupoId };
      r.duracionMs = primera.ms - r.colocacion.ms;
      await guardar(r);
    }
    const n = captura.registros.length;
    avisar(n > 1 ? `${n} banderas retiradas.` : `Bandera retirada. Tiempo colocada: ${duracion(captura.registros[0].duracionMs)}`, 5000);
  }
  captura = null;
  $('#dlgCaptura').close();
  await pintar();
  sincronizar();
});
$('#btnCancelar').addEventListener('click', () => { captura = null; $('#dlgCaptura').close(); });

// ---------- Vistas ----------
let registros = [];
const urls = new Map(); // id+tipo -> objectURL de la foto
function urlFoto(r, tipo, i = 0) {
  const blob = fotosLocal(r, tipo)[i];
  if (!blob) return '';
  const k = `${r.id}|${tipo}|${i}`;
  if (!urls.has(k)) urls.set(k, URL.createObjectURL(blob));
  return urls.get(k);
}
function figurasFotos(r, tipo) {
  const fotos = fotosLocal(r, tipo), nombre = tipo === 'colocacion' ? 'Colocación' : 'Retiro';
  return fotos.map((_, i) => `<figure><img src="${urlFoto(r, tipo, i)}" data-foto="${esc(r.id)}|${tipo}|${i}" alt="Foto de ${nombre.toLowerCase()} ${i + 1}"><figcaption>${nombre}${fotos.length > 1 ? ` ${i + 1}` : ''}</figcaption></figure>`).join('');
}

function etiquetaEnvio(r) {
  if (!r.usuarioId) return '<span class="envio">Solo en este teléfono</span>';
  if (r.conflicto) {
    return `<span class="envio alerta">⚠ En Shop Car ya había otra bandera abierta en esta vía.</span>
      <button class="btn-retirar" data-conflicto="${esc(r.id)}">Indicar motivo y enviar</button>`;
  }
  if (pendiente(r) && r.errorEnvio) return `<span class="envio alerta">⚠ No se pudo enviar a Shop Car: ${esc(r.errorEnvio)}</span>`;
  return pendiente(r) ? '<span class="envio">⏳ Pendiente de enviar a Shop Car</span>' : '<span class="envio ok">✓ Enviado a Shop Car</span>';
}

function tarjetaActiva(r, hermanas = 0) {
  return `<div class="tarjeta bandera" data-id="${esc(r.id)}">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="cronometro" data-desde="${r.colocacion.ms}">${duracion(Date.now() - r.colocacion.ms)}</div>
    <div class="meta">Colocada ${fechaHora(r.colocacion.ms)} · Colocó: ${esc(colocoDe(r))}
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}</div>
    ${fotosLocal(r, 'colocacion').length ? `<div class="fotos">${figurasFotos(r, 'colocacion')}</div>` : ''}
    <button class="btn-retirar" data-retirar="${esc(r.id)}">Retirar ${hermanas ? 'solo esta vía' : 'bandera'}</button>
    ${hermanas ? `<button class="btn-retirar todas" data-retirar-grupo="${esc(r.reporteId)}">Retirar las ${hermanas + 1} vías de este reporte</button>` : ''}
  </div>`;
}
function tarjetaRemota(b, hermanas = 0) {
  const ms = new Date(b.colocada_at).getTime();
  return `<div class="tarjeta bandera remota">
    <div class="cab"><h3>${esc([b.localidad, b.via ?? b.via_equipo, b.equipo].filter(Boolean).join(' · '))}</h3><span class="folio">${esc(b.folio)}</span></div>
    <div class="cronometro" data-desde="${ms}">${duracion(Date.now() - ms)}</div>
    <div class="meta">Colocada ${fechaHora(ms)} · Colocó: ${esc(b.responsable)}
      ${b.observaciones ? `<br>${esc(b.observaciones)}` : ''}<br>
      <span class="envio">📡 Colocada desde otro teléfono o desde la app anterior</span></div>
    <button class="btn-retirar" data-retirar-remota="${esc(b.id)}">Retirar ${hermanas ? 'solo esta vía' : 'bandera'}</button>
    ${hermanas ? `<button class="btn-retirar todas" data-retirar-remota-grupo="${esc(b.reporte_id)}">Retirar las ${hermanas + 1} vías de este reporte</button>` : ''}
  </div>`;
}
function tarjetaHistorial(r) {
  const fin = r.retiro
    ? `Retirada: ${fechaHora(r.retiro.ms)} · ${esc(r.retiro.responsable || '—')}`
    : `<span class="sin-retiro">Cerrada sin retiro</span>: ${fechaHora(r.cierre.ms)} · Motivo: ${esc(r.cierre.motivo)}`;
  return `<div class="tarjeta">
    <div class="cab"><h3>${esc(lugar(r))}</h3><span class="folio">${esc(r.folio)}</span></div>
    <div class="meta">
      Colocada: ${fechaHora(r.colocacion.ms)} · Colocó: ${esc(colocoDe(r))}<br>
      ${fin}<br>
      Tiempo colocada: <span class="duracion">${duracion(finDe(r) - r.colocacion.ms)}</span>
      ${r.obs ? `<br>${esc(r.obs)}` : ''}<br>${etiquetaEnvio(r)}
    </div>
    <div class="fotos">
      ${figurasFotos(r, 'colocacion')}
      ${r.retiro ? figurasFotos(r, 'retiro') : ''}
    </div>
    ${pendiente(r) ? '' : `<button class="borrar" data-borrar="${esc(r.id)}">Quitar de este teléfono</button>`}
  </div>`;
}

function filtrados() {
  const d = $('#fDesde').value, h = $('#fHasta').value;
  const ini = d ? new Date(d + 'T00:00').getTime() : -Infinity, fin = h ? new Date(h + 'T23:59:59.999').getTime() : Infinity;
  return registros.filter(r => !abierta(r) && r.colocacion.ms >= ini && r.colocacion.ms <= fin)
    .sort((a, b) => finDe(b) - finDe(a));
}

async function pintar() {
  registros = await todos();
  const activas = registros.filter(abierta).sort((a, b) => a.colocacion.ms - b.colocacion.ms);
  // Las abiertas en Shop Car que este teléfono no tiene (o que ya retiró y falta enviar).
  const enTelefono = new Set(registros.map(r => r.remotoId));
  const deShopCar = sesion && !MUDANZA ? remotas.filter(b => !enTelefono.has(b.id)) : [];
  $('#numActivas').textContent = activas.length + deShopCar.length;
  $('#listaActivas').innerHTML = activas.length || deShopCar.length
    ? activas.map(r => tarjetaActiva(r, r.reporteId ? activas.filter(x => x.reporteId === r.reporteId).length - 1 : 0)).join('') +
      (deShopCar.length ? `<h2 class="subtitulo">Colocadas desde otro teléfono (${deShopCar.length})</h2>` +
        deShopCar.map(b => tarjetaRemota(b, b.reporte_id ? deShopCar.filter(x => x.reporte_id === b.reporte_id).length - 1 : 0)).join('') : '')
    : '<p class="vacio">No hay banderas colocadas en este momento.</p>';

  const hist = filtrados();
  const tiempos = hist.map(r => finDe(r) - r.colocacion.ms);
  $('#resumen').innerHTML = `<div><b>${hist.length}</b><span>Reportes</span></div>
    <div><b>${hist.length ? duracion(tiempos.reduce((s, t) => s + t, 0) / hist.length) : '—'}</b><span>Promedio</span></div>
    <div><b>${hist.length ? duracion(Math.max(...tiempos)) : '—'}</b><span>Máximo</span></div>`;
  $('#listaHistorial').innerHTML = hist.length ? hist.map(tarjetaHistorial).join('')
    : '<p class="vacio">Aún no hay banderas retiradas en este periodo.</p>';

  const opciones = valores => [...new Set(valores.filter(Boolean))].slice(0, 30).map(u => `<option value="${esc(u)}">`).join('');
  $('#viasUsadas').innerHTML = opciones(registros.map(r => r.via));
  $('#personasUsadas').innerHTML = opciones([sesion?.nombre, ...registros.map(r => r.coloco)]);

  if (sesion) {
    const pendientes = registros.filter(pendiente).length;
    const e = $('#estadoEnvio');
    e.hidden = false;
    e.classList.toggle('ok', !pendientes);
    e.classList.toggle('error', !!(pendientes && ultimoError));
    e.textContent = pendientes && ultimoError
      ? `⚠ ${pendientes} registro(s) sin enviar: ${ultimoError} · toca para reintentar`
      : pendientes
      ? `⏳ ${pendientes} registro(s) pendientes de enviar a Shop Car${navigator.onLine ? '' : ' (sin conexión)'} · toca para enviar`
      : `✓ ${sesion.nombre} · todo enviado a Shop Car`;
  }
  tic();
  revisarMudanza();
}

// Cronómetros en vivo
function tic() {
  const ahora = Date.now();
  document.querySelectorAll('.cronometro[data-desde]').forEach(el => { el.textContent = duracion(ahora - Number(el.dataset.desde)); });
  const ct = $('#capTiempo');
  if (ct) ct.textContent = duracion(ahora - Number(ct.dataset.desde));
}
setInterval(tic, 1000);

// ---------- Eventos de listas ----------
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.retirar) abrirCaptura('retiro', registros.find(r => r.id === t.dataset.retirar));
  else if (t.dataset.retirarGrupo) abrirCaptura('retiro', registros.filter(r => abierta(r) && r.reporteId === t.dataset.retirarGrupo));
  else if (t.dataset.retirarRemota) {
    const b = remotas.find(x => x.id === t.dataset.retirarRemota);
    if (b && sesion) abrirCaptura('retiro', registroDeRemota(b));
  } else if (t.dataset.retirarRemotaGrupo && sesion) {
    const enTelefono = new Set(registros.map(r => r.remotoId));
    abrirCaptura('retiro', remotas.filter(b => b.reporte_id === t.dataset.retirarRemotaGrupo && !enTelefono.has(b.id)).map(registroDeRemota));
  }
  else if (t.dataset.foto) verFoto(...t.dataset.foto.split('|'));
  else if (t.dataset.conflicto) resolverConflicto(registros.find(r => r.id === t.dataset.conflicto));
  else if (t.dataset.borrar) {
    const r = registros.find(x => x.id === t.dataset.borrar);
    const aviso = r.usuarioId ? ' En Shop Car el registro se conserva.' : ' No se puede deshacer.';
    if (confirm(`¿Quitar de este teléfono el registro ${r.folio} (${lugar(r)}) y sus fotos?${aviso}`)) {
      await borrar(r.id);
      for (const [k, u] of urls) if (k.startsWith(`${r.id}|`)) { URL.revokeObjectURL(u); urls.delete(k); }
      pintar();
    }
  }
});
$('#btnColocar').addEventListener('click', () => {
  // En la dirección vieja ya no se colocan banderas nuevas: se colocan en la app nueva.
  // (Las que ya están colocadas en este teléfono se siguen retirando aquí.)
  if (MUDANZA) {
    avisar('Esta app se mudó: coloca las banderas nuevas en la app nueva (botón del aviso de arriba).', 6000);
    return;
  }
  abrirCaptura('colocacion');
});

// ---------- Mudanza ----------
// Bandera 5.13 se muda de christianmunoz1713.github.io a autocom-shopcar.github.io. Lo que un
// teléfono tiene sin enviar vive en el almacenamiento de la dirección vieja y se perdería al
// cambiar de dirección, así que en la dirección vieja esta versión:
//  * envía todo lo pendiente (colocaciones, retiros, cierres) y espera a que termine;
//  * mientras haya pendientes, o banderas colocadas en este teléfono (su retiro con foto solo se
//    puede registrar aquí), sigue funcionando y muestra un aviso que dice qué falta;
//  * cuando ya no queda nada, muestra la pantalla "La app se mudó" con el botón a la dirección
//    nueva, y no deja seguir usando esta.
// En la dirección nueva (u otra) todo esto se apaga y la app funciona normal.
const DIRECCION_VIEJA = 'christianmunoz1713.github.io';
const URL_NUEVA = 'https://autocom-shopcar.github.io/bandera-513/';
const MUDANZA = location.hostname === DIRECCION_VIEJA
  || (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('mudanza'));
$('#linkMudanza').href = URL_NUEVA;

// Al pasar a la app nueva se lleva la sesión para no pedir otra vez usuario y contraseña (el
// personal de campo no siempre la recuerda). Va en el fragmento (#), que no sale del teléfono; la
// app nueva lo cambia por una sesión propia en cuanto abre, y la de aquí se cierra.
function irAppNueva() {
  let url = URL_NUEVA;
  if (sesion?.refresh) {
    url += `#traspaso=${encodeURIComponent(sesion.refresh)}&u=${encodeURIComponent(sesion.usuario || '')}`;
    sesion = null;
    localStorage.removeItem(SESION_KEY);
  }
  location.href = url;
}
$('#linkMudanza').addEventListener('click', e => { e.preventDefault(); irAppNueva(); });
let saltoMudanza = null;

function revisarMudanza() {
  if (!MUDANZA) return;
  // Pendiente = cualquier cosa que no haya llegado a Shop Car, incluidos los registros sin dueño
  // (hechos antes de iniciar sesión), que solo se envían después de entrar con un usuario.
  const porEnviar = registros.filter(r => !r.usuarioId || pendiente(r));
  const colocadas = registros.filter(abierta);
  const listo = !porEnviar.length && !colocadas.length && !enviando;
  $('#pantallaMudanza').hidden = !listo;
  const aviso = $('#avisoMudanza');
  aviso.hidden = listo;
  // Ya no queda nada aquí: pasa sola a la app nueva (el botón sigue por si no lo hace).
  if (listo && !saltoMudanza) saltoMudanza = setTimeout(irAppNueva, 2500);
  if (listo) return;

  const conError = porEnviar.filter(r => r.errorEnvio);
  const partes = [];
  if (enviando) partes.push('⏳ Enviando a Shop Car… no cierres la app.');
  else if (porEnviar.length) {
    if (!sesion) partes.push(`⚠ Tienes <b>${porEnviar.length}</b> reporte(s) sin enviar. <b>Entra con tu usuario</b> para enviarlos.`);
    else if (!navigator.onLine) partes.push(`⚠ Tienes <b>${porEnviar.length}</b> reporte(s) sin enviar y <b>no hay señal</b>. Busca señal y vuelve a abrir la app.`);
    else partes.push(`⏳ Faltan <b>${porEnviar.length}</b> reporte(s) por enviar a Shop Car.`);
    if (conError.length) partes.push(`<b>${conError.length}</b> no se pudo(ieron) enviar: ${esc(conError[0].errorEnvio)}. Avísale a tu supervisor y no borres esta app.`);
  }
  if (colocadas.length) {
    partes.push(`⚑ Tienes <b>${colocadas.length}</b> bandera(s) colocada(s) desde este teléfono: <b>retíralas aquí</b> (o ciérralas) como siempre.`);
  }
  aviso.className = `aviso-mudanza${conError.length ? ' error' : ''}`;
  aviso.innerHTML = `<b>Esta app se va a mudar.</b> Las banderas nuevas se colocan en la
    <a href="${URL_NUEVA}" id="linkMudanzaAviso">app nueva</a>. Antes de mudarte:<br>${partes.join('<br>')}
    ${porEnviar.length && sesion && !enviando ? '<br><button type="button" class="btn-chico" id="btnEnviarMudanza">Enviar ahora</button>' : ''}`;
  $('#btnEnviarMudanza')?.addEventListener('click', () => sincronizar(true));
}
window.addEventListener('offline', revisarMudanza);

// Una colocación hecha sin señal chocó en Shop Car con otra abierta en la misma vía.
async function resolverConflicto(r) {
  const motivo = prompt('En Shop Car ya había otra bandera abierta en esta vía. ¿Por qué no se retiró?');
  if (!motivo?.trim()) return;
  try {
    const abiertas = (await rpc('banderas_abiertas_en_via', { p_localidad: r.localidad, p_via: viaDe(r) })).filter(b => b.id !== r.remotoId);
    for (const b of abiertas) {
      try { await rpc('cerrar_bandera_sin_retiro', { p_id: b.id, p_motivo: motivo.trim() }); }
      catch (err) { if (!/ya no está abierta/.test(err.message)) throw err; }
    }
    r.conflicto = false;
    await guardar(r);
    await sincronizar(true);
  } catch (err) { avisar('No se pudo: ' + err.message, 5000); }
}

let fotoActual = null;
function verFoto(id, tipo, i = 0) {
  const r = registros.find(x => x.id === id);
  i = Number(i);
  fotoActual = { blob: fotosLocal(r, tipo)[i], nombre: `${r.folio}_${tipo}_${i + 1}.jpg` };
  $('#visorImg').src = urlFoto(r, tipo, i);
  $('#btnCompartir').hidden = !navigator.canShare;
  $('#dlgFoto').showModal();
}
$('#btnCerrarFoto').addEventListener('click', () => $('#dlgFoto').close());
$('#btnDescargar').addEventListener('click', () => descargar(fotoActual.blob, fotoActual.nombre));
$('#btnCompartir').addEventListener('click', async () => {
  const f = new File([fotoActual.blob], fotoActual.nombre, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: 'Bandera Regla 5.13' }); } catch { /* cancelado */ }
  } else avisar('Este dispositivo no permite compartir archivos; usa Descargar.');
});
function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- Pestañas ----------
document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.pestanas button').forEach(x => x.classList.toggle('activa', x === b));
  document.querySelectorAll('.vista').forEach(v => v.hidden = v.id !== 'vista-' + b.dataset.vista);
}));
$('#fDesde').addEventListener('change', pintar);
$('#fHasta').addEventListener('change', pintar);

// ---------- Exportar CSV ----------
$('#btnCsv').addEventListener('click', () => {
  const hist = filtrados();
  if (!hist.length) return avisar('No hay registros en el periodo.');
  const cols = ['Folio', 'Localidad', 'Vía', 'Equipo', 'Colocó', 'Fecha colocación', 'GPS colocación',
    'Estado', 'Fecha retiro / cierre', 'Retiró', 'GPS retiro', 'Motivo sin retiro', 'Tiempo colocada (hh:mm:ss)', 'Minutos', 'Observaciones'];
  const gps = g => g ? `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : '';
  const filas = hist.map(r => {
    const ms = finDe(r) - r.colocacion.ms;
    return [r.folio, r.localidad || '', viaDe(r), r.equipo, colocoDe(r), fechaHora(r.colocacion.ms), gps(r.colocacion.gps),
      r.retiro ? 'Retirada' : 'Sin retiro', fechaHora(finDe(r)), r.retiro?.responsable, gps(r.retiro?.gps), r.cierre?.motivo,
      duracion(ms), (ms / 60000).toFixed(1), r.obs];
  });
  const csv = [cols, ...filas].map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const d = new Date();
  descargar(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `banderas_513_${d.getFullYear()}${dos(d.getMonth() + 1)}${dos(d.getDate())}.csv`);
});

// ---------- Instalación ----------
let promptInstalar;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptInstalar = e; $('#btnInstalar').hidden = false; });
$('#btnInstalar').addEventListener('click', async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt(); await promptInstalar.userChoice;
  promptInstalar = null; $('#btnInstalar').hidden = true;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

// Sesión que trae la app de la dirección vieja (ver irAppNueva).
async function recibirTraspaso() {
  const datos = new URLSearchParams(location.hash.slice(1));
  const refresh = datos.get('traspaso');
  if (!refresh) return;
  history.replaceState(null, '', location.pathname + location.search); // que no se quede en el historial
  if (sesion) return;
  try {
    guardarSesion(await pedirToken('refresh_token', { refresh_token: refresh }), datos.get('u') || '');
    await completarSesion();
    avisar(`Bienvenido, ${sesion.nombre}. Ya estás en la app nueva.`, 4500);
  } catch {
    sesion = null;
    localStorage.removeItem(SESION_KEY);
    avisar('Entra con tu usuario y contraseña de Shop Car.', 4500);
  }
}

// ---------- Inicio ----------
(async () => {
  await abrirDB();
  navigator.storage?.persist?.();
  localStorage.removeItem('bandera513-ajustes'); // la pantalla de Ajustes ya no existe
  await recibirTraspaso();
  mostrarLogin();
  await cargarLocalidades();
  await pintar();
  sincronizar();
})();
