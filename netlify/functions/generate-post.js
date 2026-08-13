// netlify/functions/generate-post.js
//
// Recibe los datos crudos de un ítem (título, sinopsis/resumen, categoría,
// tipo de publicación, estadísticas extra, fuente) y le pide a la API de
// Gemini que redacte el texto FINAL de la publicación de Facebook: en
// español, largo, carismático y natural, traduciendo cualquier contenido
// que venga en inglés (sinopsis de MAL, notas de prensa en inglés, etc.).
//
// Variable de entorno requerida en Netlify (Site settings > Environment
// variables): GEMINI_API_KEY
// Se consigue gratis en https://aistudio.google.com/apikey (no pide tarjeta).
//
// Si la clave no está configurada, o Gemini falla/se queda sin cuota
// gratuita del día, esta función devuelve un error controlado y el
// frontend (index.html) cae automáticamente al modo de plantillas local
// como respaldo, para que la app nunca se rompa.

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const POST_TYPE_GUIDANCE = {
  noticia: "Es una NOTICIA/novedad confirmada (temporada actual o próximo estreno). Anuncia la novedad con energía, como si fuera información fresca que la comunidad necesita saber ya.",
  ficha: "Es una FICHA/recomendación (por ejemplo, un manga o serie para descubrir). Preséntala como una recomendación entusiasta, invitando a la gente a sumarla a su lista.",
  curiosidad: "Es una CURIOSIDAD/dato de trivia. Cuéntalo con tono de 'dato que no todos conocen', generando intriga antes de revelar el detalle.",
  debate: "Es un DEBATE/pregunta de opinión para la comunidad. El objetivo es generar discusión sana en los comentarios; no afirmes hechos, formula una pregunta abierta y genuina."
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "Falta configurar GEMINI_API_KEY en Netlify (Site settings > Environment variables)." }, 500);
  }

  let item;
  try {
    item = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse({ error: "Cuerpo de solicitud inválido." }, 400);
  }

  const { title, postType, category, summary, extra, source } = item;
  if (!title) {
    return jsonResponse({ error: "Falta el título del ítem." }, 400);
  }

  const guidance = POST_TYPE_GUIDANCE[postType] || POST_TYPE_GUIDANCE.noticia;

  const extraBits = [];
  if (extra) {
    if (extra.score) extraBits.push(`puntuación: ${extra.score}`);
    if (extra.episodes) extraBits.push(`episodios: ${extra.episodes}`);
    if (extra.chapters) extraBits.push(`capítulos: ${extra.chapters}`);
    if (extra.status) extraBits.push(`estado: ${extra.status}`);
    if (extra.year) extraBits.push(`año: ${extra.year}`);
    if (extra.season) extraBits.push(`temporada: ${extra.season}`);
    if (extra.studios) extraBits.push(`estudio(s): ${extra.studios}`);
    if (extra.favorites) extraBits.push(`favoritos: ${extra.favorites}`);
  }

  const prompt = `Eres el redactor de contenido de una página de Facebook en español latino dedicada a anime, manga, manhwa y videojuegos, con un estilo cercano, entusiasta y con carisma de fan (no suena a robot ni a nota de prensa institucional).

TAREA: redactar el texto de UNA publicación de Facebook basada ÚNICAMENTE en estos datos reales (no inventes puntuaciones, fechas, nombres ni hechos que no estén aquí; si un dato no está, simplemente no lo menciones):

- Título: ${title}
- Categoría: ${category || "anime"}
- Tipo de publicación: ${postType || "noticia"} — ${guidance}
- Resumen / sinopsis (puede venir en inglés u otro idioma, tradúcelo al español de forma natural, sin traducción literal forzada): ${summary || "(sin resumen disponible, apóyate solo en el título)"}
- Datos adicionales confirmados: ${extraBits.length ? extraBits.join(", ") : "(ninguno)"}
- Fuente: ${source || "fuente no especificada"}

ESTILO Y FORMATO EXIGIDOS:
- Todo el texto en español latino, natural y fluido. Nunca dejes texto en inglés.
- Extenso y con carisma: entre 100 y 200 palabras en el cuerpo (sin contar hashtags), repartidas en 2 a 4 párrafos cortos separados por salto de línea doble.
- Abre con un gancho llamativo (headline corto, con 1 o 2 emojis) que dé ganas de seguir leyendo.
- Desarrolla el tema con voz de fan: entusiasmo genuino, algún comentario/opinión ligera, sin sonar exagerado ni clickbait vacío.
- Cierra con una pregunta directa a la audiencia para generar comentarios.
- Menciona la fuente de forma natural en algún punto del cuerpo (por ejemplo "según ${source || "la fuente"}"), sin necesidad de una línea aparte tipo ficha técnica.
- Genera entre 5 y 8 hashtags relevantes en español (mezcla de específicos del título/categoría y genéricos del nicho: anime, manga, manhwa, videojuegos, otaku), cada uno debe empezar con #.
- No repitas el headline dentro del cuerpo.
- No uses comillas envolviendo todo el texto.

Responde EXCLUSIVAMENTE en el formato JSON solicitado.`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.95,
      topP: 0.95,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          headline: { type: "STRING" },
          body: { type: "STRING" },
          hashtags: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["headline", "body", "hashtags"]
      }
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const json = await res.json();

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      // 429 = se acabó la cuota gratuita del día/minuto; el frontend cae a plantillas.
      return jsonResponse({ error: message }, res.status);
    }

    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return jsonResponse({ error: "Gemini no devolvió contenido (posible bloqueo de seguridad)." }, 502);
    }

    // Gemini a veces envuelve el JSON en un bloque de código markdown
    // (```json ... ```) aunque se le pida responseMimeType "application/json".
    // Limpiamos eso antes de intentar parsear.
    let cleanText = rawText.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    }
    // A veces también puede venir con texto antes/después del JSON; intentamos
    // extraer el primer objeto { ... } completo como último recurso.
    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (e) {
      const match = cleanText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (e2) {
          return jsonResponse({ error: "No se pudo interpretar la respuesta de Gemini como JSON. Fragmento: " + cleanText.slice(0, 200) }, 502);
        }
      } else {
        return jsonResponse({ error: "No se pudo interpretar la respuesta de Gemini como JSON. Fragmento: " + cleanText.slice(0, 200) }, 502);
      }
    }

    if (!parsed.headline || !parsed.body) {
      return jsonResponse({ error: "Respuesta de Gemini incompleta." }, 502);
    }

    const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(Boolean) : [];
    const hashtagLine = hashtags.map(h => h.startsWith("#") ? h : "#" + h).join(" ");

    const fullText = [parsed.headline, "", parsed.body.trim(), hashtagLine]
      .filter(line => line !== undefined && line !== null)
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return jsonResponse({
      headline: parsed.headline.trim(),
      text: fullText
    }, 200);

  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado llamando a Gemini." : (e.message || String(e));
    return jsonResponse({ error: message }, 500);
  }
};

function jsonResponse(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  };
}
