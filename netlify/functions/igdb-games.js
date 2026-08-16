// netlify/functions/igdb-games.js
//
// Proxy hacia la IGDB API (Internet Game Database, propiedad de Twitch/
// Amazon — https://api-docs.igdb.com/). Reemplaza a rawg-games.js: mismo
// propósito (fuente estructurada real de videojuegos) y MISMO formato de
// respuesta hacia el frontend, para no tener que tocar index.html — solo
// cambia la URL del endpoint que llama el frontend.
//
// IGDB usa autenticación OAuth de Twitch (no una simple API key como RAWG):
// se pide un "app access token" con tu Client ID + Client Secret, y ese
// token se reutiliza mientras sea válido (~60 días). Esta función cachea el
// token en memoria del proceso de la función para no pedir uno nuevo en
// cada request (Twitch limita cuántos tokens puedes generar).
//
// Variables de entorno requeridas en Netlify:
//   IGDB_CLIENT_ID
//   IGDB_CLIENT_SECRET
// Se consiguen gratis (sin tarjeta) así:
//   1) Crea una cuenta en https://dev.twitch.tv/console
//   2) "Register Your Application" -> nombre cualquiera, OAuth Redirect URL
//      puede ser "https://localhost" (no se usa realmente), categoría
//      "Application Integration".
//   3) Te da un Client ID; genera un Client Secret desde la misma app.
//
// Uso: /.netlify/functions/igdb-games?mode=upcoming
//      /.netlify/functions/igdb-games?mode=popular
//      /.netlify/functions/igdb-games?mode=random

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const IGDB_BASE = "https://api.igdb.com/v4";

// Caché en memoria del token: sobrevive entre invocaciones mientras la
// función de Netlify siga "caliente" (instancia reutilizada). Si la
// instancia se recicla, simplemente se pide un token nuevo — no rompe nada,
// solo evita pedir uno nuevo en cada request cuando no hace falta.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

exports.handler = async (event) => {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "Falta configurar IGDB_CLIENT_ID o IGDB_CLIENT_SECRET en Netlify (Site settings > Environment variables)." }, 500);
  }

  const mode = (event.queryStringParameters && event.queryStringParameters.mode) || "popular";

  try {
    const token = await getAppAccessToken(clientId, clientSecret);
    const games = await queryIgdb(mode, clientId, token);
    return jsonResponse({ ok: true, games });
  } catch (e) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
};

async function getAppAccessToken(clientId, clientSecret) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const url = `${TWITCH_TOKEN_URL}?client_id=${encodeURIComponent(clientId)}`
    + `&client_secret=${encodeURIComponent(clientSecret)}`
    + `&grant_type=client_credentials`;

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.message || `No se pudo obtener token de Twitch/IGDB (HTTP ${res.status}).`);
  }

  cachedToken = json.access_token;
  // Se resta un margen de 5 minutos a la expiración real para nunca usar un
  // token justo al filo de vencer.
  cachedTokenExpiresAt = now + (json.expires_in - 300) * 1000;
  return cachedToken;
}

// IGDB usa su propio lenguaje de consulta (Apicalypse), vía POST con el
// cuerpo como texto plano, no JSON.
async function queryIgdb(mode, clientId, token) {
  const nowSec = Math.floor(Date.now() / 1000);
  const in60days = nowSec + 60 * 24 * 60 * 60;
  const ago90 = nowSec - 90 * 24 * 60 * 60;

  // Se pide "screenshots.url" además de "cover.url": el cover de IGDB
  // (t_cover_big) mide solo 227x320px, muy por debajo del mínimo de 1080px
  // que exige el filtro de calidad del frontend (MIN_IMAGE_DIMENSION en
  // index.html) — así que TODA publicación basada en IGDB terminaba cayendo
  // siempre a la imagen de respaldo genérica, sin importar qué tan bueno
  // fuera el juego encontrado. Los screenshots de IGDB sí llegan a 1920x1080
  // reales (t_1080p), y son la imagen correcta para una publicación de
  // videojuegos de todos modos (una captura del juego, no solo la carátula).
  const fields = "name,first_release_date,rating,aggregated_rating,platforms.name,genres.name,summary,cover.url,screenshots.url";

  let body;
  if (mode === "upcoming") {
    // Juegos con fecha de lanzamiento confirmada en los próximos 60 días.
    body = `fields ${fields}; where first_release_date > ${nowSec} & first_release_date < ${in60days} & cover != null; sort hypes desc; limit 20;`;
  } else if (mode === "random") {
    // Dato curioso: juego bien valorado, de un rango aleatorio del ranking.
    const offset = Math.floor(Math.random() * 200);
    body = `fields ${fields}; where rating != null & cover != null; sort rating desc; limit 20; offset ${offset};`;
  } else {
    // "popular": lanzamientos recientes (últimos 90 días) ordenados por qué
    // tanto se está siguiendo/agregando ahora mismo.
    body = `fields ${fields}; where first_release_date > ${ago90} & first_release_date < ${nowSec} & cover != null; sort hypes desc; limit 20;`;
  }

  const res = await fetch(`${IGDB_BASE}/games`, {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "text/plain"
    },
    body
  });
  const json = await res.json();

  if (!res.ok) {
    const message = (json && json[0] && json[0].message) || json.message || `HTTP ${res.status}`;
    throw new Error(`IGDB: ${message}`);
  }

  const list = Array.isArray(json) ? json : [];

  // Mismo formato de salida que rawg-games.js, para que el frontend
  // (index.html) no necesite ningún cambio al cambiar de proveedor.
  return list.map(g => {
    const platforms = (g.platforms || []).map(p => p.name).filter(Boolean);
    const genres = (g.genres || []).map(gn => gn.name).filter(Boolean);
    // IGDB da rating 0-100 (como Metacritic); aggregated_rating es el
    // promedio de críticas externas, más parecido a "metacritic" de RAWG.
    const metacritic = g.aggregated_rating ? Math.round(g.aggregated_rating) : null;
    const rating = g.rating ? Math.round(g.rating) : null;
    const released = g.first_release_date
      ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10)
      : null;

    // Prioridad: screenshot grande (t_1080p, 1920x1080 reales) > cover
    // grande (t_cover_big, 227x320 — se mantiene solo como último recurso,
    // ya que el frontend igual la va a descartar por tamaño casi siempre,
    // pero es mejor que no tener ninguna imagen).
    let image = "";
    if (g.screenshots && g.screenshots.length) {
      const shot = g.screenshots[0];
      if (shot && shot.url) {
        image = shot.url.replace(/^\/\//, "https://").replace(/t_[a-z0-9_]+/, "t_1080p");
      }
    }
    if (!image && g.cover && g.cover.url) {
      image = g.cover.url.replace(/^\/\//, "https://").replace(/t_[a-z0-9_]+/, "t_cover_big");
    }

    return {
      id: g.id,
      title: g.name,
      released,
      rating,
      metacritic,
      platforms,
      genres,
      image,
      // IGDB SÍ da sinopsis real (a diferencia de RAWG) — se usa tal cual,
      // recortada, como dato real adicional para el redactor de IA.
      summary: g.summary ? g.summary.slice(0, 600) : "",
      summaryHint: [
        genres.length ? `Género: ${genres.join(", ")}` : null,
        platforms.length ? `Plataformas: ${platforms.join(", ")}` : null,
        metacritic ? `Metacritic: ${metacritic}` : null
      ].filter(Boolean).join(" · ")
    };
  }).filter(g => g.image); // sin imagen no sirve para una publicación
}

function jsonResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}
