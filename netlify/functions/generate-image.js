// netlify/functions/generate-image.js
//
// Edita/mejora la imagen OFICIAL real de la publicación (portada de MAL,
// cover de IGDB, imagen del RSS, etc.) usando Gemini 2.5 Flash Image
// ("Nano Banana") en modo edición de imagen — no genera desde cero. Si no
// hay imagen oficial disponible, cae a generación desde texto como
// respaldo. Devuelve la imagen resultante como base64 (data URL).
//
// POR QUÉ EDITAR EN VEZ DE GENERAR DESDE CERO: partir de la imagen oficial
// real y pedir una mejora/adaptación de composición es un caso de uso muy
// distinto (para el filtro de seguridad de Google) que pedir "dibuja a
// [personaje]" desde un prompt de texto vacío. Editar una imagen que el
// usuario ya tiene derecho a usar (portada pública de un catálogo como MAL/
// IGDB) tiene mucha menor probabilidad de disparar el bloqueo de
// copyright/seguridad que generar un personaje reconocible desde cero.
//
// REGLA CENTRAL (se mantiene igual que antes): esto NO elimina el filtro de
// seguridad de Google, solo reduce cuánto se dispara. Si Gemini aun así
// bloquea la edición (o, en el caso de respaldo sin imagen oficial, la
// generación desde texto) por seguridad/copyright, esta función lo detecta
// explícitamente (via finishReason o promptFeedback.blockReason) y responde
// con blocked:true — nunca intenta reformular para evadir el filtro. El
// frontend debe usar esa señal, y solo esa, para conservar la imagen
// original sin editar.
//
// Variable de entorno requerida en Netlify: GEMINI_API_KEY (la misma que
// ya usa generate-post-gemini.js).

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

// Presupuesto de tiempo: Netlify corta a los 10s (plan gratuito). Descargar
// la imagen fuente + llamar a Gemini comparten este presupuesto, por eso el
// límite de descarga es más corto (2.5s) para dejarle margen a Gemini.
const TIMEOUT_MS = 9000;
const IMAGE_FETCH_TIMEOUT_MS = 2500;

exports.handler = async (event) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY no configurada." }, 500);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  let item;
  try {
    item = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse({ error: "Cuerpo de solicitud inválido." }, 400);
  }

  const { title, category, postType, summary, sourceImageUrl } = item;
  if (!title || typeof title !== "string" || !title.trim()) {
    return jsonResponse({ error: "Falta el título." }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Intenta descargar la imagen oficial real para usarla como base de
    // edición. Si no hay URL, o la descarga falla por cualquier motivo
    // (404, CORS del lado servidor, timeout corto), se sigue sin imagen
    // fuente — no es un error fatal, cae al modo de generación desde texto.
    let sourceImage = null;
    if (sourceImageUrl && typeof sourceImageUrl === "string") {
      sourceImage = await tryFetchImageAsBase64(sourceImageUrl).catch(() => null);
    }

    const prompt = sourceImage
      ? buildEditPrompt({ title, category, postType, summary })
      : buildGeneratePrompt({ title, category, postType, summary });

    const parts = [];
    if (sourceImage) {
      parts.push({ inline_data: { mime_type: sourceImage.mimeType, data: sourceImage.base64 } });
    }
    parts.push({ text: prompt });

    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE"]
      }
    };

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

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      // 429 = cuota agotada (500/día en el free tier) — no es bloqueo de
      // copyright, el frontend debe tratarlo como "IA no disponible ahora",
      // no como señal de conservar la imagen original por copyright.
      return jsonResponse({ error: message, blocked: false, usedSourceImage: !!sourceImage }, res.status);
    }

    const candidate = json?.candidates?.[0];

    // Señal de bloqueo por seguridad/copyright: Gemini reporta esto en
    // promptFeedback.blockReason (bloqueo del prompt/imagen de entrada) o en
    // finishReason del candidato (bloqueo de la salida ya generada).
    // IMAGE_SAFETY / PROHIBITED_CONTENT / RECITATION son las razones típicas
    // cuando el filtro detecta un personaje o material protegido.
    const promptBlockReason = json?.promptFeedback?.blockReason;
    const finishReason = candidate?.finishReason;
    const isBlockedByCopyrightOrSafety = !!promptBlockReason
      || ["IMAGE_SAFETY", "PROHIBITED_CONTENT", "RECITATION", "SAFETY"].includes(finishReason);

    if (isBlockedByCopyrightOrSafety) {
      return jsonResponse({
        blocked: true,
        reason: promptBlockReason || finishReason,
        usedSourceImage: !!sourceImage
      }, 200);
    }

    const imagePart = candidate?.content?.parts?.find(p => p.inlineData || p.inline_data);
    const inline = imagePart && (imagePart.inlineData || imagePart.inline_data);

    if (!inline || !inline.data) {
      // No vino imagen y tampoco hubo señal explícita de bloqueo: se trata
      // como error genérico (no como bloqueo de copyright), para que el
      // frontend no caiga a "conservar imagen original" por una causa
      // distinta a la pensada (ej. timeout parcial, modelo sin devolver
      // contenido).
      return jsonResponse({ error: `Gemini no devolvió imagen (finishReason: ${finishReason || "desconocida"}).`, blocked: false, usedSourceImage: !!sourceImage }, 502);
    }

    const mimeType = inline.mimeType || inline.mime_type || "image/png";
    return jsonResponse({
      blocked: false,
      dataUrl: `data:${mimeType};base64,${inline.data}`,
      usedSourceImage: !!sourceImage
    }, 200);
  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado generando la imagen." : (e.message || String(e));
    return jsonResponse({ error: message, blocked: false }, 500);
  } finally {
    clearTimeout(timeout);
  }
};

// Descarga una imagen desde su URL real y la devuelve como base64 + mime
// type, listos para enviar a Gemini como imagen de entrada. Se limita el
// tamaño a 8MB (límite razonable de la API) y se usa un timeout corto para
// no comerse el presupuesto de tiempo completo de la función.
async function tryFetchImageAsBase64(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar imagen fuente`);
    const contentType = res.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) throw new Error("La URL fuente no es una imagen");
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 8 * 1024 * 1024) throw new Error("Imagen fuente demasiado grande");
    const base64 = Buffer.from(buffer).toString("base64");
    return { base64, mimeType: contentType.split(";")[0].trim() };
  } finally {
    clearTimeout(timeout);
  }
}

const CATEGORY_STYLE = {
  anime: "arte estilo anime moderno, colores vibrantes, iluminación cinematográfica",
  manga: "arte estilo manga, ilustración dinámica en blanco y negro con acentos de color",
  manhwa: "arte estilo manhwa coreano, líneas limpias, paleta de colores suaves y modernas",
  videojuegos: "arte de videojuego estilo concept art, iluminación dramática, composición de portada de juego",
  curiosidades: "ilustración temática otaku, estilo pop art anime, colores llamativos"
};

// Prompt de EDICIÓN: parte de la imagen oficial real (ya provista como
// primera parte del contenido) y pide mejorarla/adaptarla — nunca
// reemplazar el contenido reconocible por otro personaje ni "reinventar"
// la escena, solo mejorar calidad y adaptar composición al formato de
// tarjeta. Mismas condiciones de "sin texto/logos" que el modo generación.
function buildEditPrompt({ title, category, postType, summary }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.anime;

  return `Esta es la imagen OFICIAL real asociada a esta noticia/publicación: "${title}". ${summary ? `Contexto: ${summary.slice(0, 300)}` : ""}

Tarea: edita y mejora esta imagen para usarla como portada de una publicación de red social, SIN cambiar lo que la imagen representa. Instrucciones:
- Mejora nitidez, calidad y definición general de la imagen.
- Ajusta la composición y el encuadre para que funcione bien en formato vertical (proporción 4:5, retrato), dejando espacio negativo limpio en la parte superior o inferior para poder superponer texto después.
- Puedes mejorar iluminación, contraste y color de forma sutil, en línea con este estilo: ${style}.
- Conserva el contenido, los personajes y la composición original reconocibles — esto es una MEJORA de la imagen existente, no una reinterpretación ni un reemplazo.
- No agregues texto, letras, palabras, logos ni marcas de agua dentro de la imagen.
- No agregues personajes ni elementos que no estaban en la imagen original.`;
}

// Prompt de GENERACIÓN DESDE CERO: se usa solo cuando no hay imagen oficial
// disponible (no vino sourceImageUrl, o falló la descarga). Igual que
// antes: nunca pide un personaje con nombre propio o IP reconocible.
function buildGeneratePrompt({ title, category, postType, summary }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.anime;

  return `Genera UNA sola ilustración original, vertical (formato retrato, proporción 4:5), para la portada de una publicación de red social sobre cultura otaku/gaming.

Tema/contexto de la noticia (úsalo solo como inspiración de AMBIENTE y EMOCIÓN, NO reproduzcas personajes, logos ni obras con derechos de autor reconocibles): "${title}". ${summary ? `Contexto adicional: ${summary.slice(0, 300)}` : ""}

Estilo requerido: ${style}. Composición limpia con espacio negativo en la parte superior e inferior para poder superponer texto después (título arriba o abajo, según convenga). Sin texto, letras, palabras ni logos dentro de la imagen misma. Sin marcas de agua.

IMPORTANTE: la escena y los personajes deben ser ORIGINALES, inspirados en el género/tono/emoción del tema, nunca una réplica de un personaje, franquicia o marca específica existente.`;
}

function jsonResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}
