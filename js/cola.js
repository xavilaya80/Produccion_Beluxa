/* Cola de envíos sin conexión.
   Cada registro (máquina, sensores, inventario) se guarda primero en la tablet
   (IndexedDB) y se envía al servidor en segundo plano, en orden. Si no hay
   señal, queda en la cola y se envía solo cuando vuelve la conexión.
   Cada operación lleva un ID y la hora real en que ocurrió, así que reintentar
   nunca duplica datos y el Sheet queda con la hora correcta. */

var COLA = { db: null, memoria: [], seq: 0, usaMemoria: false };
var SYNC = { promesa: null, enviados: 0, recienEnviado: false };

/* ---------- Almacenamiento (IndexedDB, con respaldo en memoria) ---------- */
function dbAbrir() {
  if (COLA.db) return Promise.resolve(COLA.db);
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) { reject(new Error('Sin IndexedDB')); return; }
    var req = indexedDB.open('prod_beluxa', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('cola', { keyPath: 'seq', autoIncrement: true }); };
    req.onsuccess = function () { COLA.db = req.result; resolve(COLA.db); };
    req.onerror = function () { reject(req.error); };
  });
}

function dbOp(modo, fn) {
  return dbAbrir().then(function (db) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction('cola', modo);
      var rq = fn(t.objectStore('cola'));
      t.oncomplete = function () { resolve(rq ? rq.result : undefined); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('Transacción cancelada')); };
    });
  });
}

function colaAgregar(op) {
  if (!COLA.usaMemoria) {
    return dbOp('readwrite', function (st) { return st.add(op); }).then(function (seq) { op.seq = seq; return op; },
      function () { COLA.usaMemoria = true; return colaAgregar(op); });
  }
  op.seq = ++COLA.seq;
  COLA.memoria.push(op);
  return Promise.resolve(op);
}

function colaListar() {
  if (COLA.usaMemoria) return Promise.resolve(COLA.memoria.slice());
  return dbOp('readonly', function (st) { return st.getAll(); }).then(function (a) {
    return a.sort(function (x, y) { return x.seq - y.seq; });
  }, function () { COLA.usaMemoria = true; return colaListar(); });
}

function colaBorrar(seq) {
  if (COLA.usaMemoria) {
    COLA.memoria = COLA.memoria.filter(function (o) { return o.seq !== seq; });
    return Promise.resolve();
  }
  return dbOp('readwrite', function (st) { return st.delete(seq); });
}

function colaActualizar(op) {
  if (COLA.usaMemoria) {
    COLA.memoria = COLA.memoria.map(function (o) { return o.seq === op.seq ? op : o; });
    return Promise.resolve();
  }
  return dbOp('readwrite', function (st) { return st.put(op); });
}

/* ---------- Registros rechazados por el servidor (se muestran al usuario) ---------- */
function leerRechazos() {
  try { return JSON.parse(localStorage.getItem('prod_rechazos') || '[]'); } catch (e) { return []; }
}
function guardarRechazos(lista) {
  try { localStorage.setItem('prod_rechazos', JSON.stringify(lista.slice(-30))); } catch (e) { /* sin almacenamiento */ }
}
function agregarRechazo(desc, mensaje) {
  var l = leerRechazos();
  l.push({ desc: desc, mensaje: mensaje, ts: Date.now() });
  guardarRechazos(l);
  actualizarIndicador();
}

/* ---------- Encolar y sincronizar ---------- */
function encolar(fn, args, desc) {
  var op = { fn: fn, args: args, desc: desc, ts: Date.now(), tries: 0, fallida: false, error: '' };
  return colaAgregar(op).then(function (o) {
    actualizarIndicador();
    setTimeout(sincronizar, 0);
    return o;
  });
}

function sincronizar() {
  if (SYNC.promesa) return SYNC.promesa;
  SYNC.enviados = 0;
  SYNC.promesa = bucleSync().then(finSync, finSync);
  return SYNC.promesa;
}

function finSync() {
  SYNC.promesa = null;
  colaListar().then(function (ops) {
    if (SYNC.enviados > 0 && ops.length === 0) {
      SYNC.recienEnviado = true;
      setTimeout(function () { SYNC.recienEnviado = false; actualizarIndicador(); }, 4000);
    }
    actualizarIndicador();
  });
}

async function bucleSync() {
  for (;;) {
    var ops = await colaListar();
    var op = ops.filter(function (o) { return !o.fallida; })[0];
    if (!op) break;
    try {
      var r = await api(op.fn, op.args);
      if (r && r.busy) break;                          // servidor ocupado: se reintenta más tarde
      await colaBorrar(op.seq);
      SYNC.enviados++;
      if (typeof alResultadoCola === 'function') {
        try { await alResultadoCola(op, r); } catch (e) { console.error(e); }
      }
    } catch (err) {
      if (err && err.sinConexion) break;               // sin señal: queda en la cola
      if (/PIN incorrecto/.test(String(err && err.message))) { agregarRechazo(op.desc, 'El PIN cambió. Vuelve a ingresar el PIN para enviar los pendientes.'); break; }
      op.tries = (op.tries || 0) + 1;
      op.error = String(err && err.message || err);
      if (op.tries >= 5) op.fallida = true;
      await colaActualizar(op);
      if (!op.fallida) break;                          // se reintenta después, manteniendo el orden
    }
  }
}

/* ---------- Indicador en la barra superior ---------- */
function alCambiarRed() { actualizarIndicador(); }

async function actualizarIndicador() {
  var chip = document.getElementById('chip-sync');
  if (!chip) return;
  var ops = await colaListar();
  var pend = ops.length;
  var fallidas = ops.filter(function (o) { return o.fallida; }).length;
  var rech = leerRechazos().length;
  var sinRed = (navigator.onLine === false) || (RED.ok === false);
  var txt = '', clase = '', estadoChip = '';
  // Con internet, un envío recién hecho tarda unos segundos en confirmarse: eso es normal y no se muestra
  // como "pendiente". Si pasan más de 15 s sin confirmarse, sí se avisa.
  var masAntigua = pend ? Math.min.apply(null, ops.map(function (o) { return o.ts; })) : 0;
  var enCurso = pend > 0 && !sinRed && (Date.now() - masAntigua) < 15000;
  if (fallidas + rech > 0) { txt = '⚠ ' + (fallidas + rech) + ' con problemas'; clase = 'err'; }
  else if (enCurso) { txt = '⏳ Enviando…'; clase = 'info'; estadoChip = 'enviando'; }
  else if (pend > 0) { txt = (sinRed ? '📡 Sin conexión · ' : '⏳ ') + pend + (pend === 1 ? ' pendiente' : ' pendientes'); clase = sinRed ? 'warn' : 'info'; }
  else if (sinRed) { txt = '📡 Sin conexión'; clase = 'warn'; }
  else if (SYNC.recienEnviado) { txt = '✅ Todo enviado'; clase = 'ok'; }
  chip.style.display = txt ? 'inline-block' : 'none';
  chip.textContent = txt;
  chip.className = 'chip-sync ' + clase;
  chip.dataset.estado = estadoChip;
}

/* ---------- Pantalla de pendientes ---------- */
function escCola(v) {
  return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function abrirModalSync() {
  var ops = await colaListar();
  var rech = leerRechazos();
  var html = '';
  if (ops.length === 0 && rech.length === 0) {
    html = '<p class="nota">No hay nada pendiente. Todo está enviado.</p>';
  }
  if (ops.length) {
    html += '<h4>Pendientes de enviar</h4>';
    ops.forEach(function (o) {
      var hora = new Date(o.ts);
      var h = ('0' + hora.getHours()).slice(-2) + ':' + ('0' + hora.getMinutes()).slice(-2);
      html += '<div class="sync-item' + (o.fallida ? ' falla' : '') + '"><div><b>' + escCola(o.desc) + '</b><br><small>' + h +
        (o.fallida ? ' · No se pudo enviar: ' + escCola(o.error) : ' · en espera') + '</small></div>' +
        (o.fallida ? '<button class="btn-mini" data-descartar="' + o.seq + '">Descartar</button>' : '') + '</div>';
    });
  }
  if (rech.length) {
    html += '<h4>El servidor no aceptó</h4>';
    rech.forEach(function (r) {
      html += '<div class="sync-item falla"><div><b>' + escCola(r.desc) + '</b><br><small>' + escCola(r.mensaje) + '</small></div></div>';
    });
  }
  document.getElementById('sync-lista').innerHTML = html;
  document.getElementById('sync-limpiar').style.display = rech.length ? 'inline-block' : 'none';
  document.getElementById('modal-sync').classList.add('abierto');
}

function initCola() {
  var chip = document.getElementById('chip-sync');
  // Mientras solo está enviando (con internet) no hay nada que revisar: el aviso no abre la lista.
  if (chip) chip.addEventListener('click', function () { if (chip.dataset.estado === 'enviando') return; abrirModalSync(); });
  document.getElementById('sync-cerrar').addEventListener('click', function () { document.getElementById('modal-sync').classList.remove('abierto'); });
  document.getElementById('sync-reintentar').addEventListener('click', async function () {
    var ops = await colaListar();
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].fallida) { ops[i].fallida = false; ops[i].tries = 0; await colaActualizar(ops[i]); }
    }
    document.getElementById('modal-sync').classList.remove('abierto');
    sincronizar();
  });
  document.getElementById('sync-limpiar').addEventListener('click', function () {
    guardarRechazos([]);
    actualizarIndicador();
    abrirModalSync();
  });
  document.getElementById('sync-lista').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-descartar]');
    if (!b) return;
    await colaBorrar(Number(b.getAttribute('data-descartar')));
    actualizarIndicador();
    abrirModalSync();
  });

  window.addEventListener('online', function () { sincronizar(); actualizarIndicador(); });
  window.addEventListener('offline', actualizarIndicador);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sincronizar(); });
  // Reintento periódico mientras haya pendientes (por si la señal vuelve sin avisar).
  setInterval(function () {
    colaListar().then(function (ops) {
      if (ops.some(function (o) { return !o.fallida; }) && !SYNC.promesa) sincronizar();
    });
  }, 30000);
  // Refresca el aviso cada pocos segundos (para pasar de "Enviando…" a "N pendientes" si algo no se confirma).
  setInterval(function () { if (!document.hidden) actualizarIndicador(); }, 4000);
  actualizarIndicador();
}
