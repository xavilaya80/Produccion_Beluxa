/* Panel de planta (TV/PC, solo lectura). Datos vía API de Apps Script. */
var datosPanel = null;

function $(id) { return document.getElementById(id); }

function escapeHTML(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function duracion(desdeMs) {
  if (!desdeMs) return '';
  var mins = Math.max(0, Math.floor((Date.now() - desdeMs) / 60000));
  var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return d + ' d ' + h + ' h';
  if (h > 0) return h + ' h ' + (m < 10 ? '0' : '') + m + ' min';
  return m + ' min';
}

function render() {
  if (!datosPanel) return;
  var maqs = datosPanel.maquinas || [];
  var nOp = 0, nDet = 0, nAlr = 0, nSin = 0;
  var html = '';

  maqs.forEach(function (m) {
    var clase = 'sin', linea = 'Sin registros en la tablet', cuerpo = '';
    if (m.estado === 'Operativa') { clase = 'op'; nOp++; linea = '🟢 OPERATIVA'; }
    if (m.estado === 'Detenida') { clase = 'det'; nDet++; linea = '⛔ DETENIDA'; }
    if (!m.estado) nSin++;
    if (m.alerta) { clase = 'alr'; nAlr++; }

    if (m.estado === 'Operativa') {
      cuerpo += m.producto
        ? '<div class="producto">🏭 ' + escapeHTML(m.producto) + ' <span style="color:var(--texto-suave)">(' + escapeHTML(m.productoCod || '') + ')</span></div>'
        : '<div class="detalle">Sin orden de fabricación activa en el ERP</div>';
    }
    if (m.estado === 'Detenida') {
      cuerpo += '<div class="detalle">Motivo: <b style="color:var(--texto)">' + escapeHTML(m.motivo || '-') + '</b></div>' +
        '<div class="tiempo">⏱ Detenida hace ' + duracion(m.inicioTs) + '</div>';
    }
    if (m.jefe && m.estado) cuerpo += '<div class="detalle">Informado por ' + escapeHTML(m.jefe) + ' · ' + escapeHTML(m.desde || '') + '</div>';
    if (m.alerta) {
      cuerpo += '<div class="alerta-inicio">⚠ INFORMAR INICIO DE MÁQUINA<br><span style="font-weight:600">El ERP registró producción el ' + escapeHTML(m.prodFecha || '') + '</span></div>';
    }

    html += '<div class="maq ' + clase + '"><div class="nombre">' + escapeHTML(m.nombre) + '</div>' +
      '<div class="estado-linea">' + linea + '</div>' + cuerpo + '</div>';
  });

  $('grid').innerHTML = html || '<div class="maq"><div class="nombre">Sin máquinas configuradas</div></div>';
  $('n-op').textContent = nOp; $('n-det').textContent = nDet;
  $('n-alr').textContent = nAlr; $('n-sin').textContent = nSin;

  var aviso = $('aviso-erp');
  if (datosPanel.avisoErp) { aviso.style.display = 'block'; aviso.textContent = '⚠ ' + datosPanel.avisoErp; }
  else aviso.style.display = 'none';
}

function cargar() {
  api('panelDatos', []).then(function (d) {
    datosPanel = d;
    $('actualizado').textContent = 'Actualizado ' + (d.generado || '');
    render();
  }, function (e) {
    $('actualizado').textContent = 'Error al actualizar: ' + e.message;
  });
}

function tickReloj() {
  var n = new Date();
  $('reloj').textContent = ('0' + n.getHours()).slice(-2) + ':' + ('0' + n.getMinutes()).slice(-2);
}

document.addEventListener('DOMContentLoaded', function () {
  tickReloj(); cargar();
  setInterval(tickReloj, 15000);
  setInterval(render, 30000);     // los "hace X min" avanzan solos
  setInterval(cargar, 60000);     // datos frescos cada minuto
});
