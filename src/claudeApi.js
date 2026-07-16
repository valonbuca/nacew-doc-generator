// NOTE: This calls the Anthropic API directly from the browser using an API key
// baked into the client bundle. That is fine for local testing on your own
// machine, but it is NOT safe to ship this way — anyone who opens devtools on
// the deployed site could read your API key. Before this goes live in Nacew OS,
// move these two functions behind a small backend endpoint (e.g. a Vercel/Node
// function) that holds the key server-side and forwards the request.

const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages }),
  });
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const clean = (textBlock ? textBlock.text : "{}").replace(/```json|```/g, "").trim();
  return clean;
}

export async function extractIdCardFields(base64Data, mediaType) {
  const clean = await callClaude([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        {
          type: "text",
          text: 'This is a photo of a Kosovo ID card. Extract full name, personal ID number, birth date, municipality, and street address if visible. Respond ONLY with raw JSON, no markdown fences: {"employee_name":"","personal_id":"","birth_date":"","municipality":"","street_address":""}. Use empty string for anything not visible. Dates in dd.mm.yyyy format.',
        },
      ],
    },
  ]);
  try {
    return JSON.parse(clean);
  } catch {
    return {};
  }
}

export async function smartFormatValues(rawValues) {
  const prompt = `You are preparing field values to insert into an Albanian-language legal document (Kosovo employment/NDA paperwork).
Given this JSON of raw form input, return a JSON object with the SAME keys, where each value is cleaned up for insertion:
- Names/places: proper capitalization.
- Dates: format strictly as dd.mm.yyyy.
- Leave a field as an empty string if the input was empty — do not invent data.
- Do not add any commentary, only return raw JSON, no markdown fences.

Input:
${JSON.stringify(rawValues)}`;

  const clean = await callClaude([{ role: "user", content: prompt }]);
  try {
    return JSON.parse(clean);
  } catch {
    return rawValues;
  }
}
