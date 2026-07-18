import { useEffect, useState } from "react";
import { DOC_TYPES } from "./docTypes.js";
import {
  labelize,
  isDateField,
  todayStr,
  addToDate,
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
const PAYMENT_VARIANT_TOKENS = ["fee_amount", "fee_words", "monthly_fee", "hourly_rate"];

export default function DocForm({ docKey }) {
  const t = DOC_TYPES[docKey];
  const [tokens, setTokens] = useState([]);
  const [values, setValues] = useState({});
  const [durationMonths, setDurationMonths] = useState(12); // default 1 year, contract only
  const [paymentType, setPaymentType] = useState("project"); // service contract only
  const [status, setStatus] = useState({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const toks = await extractTokens(t.shellUrl);
      setTokens(toks);
      const initial = {};
      toks.forEach((tok) => {
        initial[tok] = tok === "today_date" || tok === "contract_date" ? todayStr() : "";
      });
      setValues(initial);
    })();
  }, [docKey]);

  // Auto-calc end_date from start_date + duration, for the contract type.
  useEffect(() => {
    if (t.hasDuration && values.start_date) {
      setValues((v) => ({ ...v, end_date: addToDate(v.start_date, durationMonths) }));
    }
  }, [values.start_date, durationMonths, t.hasDuration]);

  // Probation is always start_date -> start_date + 3 months, for the contract type.
  useEffect(() => {
    if (t.hasDuration && values.start_date) {
      setValues((v) => ({
        ...v,
        probation_start_date: v.start_date,
        probation_end_date: addToDate(v.start_date, 3),
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
  ];
  const visibleTokens = tokens.filter((tok) => !hiddenTokens.includes(tok));
  const dateTokens = visibleTokens.filter(isDateField);
  const otherTokens = visibleTokens.filter((tok) => !isDateField(tok));

  function setField(tok, val) {
    setValues((v) => ({ ...v, [tok]: val }));
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

  async function handleGenerate() {
    setBusy(true);
    try {
      let blob;
      let mergedForFilename = values;

      if (t.hasJobDuties) {
        setStatus({ text: "Generating job duties for this position...", kind: "" });
        const duties = await generateJobDuties(values.position || "");
        setStatus({ text: "Writing document...", kind: "" });
        blob = await generateContractDocx(
          t.shellUrl,
          tokens,
          values,
          duties,
          t.dutyMarker || "job_duty_1",
          t.hasPaymentVariant ? paymentType : null
        );
      } else {
        setStatus({ text: "Asking Claude to format the fields...", kind: "" });
        const formatted = await smartFormatValues(values);
        mergedForFilename = { ...values, ...formatted };
        setStatus({ text: "Writing document...", kind: "" });
        blob = await generateDocx(t.shellUrl, tokens, mergedForFilename);
      }

      const nameGuess = (mergedForFilename.employee_name || mergedForFilename.contractor_name || "document").replace(
        /\s+/g,
        "_"
      );
      const filename = `${nameGuess}_${t.filenamePrefix}.docx`;
      downloadBlob(blob, filename);
      setStatus({ text: `Downloaded ${filename}`, kind: "ok" });
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
            <div className="field" key={tok}>
              <label>Salary (EUR)</label>
              <input
                type="text"
                value={(values.salary_amount || "").replace("€", "")}
                placeholder="e.g. 3000"
                onChange={(e) => handleAmountChange("salary_amount", "salary_words", e.target.value)}
              />
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
          <div className="field" key={tok}>
            <label>{labelize(tok)}</label>
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

          {paymentType === "project" && (
            <>
              <div className="field">
                <label>Fee (EUR)</label>
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
            <div className="field">
              <label>Monthly fee (EUR)</label>
              <input
                type="text"
                value={values.monthly_fee || ""}
                placeholder="e.g. 500€"
                onChange={(e) => setField("monthly_fee", e.target.value)}
              />
            </div>
          )}

          {(paymentType === "hourly" || paymentType === "monthly") && (
            <div className="field">
              <label>Hourly rate (EUR)</label>
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
          <div className="field" key={tok}>
            <label>
              {labelize(tok)}
              {tok === "today_date" ? " (auto)" : ""}
              {tok === "contract_date" && docKey === "contract" ? " (auto)" : ""}
              {tok === "contract_date" && docKey === "nda" ? " (from uploaded contract)" : ""}
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
          <strong>{values.probation_start_date}</strong> to <strong>{values.probation_end_date}</strong> (3 months, auto)
        </p>
      )}

      {t.hasJobDuties && (
        <p className="lede" style={{ marginTop: -8 }}>
          Job duties (Neni 3) will be written automatically in Albanian based on the position above —
          no need to list them by hand.
        </p>
      )}

      <div className="generate-bar">
        <button className="btn-solid" disabled={busy} onClick={handleGenerate}>
          Generate document
        </button>
        <span className={`status mono ${status.kind}`}>{status.text}</span>
      </div>
    </>
  );
}
