// netlify/functions/_post-shared.js
//
// Lógica COMPARTIDA entre generate-post-gemini.js y generate-post-groq.js:
// construcción del prompt, parseo de la respuesta JSON del modelo, y
// validación de calidad del post generado.
//
// Por qué está separado en dos funciones de Netlify en vez de una sola con
// fallback interno: Netlify Functions corta la ejecución a los 10s (plan
// gratuito). Encadenar Gemini -> Groq dentro de UNA sola invocación obliga a
// repartir ese presupuesto de 10s entre ambos proveedores, dejando muy poco
// margen a cada uno y arriesgando timeouts (que el navegador recibe como
// HTML de error, no JSON). Con dos funciones independientes, el frontend
// llama primero a generate-post-gemini y, si falla, hace una segunda
// petición HTTP a generate-post-groq — cada una arranca su propio conteo de
// 10s desde cero, así que cada proveedor recupera su margen completo.
//
// El nombre empieza con "_" para que Netlify no lo trate como un endpoint
// invocable por su cuenta (no exporta "handler"); solo se usa vía require().

const POST_TYPE_GUIDANCE = {
  noticia: "Es una NOTICIA/novedad confirmada (temporada actual o próximo estreno). Anuncia la novedad con energía, como si fuera información fresca que la comunidad necesita saber ya.",
  ficha: "Es una FICHA/recomendación (por ejemplo, un manga o serie para descubrir). Preséntala como una recomendación entusiasta, invitando a la gente a sumarla a su lista.",
  curiosidad: "Es una CURIOSIDAD/dato de trivia. Cuéntalo con tono de 'dato que no todos conocen', generando intriga antes de revelar el detalle.",
  debate: "Es un DEBATE/pregunta de opinión para la comunidad. El objetivo es generar discusión sana en los comentarios; no afirmes hechos, formula una pregunta abierta y genuina."
};

function parseAndValidateItem(event) {
  if (event.httpMethod !== "POST") {
    return { error: { body: { error: "Método no permitido" }, status: 405 } };
  }

  let item;
  try {
    item = JSON.parse(event.body || "{}");
  } catch (e) {
    return { error: { body: { error: "Cuerpo de solicitud inválido." }, status: 400 } };
  }

  let { title, postType, category, summary, extra, source } = item;
  if (!title || typeof title !== "string" || !title.trim()) {
    return { error: { body: { error: "Falta el título del ítem." }, status: 400 } };
  }

  title = title.trim().slice(0, 200);
  summary = typeof summary === "string" ? summary.trim().slice(0, 1500) : summary;
  source = typeof source === "string" ? source.trim().slice(0, 100) : source;

  return { item: { title, postType, category, summary, extra, source } };
}

function buildPrompt({ title, postType, category, summary, extra, source }) {
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

  return `Eres el redactor de contenido de una página de Facebook en español latino dedicada al anime, manga, manhwa y videojuegos. Escribes como un fan apasionado del nicho, no como un periodista, un medio de comunicación ni una IA. Tu voz es cercana, entusiasta, con personalidad y pequeños toques de humor u opinión cuando encajan naturalmente.

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
5. Cierre: una pregunta corta y directa a la comunidad para generar comentarios. Cuando el tema se preste naturalmente a dos posturas o reacciones claras (ej. "¿esperaban esto o no?", "¿qué opinan del cambio de estudio?", una rivalidad entre personajes, una comparación), usa el formato de encuesta con dos opciones en líneas separadas con emoji (ej. "🔥 SÍ, ..." / "👀 Prefiero..."); si el tema no tiene dos posturas claras, deja solo la pregunta abierta sin forzar la encuesta.
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
}

// Valida que el post cumpla las reglas mínimas del prompt. Si el modelo
// devuelve algo demasiado corto, sin párrafos separados o sin hashtags
// suficientes, esto lo detecta para que el llamador pueda decidir qué hacer
// en vez de aceptar en silencio una publicación pobre.
function validatePost(parsed) {
  const problems = [];

  const body = (parsed.body || "").trim();
  const headline = (parsed.headline || "").trim();
  const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter(h => typeof h === "string" && h.trim()) : [];

  const bodyWordCount = body ? body.split(/\s+/).filter(Boolean).length : 0;
  if (bodyWordCount < 25) {
    problems.push(`body demasiado corto (${bodyWordCount} palabras, se esperan al menos ~25-30)`);
  }

  const paragraphBlocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (paragraphBlocks.length < 3) {
    problems.push(`faltan saltos de párrafo (se encontraron ${paragraphBlocks.length} bloques, se esperan 3: párrafo, dato/opinión, pregunta de cierre)`);
  }

  if (hashtags.length < 5) {
    problems.push(`muy pocos hashtags (${hashtags.length}, se esperan 5-8)`);
  }

  if (!headline) {
    problems.push("falta headline");
  }

  const lastBlock = paragraphBlocks[paragraphBlocks.length - 1] || "";
  if (lastBlock && !lastBlock.includes("?") && !/¿/.test(lastBlock)) {
    problems.push("el cierre no parece una pregunta a la comunidad");
  }

  return { valid: problems.length === 0, problems };
}

// Parsea el JSON { headline, body, hashtags } devuelto por cualquiera de
// los dos proveedores y arma la respuesta final común.
function parsePostJSON(rawText, providerName) {
  let cleanText = rawText.trim();
  if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (e) {
    const match = cleanText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        return { ok: false, error: `No se pudo interpretar la respuesta de ${providerName} como JSON. Fragmento: ` + cleanText.slice(0, 200), status: 502 };
      }
    } else {
      return { ok: false, error: `No se pudo interpretar la respuesta de ${providerName} como JSON. Fragmento: ` + cleanText.slice(0, 200), status: 502 };
    }
  }

  if (!parsed.headline || !parsed.body) {
    return { ok: false, error: `Respuesta de ${providerName} incompleta.`, status: 502 };
  }

  const check = validatePost(parsed);
  if (!check.valid) {
    return {
      ok: false,
      error: `Respuesta de ${providerName} no cumple los estándares de calidad: ${check.problems.join("; ")}.`,
      status: 502
    };
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

  return {
    ok: true,
    data: {
      headline: parsed.headline.trim(),
      text: fullText,
      provider: providerName
    }
  };
}

function jsonResponse(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  };
}

module.exports = { parseAndValidateItem, buildPrompt, parsePostJSON, jsonResponse };
