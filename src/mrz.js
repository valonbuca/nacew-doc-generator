// TD1 (3-line, 30-char) machine-readable-zone parsing and check-digit
// validation, per ICAO 9303. This is the ONLY thing we trust for ID-card
// data: it's fixed-width, restricted to A-Z 0-9 <, and self-checking --
// unlike OCR of the card face (glossy, holographic overlay, yellow security
// watermark over the text), a bad MRZ read is detectable rather than
// silently wrong.

const LINE_LEN = 30;

function mrzCharValue(c) {
  if (c === "<") return 0;
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55; // A=10 ... Z=35
  return NaN; // shouldn't happen given the OCR whitelist, but don't pretend it's 0
}

// Weights 7,3,1 repeating over the field, digits/letters/'<' valued per
// mrzCharValue, summed mod 10. `field` should NOT include the check digit
// itself.
export function mrzCheckDigit(field) {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = mrzCharValue(field[i]);
    if (Number.isNaN(v)) return NaN;
    sum += v * [7, 3, 1][i % 3];
  }
  return sum % 10;
}

function checkDigitOk(field, expected) {
  if (!/^[0-9]$/.test(expected)) return false;
  const computed = mrzCheckDigit(field);
  return !Number.isNaN(computed) && String(computed) === expected;
}

// YYMMDD -> dd.mm.yyyy. `preferPast` (birth dates): if the 2000s reading
// would be a future date, it must actually be the 1900s (a birth year of
// 94 is 1994, not 2094). Expiry dates never need this -- Kosovo IDs are all
// modern-issuance, so 2000+YY is unambiguous there.
function yymmddToDate(yymmdd, { preferPast = false } = {}) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(yymmdd);
  if (!m) return null;
  const yy = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;

  let year = 2000 + yy;
  if (preferPast) {
    const candidate = new Date(year, month - 1, day);
    if (candidate.getTime() > Date.now()) year = 1900 + yy;
  }
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;

  const p = (n) => String(n).padStart(2, "0");
  return `${p(day)}.${p(month)}.${year}`;
}

// Line 2: 1-6 birth YYMMDD, 7 birth check, 8 sex, 9-14 expiry YYMMDD,
// 15 expiry check, 16-18 nationality, 19-29 optional data (personal number
// lives here), 30 composite check digit (spans line 1 too -- not validated
// here; birth/expiry check digits are independently, concretely verified
// instead, per the confirmed-working real-card example).
function parseLine2(line2) {
  const birthField = line2.slice(0, 6);
  const birthCheck = line2[6];
  const expiryField = line2.slice(8, 14);
  const expiryCheck = line2[14];
  const optionalData = line2.slice(18, 29);

  const birthCheckOk = checkDigitOk(birthField, birthCheck);
  const expiryCheckOk = checkDigitOk(expiryField, expiryCheck);

  const personalIdRaw = optionalData.replace(/<+$/, "");
  const personalIdFormatOk = /^[0-9]{10}$/.test(personalIdRaw);

  return {
    birthDate: birthCheckOk ? yymmddToDate(birthField, { preferPast: true }) : null,
    birthCheckOk,
    expiryCheckOk,
    personalId: personalIdFormatOk ? personalIdRaw : null,
    personalIdFormatOk,
  };
}

function titleCase(str) {
  return str
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

// Line 3: "SURNAME<<GIVEN<NAMES" -- filler '<' separates name components,
// '<<' separates surname from given names. MRZ text is always uppercase;
// title-cased here since that's how names are written everywhere else in
// this app.
function parseLine3(line3) {
  const [surnamePart = "", givenPart = ""] = line3.split("<<");
  const surname = surnamePart.replace(/</g, " ").trim();
  const givenNames = givenPart.replace(/</g, " ").trim();
  if (!surname && !givenNames) return "";
  // Kosovo usage elsewhere in this app is "Given Names Surname".
  return titleCase([givenNames, surname].filter(Boolean).join(" "));
}

// Takes the 3 MRZ lines (each ideally 30 chars) and returns only fields
// whose check digit (or, for personal_id, format) actually validated --
// callers must not populate anything this leaves blank.
export function parseTd1(lines) {
  const [, line2raw, line3raw] = lines;
  const line2 = (line2raw || "").padEnd(LINE_LEN, "<").slice(0, LINE_LEN);
  const line3 = (line3raw || "").padEnd(LINE_LEN, "<").slice(0, LINE_LEN);

  const { birthDate, birthCheckOk, expiryCheckOk, personalId, personalIdFormatOk } = parseLine2(line2);
  const name = parseLine3(line3);

  // Treat the whole read as reliable only when BOTH independently-checked
  // dates validate -- a bad rotation/crop tends to corrupt the whole line,
  // not one field in isolation, so requiring both is the real signal that
  // personal_id (which has no check digit of its own) was read cleanly too.
  const lineReliable = birthCheckOk && expiryCheckOk;

  return {
    birth_date: lineReliable && birthDate ? birthDate : "",
    personal_id: lineReliable && personalIdFormatOk ? personalId : "",
    name: lineReliable ? name : "",
    reliable: lineReliable,
    birthCheckOk,
    expiryCheckOk,
    personalIdFormatOk,
  };
}

export const _internal = { mrzCharValue, checkDigitOk, yymmddToDate, parseLine2, parseLine3 };
