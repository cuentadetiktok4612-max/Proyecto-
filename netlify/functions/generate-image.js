// netlify/functions/generate-image.js
//
// Genera o edita la imagen de portada de una publicación usando Cloudflare
// Workers AI (gratis, 10,000 Neurons/día, sin tarjeta de crédito):
//   - Si hay imagen OFICIAL real disponible (portada de MAL, cover de IGDB,
//     imagen del RSS) -> se EDITA/mejora con @cf/runwayml/stable-diffusion-
//     v1-5-img2img, conservando el contenido original, solo mejorando
//     nitidez/composición.
//   - Si no hay imagen oficial -> se GENERA desde cero con
//     @cf/black-forest-labs/flux-1-schnell, sin pedir nunca personajes con
//     nombre propio o IP reconocible.
//
// MANEJO DE SATURACIÓN (error 3040 "Capacity temporarily exceeded"): es un
// error transitorio de Cloudflare (no de esta cuenta ni de sus créditos:
// eso sería el error 3036, distinto) que ocurre cuando no hay datacenter
// GPU disponible en ese instante para el modelo pedido. Esta función:
//   1. Reintenta una vez de inmediato contra Cloudflare (dentro del mismo
//      presupuesto de 9s), ya que a veces el siguiente intento cae en otro
//      datacenter con capacidad libre.
//   2. Si el intento era de EDICIÓN y sigue sin capacidad, cae una vez a
//      GENERAR desde cero con FLUX en vez de editar (FLUX suele tener mejor
//      disponibilidad al ser menos usado que el modelo de edición), para
//      devolver algo en vez de nada.
//   3. Si aun así falla, devuelve capacityError:true para que el FRONTEND
//      reintente con espera larga (varios minutos) en vez de rendirse,
//      porque Netlify free corta esta función a los 10s y no hay margen
//      para un backoff largo aquí.
//
// POR QUÉ CLOUDFLARE Y NO GEMINI: la API de Gemini no tiene cuota gratuita
// para generación de imágenes vía API (ni gemini-2.5-flash-image ni
// gemini-3.x-flash-image la tienen; su Free Tier aparece como "Not
// available" en la página oficial de precios) — solo Cloudflare Workers AI
// ofrece hoy un tier gratuito real para esto, con reseteo diario.
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
    if (sourceImageUrl && typeof sourceImageUrl === "string") {
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
      payload.strength = 0.55;
      payload.num_steps = 20;
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

    // Si la EDICIÓN (img2img) sigue sin capacidad tras el reintento, se
    // prueba UNA vez, dentro del mismo presupuesto de tiempo, generar desde
    // cero con FLUX en vez de editar. FLUX suele tener mejor disponibilidad
    // que el modelo de edición porque lo usan menos proyectos gratuitos, así
    // que en el peor caso el usuario recibe una ilustración generada en vez
    // de la edición de su imagen oficial, en lugar de ningún resultado.
    if (!res.ok && res.status === 429 && usedSourceImage) {
      const errJsonPeek2 = await res.clone().json().catch(() => ({}));
      const code2 = errJsonPeek2?.errors?.[0]?.code;
      if (code2 === 3040 || !code2) {
        usedSourceImage = false;
        model = MODEL_GENERATE;
        prompt = buildGeneratePrompt({ title, category, postType, summary });
        payload = { prompt, width: 864, height: 1080 };
        res = await callCloudflare();
      }
    }

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

function buildEditPrompt({ category }) {
  const style = CATEGORY_STYLE[category] || CATEGORY_STYLE.anime;
  return `high quality, sharp, detailed, ${style}, professional social media cover art, clean composition, vertical portrait format`;
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
