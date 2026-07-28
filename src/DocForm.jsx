import { useEffect, useState } from "react";
import { DOC_TYPES } from "./docTypes.js";
import {
  labelize,
  isDateField,
  todayStr,
  endDateInclusive,
  numberToAlbanianWords,
  extractTokens,
  generateDocx,
  generateContractDocx,
  downloadBlob,
} from "./docxUtils.js";
import {
  extractIdCardFromFile,
  extractNdaFieldsFromContract,
  generateJobDuties,
  smartFormatValues,
} from "./claudeApi.js";

// Fields that exist in the shell but are fully auto-derived, so they never
// get their own input box:
//  - end_date             -> start_date + duration selector
//  - probation_start_date -> always equal to start_date
//  - probation_end_date   -> always start_date + 3 months
const AUTO_DERIVED_CONTRACT_FIELDS = ["end_date", "probation_start_date", "probation_end_date"];

// Service contract's payment fields -- rendered manually below based on the
// selected payment type instead of through the generic token loop.
const PAYMENT_VARIANT_TOKENS = ["fee_amount", "fee_words", "monthly_fee", "hourly_rate", "fee_type"];

// Net/gross tokens for the salary/fee amount -- rendered via a dedicated
// selector rather than the generic token loop, and always defaulted (an
// empty value would leave the shell's sentence broken, e.g. "pagë mujore ,
// në shumën prej..."). Casing is fixed per shell: the contract's sentence
// capitalizes it ("Bruto"/"Neto"), the service contract's doesn't.
const DEFAULT_SALARY_TYPE = "Bruto";
const DEFAULT_FEE_TYPE = "bruto";

// Employment Contract -> NDA: both shells were tokenized with identical
// names for the fields they share, so chaining straight from a generated
// contract is a plain copy -- no re-extraction, no re-upload.
const NDA_CHAINED_FIELDS = [
  "employee_name",
  "birth_date",
  "municipality",
  "street_address",
  "personal_id",
  "position",
  "contract_date",
];

export default function DocForm({ docKey }) {
  // Normally mirrors docKey. Diverges only while reviewing a chained NDA
  // generated from a just-downloaded Employment Contract (see
  // handleChainNda) -- everywhere below that reads `t`/`tokens` then
  // transparently operates on whichever document is actually being
  // reviewed/generated.
  const [reviewDocKey, setReviewDocKey] = useState(docKey);
  const t = DOC_TYPES[reviewDocKey];
  const [tokens, setTokens] = useState([]);
  const [values, setValues] = useState({});
  const [durationMonths, setDurationMonths] = useState(12); // default 1 year, contract only
  const [paymentType, setPaymentType] = useState("project"); // service contract only
  const [status, setStatus] = useState({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);
  const [invalidFields, setInvalidFields] = useState([]);
  const [phase, setPhase] = useState("form"); // "form" | "review"
  const [duties, setDuties] = useState([]);
  const [reviewValues, setReviewValues] = useState(null); // frozen values shown/used at review time
  const [contractDownloaded, setContractDownloaded] = useState(false); // Employment Contract only, offers the NDA chain

  useEffect(() => {
    (async () => {
      const toks = await extractTokens(DOC_TYPES[docKey].shellUrl);
      setTokens(toks);
      const initial = {};
      toks.forEach((tok) => {
        initial[tok] =
          tok === "today_date" || tok === "contract_date"
            ? todayStr()
            : tok === "salary_type"
            ? DEFAULT_SALARY_TYPE
            : tok === "fee_type"
            ? DEFAULT_FEE_TYPE
            : "";
      });
      setValues(initial);
    })();
  }, [docKey]);

  // Auto-calc end_date from start_date + duration, for the contract type.
  // A contract ends the day BEFORE the calendar anniversary of its start.
  useEffect(() => {
    if (t.hasDuration && values.start_date) {
      setValues((v) => ({ ...v, end_date: endDateInclusive(v.start_date, durationMonths) }));
    }
  }, [values.start_date, durationMonths, t.hasDuration]);

  // Probation is always start_date -> start_date + 3 months (inclusive), for the contract type.
  useEffect(() => {
    if (t.hasDuration && values.start_date) {
      setValues((v) => ({
        ...v,
        probation_start_date: v.start_date,
        probation_end_date: endDateInclusive(v.start_date, 3),
      }));
    }
  }, [values.start_date, t.hasDuration]);

  // The duty marker field (paragraph gets duplicated per duty), the
  // auto-derived date fields, and the service contract's payment fields
  // (rendered manually based on the selected payment type) never get a plain
  // input box in the generic loop below.
  const hiddenTokens = [
    ...(t.hasJobDuties ? [t.dutyMarker || "job_duty_1"] : []),
    ...(t.hasDuration ? AUTO_DERIVED_CONTRACT_FIELDS : []),
    ...(t.hasPaymentVariant ? PAYMENT_VARIANT_TOKENS : []),
    "salary_type", // rendered next to salary_amount instead, see below
  ];
  const visibleTokens = tokens.filter((tok) => !hiddenTokens.includes(tok));
  const dateTokens = visibleTokens.filter(isDateField);
  const otherTokens = visibleTokens.filter((tok) => !isDateField(tok));

  // Fields that must be non-empty before generating. Mirrors what's actually
  // rendered below: every visible text/date field, minus the salary/fee
  // "words" siblings (auto-derived from the amount field, never required on
  // their own), plus whichever payment-variant field(s) are shown for the
  // currently selected paymentType.
  const paymentVariantRequired = !t.hasPaymentVariant
    ? []
    : paymentType === "project"
    ? ["fee_amount"]
    : paymentType === "hourly"
    ? ["hourly_rate"]
    : paymentType === "monthly"
    ? ["monthly_fee", "hourly_rate"]
    : ["monthly_fee"]; // monthlyOnly
  const requiredTokens = [
    ...otherTokens.filter((tok) => tok !== "salary_words" && tok !== "fee_words"),
    ...dateTokens,
    ...paymentVariantRequired,
  ];

  // Everything worth eyeballing on the review screen -- the required set,
  // plus the auto-derived "words" siblings and (for the contract type) the
  // auto-calculated end/probation dates, since those are real values that
  // end up in the document even though they're never directly editable.
  const summaryTokens = [
    ...otherTokens,
    ...dateTokens,
    ...paymentVariantRequired,
    ...(t.hasPaymentVariant && paymentType === "project" ? ["fee_words"] : []),
    ...(t.hasDuration ? AUTO_DERIVED_CONTRACT_FIELDS : []),
    ...(tokens.includes("salary_type") ? ["salary_type"] : []),
    ...(tokens.includes("fee_type") ? ["fee_type"] : []),
  ];

  function fieldDisplayName(tok) {
    if (tok === "salary_amount") return "Salary (EUR)";
    if (tok === "fee_amount") return "Fee (EUR)";
    if (tok === "monthly_fee") return "Monthly fee (EUR)";
    if (tok === "hourly_rate") return "Hourly rate (EUR)";
    return labelize(tok);
  }

  function setField(tok, val) {
    setValues((v) => ({ ...v, [tok]: val }));
    setInvalidFields((inv) => inv.filter((f) => f !== tok));
  }

  function applyExtractedFields(parsed) {
    setValues((v) => {
      const next = { ...v };
      Object.keys(parsed).forEach((k) => {
        if (parsed[k] && k in next) next[k] = parsed[k];
      });
      return next;
    });
  }

  // Salary/fee amounts are entered as a plain number; the € sign and the
  // spelled-out Albanian words are both derived automatically from it.
  function handleAmountChange(amountKey, wordsKey, raw) {
    const digits = raw.replace(/[^\d]/g, "");
    setValues((v) => ({
      ...v,
      [amountKey]: digits ? `${digits}€` : "",
      [wordsKey]: digits ? numberToAlbanianWords(digits) : "",
    }));
    if (digits) setInvalidFields((inv) => inv.filter((f) => f !== amountKey));
  }

  // One upload widget, driven by DOC_TYPES[key].sourceUpload — reads an ID
  // card (for a new Contract) or an existing contract (for an NDA, since the
  // contract already has every field the NDA needs).
  async function handleSourceUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const kind = t.sourceUpload.kind;
    setStatus({ text: kind === "contract" ? "Reading contract..." : "Reading ID card...", kind: "" });
    try {
      const parsed =
        kind === "contract"
          ? await extractNdaFieldsFromContract(file)
          : await extractIdCardFromFile(file, docKey === "service" ? "contractor_name" : "employee_name");
      applyExtractedFields(parsed);
      setStatus({ text: "Fields filled — please double-check before generating.", kind: "ok" });
    } catch (err) {
      console.error(err);
      setStatus({ text: "Could not read the file, fill in manually.", kind: "err" });
    }
  }

  // Phase 1: validate, run the Claude call(s), then hand off to the review
  // screen instead of writing a file straight away -- these are real legal
  // documents, so the AI-written duties (and, for the NDA, the auto-extracted
  // field values) get a human look before anything is committed to a .docx.
  async function handlePrepareReview() {
    const missing = requiredTokens.filter((tok) => !values[tok] || !String(values[tok]).trim());
    if (missing.length > 0) {
      setInvalidFields(missing);
      setStatus({ text: `Please fill in: ${missing.map(fieldDisplayName).join(", ")}`, kind: "err" });
      return;
    }
    setInvalidFields([]);

    setBusy(true);
    try {
      if (t.hasJobDuties) {
        setStatus({ text: "Generating job duties for this position...", kind: "" });
        const generated = await generateJobDuties(values.position || "");
        setDuties(generated);
        setReviewValues(values);
      } else {
        setStatus({ text: "Asking Claude to format the fields...", kind: "" });
        const formatted = await smartFormatValues(values);
        setReviewValues({ ...values, ...formatted });
      }
      setStatus({ text: "Review below, then confirm to write the document.", kind: "ok" });
      setPhase("review");
    } catch (err) {
      console.error(err);
      setStatus({ text: "Could not prepare the review — see console.", kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerateDuties() {
    setBusy(true);
    try {
      setStatus({ text: "Regenerating job duties...", kind: "" });
      const generated = await generateJobDuties((reviewValues || values).position || "");
      setDuties(generated);
      setStatus({ text: "Duties regenerated — review before confirming.", kind: "ok" });
    } catch (err) {
      console.error(err);
      setStatus({ text: "Could not regenerate duties — see console.", kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  function updateDuty(i, text) {
    setDuties((d) => d.map((duty, idx) => (idx === i ? text : duty)));
  }

  function removeDuty(i) {
    // Never let it go to zero -- generateContractDocx leaves the {{job_duty_1}}
    // marker untouched when duties is empty, which would leak a literal
    // placeholder into the document.
    setDuties((d) => (d.length <= 1 ? d : d.filter((_, idx) => idx !== i)));
  }

  function addDuty() {
    setDuties((d) => (d.length >= 5 ? d : [...d, ""]));
  }

  async function handleBackToForm() {
    // Returning from a chained NDA review -- restore the original document's
    // own tokens so the form renders correctly again (values themselves were
    // never touched by chaining, only tokens/reviewValues/duties were).
    if (reviewDocKey !== docKey) {
      const originalTokens = await extractTokens(DOC_TYPES[docKey].shellUrl);
      setTokens(originalTokens);
      setReviewDocKey(docKey);
    }
    setPhase("form");
    setStatus({ text: "", kind: "" });
  }

  // Employment Contract -> matching NDA, straight from values already in
  // state. No re-upload, no re-extraction, no required-field gate (a blank
  // birth_date is expected and shouldn't block, same as the plain NDA flow).
  // Still runs smartFormatValues for consistent capitalization/date formatting,
  // and still lands on the same review panel before anything is written.
  async function handleChainNda() {
    setBusy(true);
    try {
      setStatus({ text: "Preparing the matching NDA...", kind: "" });
      const ndaTokens = await extractTokens(DOC_TYPES.nda.shellUrl);
      const mapped = {};
      ndaTokens.forEach((tok) => {
        mapped[tok] =
          tok === "today_date" ? todayStr() : NDA_CHAINED_FIELDS.includes(tok) ? reviewValues[tok] || "" : "";
      });
      const formatted = await smartFormatValues(mapped);
      setTokens(ndaTokens);
      setDuties([]);
      setReviewValues({ ...mapped, ...formatted });
      setReviewDocKey("nda");
      setStatus({ text: "Review the matching NDA below, then confirm to write it.", kind: "ok" });
    } catch (err) {
      console.error(err);
      setStatus({ text: "Could not prepare the NDA — see console.", kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  // Phase 2: build the .docx from the reviewed/edited duties and values --
  // no fresh Claude call, so hand edits made during review survive as-is.
  async function handleConfirmDownload() {
    setBusy(true);
    try {
      setStatus({ text: "Writing document...", kind: "" });
      const blob = t.hasJobDuties
        ? await generateContractDocx(
            t.shellUrl,
            tokens,
            reviewValues,
            duties,
            t.dutyMarker || "job_duty_1",
            t.hasPaymentVariant ? paymentType : null
          )
        : await generateDocx(t.shellUrl, tokens, reviewValues);

      const nameGuess = (reviewValues.employee_name || reviewValues.contractor_name || "document").replace(
        /\s+/g,
        "_"
      );
      const filename = `${nameGuess}_${t.filenamePrefix}.docx`;
      downloadBlob(blob, filename);
      setStatus({ text: `Downloaded ${filename}`, kind: "ok" });
      if (docKey === "contract" && reviewDocKey === "contract") setContractDownloaded(true);
    } catch (err) {
      console.error(err);
      setStatus({ text: "Generation failed — see console.", kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tag mono">[ {t.label.toUpperCase()} ]</div>
      <h1>{t.label}</h1>
      <p className="lede">{visibleTokens.length} fields detected in this shell.</p>

      {phase === "form" && (
        <>
          {t.sourceUpload && (
            <div className="idcard">
              <div className="ico">{t.sourceUpload.kind === "contract" ? "📄" : "🪪"}</div>
              <div className="txt">
                <b>{t.sourceUpload.label}</b>
                <span>{t.sourceUpload.hint}</span>
              </div>
              <input type="file" id="sourceFile" accept=".pdf,.docx,image/*" onChange={handleSourceUpload} />
              <button className="btn-outline" onClick={() => document.getElementById("sourceFile").click()}>
                Upload
              </button>
            </div>
          )}

          {otherTokens.map((tok) => {
            if (tok === "salary_amount") {
              return (
                <div className="row2" key={tok}>
                  <div className={`field${invalidFields.includes(tok) ? " invalid" : ""}`}>
                    <label>
                      Salary (EUR) <span className="required-mark">*</span>
                    </label>
                    <input
                      type="text"
                      value={(values.salary_amount || "").replace("€", "")}
                      placeholder="e.g. 3000"
                      onChange={(e) => handleAmountChange("salary_amount", "salary_words", e.target.value)}
                    />
                  </div>
                  {tokens.includes("salary_type") && (
                    <div className="field">
                      <label>Salary type</label>
                      <select
                        value={values.salary_type || DEFAULT_SALARY_TYPE}
                        onChange={(e) => setField("salary_type", e.target.value)}
                      >
                        <option value="Bruto">Gross (Bruto)</option>
                        <option value="Neto">Net (Neto)</option>
                      </select>
                    </div>
                  )}
                </div>
              );
            }
            if (tok === "salary_words") {
              return (
                <div className="field" key={tok}>
                  <label>Salary in words (auto)</label>
                  <input
                    type="text"
                    value={values.salary_words || ""}
                    placeholder="filled in automatically from the amount above"
                    onChange={(e) => setField("salary_words", e.target.value)}
                  />
                </div>
              );
            }
            return (
              <div className={`field${invalidFields.includes(tok) ? " invalid" : ""}`} key={tok}>
                <label>
                  {labelize(tok)} <span className="required-mark">*</span>
                </label>
                <input
                  type="text"
                  value={values[tok] || ""}
                  placeholder={labelize(tok)}
                  onChange={(e) => setField(tok, e.target.value)}
                />
              </div>
            );
          })}

          {t.hasPaymentVariant && (
            <>
              <div className="field">
                <label>Payment type</label>
                <select value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
                  <option value="project">Project-based</option>
                  <option value="monthlyOnly">Monthly</option>
                  <option value="hourly">Hourly</option>
                  <option value="monthly">Monthly + Hourly</option>
                </select>
              </div>

              {tokens.includes("fee_type") && (
                <div className="field">
                  <label>Fee type</label>
                  <select
                    value={values.fee_type || DEFAULT_FEE_TYPE}
                    onChange={(e) => setField("fee_type", e.target.value)}
                  >
                    <option value="bruto">Gross (bruto)</option>
                    <option value="neto">Net (neto)</option>
                  </select>
                </div>
              )}

              {paymentType === "project" && (
                <>
                  <div className={`field${invalidFields.includes("fee_amount") ? " invalid" : ""}`}>
                    <label>
                      Fee (EUR) <span className="required-mark">*</span>
                    </label>
                    <input
                      type="text"
                      value={(values.fee_amount || "").replace("€", "")}
                      placeholder="e.g. 3000"
                      onChange={(e) => handleAmountChange("fee_amount", "fee_words", e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>Fee in words (auto)</label>
                    <input
                      type="text"
                      value={values.fee_words || ""}
                      placeholder="filled in automatically from the amount above"
                      onChange={(e) => setField("fee_words", e.target.value)}
                    />
                  </div>
                </>
              )}

              {(paymentType === "monthlyOnly" || paymentType === "monthly") && (
                <div className={`field${invalidFields.includes("monthly_fee") ? " invalid" : ""}`}>
                  <label>
                    Monthly fee (EUR) <span className="required-mark">*</span>
                  </label>
                  <input
                    type="text"
                    value={values.monthly_fee || ""}
                    placeholder="e.g. 500€"
                    onChange={(e) => setField("monthly_fee", e.target.value)}
                  />
                </div>
              )}

              {(paymentType === "hourly" || paymentType === "monthly") && (
                <div className={`field${invalidFields.includes("hourly_rate") ? " invalid" : ""}`}>
                  <label>
                    Hourly rate (EUR) <span className="required-mark">*</span>
                  </label>
                  <input
                    type="text"
                    value={values.hourly_rate || ""}
                    placeholder="e.g. 15€"
                    onChange={(e) => setField("hourly_rate", e.target.value)}
                  />
                </div>
              )}
            </>
          )}

          {t.hasDuration && (
            <div className="field">
              <label>Contract duration</label>
              <select value={durationMonths} onChange={(e) => setDurationMonths(Number(e.target.value))}>
                <option value={6}>6 months</option>
                <option value={12}>1 year (default)</option>
                <option value={18}>18 months</option>
                <option value={24}>2 years</option>
              </select>
            </div>
          )}

          <div className="row2">
            {dateTokens.map((tok) => (
              <div className={`field${invalidFields.includes(tok) ? " invalid" : ""}`} key={tok}>
                <label>
                  {labelize(tok)}
                  {tok === "today_date" ? " (auto)" : ""}
                  {tok === "contract_date" && docKey === "contract" ? " (auto)" : ""}
                  {tok === "contract_date" && docKey === "nda" ? " (from uploaded contract)" : ""}{" "}
                  <span className="required-mark">*</span>
                </label>
                <input
                  type="text"
                  value={values[tok] || ""}
                  placeholder="dd.mm.yyyy"
                  onChange={(e) => setField(tok, e.target.value)}
                />
              </div>
            ))}
          </div>

          {t.hasDuration && values.start_date && (
            <p className="lede" style={{ marginTop: -8 }}>
              End date: <strong>{values.end_date}</strong> &middot; Probation:{" "}
              <strong>{values.probation_start_date}</strong> to <strong>{values.probation_end_date}</strong> (3 months,
              auto)
            </p>
          )}

          {t.hasJobDuties && (
            <p className="lede" style={{ marginTop: -8 }}>
              Job duties (Neni 3) will be written automatically in Albanian based on the position above — no need to
              list them by hand.
            </p>
          )}
        </>
      )}

      {phase === "review" && (
        <>
          {t.hasJobDuties && (
            <div className="review-section">
              <div className="review-section-title mono">JOB DUTIES (NENI 3)</div>
              {duties.map((duty, i) => (
                <div className="duty-row" key={i}>
                  <input type="text" value={duty} onChange={(e) => updateDuty(i, e.target.value)} />
                  <button
                    className="btn-outline duty-remove"
                    onClick={() => removeDuty(i)}
                    disabled={busy || duties.length <= 1}
                    title="Remove this duty"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <div className="duty-actions">
                <button className="btn-outline" onClick={addDuty} disabled={busy || duties.length >= 5}>
                  + Add duty
                </button>
                <button className="btn-outline" onClick={handleRegenerateDuties} disabled={busy}>
                  Regenerate duties
                </button>
              </div>
            </div>
          )}

          <div className="review-section">
            <div className="review-section-title mono">FIELD SUMMARY</div>
            <div className="summary">
              {summaryTokens.map((tok) => (
                <div className="summary-row" key={tok}>
                  <span className="summary-label">{fieldDisplayName(tok)}</span>
                  <span className="summary-value">{(reviewValues && reviewValues[tok]) || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="generate-bar">
        {phase === "form" ? (
          <button className="btn-solid" disabled={busy} onClick={handlePrepareReview}>
            Review document
          </button>
        ) : (
          <>
            <button className="btn-outline" disabled={busy} onClick={handleBackToForm}>
              &larr; Back to form
            </button>
            <button className="btn-solid" disabled={busy} onClick={handleConfirmDownload}>
              Confirm &amp; download
            </button>
          </>
        )}
        <span className={`status mono ${status.kind}`}>{status.text}</span>
      </div>

      {docKey === "contract" && phase === "review" && reviewDocKey === "contract" && contractDownloaded && (
        <div className="chain-offer">
          <span>
            Contract generated. Also generate the matching NDA for{" "}
            <strong>{reviewValues && reviewValues.employee_name}</strong>?
          </span>
          <button className="btn-outline" onClick={handleChainNda} disabled={busy}>
            Generate NDA
          </button>
        </div>
      )}
    </>
  );
}
