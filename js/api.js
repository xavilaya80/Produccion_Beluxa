/* Cliente de la API de Apps Script.
   POST con cuerpo text/plain (sin Content-Type personalizado) para evitar
   el preflight CORS, que Apps Script no soporta.
   Los errores de red/tiempo de espera llevan err.sinConexion = true: la cola
   offline los reconoce y reintenta más tarde en vez de descartar el registro. */
var RED = { ok: null };            // null = aún no se sabe; true/false según el último intento

function marcarRed(ok) {
  if (RED.ok === ok) return;
  RED.ok = ok;
  if (typeof alCambiarRed === 'function') alCambiarRed();
}

function api(nombreFn, args, timeoutMs) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 90000);   // cerrarConteo puede tardar (PDF + correo)

  return fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ fn: nombreFn, args: args || [] }),
    redirect: 'follow',
    signal: ctl.signal
  }).then(function (res) {
    return res.json();
  }).then(function (data) {
    marcarRed(true);
    if (data && data.error) throw new Error(data.error);
    return data.result;
  }).catch(function (err) {
    var e = err;
    if (err && err.name === 'AbortError') {
      e = new Error('El servidor tardó demasiado en responder.');
      e.sinConexion = true;
    } else if (err instanceof TypeError) {
      e = new Error('Sin conexión con el servidor. Revisa tu internet.');
      e.sinConexion = true;
    }
    if (e && e.sinConexion) marcarRed(false);
    throw e;
  }).finally(function () {
    clearTimeout(timer);
  });
}
