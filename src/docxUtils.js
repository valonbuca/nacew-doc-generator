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

export function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function fetchShellZip(shellUrl) {
  const res = await fetch(shellUrl);
  const buf = await res.arrayBuffer();
  return JSZip.loadAsync(buf);
}

export async function extractTokens(shellUrl) {
  const zip = await fetchShellZip(shellUrl);
  const xml = await zip.file("word/document.xml").async("string");
  return [...new Set([...xml.matchAll(/{{([a-zA-Z0-9_]+)}}/g)].map((m) => m[1]))];
}

export async function generateDocx(shellUrl, tokens, values) {
  const zip = await fetchShellZip(shellUrl);
  let xml = await zip.file("word/document.xml").async("string");
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
