/* Cliente de la API de Apps Script.
   POST con cuerpo text/plain (sin Content-Type personalizado) para evitar
   el preflight CORS, que Apps Script no soporta. */
function api(nombreFn, args) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 90000);   // cerrarConteo puede tardar (PDF + correo)

  return fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ fn: nombreFn, args: args || [] }),
    redirect: 'follow',
    signal: ctl.signal
  }).then(function (res) {
    return res.json();
  }).then(function (data) {
    if (data && data.error) throw new Error(data.error);
    return data.result;
  }).catch(function (err) {
    if (err && err.name === 'AbortError') throw new Error('El servidor tardó demasiado en responder.');
    if (err instanceof TypeError) throw new Error('Sin conexión con el servidor. Revisa tu internet.');
    throw err;
  }).finally(function () {
    clearTimeout(timer);
  });
}
