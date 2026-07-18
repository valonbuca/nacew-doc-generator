import JSZip from "jszip";

// NOTE: This calls the Anthropic API directly from the browser using an API key
// baked into the client bundle. That is fine for local testing on your own
// machine, but it is NOT safe to ship this way — anyone who opens devtools on
// the deployed site could read your API key. Before this goes live in Nacew OS,
// move these functions behind a small backend endpoint (e.g. a Vercel/Node
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
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages }),
  });
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  const clean = (textBlock ? textBlock.text : "{}").replace(/```json|```/g, "").trim();
  return clean;
}

// ---------------------------------------------------------------------------
// Shared file reading: turns whatever Valon uploads (PDF, .docx with embedded
// images, or a plain image) into the right Claude content blocks.
//   - PDF             -> sent directly as a document block (Claude reads it natively)
//   - .docx           -> embedded images extracted via JSZip and sent as image blocks
//   - image (jpg/png) -> sent directly as an image block
// Used both for ID cards (Contract flow) and full contracts (NDA flow).
// ---------------------------------------------------------------------------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractImagesFromDocx(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const mediaFiles = Object.keys(zip.files).filter((n) => n.startsWith("word/media/"));
  const blocks = [];
  for (const name of mediaFiles) {
    const ext = name.split(".").pop().toLowerCase();
    const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
    const base64 = await zip.files[name].async("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
  }
  return blocks;
}

async function extractTextFromDocx(file) {
  // For a .docx that's a real text contract (not scanned images), pulling the
  // raw text out is more reliable for Claude than screenshotting it would be.
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const xml = await doc.async("string");
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(" ");
  return text;
}

async function buildFileContentBlocks(file, { preferText = false } = {}) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    const base64 = await fileToBase64(file);
    return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }];
  }
  if (name.endsWith(".docx")) {
    if (preferText) {
      const text = await extractTextFromDocx(file);
      if (text.trim()) return [{ type: "text", text }];
    }
    const blocks = await extractImagesFromDocx(file);
    if (blocks.length) return blocks;
    // fall through if the docx had no embedded images/text for some reason
  }
  const base64 = await fileToBase64(file);
  return [{ type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: base64 } }];
}

// ---------------------------------------------------------------------------
// ID card reading (Contract flow — building a NEW contract from an ID card).
// ---------------------------------------------------------------------------

export async function extractIdCardFromFile(file, nameField = "employee_name") {
  const contentBlocks = await buildFileContentBlocks(file);
  const clean = await callClaude([
    {
      role: "user",
      content: [
        ...contentBlocks,
        {
          type: "text",
          text: 'This file contains the front and/or back of a Kosovo ID card (may be a PDF or a Word doc with both sides embedded as images). Extract: full name, birth date, personal number ("Numri Personal" — a 10-digit number found on the BACK of the card, not the document number on the front), municipality, and street address. Respond ONLY with raw JSON, no markdown fences: {"employee_name":"","birth_date":"","personal_id":"","municipality":"","street_address":""}. Use empty string for anything not visible or not on the card.',
        },
      ],
    },
  ]);
  try {
    const parsed = JSON.parse(clean);
    const { employee_name, ...rest } = parsed;
    return { [nameField]: employee_name, ...rest };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// NDA fields read straight from an existing employment contract — no manual
// form-filling needed, the contract already has everything the NDA needs.
// ---------------------------------------------------------------------------

export async function extractNdaFieldsFromContract(file) {
  const contentBlocks = await buildFileContentBlocks(file, { preferText: true });
  const clean = await callClaude([
    {
      role: "user",
      content: [
        ...contentBlocks,
        {
          type: "text",
          text: `This file is a Kosovo employment contract (Kontratë Pune) between EWWWOLUTION L.L.C. and an employee. Read the whole contract and extract the following fields for use in an NDA annex:

- employee_name: the employee's full name
- birth_date: their birth date if stated ("i lindur më ..."), else empty string
- municipality: the town/municipality of their residence ("vendbanim në ...")
- street_address: their street/building address, WITHOUT repeating the municipality and without a leading "Rruga" (I'll add that prefix myself, unless the address is actually a boulevard/square rather than a street, in which case include the full descriptor like "Bulevardi ..." so it isn't wrongly prefixed)
- personal_id: their "numër personal të identifikimit" (a 10-digit number)
- position: their job title ("Pozita")
- contract_date: the contract's signing date. Contracts usually state this date in two places (near the top, and again next to the signatures at the bottom) and they should match — if one of the two is clearly an invalid or malformed date (e.g. an impossible day/month like "17.17.2026"), use the other, valid one instead and ignore the typo.

Respond ONLY with raw JSON, no markdown fences: {"employee_name":"","birth_date":"","municipality":"","street_address":"","personal_id":"","position":"","contract_date":""}. Use empty string for anything not stated in the contract. Dates in dd.mm.yyyy format.`,
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

// ---------------------------------------------------------------------------
// Job duties: auto-generated in Albanian from just the position title.
// ---------------------------------------------------------------------------

export async function generateJobDuties(position) {
  const prompt = `Write 6 to 9 professional job duties in Albanian for the position "${position}", for insertion into Neni 3 of a formal Kosovo employment contract (Ewwwolution/Nacew house style).

Match this tone and specificity — for reference, here's what was written for a UI/UX Designer:
"Ridizajnimi i UI/UX i platformës ekzistuese dhe veçorive të reja për web & mobil"
"Krijimi, mirëmbajtja dhe zgjerimi i sistemit të dizajnit (design system)"
"Strukturimi i UI komponentëve në mënyrë që të jenë të lexueshme nga inteligjenca artificiale (AI)"

Do NOT include a final catch-all duty like "kryen detyra dhe përgjegjësi të tjera..." — that line is already fixed in the template and will be appended automatically after your list.

Respond ONLY with a raw JSON array of strings, no markdown fences, no commentary.`;

  const clean = await callClaude([{ role: "user", content: prompt }]);
  try {
    const arr = JSON.parse(clean);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Generic field cleanup — fallback formatter, still used as a final pass
// after contract-extraction for the NDA flow (capitalization/date formatting).
// ---------------------------------------------------------------------------

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
