import JSZip from "jszip";
import { parseValidDate } from "./docxUtils.js";

// Reads a Kosovo employment contract that WE generated (from contract-shell.docx)
// and pulls the NDA's fields straight out of its fixed wording via regex --
// no Claude call needed, since our own shells' phrasing never varies. This is
// only reliable for our own generated contracts; a foreign/scanned contract
// should go through the Claude-vision path instead.

async function readDocxFlatText(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const xml = await doc.async("string");
  // Concatenating every <w:t> node in document order reconstructs the real
  // text regardless of how Word's spellchecker split it across runs --
  // run boundaries don't drop or add characters, so this is robust to that.
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
}

// contract_date is stated twice in the shell (the legal citation near the
// top, and the signature line at the bottom) and should agree; a real
// contract had one of the two be a malformed date ("17.17.2026"). Vote across
// whichever candidates parse as real calendar dates and take the most
// frequent; a tie keeps the first (the legal citation, listed first below).
function pickMostFrequentDate(candidates) {
  const valid = candidates.map(parseValidDate).filter(Boolean);
  if (!valid.length) return "";
  const counts = {};
  valid.forEach((d) => {
    counts[d] = (counts[d] || 0) + 1;
  });
  let best = valid[0];
  let bestCount = 0;
  for (const d of valid) {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

export async function extractNdaFieldsFromContractOffline(file) {
  const text = await readDocxFlatText(file);

  const identity = text.match(
    /PUNËMARRËSI:\s*([^,]+),\s*i lindur më\s*([^,]*),\s*me vendbanim në\s*([^,]+),\s*Adresa:\s*(.+?)\s*identifikuar përmes letërnjoftimit me numër personal:\s*(\d+)/
  );

  // Quote characters around the position vary (straight " and curly “ ” in
  // the same shell, sometimes mismatched on the same word) -- match any of
  // them as delimiters rather than a specific pair.
  const positionMatch = text.match(/pozitën e punës[^"'“”‘’]*["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);

  // Scoped to the legal-citation and signature contexts specifically -- a
  // generic /më datë (\d{2}\.\d{2}\.\d{4})/ would also match Neni 20.1's
  // "Kjo kotratë hyn në fuqi më datë ..." (the START date, a different
  // field entirely) and corrupt contract_date with it.
  const legalCitationDate = text.match(/Ligjit të Punës Nr\.\s*03\/L-212,?\s*më datë\s*(\d{2}\.\d{2}\.\d{4})/);
  const signatureDate = text.match(/Gjilan,\s*më\s*(\d{2}\.\d{2}\.\d{4})/);
  const contractDate = pickMostFrequentDate([legalCitationDate?.[1], signatureDate?.[1]]);

  return {
    employee_name: (identity?.[1] || "").trim(),
    // birth_date is frequently left blank on the source contract -- a
    // non-date value (including empty) is treated as blank, not a failure.
    birth_date: parseValidDate(identity?.[2]) || "",
    municipality: (identity?.[3] || "").trim(),
    street_address: (identity?.[4] || "").trim(),
    personal_id: (identity?.[5] || "").trim(),
    position: (positionMatch?.[1] || "").trim(),
    contract_date: contractDate,
  };
}
