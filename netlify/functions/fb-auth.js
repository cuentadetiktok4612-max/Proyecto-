// netlify/functions/fb-auth.js
//
// Recibe el "code" que Facebook manda tras el login OAuth y hace, en el
// servidor (donde el App Secret está seguro), los 3 pasos necesarios para
// terminar con un token de PÁGINA que no caduca:
//
//   1) code  -> token de usuario de corta duración
//   2) token de usuario corto -> token de usuario de LARGA duración (~60 días)
//   3) token de usuario largo -> token de PÁGINA (este último es el que
//      efectivamente no expira, mientras la página siga activa y no se
//      revoquen permisos).
//
// Variables de entorno requeridas en Netlify (Site settings > Environment
// variables): FB_APP_ID, FB_APP_SECRET, FB_REDIRECT_URI
//
// FB_REDIRECT_URI debe ser EXACTAMENTE la misma URL que se registró en
// Facebook Developers y que usó el navegador al iniciar el login, por ej:
//   https://generadordepubli.netlify.app/.netlify/functions/fb-auth

const GRAPH_API_VERSION = "v21.0";

exports.handler = async (event) => {
  const { code, error, error_description } = event.queryStringParameters || {};

  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const redirectUri = process.env.FB_REDIRECT_URI;

  // El usuario canceló el login o Facebook rechazó la solicitud.
  if (error) {
    return htmlResponse(popupCloseScript({
      ok: false,
      message: error_description || error
    }));
  }

  if (!code) {
    return htmlResponse(popupCloseScript({
      ok: false,
      message: "Falta el código de autorización de Facebook."
    }), 400);
  }

  if (!appId || !appSecret || !redirectUri) {
    return htmlResponse(popupCloseScript({
      ok: false,
      message: "Falta configurar FB_APP_ID, FB_APP_SECRET o FB_REDIRECT_URI en Netlify."
    }), 500);
  }

  try {
    // Paso 1: code -> token de usuario de corta duración
    const tokenUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?`
      + `client_id=${encodeURIComponent(appId)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&code=${encodeURIComponent(code)}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || tokenJson.error) {
      throw new Error(tokenJson.error?.message || `HTTP ${tokenRes.status} en el paso 1`);
    }
    const shortUserToken = tokenJson.access_token;
    if (!shortUserToken) throw new Error("Facebook no devolvió un token de usuario (paso 1).");

    // Paso 2: token de usuario corto -> token de usuario de larga duración
    const exchangeUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?`
      + `grant_type=fb_exchange_token`
      + `&client_id=${encodeURIComponent(appId)}`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&fb_exchange_token=${encodeURIComponent(shortUserToken)}`;

    const exchangeRes = await fetch(exchangeUrl);
    const exchangeJson = await exchangeRes.json();
    if (!exchangeRes.ok || exchangeJson.error) {
      throw new Error(exchangeJson.error?.message || `HTTP ${exchangeRes.status} en el paso 2`);
    }
    const longUserToken = exchangeJson.access_token;
    if (!longUserToken) throw new Error("Facebook no devolvió un token de usuario de larga duración (paso 2).");

    // Paso 3: con el token de usuario largo, pedir las páginas que administra
    // esta persona — el access_token que trae cada página ahí YA es permanente.
    const pagesUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts?access_token=${encodeURIComponent(longUserToken)}`;
    const pagesRes = await fetch(pagesUrl);
    const pagesJson = await pagesRes.json();
    if (!pagesRes.ok || pagesJson.error) {
      throw new Error(pagesJson.error?.message || `HTTP ${pagesRes.status} en el paso 3`);
    }

    const pages = (pagesJson.data || []).map(p => ({
      id: p.id,
      name: p.name,
      access_token: p.access_token
    }));

    if (pages.length === 0) {
      throw new Error("Tu cuenta no administra ninguna página de Facebook, o no diste permiso sobre ninguna al iniciar sesión.");
    }

    // Le devolvemos la lista de páginas al popup; el frontend deja elegir
    // si administra más de una.
    return htmlResponse(popupCloseScript({ ok: true, pages }));

  } catch (e) {
    return htmlResponse(popupCloseScript({
      ok: false,
      message: e.message || String(e)
    }), 500);
  }
};

// Responde con una paginita HTML mínima que le pasa el resultado a la
// ventana que abrió el popup (via postMessage) y luego se cierra sola.
function popupCloseScript(payload) {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Conectando con Facebook…</title></head>
<body style="font-family:sans-serif;background:#0f1216;color:#eef1f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <p>${payload.ok ? "Conexión exitosa, puedes cerrar esta ventana…" : "Ocurrió un error, cerrando…"}</p>
  <script>
    (function(){
      var payload = ${json};
      if (window.opener) {
        window.opener.postMessage({ source: "otagen-fb-auth", payload: payload }, "*");
      }
      setTimeout(function(){ window.close(); }, payload.ok ? 600 : 2500);
    })();
  </script>
</body></html>`;
}

function htmlResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body
  };
}
