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

  const prompt = `Eres el redactor de contenido de una página de Facebook en español latino dedicada al anime, manga, manhwa y videojuegos. Escribes como un fan apasionado del nicho, no como un periodista, un medio de comunicación ni una IA. Tu voz es cercana, entusiasta, con personalidad y pequeños toques de humor u opinión cuando encajan naturalmente.

TAREA: redactar el texto de UNA publicación de Facebook usando EXCLUSIVAMENTE estos datos reales. No inventes fechas, cifras, nombres, rumores ni hechos que no estén aquí; si un dato no aparece, simplemente no lo menciones.

- Título: ${title}
- Categoría: ${category || "anime"}
- Tipo de publicación: ${postType || "noticia"} — ${guidance}
- Resumen / sinopsis (puede venir en inglés u otro idioma: tradúcelo al español de forma natural y fluida, nunca de forma literal ni dejando frases en inglés): ${summary || "(sin resumen disponible, apóyate solo en el título)"}
- Datos adicionales confirmados: ${extraBits.length ? extraBits.join(", ") : "(ninguno)"}
- Fuente: ${source || "fuente no especificada"}

VARIEDAD (muy importante, léelo con atención):
- No repitas siempre la misma fórmula. Según el ángulo más natural para ESTOS datos concretos, decide si conviene enmarcarlo como noticia fresca, recomendación de fan, dato curioso poco conocido, comparación/opinión, o pregunta abierta para generar debate.
- Varía también cómo abres el primer párrafo: a veces con una afirmación directa, otras con una pequeña anécdota o contexto, otras con una exclamación o una pregunta retórica. Evita caer siempre en el mismo tipo de frase de apertura.
- Que cada publicación se sienta escrita por una persona distinta de humor, no por una plantilla rellenada.

ESTRUCTURA EXACTA del campo "body" (síguela al pie de la letra):
1. Primer párrafo (2 a 4 líneas): desarrolla la idea principal con el gancho más interesante de los datos disponibles. 1 o 2 emojis repartidos con naturalidad, nunca amontonados.
2. Salto de línea doble ("\\n\\n").
3. Segundo párrafo (1 a 3 líneas): un dato adicional, contexto breve, o una opinión/comentario genuino de fan sobre ese dato.
4. Salto de línea doble.
5. Cierre: una pregunta corta y directa a la comunidad para generar comentarios. Opcionalmente, dos opciones tipo encuesta en líneas separadas con emoji (ej. "🔥 SÍ, ..." / "👀 Prefiero...").
El body NUNCA va como un bloque de texto pegado: siempre debe tener esos saltos de línea dobles entre las 3 partes.

LÍMITES (estrictos):
- Máximo 90 palabras en total en el "body" (sin contar headline ni hashtags). Corto, directo, fácil de leer en un feed de celular.
- Elige un único gancho principal y como máximo un dato extra. Nada de resúmenes exhaustivos ni de listar todos los detalles del resumen.
- No repitas dentro del body nada que ya dijiste en el headline.

ESTILO Y FORMATO:
- Todo en español latino, natural y fluido. Nunca dejes texto en inglés.
- El "headline" es la única línea de gancho de todo el post: máximo 12 palabras, con 1-2 emojis, con fuerza pero sin sonar a clickbait vacío ni a titular de notaría.
- El body NUNCA debe abrir repitiendo o parafraseando el título como si fuera un subtítulo. Va directo al desarrollo, como si continuara la idea del headline sin repetirla.
- Evita frases genéricas gastadas ("no te lo puedes perder", "una verdadera joya", "atención cazadores/otakus") salvo que encajen de forma puntual; prioriza siempre algo más específico al contenido real.
- Menciona la fuente de forma natural en algún punto del body (por ejemplo "según ${source || "la fuente"}") solo si suena orgánico; si no aporta, omítela.
- Genera entre 5 y 8 hashtags relevantes en español, mezclando específicos (título/categoría/franquicia) y genéricos del nicho (anime, manga, manhwa, videojuegos, otaku). Todos deben empezar con #.
- No envuelvas el texto completo entre comillas.

Responde EXCLUSIVAMENTE en el formato JSON solicitado.`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.05,
      topP: 0.95,
      maxOutputTokens: 1400,
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
    const { json, res } = await callGeminiWithRetry(payload, apiKey);

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      // 429 = se acabó la cuota gratuita del día/minuto; el frontend cae a plantillas.
      return jsonResponse({ error: message }, res.status);
    }

    const candidate = json?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text;

    if (!rawText) {
      const reason = candidate?.finishReason || "desconocida";
      return jsonResponse({ error: `Gemini no devolvió contenido (posible bloqueo de seguridad o corte, razón: ${reason}).` }, 502);
    }

    if (candidate?.finishReason === "MAX_TOKENS") {
      return jsonResponse({ error: "La respuesta de Gemini se cortó por límite de tokens (MAX_TOKENS). Sube maxOutputTokens." }, 502);
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

    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter(h => typeof h === "string" && h.trim())
      : [];
    const hashtagLine = hashtags.map(h => h.trim().startsWith("#") ? h.trim() : "#" + h.trim()).join(" ");

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

async function callGeminiOnce(payload, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    return { json, res };
  } finally {
    clearTimeout(timeout);
  }
}

// Reintenta UNA vez, solo ante fallos transitorios (5xx o timeout/abort).
// Nunca reintenta ante 429 (cuota agotada) ni 4xx de petición mal formada,
// para no desperdiciar cuota ni demorar innecesariamente la caída a plantillas.
async function callGeminiWithRetry(payload, apiKey) {
  try {
    const first = await callGeminiOnce(payload, apiKey, 20000);
    if (first.res.ok || first.res.status === 429 || first.res.status === 400) {
      return first;
    }
    // Error transitorio (5xx): un segundo intento con margen algo mayor.
    return await callGeminiOnce(payload, apiKey, 20000);
  } catch (e) {
    if (e.name === "AbortError") {
      // Timeout en el primer intento: probamos una vez más.
      return await callGeminiOnce(payload, apiKey, 20000);
    }
    throw e;
  }
}

function jsonResponse(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  };
}
