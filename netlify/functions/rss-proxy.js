// netlify/functions/rss-proxy.js
//
// Proxy propio para traer feeds RSS/Atom (y también las páginas .rss de
// Reddit, que técnicamente son Atom). Reemplaza la dependencia de proxies
// CORS públicos y gratuitos de terceros (allorigins.win, corsproxy.io,
// codetabs.com) que el frontend usaba antes vía fetchWithCorsProxy().
//
// Por qué hacía falta: esos proxies gratuitos son inherentemente
// inestables (rate limits compartidos entre TODOS sus usuarios, caídas,
// bloqueos por volumen) y se llamaban desde el navegador de cada usuario
// de la app, uno por uno, para hasta 19 fuentes distintas. En la práctica
// eso hacía que casi todas las fuentes fallaran por timeout. Una función
// de Netlify corre en el servidor de Netlify: tiene salida a internet
// normal y directa, sin pasar por esos intermediarios gratuitos.
//
// El frontend sigue teniendo el fallback a los proxies viejos (ver
// fetchWithCorsProxy en index.html) por si esta función no está disponible
// (por ejemplo, abriendo el HTML directamente sin pasar por Netlify).
//
// Uso: /.netlify/functions/rss-proxy?url=<url del feed, URL-encoded>

// Lista blanca de hosts permitidos. No es solo un detalle de seguridad
// (evitar que esta función se use como proxy abierto para cualquier URL
// arbitraria) — también deja claro, con solo mirar este archivo, qué
// fuentes puede traer el proxy. Debe mantenerse en sincronía con
// RSS_FEEDS y REDDIT_FEEDS en index.html.
const ALLOWED_HOSTS = [
  "feeds.ign.com",
  "www.siliconera.com",
  "www.pcgamer.com",
  "www.crunchyroll.com",
  "www.animenewsnetwork.com",
  "kotaku.com",
  "www.polygon.com",
  "www.cbr.com",
  "comicbook.com",
  "www.animetrending.com",
  "otakuusamagazine.com",
  "screenrant.com",
  "www.gamesradar.com",
  "www.eurogamer.net",
  "www.reddit.com",
  "old.reddit.com"
];

const FETCH_TIMEOUT_MS = 9000;

exports.handler = async (event) => {
  const rawUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!rawUrl) {
    return textResponse("Falta el parámetro 'url'.", 400);
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch (e) {
    return textResponse("URL inválida.", 400);
  }

  if (targetUrl.protocol !== "https:") {
    return textResponse("Solo se permiten URLs https.", 400);
  }
  if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    return textResponse(`Host no permitido: ${targetUrl.hostname}`, 403);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(targetUrl.toString(), {
      signal: controller.signal,
      headers: {
        // Varios sitios (Reddit incluido) devuelven un error o un feed
        // recortado si no reciben un User-Agent que parezca un navegador o
        // lector de feeds normal.
        "User-Agent": "Mozilla/5.0 (compatible; InfotakuBot/1.0; +https://infotaku.example/bot)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return textResponse(`Origen respondió HTTP ${res.status}.`, 502);
    }
    const body = await res.text();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        // Cache corto en el borde de Netlify: si varios usuarios generan
        // publicaciones casi al mismo tiempo, no hace falta pedirle el
        // mismo feed al origen una vez por usuario.
        "Cache-Control": "public, max-age=120"
      },
      body
    };
  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado" : (e.message || String(e));
    return textResponse(message, 504);
  }
};

function textResponse(message, statusCode) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: message
  };
}
