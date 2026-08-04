import JSZip from "jszip";

export function labelize(token) {
  return token.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isDateField(token) {
  return /date/.test(token);
}

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Validates a dd.mm.yyyy string against the real calendar (rejects e.g.
// month 17, or day 30 in February) -- used both to sanity-check dates pulled
// out of free-text contract parsing and to enforce date-ordering rules.
// Returns the normalized string, or null if it isn't a real date.
export function parseValidDate(str) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(str || "").trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// Compares two dd.mm.yyyy strings; negative if a < b, positive if a > b.
// Returns 0 if either isn't a valid date (callers should validate first if
// that distinction matters).
export function compareDates(a, b) {
  const da = parseValidDate(a);
  const db = parseValidDate(b);
  if (!da || !db) return 0;
  const [d1, m1, y1] = da.split(".").map(Number);
  const [d2, m2, y2] = db.split(".").map(Number);
  return new Date(y1, m1 - 1, d1).getTime() - new Date(y2, m2 - 1, d2).getTime();
}

export function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function fetchShellZip(shellUrl) {
  const res = await fetch(shellUrl);
  const buf = await res.arrayBuffer();
  return JSZip.loadAsync(buf);
}

// Word's spellchecker sometimes flags a {{token_name}} as a misspelled word
// and gives it its own run wrapped in <w:proofErr> markers, splitting one
// token across three separate <w:r> elements (this happened throughout the
// service contract shell). Token detection/replacement below works on the
// raw XML string, so a split token would otherwise go unmatched. This merges
// those three runs back into one, using the surrounding run's formatting.
// The middle run doesn't always carry a <w:rPr> (plain, unformatted runs
// omit it entirely) -- that group is optional; when absent, the backref
// \1 simply matches nothing, so the closing run doesn't need one either.
const SPLIT_TOKEN_RUN_RE =
  /\{\{<\/w:t><\/w:r><w:proofErr w:type="spellStart"\/><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t(?: xml:space="preserve")?>([a-zA-Z0-9_]+)<\/w:t><\/w:r><w:proofErr w:type="spellEnd"\/><w:r>\1<w:t(?: xml:space="preserve")?>\}\}/g;

function coalesceSplitTokenRuns(xml) {
  return xml.replace(SPLIT_TOKEN_RUN_RE, "{{$2}}");
}

export async function extractTokens(shellUrl) {
  const zip = await fetchShellZip(shellUrl);
  const xml = coalesceSplitTokenRuns(await zip.file("word/document.xml").async("string"));
  return [...new Set([...xml.matchAll(/{{([a-zA-Z0-9_]+)}}/g)].map((m) => m[1]))];
}

export async function generateDocx(shellUrl, tokens, values) {
  const zip = await fetchShellZip(shellUrl);
  let xml = coalesceSplitTokenRuns(await zip.file("word/document.xml").async("string"));
  tokens.forEach((tok) => {
    const re = new RegExp("{{" + tok + "}}", "g");
    xml = xml.replace(re, escapeXml(values[tok] ?? ""));
  });
  zip.file("word/document.xml", xml);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// Finds every top-level <w:p ...>...</w:p> block in document order, along
// with its flattened text content, so payment-variant/duty logic can locate
// paragraphs by what token they contain rather than by a hardcoded position.
function findParagraphs(xml) {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    text: [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(""),
  }));
}

// Service contract shell has four alternate payment paragraphs already sitting
// in the document (one per payment type), each immediately followed by its own
// sub-note/sub-bullet where relevant:
//   project     -> the {{fee_amount}} paragraph + its sibling note
//   monthly     -> the FIRST {{monthly_fee}} paragraph (fixed monthly regardless
//                  of hours) + its sibling {{hourly_rate}} sub-bullet (extra pay
//                  per hour on top) -- this is the "Monthly + Hourly" combo
//   hourly      -> the {{hourly_rate}} paragraph that ISN'T that sub-bullet
//   monthlyOnly -> the LAST {{monthly_fee}} paragraph (standalone, no hourly)
// Only the paragraph(s) for the selected type should survive; the rest are
// spliced out entirely before the normal token replace runs.
function applyPaymentVariant(xml, paymentType) {
  const paras = findParagraphs(xml);

  const feeAmountIdx = paras.findIndex((p) => p.text.includes("{{fee_amount}}"));
  const monthlyIdxs = paras.reduce((acc, p, i) => (p.text.includes("{{monthly_fee}}") ? [...acc, i] : acc), []);
  const hourlyIdxs = paras.reduce((acc, p, i) => (p.text.includes("{{hourly_rate}}") ? [...acc, i] : acc), []);

  const projectBlock = [feeAmountIdx, feeAmountIdx + 1];
  const monthlyBlock = [monthlyIdxs[0], monthlyIdxs[0] + 1];
  const hourlyOnlyIdx = hourlyIdxs.find((i) => i !== monthlyBlock[1]);
  const monthlyOnlyIdx = monthlyIdxs[monthlyIdxs.length - 1];

  const keepByType = {
    project: projectBlock,
    monthly: monthlyBlock,
    hourly: [hourlyOnlyIdx],
    monthlyOnly: [monthlyOnlyIdx],
  };
  const keep = keepByType[paymentType] || [];

  const candidates = new Set([...projectBlock, ...monthlyBlock, hourlyOnlyIdx, monthlyOnlyIdx]);
  const toDelete = [...candidates].filter((i) => !keep.includes(i)).sort((a, b) => b - a);

  toDelete.forEach((i) => {
    const { start, end } = paras[i];
    xml = xml.slice(0, start) + xml.slice(end);
  });

  return xml;
}

// Contract/Service shells have one special field: a single lettered list
// paragraph (marked by `dutyMarker`, e.g. {{job_duty_1}} or {{service_duty_1}})
// where Word's own numbering handles a/b/c automatically. To fill it with N
// duties, that paragraph must be duplicated N times before the normal token
// replace runs. The shell's own fixed closing duty
// ("Kryen detyra e pergjegjesi te tjera...") already follows it and becomes
// the final lettered item automatically -- don't include it in `duties`.
//
// `paymentType`, when given, is applied first via applyPaymentVariant (used by
// the service contract shell, which has alternate payment paragraphs to prune).
export async function generateContractDocx(shellUrl, tokens, values, duties, dutyMarker = "job_duty_1", paymentType = null) {
  const zip = await fetchShellZip(shellUrl);
  let xml = coalesceSplitTokenRuns(await zip.file("word/document.xml").async("string"));

  if (paymentType) {
    xml = applyPaymentVariant(xml, paymentType);
  }

  const marker = "{{" + dutyMarker + "}}";
  const markerIdx = xml.indexOf(marker);
  if (markerIdx !== -1 && duties && duties.length) {
    const pStart = xml.lastIndexOf("<w:p ", markerIdx);
    const pEnd = xml.indexOf("</w:p>", markerIdx) + "</w:p>".length;
    const template = xml.slice(pStart, pEnd);
    const dupBlock = duties.map((d) => template.replace(marker, escapeXml(d))).join("");
    xml = xml.slice(0, pStart) + dupBlock + xml.slice(pEnd);
  }

  tokens.forEach((tok) => {
    if (tok === dutyMarker) return; // handled above
    const re = new RegExp("{{" + tok + "}}", "g");
    xml = xml.replace(re, escapeXml(values[tok] ?? ""));
  });

  zip.file("word/document.xml", xml);
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function formatDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()}`;
}

// Advances a dd.mm.yyyy string by `months` calendar months, clamping the day
// to the last valid day of the target month (31 Jan + 1 month -> 28/29 Feb,
// not an invalid 31 Feb -- JS's Date constructor would otherwise silently
// roll that overflow into March).
export function addMonths(dateStr, months) {
  const [d, m, y] = dateStr.split(".").map(Number);
  if (!d || !m || !y) return "";
  const total = m - 1 + months;
  const targetYear = y + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  return formatDate(new Date(targetYear, targetMonth, Math.min(d, lastDayOfTargetMonth)));
}

// A contract/probation running for `months` months from `startStr` ends the
// day BEFORE the calendar anniversary, not on it -- 1 Jan 1999 + 1 year ends
// 31 Dec 1999. Used for the contract's duration selector (defaults to 12
// months / 1 year from start_date) and for the probation end date (always
// 3 months from start_date).
export function endDateInclusive(startStr, months) {
  const anniversary = addMonths(startStr, months);
  if (!anniversary) return "";
  const [d, m, y] = anniversary.split(".").map(Number);
  const end = new Date(y, m - 1, d);
  end.setDate(end.getDate() - 1);
  return formatDate(end);
}

// Spells out a whole number in Albanian, e.g. 2500 -> "Dy mijë e pesëqind".
// Covers 0-999,999, which comfortably covers any realistic monthly salary.
const ONES = ["", "një", "dy", "tre", "katër", "pesë", "gjashtë", "shtatë", "tetë", "nëntë"];
const TEENS = [
  "dhjetë", "njëmbëdhjetë", "dymbëdhjetë", "trembëdhjetë", "katërmbëdhjetë",
  "pesëmbëdhjetë", "gjashtëmbëdhjetë", "shtatëmbëdhjetë", "tetëmbëdhjetë", "nëntëmbëdhjetë",
];
const TENS = ["", "", "njëzet", "tridhjetë", "dyzet", "pesëdhjetë", "gjashtëdhjetë", "shtatëdhjetë", "tetëdhjetë", "nëntëdhjetë"];

function twoDigitWords(n) {
  if (n === 0) return "";
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} e ${ONES[u]}`;
}

function threeDigitWords(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h > 0) parts.push(h === 1 ? "njëqind" : `${ONES[h]}qind`);
  if (r > 0) parts.push(twoDigitWords(r));
  return parts.join(" e ");
}

// Both shell placeholders this feeds ("me shkronja Euro" / "dymijë Euro")
// include the currency word, so the spelled-out amount must end in " Euro"
// too -- e.g. "Tre mijë Euro", not just "Tre mijë".
export function numberToAlbanianWords(num) {
  const n = Math.round(Number(num));
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "Zero Euro";

  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const parts = [];
  if (thousands > 0) {
    parts.push(thousands === 1 ? "një mijë" : `${threeDigitWords(thousands)} mijë`);
  }
  if (rest > 0) {
    parts.push(threeDigitWords(rest));
  }
  const words = parts.join(" e ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} Euro`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
