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
   placeholders — ask Claude to do this the same way the NDA and Contract
   shells were done).
2. Drop it in `public/`, e.g. `public/contract-shell.docx`.
3. Add an entry to `src/docTypes.js`:

```js
contract: {
  label: "New Employment Contract",
  blurb: "Fixed-term employment contract — EWWWOLUTION / NACEW.",
  shellUrl: "/contract-shell.docx",
  filenamePrefix: "Kontrate-Pune",
  available: true,
  hasJobDuties: true,  // auto-generates Albanian job duties from the position
  hasDuration: true,   // shows a duration selector, auto-computes end_date
},
```

That's it — the form fields are auto-detected from whatever `{{tokens}}` are
inside the shell, so nothing else needs to change.

## NDA flow: contract in, NDA out

The NDA doesn't ask you to fill in any fields by hand — the underlying
employment contract already has everything it needs. Upload the contract
(PDF or Word) and `extractNdaFieldsFromContract` in `src/claudeApi.js` reads
the whole thing and pulls out: name, birth date, municipality, address,
personal ID, position, and the contract's signing date. It's specifically
told to fall back to whichever of the contract's two stated dates (top vs.
signature block) is actually valid, in case the other one has a typo
(this happened with a real contract — "17.17.2026" isn't a date).

The extracted fields still populate the same input boxes as before, so you
get a chance to glance over them (and fix anything odd, like an address that
isn't quite a street) before hitting Generate — it just means you're
reviewing rather than typing from scratch.

## Contract-specific behavior

The Employment Contract shell has a few things the NDA shell doesn't:

- **Personal ID from the ID card file.** Valon typically has a single PDF or
  Word doc with both sides of the ID card already in it. `extractIdCardFromFile`
  in `src/claudeApi.js` reads whichever file type comes in (PDF sent directly,
  `.docx` has its embedded images pulled out via JSZip, plain images sent as-is)
  and is explicitly told the personal number ("Numri Personal") lives on the
  **back** of the card, not the front (which only has the document number).

- **Job duties are auto-generated, not typed in.** `{{job_duty_1}}` in the shell
  marks a single lettered list paragraph (Word's own numbering handles the
  a/b/c automatically). `generateContractDocx` in `src/docxUtils.js` duplicates
  that paragraph once per generated duty before doing the normal token
  replacement — this is the one field that can't be a plain find-and-replace.
  The shell's own fixed closing duty ("Kryen detyra e përgjegjësi të tjera...")
  is already in the template right after this block and becomes the final
  lettered item automatically, whatever letter that ends up being.

- **Three date/number fields are fully auto-derived and don't get their own
  input box:**
  - `end_date` = `start_date` + the duration selector (default: 1 year)
  - `probation_start_date` = `start_date` (always)
  - `probation_end_date` = `start_date` + 3 months (always)
  All three recompute live as you type the start date, and are shown as a
  read-only summary line under the date fields so you can sanity-check them
  before generating.

- **Salary is entered once, spelled out automatically.** Type just the number
  (e.g. `3000`) into "Salary (EUR)" — the € sign gets appended and
  `numberToAlbanianWords()` in `src/docxUtils.js` spells it out in Albanian
  for the `salary_words` field (e.g. "Tre mijë"), matching the exact wording
  style seen in real contracts (verified against 3000→"Tre mijë",
  2500→"Dy mijë e pesëqind", 1900→"Një mijë e nëntëqind", 800→"Tetëqind").
  The spelled-out field stays editable in case an unusual number needs a
  manual tweak.


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
