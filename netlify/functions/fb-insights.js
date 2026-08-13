// netlify/functions/fb-insights.js
//
// Consulta datos REALES de la Graph API de Facebook para la página conectada:
//   1) page_fans_online          -> en qué horas, por día de la semana, están
//                                    conectados los seguidores reales de la página.
//   2) posts recientes + insights por post (post_impressions, post_engaged_users,
//      reacciones/comentarios/compartidos) -> qué categorías/tipos de post de
//      ESTA página específica generaron más interacción.
//
// No inventa nada: si Facebook no devuelve datos suficientes (página nueva,
// pocos seguidores, permiso no otorgado, etc.), esta función lo declara
// explícitamente en la respuesta (campo "insufficientData" / "error") en vez
// de rellenar con números por defecto. El frontend debe respetar esa señal
// y mostrarlo tal cual al usuario, nunca disfrazarlo de dato real.
//
// Se llama como: /.netlify/functions/fb-insights?pageId=...&token=...
// (pageId y token vienen de las credenciales que el usuario ya conectó desde
// el frontend — no se guardan en el servidor, se reciben en cada llamada).

const GRAPH_API_VERSION = "v21.0";

exports.handler = async (event) => {
  const { pageId, token } = event.queryStringParameters || {};

  if (!pageId || !token) {
    return jsonResponse({ ok: false, error: "Falta pageId o token." }, 400);
  }

  try {
    const [fansOnlineResult, postsResult] = await Promise.all([
      fetchFansOnline(pageId, token),
      fetchRecentPostsWithInsights(pageId, token)
    ]);

    return jsonResponse({
      ok: true,
      fansOnline: fansOnlineResult,
      postsPerformance: postsResult
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message || String(e) }, 500);
  }
};

// ---------------------------------------------------------------------------
// 1) Horas reales en que la audiencia de la página está conectada.
//
// page_fans_online devuelve, por cada día consultado, un objeto donde las
// claves son la hora en UTC (0-23) y los valores el número de fans conectados
// esa hora. Facebook normalmente entrega el último día completo disponible.
// ---------------------------------------------------------------------------
async function fetchFansOnline(pageId, token) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/insights/page_fans_online`
    + `?period=day&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok || json.error) {
    // Errores típicos aquí: permiso read_insights no otorgado, token sin
    // permisos de página, o página con muy pocos fans (Facebook a veces
    // directamente omite esta métrica bajo un umbral mínimo de audiencia).
    return {
      available: false,
      reason: json.error?.message || `HTTP ${res.status} al consultar page_fans_online.`
    };
  }

  const values = (json.data && json.data[0] && json.data[0].values) || [];
  if (values.length === 0) {
    return {
      available: false,
      reason: "Facebook no devolvió datos de 'fans conectados por hora' todavía. Suele pasar en páginas nuevas o con pocos seguidores; normalmente empieza a poblarse tras acumular más actividad."
    };
  }

  // Se toma el registro más reciente (un objeto {"0": n, "1": n, ..., "23": n}, hora UTC).
  const latest = values[values.length - 1];
  const hourlyUTC = latest.value || {};

  const hoursSorted = Object.entries(hourlyUTC)
    .map(([hourUTC, fans]) => ({ hourUTC: parseInt(hourUTC, 10), fans }))
    .sort((a, b) => b.fans - a.fans);

  return {
    available: true,
    asOf: latest.end_time || null,
    hourlyUTC,
    topHoursUTC: hoursSorted.slice(0, 5)
  };
}

// ---------------------------------------------------------------------------
// 2) Rendimiento real de publicaciones recientes de la página (hasta 25).
//
// Se piden los posts más recientes junto con sus métricas de insights.
// Esto sirve para que el frontend cruce, por su cuenta, qué categorías
// propias (guardadas en localStorage al momento de publicar) coinciden con
// qué post_id de Facebook, y así saber qué categoría rindió mejor.
// ---------------------------------------------------------------------------
async function fetchRecentPostsWithInsights(pageId, token) {
  const fields = [
    "id",
    "created_time",
    "message",
    "insights.metric(post_impressions,post_engaged_users,post_reactions_like_total)"
  ].join(",");

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/posts`
    + `?fields=${encodeURIComponent(fields)}&limit=25&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok || json.error) {
    return {
      available: false,
      reason: json.error?.message || `HTTP ${res.status} al consultar posts/insights.`
    };
  }

  const posts = (json.data || []).map(p => {
    const metrics = {};
    ((p.insights && p.insights.data) || []).forEach(m => {
      const val = (m.values && m.values[0] && m.values[0].value) || 0;
      metrics[m.name] = val;
    });
    return {
      id: p.id,
      createdTime: p.created_time,
      impressions: metrics.post_impressions || 0,
      engagedUsers: metrics.post_engaged_users || 0,
      likes: metrics.post_reactions_like_total || 0
    };
  });

  if (posts.length === 0) {
    return {
      available: false,
      reason: "La página todavía no tiene publicaciones con datos de Insights disponibles."
    };
  }

  return { available: true, posts };
}

function jsonResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}
