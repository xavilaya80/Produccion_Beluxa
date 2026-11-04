# Producción Beluxa — PWA

Juego de archivos **nuevo y completo** (no parcha tu proyecto actual):

```
produccion-pwa/
├── apps-script/Code.gs          ← backend completo (reemplaza todos los archivos de tu Apps Script)
├── index.html / panel.html      ← app de tablet y panel de planta
├── css/styles.css
├── js/config.js                 ← aquí va la URL de tu Apps Script
├── js/api.js  app.js  panel.js
└── manifest.webmanifest  sw.js  icons/
```

Los datos siguen en tu Google Sheet; nada se migra.

## Paso 1 — Backend (Apps Script)

Recomendado: **copia el Sheet** "Produccion_Beluxa" (Archivo > Hacer una copia) para no tocar el original,
y trabaja en el Apps Script de esa copia (Extensiones > Apps Script).

1. Borra el contenido de `Code.gs` y pega `apps-script/Code.gs` completo.
2. Elimina los archivos `Index`, `JS`, `Panel` y `Styles` (ya no se usan; la interfaz vive en GitHub).
3. Ejecuta `setup()` una vez si usas una hoja nueva (en una copia ya está todo).
4. **Implementar > Nueva implementación > Aplicación web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
5. Copia la URL que termina en `/exec`. Si la abres en el navegador debe mostrar `{"ok":true,...}`.

> Si prefieres trabajar sobre tu proyecto actual, el procedimiento es el mismo; la app antigua dejará de servir HTML.

## Paso 2 — Frontend

1. Abre `js/config.js` y pega la URL en `API_URL`.
2. Prueba local (opcional): `python -m http.server 8080` dentro de la carpeta y abre http://localhost:8080.

## Paso 3 — GitHub Pages

1. Crea un repositorio nuevo en GitHub y sube todo **excepto** la carpeta `apps-script/` (es solo el backend).
2. Repo > **Settings > Pages** > Source: *Deploy from a branch* > rama `main`, carpeta `/ (root)`.
3. La app queda en `https://TU_USUARIO.github.io/NOMBRE_REPO/` y el panel de planta en `.../panel.html`.
4. En la tablet: abrir esa URL en Chrome > menú > **Instalar app / Añadir a pantalla de inicio**.

## Pestaña Sensores

Por cada máquina: se elige jefe de turno y máquina, se toma la foto de los sensores con la cámara
y se marca **Operativo** o **No operativo** (más una observación opcional).
- La fila se guarda en el **mismo Google Sheet**, hoja `Registros_Sensores` (se crea sola la primera vez).
- La foto (JPEG reducido) se guarda en Drive, carpeta `Sensores_Maquinas`; la hoja guarda el enlace. **Todas** quedan guardadas, sin borrarse nunca.
- En la app solo se ven los sensores/fotos del **turno en curso**: día 08:00–20:00 y noche 20:00–08:00 (hora de Chile). Al cambiar el turno el panel parte vacío; el historial completo está en la hoja y en Drive.
- Las máquinas salen de `Config_Maquinas`, igual que en la pestaña Máquinas.
- Al implementar el backend, Google pedirá aceptar permisos de Drive (ya los usaba el PDF del conteo).

## Notas

- Al actualizar archivos del frontend, sube el número de `CACHE` en `sw.js` (`produccion-beluxa-v2`…) para forzar que las tablets tomen la versión nueva.
- La app abre sin internet (carcasa en caché), pero guardar registros/conteos **requiere conexión**.
- El PIN se valida en el servidor. Cambia el PIN inicial `0000` con `configurarPin('xxxx')`.
- Logo: por ahora es un badge de texto "BELUXA". Para usar el logo real agrega `icons/logo.png` y cambia `.logo-beluxa` en `css/styles.css`.
