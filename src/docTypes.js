// Registry of document shells available in the generator.
// To add a new document type once Valon shares a tokenized shell:
//   1. Drop the .docx file into /public (e.g. public/contract-shell.docx)
//   2. Add an entry below pointing at it.
// The form fields are auto-detected from {{tokens}} inside the shell —
// nothing else needs to change.

export const DOC_TYPES = {
  nda: {
    label: "New NDA",
    blurb: "Non-compete, non-disclosure & inventory acknowledgement annex — EWWWOLUTION / NACEW.",
    shellUrl: "/nda-shell.docx",
    filenamePrefix: "NDA-NCA-Inventari",
    available: true,
  },
  contract: {
    label: "New Employment Contract",
    blurb: "Fixed-term employment contract shell — not loaded yet.",
    shellUrl: null,
    filenamePrefix: "Kontrate-Pune",
    available: false,
  },
};
