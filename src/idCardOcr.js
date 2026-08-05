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

// Real-world embedded card images run around 1058x1688 at 72dpi -- fine to
// look at, but that puts MRZ character height at ~35-40px, which is
// marginal for OCR. Any candidate image below this on its long edge gets
// upscaled before anything else happens to it.
const MIN_LONG_EDGE = 1500;
// PDF pages rendered at 1.0 keep that same marginal character height; 3x
// brings it to a comfortable ~110px. This is the single biggest lever on
// whether OCR works at all, so it isn't a tunable "just in case" knob.
const PDF_RENDER_SCALE = 3;

// Word only guarantees jpeg/png/gif/bmp/webp can be decoded by <img>/canvas.
// Older docs frequently carry pasted screenshots as .emf/.wmf, or scans as
// .tiff -- none of which a browser can decode. Skip those explicitly with a
// note instead of letting them fail opaquely inside loadImageFromBlob.
const DECODABLE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);

function getDrawableSize(source) {
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

async function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    // Safe to revoke once the bitmap has decoded (or failed) -- drawImage()
    // no longer needs the URL either way.
    URL.revokeObjectURL(url);
  }
  return img;
}

// Upscales a candidate image (in place, via a fresh canvas) if its long edge
// is below MIN_LONG_EDGE. Cheap no-op for anything already large enough,
// which covers every PDF-rendered page since PDF_RENDER_SCALE already
// pushes those well past this threshold.
function ensureMinLongEdge(source, minLongEdge) {
  const { width, height } = getDrawableSize(source);
  const longEdge = Math.max(width, height);
  if (longEdge >= minLongEdge) return source;
  const scale = minLongEdge / longEdge;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Renders every page of the PDF to a canvas. A photo of an ID card saved as
// PDF (the common real-world case) typically has the front on one page and
// the back -- the one that actually matters -- on another, so every page is
// a candidate; the caller's check-digit search picks the winner.
async function candidateImagesFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await getDocument({ data: buf }).promise;
  const images = [];
  const notes = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      images.push(canvas);
    } catch (err) {
      notes.push(`Couldn't render page ${pageNum} of the PDF (${err.message || "unknown error"}).`);
    }
  }
  return { images, notes };
}

async function candidateImagesFromDocx(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const mediaFiles = Object.keys(zip.files).filter((n) => n.startsWith("word/media/") && !zip.files[n].dir);
  const images = [];
  const notes = [];
  for (const name of mediaFiles) {
    const shortName = name.split("/").pop();
    const ext = shortName.split(".").pop().toLowerCase();
    if (!DECODABLE_EXTENSIONS.has(ext)) {
      notes.push(`Skipped ${shortName} -- .${ext} images can't be read in a browser; re-save as JPG or PNG.`);
      continue;
    }
    const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "bmp" ? "image/bmp" : ext === "webp" ? "image/webp" : "image/jpeg";
    try {
      const arrayBuffer = await zip.files[name].async("arraybuffer");
      images.push(await loadImageFromBlob(new Blob([arrayBuffer], { type: mediaType })));
    } catch {
      notes.push(`Skipped ${shortName} -- the image data couldn't be decoded.`);
    }
  }
  return { images, notes };
}

// Every image extracted from the uploaded file is a candidate -- we don't
// know in advance which page/embed is the back of the card (or whether
// front and back were both included), so each is tried in turn until one
// yields a checksum-valid MRZ. Always resolves to {images, notes}, even on
// total failure, so the caller can report exactly what happened rather than
// failing opaquely.
async function candidateImages(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return candidateImagesFromPdf(file);
  }
  if (name.endsWith(".docx")) {
    return candidateImagesFromDocx(file);
  }
  try {
    const img = await loadImageFromBlob(file);
    return { images: [img], notes: [] };
  } catch {
    return { images: [], notes: [`Couldn't read ${file.name} as an image.`] };
  }
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

// OCR text -> candidate MRZ lines. Strips anything outside the MRZ alphabet
// and drops lines too short to be meaningful (stray noise blips), but does
// NOT cap the upper length -- a couple of extra OCR-inserted characters on
// an otherwise-good line shouldn't disqualify it, since parseTd1 already
// pads/truncates to exactly 30 chars and the check digits are the real
// correctness gate. Line 1 (document number etc.) is never used by
// parseTd1 and is the line most likely to fall outside the crop or OCR
// into noise, so callers should key off the LAST TWO entries (line 2 /
// line 3) rather than require exactly 3 -- a clean 2-line read is just as
// usable as a 3-line one here.
function extractMrzLines(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.toUpperCase().replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 15);
}

// Tries every candidate image at every rotation until one produces a
// checksum-valid MRZ, and returns immediately on the first hit -- this is
// deliberately a brute force over (image x rotation): we don't try to guess
// which page is the back of the card or which way up it is, we let the
// check digits themselves pick the winner, which also means a wrong guess
// can't silently produce bad data. `onProgress(message)` fires before each
// attempt so the caller can show something other than silence during the
// (up to several second) run.
export async function readMrzFromIdCard(file, { onProgress } = {}) {
  const { images, notes } = await candidateImages(file);
  if (!images.length) {
    return { birth_date: "", personal_id: "", name: "", reliable: false, notes };
  }

  const worker = await createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_char_whitelist: MRZ_WHITELIST,
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });

    const total = images.length * ROTATIONS.length;
    let attempt = 0;
    for (const rawImage of images) {
      const normalized = ensureMinLongEdge(rawImage, MIN_LONG_EDGE);
      for (const angle of ROTATIONS) {
        attempt++;
        onProgress?.(`Reading ID card's machine-readable strip... (${attempt}/${total})`);
        const prepared = prepareMrzBand(normalized, angle);
        const { data } = await worker.recognize(prepared);
        const lines = extractMrzLines(data.text);
        if (lines.length >= 2) {
          // Line 1 is never used by parseTd1, so a clean 2-line read (line
          // 2 + line 3) is exactly as usable as a 3-line one -- always take
          // the last two candidates regardless of whether line 1 survived.
          const result = parseTd1([null, lines[lines.length - 2], lines[lines.length - 1]]);
          if (result.reliable) return { ...result, notes };
        }
      }
    }
  } finally {
    await worker.terminate();
  }
  return { birth_date: "", personal_id: "", name: "", reliable: false, notes };
}
