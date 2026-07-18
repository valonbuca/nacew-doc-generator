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
    sourceUpload: {
      kind: "contract",
      label: "Upload the employment contract (PDF or Word)",
      hint: "Auto-fills every field below — name, personal ID, position, address, dates",
    },
  },
  contract: {
    label: "New Employment Contract",
    blurb: "Fixed-term employment contract — EWWWOLUTION / NACEW.",
    shellUrl: "/contract-shell.docx",
    filenamePrefix: "Kontrate-Pune",
    available: true,
    hasJobDuties: true,   // triggers auto-generated Albanian duty list + paragraph duplication
    hasDuration: true,    // triggers the duration selector -> auto end_date
    sourceUpload: {
      kind: "idcard",
      label: "Upload ID card (PDF or Word, both sides)",
      hint: "Auto-fills name, birth date, personal number (from the back), address",
    },
  },
  service: {
    label: "New Service Contract",
    blurb: "Independent contractor service agreement — EWWWOLUTION / NACEW.",
    shellUrl: "/service-contract-shell.docx",
    filenamePrefix: "Kontrate-Sherbimi",
    available: true,
    hasJobDuties: true,     // reuses the duty-generation flow (generateJobDuties)
    dutyMarker: "service_duty_1", // this shell's repeatable-duty marker (contract's is job_duty_1, the default)
    hasDuration: false,     // explicit start_date/end_date fields, no duration selector/auto-calc
    hasPaymentVariant: true, // triggers the payment-type selector + payment-paragraph splicing
    sourceUpload: {
      kind: "idcard",
      label: "Upload ID card (PDF or Word, both sides)",
      hint: "Auto-fills name, personal number (from the back), address",
    },
  },
};