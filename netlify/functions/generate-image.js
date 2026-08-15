// netlify/functions/generate-image.js
//
// Genera o edita la imagen de portada de una publicación usando Cloudflare
// Workers AI (gratis, 10,000 Neurons/día, sin tarjeta de crédito):
//   - Si hay imagen OFICIAL real disponible (portada de MAL, cover de IGDB,
//     imagen del RSS) -> se EDITA/mejora con @cf/runwayml/stable-diffusion-
//     v1-5-img2img, conservando el contenido original, solo mejorando
//     nitidez/composición/color.
//   - Si no hay imagen oficial -> se GENERA desde cero con
//     @cf/black-forest-labs/flux-1-schnell, sin pedir nunca personajes con
//     nombre propio o IP reconocible.
//
// SOBRE LA CALIDAD DE LA EDICIÓN: @cf/runwayml/stable-diffusion-v1-5-img2img
// es, a la fecha, el ÚNICO modelo de Cloudflare Workers AI que (a) acepta una
// imagen de entrada para editar y (b) sigue etiquetado "Beta" -> gratis e
// ilimitado dentro del pool de Neurons (los modelos más nuevos de edición
// unificada, como flux-2-klein, son modelos "Partner" con precio por tile,
// NO cubiertos por el tier gratuito). Es un modelo de 2024 y no entiende el
// contenido semánticamente como los modelos multimodales modernos: solo
// difunde ruido guiado por el prompt sobre la imagen de entrada. Por eso:
//   - `strength` se mantiene BAJO (ver STRENGTH_EDIT) para que el resultado
//     se quede cerca de la imagen real en vez de "reinventarla" — el
//     objetivo es mejorar nitidez/color, no transformar el contenido.
//   - `num_steps` va al máximo que permite el modelo (20) para la mejor
//     calidad posible dentro de este modelo.
//   - El prompt de edición es deliberadamente conservador (ver
//     buildEditPrompt): pide explícitamente PRESERVAR la composición y el
//     sujeto, no reinterpretarlos.
//
// MANEJO DE SATURACIÓN (error 3040 "Capacity temporarily exceeded"): es un
// error transitorio de Cloudflare (no de esta cuenta ni de sus créditos:
// eso sería el error 3036, distinto) que ocurre cuando no hay datacenter
// GPU disponible en ese instante para el modelo pedido. Esta función:
//   1. Reintenta una vez de inmediato contra Cloudflare (dentro del mismo
//      presupuesto de 9s), ya que a veces el siguiente intento cae en otro
//      datacenter con capacidad libre.
//   2. Si aun así falla, devuelve capacityError:true para que el FRONTEND
//      reintente con espera larga (varios minutos), y si se agota ese
//      tiempo, use su propio respaldo con Canvas 2D (sin IA) que SÍ
//      conserva la imagen oficial. Cuando la solicitud era de EDICIÓN
//      (había imagen oficial), esta función NUNCA cae a generar una
//      ilustración desde cero como sustituto silencioso: eso reemplazaría
//      la imagen real de la noticia por arte inventado sin avisar.
//
// POR QUÉ CLOUDFLARE Y NO GEMINI/OTROS: a la fecha, ningún proveedor con
// modelos de edición de imagen que SÍ entienden contenido semánticamente
// (Gemini 3.1 Flash Image, etc.) ofrece tier gratuito para generación de
// imágenes vía API — todos cobran por imagen. Cloudflare Workers AI es hoy
// la única opción con tier gratuito real para esto. Si en el futuro se
// decide asumir un costo mínimo (unos centavos por imagen), migrar a un
// modelo multimodal de edición real sería el siguiente paso natural.
//
// NOTA SOBRE COPYRIGHT: a diferencia de Gemini, los modelos de Stable
// Diffusion/FLUX en Cloudflare no traen un filtro de seguridad explícito
// que reporte "bloqueado por copyright" en la respuesta (no hay un
// finishReason ni blockReason equivalente). Por eso esta función YA NO
// puede detectar bloqueos de copyright de forma confiable — simplemente
// nunca se le pide reproducir un personaje con nombre propio en el prompt
// de generación desde cero, y en edición se le pide conservar el contenido
// original tal cual (mejorar, no reinterpretar), lo cual reduce el riesgo
// por diseño del prompt en vez de por un filtro de la plataforma. El campo
// "blocked" se mantiene en la respuesta por compatibilidad con el frontend,
// pero siempre será false con este proveedor.
//
// Variables de entorno requeridas en Netlify:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_API_TOKEN (con permiso "Workers AI - Read/Edit")
// Se consiguen gratis en https://dash.cloudflare.com (cuenta gratis) ->
// "Workers & Pages" -> "AI" para el Account ID, y "My Profile" -> "API
// Tokens" -> "Create Token" -> plantilla "Workers AI" para el token.

const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";
const MODEL_GENERATE = "@cf/black-forest-labs/flux-1-schnell";
const MODEL_EDIT = "@cf/runwayml/stable-diffusion-v1-5-img2img";

// Cuánto se permite que el modelo se aleje de la imagen de entrada durante
// la edición (0 = idéntica a la original, 1 = ignora la original). Antes
// estaba en 0.55, que en la práctica reinterpreta bastante la imagen. Se
// baja a 0.30 para que el resultado se quede fiel al contenido real
// (mismo personaje/escena/composición) y el cambio se note solo en
// nitidez, color y detalle — que es lo que se pidió: "editar la imagen
// oficial, mejorar calidad y colores", no generar una versión distinta.
const STRENGTH_EDIT = 0.30;
const NUM_STEPS_EDIT = 20; // máximo permitido por este modelo

// Presupuesto de tiempo: Netlify corta a los 10s (plan gratuito). Descargar
// la imagen fuente + llamar a Cloudflare comparten este presupuesto.
const TIMEOUT_MS = 9000;
const IMAGE_FETCH_TIMEOUT_MS = 2500;

exports.handler = async (event) => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    return jsonResponse({ error: "Falta configurar CLOUDFLARE_ACCOUNT_ID o CLOUDFLARE_API_TOKEN en Netlify." }, 500);
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
    let sourceImageB64 = null;
    // Solo se acepta una URL http(s) real como imagen fuente para editar.
    // Si llega un data: URL (por ejemplo, si el frontend accidentalmente
    // reenviara una imagen ya procesada en vez de la URL pública original),
    // se ignora aquí y la solicitud cae a modo GENERAR desde cero en vez de
    // editar sobre una imagen que ya no es la oficial. Esto blinda en el
    // backend la regla de que la edición parte siempre de la foto real,
    // nunca de un resultado previo de la IA o del respaldo local.
    if (sourceImageUrl && typeof sourceImageUrl === "string" && /^https?:\/\//i.test(sourceImageUrl)) {
      sourceImageB64 = await tryFetchImageAsBase64(sourceImageUrl).catch(() => null);
    }

    let usedSourceImage = !!sourceImageB64;
    let model = usedSourceImage ? MODEL_EDIT : MODEL_GENERATE;
    let prompt = usedSourceImage
      ? buildEditPrompt({ title, category, postType, summary })
      : buildGeneratePrompt({ title, category, postType, summary });

    let payload = { prompt };
    if (usedSourceImage) {
      payload.image_b64 = sourceImageB64;
      payload.strength = STRENGTH_EDIT;
      payload.num_steps = NUM_STEPS_EDIT;
      // Refuerza en negativo lo que el prompt positivo ya pide preservar:
      // evita que el modelo "invente" un personaje, escena o estilo
      // distintos al de la imagen real que se está editando.
      payload.negative_prompt = "different character, different subject, different scene, altered composition, reinterpreted content, changed pose, low quality, blurry, distorted, watermark, text";
    } else {
      payload.width = 864;
      payload.height = 1080;
    }

    const callCloudflare = () => fetch(`${CF_BASE}/${accountId}/ai/run/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    let res = await callCloudflare();

    // Error 3040 de Cloudflare ("Out of capacity" / 429): significa que en
    // ese instante no había datacenter disponible para el modelo, NO que se
    // acabó la cuota gratuita (eso es el error 3036, distinto). Es
    // transitorio y muchas veces se resuelve reintentando de inmediato
    // contra otro datacenter. Se reintenta UNA vez sin esperar, porque
    // Netlify free corta a los 10s y ya no queda presupuesto para un
    // backoff largo aquí (el frontend hace los reintentos con espera).
    if (!res.ok && res.status === 429) {
      const errJsonPeek = await res.clone().json().catch(() => ({}));
      const code = errJsonPeek?.errors?.[0]?.code;
      if (code === 3040 || !code) {
        res = await callCloudflare();
      }
    }

    // IMPORTANTE: si la solicitud es de EDICIÓN (había imagen oficial) y
    // sigue sin capacidad tras el reintento, YA NO se cae a generar desde
    // cero con FLUX. Hacerlo sustituía en silencio la imagen oficial de la
    // publicación por una ilustración inventada sin avisar — el usuario veía
    // "Mejorar con IA" y terminaba con una imagen que no tenía nada que ver
    // con la noticia real. Ahora, si la edición no tiene capacidad, se
    // devuelve el error de capacidad tal cual (capacityError:true) para que
    // el FRONTEND use su propio respaldo con Canvas 2D
    // (composeLocalFallbackImage), que sí conserva la imagen oficial.
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      const code = errJson?.errors?.[0]?.code;
      const rawMessage = errJson?.errors?.[0]?.message || `HTTP ${res.status}`;
      const message = code === 3040
        ? "Cloudflare está temporalmente sin capacidad para generar imágenes (no es problema de tu cuenta ni de tus créditos). Intenta de nuevo en unos segundos."
        : rawMessage;
      return jsonResponse({ error: message, capacityError: code === 3040, blocked: false, usedSourceImage }, res.status);
    }

    if (contentType.startsWith("image/")) {
      const buffer = await res.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return jsonResponse({
        blocked: false,
        dataUrl: `data:${contentType};base64,${base64}`,
        usedSourceImage
      }, 200);
    }

    const json = await res.json().catch(() => null);
    if (json && json.result && json.result.image) {
      return jsonResponse({
        blocked: false,
        dataUrl: `data:image/png;base64,${json.result.image}`,
        usedSourceImage
      }, 200);
    }

    return jsonResponse({ error: "Cloudflare no devolvió una imagen reconocible.", blocked: false, usedSourceImage }, 502);
  } catch (e) {
    // Un AbortError aquí es el timeout de 9s hacia Cloudflare. En la
    // práctica, cuando Cloudflare está saturado también puede tardar en
    // responder en vez de devolver 429 de inmediato — así que se trata
    // igual que el error de capacidad para que el frontend reintente en
    // vez de rendirse.
    const isTimeout = e.name === "AbortError";
    const message = isTimeout
      ? "Tiempo de espera agotado generando la imagen (probable saturación temporal de Cloudflare)."
      : (e.message || String(e));
    return jsonResponse({ error: message, capacityError: isTimeout, blocked: false }, isTimeout ? 429 : 500);
  } finally {
    clearTimeout(timeout);
  }
};

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
    return Buffer.from(buffer).toString("base64");
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

// Prompt deliberadamente conservador: junto con STRENGTH_EDIT bajo, el
// objetivo es que el modelo perciba esto como "restaurar/pulir la imagen
// que ya existe", no como "reinterpretarla libremente". Se nombra
// explícitamente qué se debe preservar (sujeto, pose, encuadre) antes de
// pedir la mejora, porque Stable Diffusion 1.5 tiende a ignorar
// instrucciones negativas o implícitas si no están dichas primero.
function buildEditPrompt({ category }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.anime;
  return `same subject, same pose, same composition, same framing, preserve original content exactly, only enhance: sharper details, richer color grading, improved lighting and contrast, higher fidelity, ${style}, professional social media cover quality, vertical portrait format`;
}

function buildGeneratePrompt({ category }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.anime;
  return `original anime/manga illustration, ${style}, dynamic composition, vertical portrait format, no text, no watermark, no logos, original characters only, not based on any specific existing franchise or character`;
}

function jsonResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}
