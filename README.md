# Nacew OS — Document Generator (standalone)

Button-first document generator: pick a document type, fill a form (or upload
an ID card photo for auto-fill), and download a completed `.docx` — built from
a fixed template shell with `{{tokens}}`.

## Setup

```bash
npm install
cp .env.example .env      # then paste your Anthropic API key into .env
npm run dev
```

Open the printed local URL (usually http://localhost:5173).

## How it's organized

- `src/docTypes.js` — the registry of document shells. This is the only file
  you touch to add a new document type.
- `public/*.docx` — the actual shell files (tokenized `.docx` templates).
- `src/docxUtils.js` — reads `{{tokens}}` out of a shell and writes the final
  `.docx` in the browser (via JSZip), no server round-trip.
- `src/claudeApi.js` — calls to Claude: one to read an ID card photo, one to
  clean up/format the field values before they go into the document.
- `src/App.jsx` / `src/DocForm.jsx` — the two screens (pick a document type →
  fill its form).

## Adding a new document type

1. Take the shell `.docx` you want to add (already tokenized with `{{...}}`
   placeholders — ask Claude to do this the same way the NDA shell was done).
2. Drop it in `public/`, e.g. `public/contract-shell.docx`.
3. Add an entry to `src/docTypes.js`:

```js
contract: {
  label: "New Employment Contract",
  blurb: "Fixed-term employment contract — EWWWOLUTION / NACEW.",
  shellUrl: "/contract-shell.docx",
  filenamePrefix: "Kontrate-Pune",
  available: true,
},
```

That's it — the form fields are auto-detected from whatever `{{tokens}}` are
inside the shell, so nothing else needs to change.

## ⚠️ Before this goes live in Nacew OS

Right now `src/claudeApi.js` calls the Anthropic API directly from the browser
with an API key baked into the build. That's fine for testing on your own
machine, but it means the key would be visible to anyone who opens devtools on
the deployed site. Before shipping, move `extractIdCardFields` and
`smartFormatValues` behind a small backend endpoint (a Vercel serverless
function works well, matching how your other Nacew tools are set up) that
holds the key server-side.

## Known limitation carried over from the NDA shell

The shell's address line is hardcoded as `Adresa: Rruga {{street_address}}` —
this reads wrong for addresses that aren't streets (e.g. boulevards, as with
Vegim Rashiti's NDA). Worth revisiting if this keeps coming up.
