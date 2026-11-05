/* App Producción Beluxa — lógica de la tablet (PWA).
   Las llamadas al servidor van a la API de Apps Script (ver api.js).
   El PIN viaja en cada llamada y el servidor lo valida siempre. */

var estado = {
  pin: '',
  catalogo: null,
  jefe: localStorage.getItem('prod_jefe') || '',
  maquina: '',
  estadoOp: '',
  motivo: '',
  categoria: '',
  responsableSel: '',
  insumoSel: null,
  conteo: null,          // {idConteo, responsable, inicio, items:[]}
  ultimoCierre: null
};

function $(id) { return document.getElementById(id); }

function escapeHTML(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/* ---------- Números en formato chileno: punto miles, coma decimales ---------- */
// '1.250,50' -> 1250.5 | '12,5' -> 12.5 | '1.250' -> 1250 | '12.5' -> 12.5
function parseCantidad(txt) {
  var s = String(txt || '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');   // puntos de miles sin decimales
  }
  var n = parseFloat(s);
  return isNaN(n) ? NaN : Math.round(n * 100) / 100;
}

// 1250.5 -> '1.250,50' | 2200 -> '2.200' (decimales solo cuando existen)
function formatoCL(n) {
  n = Number(n);
  if (isNaN(n)) return '';
  var neg = n < 0 ? '-' : '';
  n = Math.abs(n);
  var entero = Math.floor(n);
  var dec = Math.round((n - entero) * 100);
  if (dec === 100) { entero++; dec = 0; }
  var s = String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (dec > 0) s += ',' + (dec < 10 ? '0' + dec : dec);
  return neg + s;
}

function setMensaje(id, texto, tipo) {
  var el = $(id);
  el.textContent = texto || '';
  el.className = 'mensaje' + (tipo ? ' ' + tipo : '');
  if (texto && tipo === 'ok') setTimeout(function () { if (el.textContent === texto) { el.textContent = ''; el.className = 'mensaje'; } }, 6000);
}

/* ---------- Confirmación propia (los dialogs nativos no se usan) ---------- */
var confirmarCallback = null;
function confirmar(titulo, texto, cb) {
  $('confirmar-titulo').textContent = titulo;
  $('confirmar-texto').textContent = texto;
  confirmarCallback = cb;
  $('modal-confirmar').classList.add('abierto');
}
document.addEventListener('DOMContentLoaded', function () {
  $('confirmar-no').addEventListener('click', function () { $('modal-confirmar').classList.remove('abierto'); confirmarCallback = null; });
  $('confirmar-si').addEventListener('click', function () {
    $('modal-confirmar').classList.remove('abierto');
    var cb = confirmarCallback; confirmarCallback = null;
    if (cb) cb();
  });
});

/* ---------- Llamadas al servidor (mismo contrato que google.script.run) ---------- */
function llamar(nombreFn, args, exito, fallo) {
  api(nombreFn, args).then(exito, function (err) {
    if (fallo) fallo(err);
    else setMensaje('msg-maquina', 'Error: ' + err.message, 'err');
  });
}

/* ---------- Arranque: PIN -> catálogo ---------- */
document.addEventListener('DOMContentLoaded', function () {
  var pinGuardado = localStorage.getItem('prod_pin') || '';
  if (pinGuardado) {
    estado.pin = pinGuardado;
    cargarCatalogo();
  }
  $('btn-pin').addEventListener('click', entrarConPin);
  $('input-pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') entrarConPin(); });
  $('btn-reintentar').addEventListener('click', cargarCatalogo);
  initMaquinas();
  initSensores();
  initInventario();
  initCola();
});

function entrarConPin() {
  var pin = $('input-pin').value.trim();
  if (!pin) { $('pin-error').textContent = 'Ingresa el PIN.'; return; }
  $('pin-error').textContent = '';
  $('btn-pin').disabled = true;
  llamar('verificarPin', [pin], function (r) {
    $('btn-pin').disabled = false;
    if (!r.ok) { $('pin-error').textContent = 'PIN incorrecto.'; return; }
    estado.pin = pin;
    localStorage.setItem('prod_pin', pin);
    cargarCatalogo();
  }, function (err) {
    $('btn-pin').disabled = false;
    $('pin-error').textContent = 'No se pudo verificar: ' + err.message;
  });
}

/* ---------- Copia local de los datos (para abrir la app sin internet) ---------- */
function leerCache() {
  try { var s = localStorage.getItem('prod_cache'); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function guardarCache() {
  try {
    estado.catalogo.conteoAbierto = estado.conteo;
    localStorage.setItem('prod_cache', JSON.stringify(estado.catalogo));
  } catch (e) { /* sin almacenamiento disponible */ }
}
function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function nuevoId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function p2(n) { return ('0' + n).slice(-2); }
function fmtCorta(ms) {          // dd-MM-yyyy HH:mm con la hora de la tablet
  var d = new Date(ms);
  return p2(d.getDate()) + '-' + p2(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

async function cargarCatalogo() {
  $('pin-screen').style.display = 'none';
  $('loading-screen').style.display = 'flex';
  $('btn-reintentar').style.display = 'none';
  $('loading-texto').textContent = 'Cargando datos de la planta…';

  var cache = leerCache();
  // Primero se envía lo pendiente (máx. 12 s de espera) para que el servidor tenga lo último.
  await Promise.race([sincronizar(), esperar(12000)]);
  var pend = (await colaListar()).length;

  try {
    var data = await api('getCatalogo', [estado.pin], cache ? 15000 : 90000);
    if (!data || !data.ok) { errorCarga('Respuesta inesperada del servidor.'); return; }
    if (pend > 0 && cache) {          // hay registros locales que aún no llegaron al servidor: se conservan
      data.estadoMaquinas = cache.estadoMaquinas || data.estadoMaquinas;
      data.estadoSensores = cache.estadoSensores || data.estadoSensores;
      data.conteoAbierto = cache.conteoAbierto;
    }
    iniciarApp(data, false);
  } catch (err) {
    // PIN inválido guardado (lo cambiaron): volver a pedirlo.
    if (String(err.message).indexOf('PIN incorrecto') !== -1) {
      localStorage.removeItem('prod_pin');
      estado.pin = '';
      $('loading-screen').style.display = 'none';
      $('pin-screen').style.display = 'flex';
      $('pin-error').textContent = 'El PIN cambió. Ingresa el nuevo.';
      return;
    }
    // Sin internet: se abre con la última copia guardada en la tablet.
    if (err.sinConexion && cache) { iniciarApp(cache, true); return; }
    errorCarga(err.message + (err.sinConexion ? ' La primera vez que se usa la app hace falta internet.' : ''));
  }
}

function iniciarApp(data, sinConexion) {
  estado.catalogo = data;
  $('hora-servidor').textContent = sinConexion ? 'sin conexión' : (data.horaServidor ? data.horaServidor.slice(0, 16) : '');
  renderJefes();
  renderMaquinas();
  renderMotivos();
  renderResponsables();
  renderPanelEstado(data.estadoMaquinas || {});
  renderMaquinasSensor();
  renderPanelSensores(data.estadoSensores);
  refrescarGuardarSensor();
  aplicarConteoAbierto(data.conteoAbierto);
  guardarCache();
  $('loading-screen').style.display = 'none';
  $('app').style.display = 'block';
  actualizarIndicador();
}

function errorCarga(msg) {
  $('loading-texto').textContent = 'No se pudieron cargar los datos: ' + msg;
  $('btn-reintentar').style.display = 'inline-block';
}

/* ---------- Pestañas ---------- */
document.addEventListener('click', function (e) {
  var tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('activa'); });
  document.querySelectorAll('.vista').forEach(function (v) { v.classList.remove('activa'); });
  tab.classList.add('activa');
  $('tab-' + tab.dataset.tab).classList.add('activa');
});

/* ====================================================================
 * MÁQUINAS
 * ==================================================================== */

function initMaquinas() {
  $('btn-operativa').addEventListener('click', function () { setEstadoOp('Operativa'); });
  $('btn-detenida').addEventListener('click', function () { setEstadoOp('Detenida'); });
  $('btn-guardar-maquina').addEventListener('click', guardarMaquina);
}

// El jefe de turno se elige una vez y vale para Máquinas y Sensores (dos grillas sincronizadas).
function renderJefes() {
  var ids = ['grilla-jefes', 'grilla-jefes-sensor'];
  ids.forEach(function (id) {
    var g = $(id);
    g.innerHTML = '';
    estado.catalogo.jefes.forEach(function (j) {
      var b = document.createElement('button');
      b.className = 'btn-opcion' + (estado.jefe === j ? ' sel' : '');
      b.textContent = j;
      b.dataset.jefe = j;
      b.addEventListener('click', function () {
        estado.jefe = j;
        localStorage.setItem('prod_jefe', j);
        ids.forEach(function (otro) {
          $(otro).querySelectorAll('.btn-opcion').forEach(function (x) {
            x.classList.toggle('sel', x.dataset.jefe === j);
          });
        });
        refrescarGuardar();
        refrescarGuardarSensor();
      });
      g.appendChild(b);
    });
  });
}

function renderMaquinas() {
  var g = $('grilla-maquinas');
  g.innerHTML = '';
  estado.catalogo.maquinas.forEach(function (m) {
    var b = document.createElement('button');
    b.className = 'btn-opcion';
    b.textContent = m;
    b.addEventListener('click', function () {
      estado.maquina = m;
      g.querySelectorAll('.btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      refrescarGuardar();
    });
    g.appendChild(b);
  });
}

function renderMotivos() {
  var g = $('grilla-motivos');
  g.innerHTML = '';
  estado.catalogo.motivos.forEach(function (m) {
    var b = document.createElement('button');
    b.className = 'btn-opcion';
    b.textContent = m;
    b.addEventListener('click', function () {
      estado.motivo = m;
      g.querySelectorAll('.btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      refrescarGuardar();
    });
    g.appendChild(b);
  });
}

function setEstadoOp(v) {
  estado.estadoOp = v;
  $('btn-operativa').classList.toggle('sel', v === 'Operativa');
  $('btn-detenida').classList.toggle('sel', v === 'Detenida');
  $('paso-motivo').style.display = (v === 'Detenida') ? 'block' : 'none';
  if (v === 'Operativa') {
    estado.motivo = '';
    document.querySelectorAll('#grilla-motivos .btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
  }
  refrescarGuardar();
}

function refrescarGuardar() {
  var listo = estado.jefe && estado.maquina && estado.estadoOp &&
    (estado.estadoOp === 'Operativa' || estado.motivo);
  $('btn-guardar-maquina').disabled = !listo;
}

// El registro se guarda primero en la tablet y se envía en segundo plano (funciona sin internet).
function guardarMaquina() {
  var btn = $('btn-guardar-maquina');
  btn.disabled = true;
  var datos = {
    id: nuevoId(), ts: Date.now(),
    jefe: estado.jefe, maquina: estado.maquina, estado: estado.estadoOp,
    motivo: estado.estadoOp === 'Detenida' ? estado.motivo : ''
  };
  encolar('guardarRegistroMaquina', [estado.pin, datos], datos.maquina + ': ' + datos.estado).then(function () {
    // Actualiza el panel con el estado recién guardado, sin esperar al servidor.
    var previo = estado.catalogo.estadoMaquinas[datos.maquina];
    estado.catalogo.estadoMaquinas[datos.maquina] = {
      estado: datos.estado, motivo: datos.motivo, fechaHora: fmtCorta(datos.ts), jefe: datos.jefe, ts: datos.ts,
      inicioTs: (previo && previo.estado === datos.estado && previo.inicioTs) ? previo.inicioTs : datos.ts
    };
    guardarCache();
    renderPanelEstado(estado.catalogo.estadoMaquinas);
    setMensaje('msg-maquina', '✅ ' + datos.maquina + ' registrada como ' + datos.estado.toUpperCase() + '.', 'ok');
    // Auto re-open: formulario limpio, conservando el jefe de turno.
    estado.maquina = ''; estado.estadoOp = ''; estado.motivo = '';
    document.querySelectorAll('#grilla-maquinas .btn-opcion, #grilla-motivos .btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
    $('btn-operativa').classList.remove('sel');
    $('btn-detenida').classList.remove('sel');
    $('paso-motivo').style.display = 'none';
    refrescarGuardar();
  });
}

function renderPanelEstado(mapa) {
  var panel = $('panel-estado');
  panel.innerHTML = '';
  estado.catalogo.maquinas.forEach(function (m) {
    var e = mapa[m];
    var div = document.createElement('div');
    var clase = 'sin', detalle = 'Sin registros';
    if (e) {
      clase = (e.estado === 'Detenida') ? 'det' : 'op';
      detalle = (e.estado === 'Detenida' ? '⛔ ' + escapeHTML(e.motivo || 'Detenida') : '✅ Operativa') +
        '<br>' + escapeHTML(e.fechaHora || '');
    }
    div.className = 'ficha-maquina ' + clase;
    div.innerHTML = '<div class="nombre">' + escapeHTML(m) + '</div><div class="detalle">' + detalle + '</div>';
    panel.appendChild(div);
  });
}

/* ====================================================================
 * SENSORES: foto + estado Operativo / No operativo por máquina
 * ==================================================================== */

var sensor = { maquina: '', estado: '', foto: '' };   // foto = base64 JPEG (sin prefijo)

function initSensores() {
  $('btn-foto').addEventListener('click', abrirCamara);
  $('camara-capturar').addEventListener('click', capturarDesdeCamara);
  $('camara-cancelar').addEventListener('click', cerrarCamara);
  $('camara-archivo').addEventListener('click', function () { cerrarCamara(); $('input-foto').click(); });
  $('input-foto').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    $('btn-foto').disabled = true;
    comprimirFoto(f).then(function (dataUrl) {
      aplicarFoto(dataUrl);
    }, function (err) {
      setMensaje('msg-sensor', err.message, 'err');
    }).then(function () {
      $('btn-foto').disabled = false;
      $('input-foto').value = '';
    });
  });
  $('btn-sens-ok').addEventListener('click', function () { setEstadoSensor('Operativo'); });
  $('btn-sens-no').addEventListener('click', function () { setEstadoSensor('No operativo'); });
  $('btn-guardar-sensor').addEventListener('click', guardarSensor);
  // Revisa cada minuto si terminó el turno para vaciar el panel de fotos/estados.
  setInterval(function () { if (estado.catalogo) renderPanelSensores(); }, 60000);
}

function aplicarFoto(dataUrl) {
  sensor.foto = dataUrl.split(',')[1];
  $('foto-img').src = dataUrl;
  $('foto-preview').style.display = 'block';
  $('btn-foto').textContent = '🔄 VOLVER A TOMAR FOTO';
  setMensaje('msg-sensor', '', '');
  refrescarGuardarSensor();
}

/* ---------- Cámara en vivo (getUserMedia): abre la cámara también en PC/web ----------
   Si el navegador no tiene cámara o el permiso se niega, se ofrece elegir un archivo. */
var camaraStream = null;

function abrirCamara() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('input-foto').click();      // navegador sin soporte: selector/cámara nativa
    return;
  }
  setMensaje('msg-sensor', '', '');
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  }).then(function (stream) {
    camaraStream = stream;
    var v = $('camara-video');
    v.srcObject = stream;
    v.play();
    $('modal-camara').classList.add('abierto');
  }, function (err) {
    var motivo = (err && err.name === 'NotAllowedError')
      ? 'Permiso de cámara denegado. Permítelo en el navegador (candado junto a la dirección) o elige un archivo.'
      : 'No se pudo abrir la cámara (' + (err && err.name ? err.name : 'error') + '). Puedes elegir un archivo.';
    setMensaje('msg-sensor', motivo, 'err');
    $('input-foto').click();
  });
}

function cerrarCamara() {
  if (camaraStream) {
    camaraStream.getTracks().forEach(function (t) { t.stop(); });
    camaraStream = null;
  }
  $('camara-video').srcObject = null;
  $('modal-camara').classList.remove('abierto');
}

function capturarDesdeCamara() {
  var v = $('camara-video');
  if (!v.videoWidth) { setMensaje('msg-sensor', 'La cámara aún no está lista. Espera un segundo.', 'err'); return; }
  var k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
  var c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  var dataUrl = c.toDataURL('image/jpeg', 0.7);
  cerrarCamara();
  aplicarFoto(dataUrl);
}

// Reduce la foto (lado mayor 1280 px, JPEG 70%) para que suba rápido aunque haya poca señal.
function comprimirFoto(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var k = Math.min(1, 1280 / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la foto. Intenta de nuevo.'));
    };
    img.src = url;
  });
}

function renderMaquinasSensor() {
  var g = $('grilla-maquinas-sensor');
  g.innerHTML = '';
  estado.catalogo.maquinas.forEach(function (m) {
    var b = document.createElement('button');
    b.className = 'btn-opcion' + (sensor.maquina === m ? ' sel' : '');
    b.textContent = m;
    b.addEventListener('click', function () {
      sensor.maquina = m;
      g.querySelectorAll('.btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      refrescarGuardarSensor();
    });
    g.appendChild(b);
  });
}

function setEstadoSensor(v) {
  sensor.estado = v;
  $('btn-sens-ok').classList.toggle('sel', v === 'Operativo');
  $('btn-sens-no').classList.toggle('sel', v === 'No operativo');
  refrescarGuardarSensor();
}

function refrescarGuardarSensor() {
  $('btn-guardar-sensor').disabled = !(estado.jefe && sensor.maquina && sensor.foto && sensor.estado);
}

function limpiarFormularioSensor() {
  sensor.maquina = ''; sensor.estado = ''; sensor.foto = '';
  document.querySelectorAll('#grilla-maquinas-sensor .btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
  $('btn-sens-ok').classList.remove('sel');
  $('btn-sens-no').classList.remove('sel');
  $('foto-preview').style.display = 'none';
  $('foto-img').removeAttribute('src');
  $('btn-foto').textContent = '📷 TOMAR FOTO';
  $('input-obs-sensor').value = '';
  refrescarGuardarSensor();
}

// El registro (con su foto) se guarda primero en la tablet y se sube en segundo plano (funciona sin internet).
function guardarSensor() {
  var btn = $('btn-guardar-sensor');
  btn.disabled = true;
  var datos = {
    id: nuevoId(), ts: Date.now(),
    jefe: estado.jefe, maquina: sensor.maquina, estado: sensor.estado,
    observacion: $('input-obs-sensor').value, foto: sensor.foto
  };
  encolar('guardarRegistroSensor', [estado.pin, datos], 'Sensores ' + datos.maquina + ': ' + datos.estado + ' (con foto)').then(function () {
    if (!estado.catalogo.estadoSensores) estado.catalogo.estadoSensores = { turno: null, porMaquina: {} };
    estado.catalogo.estadoSensores.porMaquina[datos.maquina] = {
      estado: datos.estado, fechaHora: fmtCorta(datos.ts), ts: datos.ts, jefe: datos.jefe,
      observacion: datos.observacion, fotoUrl: '', pendiente: true, idReg: datos.id
    };
    guardarCache();
    renderPanelSensores();
    setMensaje('msg-sensor', '✅ Sensores de ' + datos.maquina + ': ' + datos.estado.toUpperCase() + '.', 'ok');
    limpiarFormularioSensor();
  });
}

/* data = { turno: {inicio, fin, diurno}, porMaquina: {...} }.
   Solo se muestran registros del turno en curso (08:00-20:00 / 20:00-08:00).
   Si el turno termina con la app abierta, el panel se vacía solo (cada minuto se revisa). */
function renderPanelSensores(data) {
  if (data) estado.catalogo.estadoSensores = data;
  data = estado.catalogo.estadoSensores || { turno: null, porMaquina: {} };
  var t = data.turno;
  if (t) {
    while (Date.now() >= t.fin) {          // el turno cambió: avanzar al siguiente
      t.inicio = t.fin;
      t.fin = t.fin + 12 * 3600000;
      t.diurno = !t.diurno;
    }
    $('turno-sensores').textContent = 'Turno ' + (t.diurno ? 'día 08:00 – 20:00' : 'noche 20:00 – 08:00') +
      '. Las fotos y estados se muestran solo durante el turno; todas quedan guardadas en Drive.';
  } else {
    $('turno-sensores').textContent = '';
  }
  var mapa = {};
  Object.keys(data.porMaquina || {}).forEach(function (m) {
    var e = data.porMaquina[m];
    if (!t || (e.ts >= t.inicio && e.ts < t.fin)) mapa[m] = e;
  });

  var panel = $('panel-sensores');
  panel.innerHTML = '';
  estado.catalogo.maquinas.forEach(function (m) {
    var e = mapa[m];
    var div = document.createElement('div');
    var clase = 'sin', detalle = 'Sin registros';
    if (e) {
      var ok = e.estado === 'Operativo';
      clase = ok ? 'op' : 'det';
      detalle = (ok ? '✅ Operativo' : '⚠ No operativo') +
        (e.observacion ? '<br>' + escapeHTML(e.observacion) : '') +
        '<br>' + escapeHTML(e.fechaHora || '') +
        (e.fotoUrl ? '<br><a href="' + escapeHTML(e.fotoUrl) + '" target="_blank" rel="noopener">📷 ver foto</a>'
          : (e.pendiente ? '<br>⏳ foto pendiente de envío' : ''));
    }
    div.className = 'ficha-maquina ' + clase;
    div.innerHTML = '<div class="nombre">' + escapeHTML(m) + '</div><div class="detalle">' + detalle + '</div>';
    panel.appendChild(div);
  });
}

/* ====================================================================
 * INVENTARIO B35
 * ==================================================================== */

function initInventario() {
  $('btn-iniciar-conteo').addEventListener('click', iniciarConteo);
  $('btn-agregar-item').addEventListener('click', agregarItem);
  $('btn-cerrar-conteo').addEventListener('click', pedirCierreConteo);
  $('btn-nuevo-conteo').addEventListener('click', function () {
    $('inv-resumen').style.display = 'none';
    $('inv-inicio').style.display = 'block';
    estado.responsableSel = '';
    renderResponsables();
  });
  $('btn-reenviar-correo').addEventListener('click', reenviarCorreo);
  $('buscar-insumo').addEventListener('input', renderListaInsumos);
  $('btn-menos').addEventListener('click', function () { ajustarCantidad(-1); });
  $('btn-mas').addEventListener('click', function () { ajustarCantidad(1); });

  document.querySelectorAll('.btn-cat').forEach(function (b) {
    b.addEventListener('click', function () {
      estado.categoria = b.dataset.cat;
      document.querySelectorAll('.btn-cat').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      estado.insumoSel = null;
      $('bloque-insumo').style.display = 'block';
      $('bloque-cantidad').style.display = 'none';
      $('buscar-insumo').value = '';
      renderListaInsumos();
    });
  });

  $('editar-cancelar').addEventListener('click', function () { $('modal-editar').classList.remove('abierto'); });
  $('editar-guardar').addEventListener('click', guardarEdicionItem);
  $('btn-opciones-conteo').addEventListener('click', abrirOpcionesConteo);
  $('opc-cerrar').addEventListener('click', cerrarOpcionesConteo);
  $('opc-descartar').addEventListener('click', descartarConteo);
}

function aplicarConteoAbierto(conteo) {
  if (conteo) {
    estado.conteo = conteo;
    mostrarConteo();
  } else {
    estado.conteo = null;
    $('inv-conteo').style.display = 'none';
    $('inv-inicio').style.display = 'block';
  }
}

function mostrarConteo() {
  $('inv-inicio').style.display = 'none';
  $('inv-resumen').style.display = 'none';
  $('inv-conteo').style.display = 'block';
  $('conteo-responsable').textContent = estado.conteo.responsable;
  $('conteo-inicio').textContent = estado.conteo.inicio;
  renderItems();
}

// El responsable se elige con botones (los mismos jefes de turno): nadie tipea.
function renderResponsables() {
  var g = $('grilla-responsables');
  if (!g) return;
  g.innerHTML = '';
  estado.catalogo.jefes.forEach(function (j) {
    var b = document.createElement('button');
    b.className = 'btn-opcion' + (estado.responsableSel === j ? ' sel' : '');
    b.textContent = j;
    b.addEventListener('click', function () {
      estado.responsableSel = j;
      g.querySelectorAll('.btn-opcion').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      $('btn-iniciar-conteo').disabled = false;
    });
    g.appendChild(b);
  });
  $('btn-iniciar-conteo').disabled = !estado.responsableSel;
}

async function iniciarConteo() {
  var resp = estado.responsableSel;
  if (!resp) { setMensaje('msg-inicio-conteo', 'Selecciona el responsable.', 'err'); return; }
  var btn = $('btn-iniciar-conteo');
  btn.disabled = true; btn.textContent = 'Iniciando…';

  var ts = Date.now();
  var d = new Date(ts);
  var id = 'CONTEO-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) +
    '-' + Math.random().toString(36).slice(2, 5);
  var opts = { id: id, ts: ts };

  // Si hay conexión y nada pendiente, se consulta al servidor (puede haber un conteo ya abierto).
  await Promise.race([sincronizar(), esperar(10000)]);
  var pend = (await colaListar()).length;
  if (pend === 0) {
    try {
      var r = await api('iniciarConteo', [estado.pin, resp, opts], 20000);
      btn.disabled = false; btn.textContent = '▶ INICIAR CONTEO';
      if (!r.ok) { setMensaje('msg-inicio-conteo', r.mensaje, 'err'); return; }
      estado.conteo = r.conteo;
      if (r.existente) setMensaje('msg-item', r.mensaje, 'ok');
      guardarCache();
      mostrarConteo();
      return;
    } catch (err) {
      if (!err.sinConexion) {
        btn.disabled = false; btn.textContent = '▶ INICIAR CONTEO';
        setMensaje('msg-inicio-conteo', 'No se pudo iniciar: ' + err.message, 'err');
        return;
      }
    }
  }
  // Sin conexión (o con envíos pendientes): el conteo se inicia en la tablet y se registra en el servidor después.
  estado.conteo = { idConteo: id, responsable: resp, inicio: fmtCorta(ts), items: [] };
  await encolar('iniciarConteo', [estado.pin, resp, opts], 'Iniciar conteo de ' + resp);
  btn.disabled = false; btn.textContent = '▶ INICIAR CONTEO';
  guardarCache();
  mostrarConteo();
}

function renderListaInsumos() {
  var filtro = $('buscar-insumo').value.toLowerCase().trim();
  var cont = $('lista-insumos');
  cont.innerHTML = '';
  var lista = estado.catalogo.insumos.filter(function (x) {
    if (x.categoria !== estado.categoria) return false;
    if (!filtro) return true;
    return (x.insumo + ' ' + x.codigo).toLowerCase().indexOf(filtro) !== -1;
  });
  if (lista.length === 0) {
    cont.innerHTML = '<div class="nota">Sin coincidencias en ' + escapeHTML(estado.categoria || '—') + '.</div>';
    return;
  }
  lista.forEach(function (x) {
    var b = document.createElement('button');
    b.className = 'item-insumo' + (estado.insumoSel && estado.insumoSel.codigo === x.codigo ? ' sel' : '');
    b.innerHTML = '<b>' + escapeHTML(x.insumo) + '</b><small>' + escapeHTML(x.codigo) + ' · ' + escapeHTML(x.unidad) +
      (x.observacion ? ' · 📌 ' + escapeHTML(x.observacion) : '') + '</small>';
    b.addEventListener('click', function () { elegirInsumo(x); });
    cont.appendChild(b);
  });
}

function elegirInsumo(x) {
  estado.insumoSel = x;
  renderListaInsumos();
  $('bloque-cantidad').style.display = 'block';
  $('insumo-elegido').innerHTML = escapeHTML(x.insumo) + ' (' + escapeHTML(x.codigo) + ')' +
    (x.observacion ? '<br><span style="color:#f59e0b;font-size:0.88rem;">📌 ' + escapeHTML(x.observacion) + '</span>' : '');
  $('unidad-insumo').textContent = x.unidad;
  $('input-cantidad').value = '';
  $('input-obs-item').value = '';
  $('input-cantidad').focus();
}

function ajustarCantidad(delta) {
  var el = $('input-cantidad');
  var v = parseCantidad(el.value);
  if (isNaN(v)) v = 0;
  v = Math.max(0, Math.round((v + delta) * 100) / 100);
  el.value = formatoCL(v);
}

function agregarItem() {
  if (!estado.conteo) return;
  if (!estado.insumoSel) { setMensaje('msg-item', 'Selecciona un insumo.', 'err'); return; }
  var cant = parseCantidad($('input-cantidad').value);
  if (isNaN(cant) || cant < 0) { setMensaje('msg-item', 'Cantidad inválida. Usa coma para los decimales (ej: 1.250,50).', 'err'); return; }

  var yaExiste = estado.conteo.items.some(function (it) { return it.codigo === estado.insumoSel.codigo; });
  var enviar = function () {
    var btn = $('btn-agregar-item');
    btn.disabled = true;
    var ins = estado.insumoSel;
    var obs = $('input-obs-item').value;
    var item = {
      idItem: nuevoId(), codigo: ins.codigo, insumo: ins.insumo, categoria: ins.categoria,
      cantidad: cant, unidad: ins.unidad, observacion: String(obs || '').trim()
    };
    var conteoId = estado.conteo.idConteo;
    // El ítem se guarda primero en la tablet y se envía en segundo plano (funciona sin internet).
    encolar('agregarItemConteo', [estado.pin, conteoId, { idItem: item.idItem, codigo: item.codigo, cantidad: cant, observacion: item.observacion, ts: Date.now() }],
      'Ítem ' + ins.insumo + ': ' + formatoCL(cant) + ' ' + ins.unidad).then(function () {
      btn.disabled = false;
      if (estado.conteo && estado.conteo.idConteo === conteoId) estado.conteo.items.push(item);
      guardarCache();
      renderItems();
      setMensaje('msg-item', '✅ ' + ins.insumo + ': ' + formatoCL(cant) + ' ' + ins.unidad + ' agregado.', 'ok');
      // Listo para el siguiente ítem de la misma categoría.
      estado.insumoSel = null;
      $('bloque-cantidad').style.display = 'none';
      $('buscar-insumo').value = '';
      renderListaInsumos();
    });
  };

  if (yaExiste) {
    confirmar('Insumo repetido',
      'El insumo "' + estado.insumoSel.insumo + '" ya está registrado en este conteo.\n\n¿Agregarlo de nuevo como una línea aparte? (También puedes editar la línea existente en la lista.)',
      enviar);
  } else {
    enviar();
  }
}

function renderItems() {
  var cont = $('lista-items');
  var items = (estado.conteo && estado.conteo.items) || [];
  $('n-items').textContent = items.length;
  cont.innerHTML = '';
  if (items.length === 0) {
    cont.innerHTML = '<div class="nota">Aún no hay ítems en este conteo.</div>';
    return;
  }
  var vistos = {};
  items.forEach(function (it) { vistos[it.codigo] = (vistos[it.codigo] || 0) + 1; });

  items.forEach(function (it) {
    var div = document.createElement('div');
    div.className = 'item-conteo';
    div.innerHTML =
      '<div class="info"><div class="titulo">' + escapeHTML(it.insumo) + '</div>' +
      '<div class="sub">' + escapeHTML(it.codigo) + ' · ' + escapeHTML(it.categoria) +
      (it.observacion ? ' · ' + escapeHTML(it.observacion) : '') + '</div>' +
      (vistos[it.codigo] > 1 ? '<div class="dup">⚠ Registrado ' + vistos[it.codigo] + ' veces</div>' : '') +
      '</div>' +
      '<div class="cant">' + formatoCL(it.cantidad) + ' ' + escapeHTML(it.unidad) + '</div>';

    var bEdit = document.createElement('button');
    bEdit.className = 'btn-mini'; bEdit.textContent = '✏️';
    bEdit.addEventListener('click', function () { abrirEditarItem(it); });

    var bDel = document.createElement('button');
    bDel.className = 'btn-mini'; bDel.textContent = '🗑️';
    bDel.addEventListener('click', function () {
      confirmar('Eliminar ítem', '¿Eliminar "' + it.insumo + '" (' + formatoCL(it.cantidad) + ' ' + it.unidad + ') del conteo?', function () {
        var conteoId = estado.conteo.idConteo;
        encolar('eliminarItemConteo', [estado.pin, conteoId, it.idItem], 'Eliminar ítem ' + it.insumo).then(function () {
          if (estado.conteo && estado.conteo.idConteo === conteoId) {
            estado.conteo.items = estado.conteo.items.filter(function (x) { return x.idItem !== it.idItem; });
          }
          guardarCache();
          renderItems();
        });
      });
    });

    div.appendChild(bEdit);
    div.appendChild(bDel);
    cont.appendChild(div);
  });
}

var itemEditando = null;
function abrirEditarItem(it) {
  itemEditando = it;
  $('editar-titulo').textContent = it.insumo + ' (' + it.codigo + ')';
  $('editar-unidad').textContent = it.unidad;
  $('editar-cantidad').value = formatoCL(it.cantidad);
  $('editar-obs').value = it.observacion || '';
  $('modal-editar').classList.add('abierto');
}

function guardarEdicionItem() {
  if (!itemEditando) return;
  var cant = parseCantidad($('editar-cantidad').value);
  if (isNaN(cant) || cant < 0) return;
  var btn = $('editar-guardar');
  btn.disabled = true;
  var it = itemEditando;
  var obs = String($('editar-obs').value || '').trim();
  var conteoId = estado.conteo.idConteo;
  encolar('actualizarItemConteo', [estado.pin, conteoId, it.idItem, cant, obs], 'Corregir ítem ' + it.insumo + ': ' + formatoCL(cant) + ' ' + it.unidad).then(function () {
    btn.disabled = false;
    $('modal-editar').classList.remove('abierto');
    it.cantidad = cant;
    it.observacion = obs;
    guardarCache();
    renderItems();
  });
}

/* ---------- Corregir el conteo en curso: cambiar el responsable o descartarlo ---------- */
function abrirOpcionesConteo() {
  if (!estado.conteo) return;
  $('opc-actual').textContent = estado.conteo.responsable;
  var g = $('opc-grilla');
  g.innerHTML = '';
  estado.catalogo.jefes.forEach(function (j) {
    var b = document.createElement('button');
    b.className = 'btn-opcion' + (j === estado.conteo.responsable ? ' sel' : '');
    b.textContent = j;
    b.addEventListener('click', function () { cambiarResponsable(j); });
    g.appendChild(b);
  });
  $('modal-opciones-conteo').classList.add('abierto');
}

function cerrarOpcionesConteo() { $('modal-opciones-conteo').classList.remove('abierto'); }

function cambiarResponsable(nuevo) {
  var c = estado.conteo;
  if (!c) return;
  if (nuevo === c.responsable) { cerrarOpcionesConteo(); return; }
  var id = c.idConteo;
  encolar('cambiarResponsableConteo', [estado.pin, id, nuevo], 'Cambiar responsable del conteo a ' + nuevo).then(function () {
    if (estado.conteo && estado.conteo.idConteo === id) {
      estado.conteo.responsable = nuevo;
      $('conteo-responsable').textContent = nuevo;
    }
    guardarCache();
    cerrarOpcionesConteo();
    setMensaje('msg-item', '✅ Responsable cambiado a ' + nuevo + '.', 'ok');
  });
}

function descartarConteo() {
  var c = estado.conteo;
  if (!c) return;
  cerrarOpcionesConteo();
  var n = (c.items || []).length;
  confirmar('Eliminar conteo',
    'Se eliminará por completo el conteo de ' + c.responsable + (n === 1 ? ' y su ítem' : (n ? ' y sus ' + n + ' ítems' : '')) +
    '. No quedará ningún registro y no se enviará PDF ni correo.\n\nPodrás empezar un conteo nuevo. ¿Eliminarlo?',
    function () {
      var id = c.idConteo;
      encolar('cancelarConteo', [estado.pin, id], 'Eliminar conteo de ' + c.responsable).then(function () {
        estado.conteo = null;
        estado.responsableSel = '';
        guardarCache();
        renderResponsables();
        $('inv-conteo').style.display = 'none';
        $('inv-resumen').style.display = 'none';
        $('inv-inicio').style.display = 'block';
        setMensaje('msg-inicio-conteo', 'Conteo eliminado. Elige el responsable para empezar uno nuevo.', 'ok');
      });
    });
}

function pedirCierreConteo() {
  var items = estado.conteo.items || [];
  var resumen = 'Responsable: ' + estado.conteo.responsable +
    '\nÍtems registrados: ' + items.length +
    (items.length === 0 ? '\n\n⚠ El conteo está VACÍO.' : '') +
    '\n\nAl cerrar: se genera el PDF de respaldo y se envía el correo a las áreas configuradas (si no hay internet, se hace solo cuando vuelva la conexión). Después no se puede seguir agregando ítems.';
  confirmar('Cerrar conteo Bodega 35', resumen, cerrarConteo);
}

function cerrarConteo() {
  var cab = estado.conteo;
  if (!cab) return;
  var btn = $('btn-cerrar-conteo');
  btn.disabled = true;
  encolar('cerrarConteo', [estado.pin, cab.idConteo], 'Cerrar conteo de ' + cab.responsable + ' (' + cab.items.length + ' ítems)').then(function () {
    btn.disabled = false;
    estado.ultimoCierre = { idConteo: cab.idConteo, responsable: cab.responsable, totalItems: cab.items.length };
    estado.conteo = null;
    guardarCache();
    $('inv-conteo').style.display = 'none';
    $('inv-resumen').style.display = 'block';
    mostrarResumenCierre(null);     // se completa con el PDF y el correo cuando el servidor responda
  });
}

// r = respuesta del servidor al cerrar; null mientras el cierre aún está en la cola.
function mostrarResumenCierre(r) {
  var u = estado.ultimoCierre || {};
  var html;
  if (!r) {
    html = '<b>Conteo cerrado</b> con ' + (u.totalItems || 0) + ' ítems.<br>' +
      '⏳ El PDF de respaldo y el correo se generan y envían solos cuando haya conexión con el servidor.';
    $('btn-reenviar-correo').style.display = 'none';
  } else if (r.yaCerrado) {
    html = '<b>Conteo cerrado</b> con ' + (u.totalItems || 0) + ' ítems.';
    $('btn-reenviar-correo').style.display = 'none';
  } else {
    html = '<b>Total ítems:</b> ' + r.totalItems +
      (r.bajoMinimo ? '<br><b style="color:#f87171">' + r.bajoMinimo + ' ítem(s) bajo stock mínimo</b>' : '') +
      '<br><b>PDF:</b> <a href="' + escapeHTML(r.pdfUrl) + '" target="_blank" rel="noopener">abrir respaldo en Drive</a>' +
      '<br><b>Correo:</b> ' + (r.correoEnviado
        ? '✅ enviado a ' + escapeHTML((r.destinatarios || []).join(', '))
        : '❌ ' + escapeHTML(r.mensajeCorreo || 'no se envió'));
    $('btn-reenviar-correo').style.display = r.correoEnviado ? 'none' : 'inline-block';
  }
  $('resumen-cierre').innerHTML = html;
}

/* ====================================================================
 * RESULTADOS DE LA COLA (se llama cuando el servidor responde a un envío)
 * ==================================================================== */

// Si otra tablet ya había abierto un conteo, los ítems de este pasan a ese conteo.
async function remapearConteo(viejo, nuevo) {
  var ops = await colaListar();
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    if (o.fn !== 'iniciarConteo' && o.args && o.args[1] === viejo) {
      o.args[1] = nuevo;
      await colaActualizar(o);
    }
  }
}

async function alResultadoCola(op, r) {
  var fn = op.fn;
  var msg = (r && r.mensaje) || '';

  if (r && r.ok === false) {
    var silencioso =
      (/No se encontró el ítem/.test(msg) && (fn === 'eliminarItemConteo' || fn === 'actualizarItemConteo')) ||
      (fn === 'cerrarConteo' && /ya no está abierto/.test(msg)) ||
      ((fn === 'cancelarConteo' || fn === 'cambiarResponsableConteo') && /ya no está abierto/.test(msg));
    if (fn === 'cerrarConteo' && silencioso && estado.ultimoCierre && estado.ultimoCierre.idConteo === op.args[1]) {
      mostrarResumenCierre({ yaCerrado: true });
    }
    if (!silencioso) agregarRechazo(op.desc, msg || 'El servidor no aceptó el registro.');
    if (r.conteoCerrado) recargarConteo();
    return;
  }

  if (fn === 'guardarRegistroSensor' && r.estadoNuevo && estado.catalogo && estado.catalogo.estadoSensores) {
    var actual = estado.catalogo.estadoSensores.porMaquina[r.maquina];
    if (actual && actual.idReg === op.args[1].id) {        // todavía es el último: completar con el enlace de la foto
      estado.catalogo.estadoSensores.porMaquina[r.maquina] = r.estadoNuevo;
      guardarCache();
      renderPanelSensores();
    }
  } else if (fn === 'iniciarConteo') {
    var mio = op.args[2] && op.args[2].id;
    if (r.existente && r.conteo && r.conteo.idConteo !== mio) {
      await remapearConteo(mio, r.conteo.idConteo);
      if (estado.conteo && estado.conteo.idConteo === mio) {
        var locales = estado.conteo.items.filter(function (li) {
          return !r.conteo.items.some(function (si) { return si.idItem === li.idItem; });
        });
        estado.conteo.idConteo = r.conteo.idConteo;
        estado.conteo.items = r.conteo.items.concat(locales);
        guardarCache();
        mostrarConteo();
        setMensaje('msg-item', 'Ya había un conteo abierto de ' + r.conteo.responsable + ': tus ítems se agregaron a ese conteo.', 'ok');
      }
    }
  } else if (fn === 'cerrarConteo') {
    if (estado.ultimoCierre && estado.ultimoCierre.idConteo === op.args[1]) mostrarResumenCierre(r);
  }
}

function reenviarCorreo() {
  if (!estado.ultimoCierre) return;
  var btn = $('btn-reenviar-correo');
  btn.disabled = true; btn.textContent = 'Enviando…';
  llamar('reenviarCorreoConteo', [estado.pin, estado.ultimoCierre.idConteo], function (r) {
    btn.disabled = false; btn.textContent = '📧 Reenviar correo';
    $('resumen-cierre').innerHTML += '<br>' + (r.ok ? '✅ ' : '❌ ') + escapeHTML(r.mensaje);
    if (r.ok) btn.style.display = 'none';
  }, function (err) {
    btn.disabled = false; btn.textContent = '📧 Reenviar correo';
    $('resumen-cierre').innerHTML += '<br>❌ ' + escapeHTML(err.message);
  });
}

function recargarConteo() {
  // El conteo cambió desde otra pantalla: se vuelve a pedir el estado real.
  llamar('getCatalogo', [estado.pin], function (data) {
    if (data && data.ok) {
      estado.catalogo = data;
      aplicarConteoAbierto(data.conteoAbierto);
      renderPanelEstado(data.estadoMaquinas);
      renderPanelSensores(data.estadoSensores);
      guardarCache();
    }
  });
}
