// netlify/functions/generate-post-gemini.js
//
// Genera el texto del post SOLO con Gemini. Separada de la función de Groq
// (generate-post-groq.js) para que cada proveedor tenga su propio
// presupuesto completo de ~10s (límite de Netlify Functions en el plan
// gratuito), en vez de compartirlo dentro de una sola invocación con
// fallback interno. El frontend decide si llama a Groq después, como una
// segunda petición HTTP independiente.
//
// Variable de entorno requerida en Netlify: GEMINI_API_KEY
// Se consigue gratis en https://aistudio.google.com/apikey (no pide tarjeta).

const { parseAndValidateItem, buildPrompt, parsePostJSON, jsonResponse } = require("./_post-shared");

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Presupuesto de tiempo: Netlify corta a los 10s. Se deja ~1s de margen
// para el propio overhead de arranque/red de la función.
const TIMEOUT_MS = 9000;

exports.handler = async (event) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY no configurada." }, 500);
  }

  const parsed = parseAndValidateItem(event);
  if (parsed.error) return jsonResponse(parsed.error.body, parsed.error.status);

  const prompt = buildPrompt(parsed.item);

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.05,
      topP: 0.95,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      // 429 = se acabó la cuota gratuita del día/minuto.
      return jsonResponse({ error: message }, res.status);
    }

    const candidate = json?.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text;

    if (!rawText) {
      const reason = candidate?.finishReason || "desconocida";
      return jsonResponse({ error: `Gemini no devolvió contenido (posible bloqueo de seguridad o corte, razón: ${reason}).` }, 502);
    }

    if (candidate?.finishReason === "MAX_TOKENS") {
      return jsonResponse({ error: "La respuesta de Gemini se cortó por límite de tokens (MAX_TOKENS)." }, 502);
    }

    const result = parsePostJSON(rawText, "Gemini");
    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.status || 502);
    }
    return jsonResponse(result.data, 200);
  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado llamando a Gemini." : (e.message || String(e));
    return jsonResponse({ error: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
};
