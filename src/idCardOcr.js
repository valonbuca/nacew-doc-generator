import { createWorker, PSM } from "tesseract.js";
import JSZip from "jszip";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { parseTd1 } from "./mrz.js";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Kosovo ID cards are glossy, carry a holographic overlay and a yellow
// security watermark over the printed text, and phone photos of them
// arrive rotated -- general OCR of the card face is exactly the kind of
// "looks plausible, quietly wrong" failure that produces a legally
// incorrect contract. Instead we read the MRZ strip on the back: fixed
// width, restricted charset, and self-checking (see mrz.js). Everything
// here exists to get a clean crop of that strip in front of Tesseract;
// the whitelist + PSM.SINGLE_BLOCK setup is what actually matters.
const MRZ_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
const ROTATIONS = [0, 90, 180, 270];
const MRZ_BAND_FRACTION = 0.38; // bottom ~38% of the page -- a bit more generous than an exact third
const OCR_TARGET_WIDTH = 1400; // Tesseract does much better on upscaled input

function getDrawableSize(source) {
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

async function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  // Safe to revoke once the bitmap has decoded -- drawImage() no longer needs the URL.
  URL.revokeObjectURL(url);
  return img;
}

async function candidateImagesFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await getDocument({ data: buf }).promise;
  const images = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 3 }); // roughly print-quality for a card-sized page
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    images.push(canvas);
  }
  return images;
}

async function candidateImagesFromDocx(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const mediaFiles = Object.keys(zip.files).filter((n) => n.startsWith("word/media/"));
  const images = [];
  for (const name of mediaFiles) {
    const ext = name.split(".").pop().toLowerCase();
    const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
    const arrayBuffer = await zip.files[name].async("arraybuffer");
    images.push(await loadImageFromBlob(new Blob([arrayBuffer], { type: mediaType })));
  }
  return images;
}

// Every image embedded in the uploaded file is a candidate -- we don't know
// in advance which one is the back of the card (or whether front and back
// were both included), so each is tried in turn until one yields a
// checksum-valid MRZ.
async function candidateImages(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return candidateImagesFromPdf(file);
  }
  if (name.endsWith(".docx")) {
    const images = await candidateImagesFromDocx(file);
    if (images.length) return images;
  }
  return [await loadImageFromBlob(file)];
}

function rotatedCanvas(source, angleDeg) {
  const { width, height } = getDrawableSize(source);
  const canvas = document.createElement("canvas");
  const swapped = angleDeg === 90 || angleDeg === 270;
  canvas.width = swapped ? height : width;
  canvas.height = swapped ? width : height;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(source, -width / 2, -height / 2, width, height);
  return canvas;
}

function cropBottomBand(canvas, fraction) {
  const bandHeight = Math.round(canvas.height * fraction);
  const y = canvas.height - bandHeight;
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = bandHeight;
  out.getContext("2d").drawImage(canvas, 0, y, canvas.width, bandHeight, 0, 0, canvas.width, bandHeight);
  return out;
}

// Greyscale + a min/max contrast stretch. OCR-B (the MRZ font) is fixed-
// pitch and high-contrast by design; this just removes color noise from the
// card's holographic overlay and watermark and pushes the real text/
// background gap back toward black/white.
function greyscaleAndContrast(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  const pixelCount = width * height;
  const grey = new Float32Array(pixelCount);
  let min = 255;
  let max = 0;
  for (let i = 0, p = 0; p < pixelCount; i += 4, p++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    grey[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, p = 0; p < pixelCount; i += 4, p++) {
    const stretched = ((grey[p] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = stretched;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function upscale(canvas, targetWidth) {
  if (canvas.width >= targetWidth) return canvas;
  const scale = targetWidth / canvas.width;
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function prepareMrzBand(source, angleDeg) {
  const rotated = rotatedCanvas(source, angleDeg);
  const cropped = cropBottomBand(rotated, MRZ_BAND_FRACTION);
  greyscaleAndContrast(cropped);
  return upscale(cropped, OCR_TARGET_WIDTH);
}

// OCR text -> up to 3 MRZ-shaped lines. Strips anything outside the MRZ
// alphabet, drops lines that are clearly too short/long to be a 30-char MRZ
// row (allowing slack for OCR insertion/deletion mistakes), and keeps the
// last 3 candidates in order (the MRZ band sits at the bottom of the crop;
// any stray noise line from an imperfect crop tends to land above it).
function extractMrzLines(rawText) {
  const candidates = rawText
    .split(/\r?\n/)
    .map((line) => line.toUpperCase().replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 24 && line.length <= 33);
  return candidates.slice(-3);
}

// Tries every candidate image at every rotation until one produces a
// checksum-valid MRZ, and returns immediately on the first hit. Returns
// `{ reliable: false, ... }` if nothing validated -- callers must treat
// that exactly like "nothing could be read" and fall back to manual entry.
export async function readMrzFromIdCard(file) {
  const images = await candidateImages(file);
  const worker = await createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_char_whitelist: MRZ_WHITELIST,
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });

    for (const image of images) {
      for (const angle of ROTATIONS) {
        const prepared = prepareMrzBand(image, angle);
        const { data } = await worker.recognize(prepared);
        const lines = extractMrzLines(data.text);
        if (lines.length === 3) {
          const result = parseTd1(lines);
          if (result.reliable) return result;
        }
      }
    }
  } finally {
    await worker.terminate();
  }
  return { birth_date: "", personal_id: "", name: "", reliable: false };
}

// Drop-in replacement for the old Claude-vision extractIdCardFromFile --
// same signature, same return shape, entirely local. Never returns
// municipality or street_address: municipality is only printed on the card
// face under "Vendbanimi" (not in the MRZ at all) and must still be typed;
// Kosovo ID cards never print a street address, full stop.
export async function extractIdCardFromFileLocal(file, nameField = "employee_name") {
  const result = await readMrzFromIdCard(file);
  if (!result.reliable) return {};
  return {
    [nameField]: result.name,
    birth_date: result.birth_date,
    personal_id: result.personal_id,
  };
}
