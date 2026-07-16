import { useEffect, useState } from "react";
import { DOC_TYPES } from "./docTypes.js";
import { labelize, isDateField, todayStr, extractTokens, generateDocx, downloadBlob } from "./docxUtils.js";
import { extractIdCardFields, smartFormatValues } from "./claudeApi.js";

export default function DocForm({ docKey }) {
  const t = DOC_TYPES[docKey];
  const [tokens, setTokens] = useState([]);
  const [values, setValues] = useState({});
  const [status, setStatus] = useState({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const toks = await extractTokens(t.shellUrl);
      setTokens(toks);
      const initial = {};
      toks.forEach((tok) => {
        initial[tok] = tok === "today_date" ? todayStr() : "";
      });
      setValues(initial);
    })();
  }, [docKey]);

  const dateTokens = tokens.filter(isDateField);
  const otherTokens = tokens.filter((tok) => !isDateField(tok));

  function setField(tok, val) {
    setValues((v) => ({ ...v, [tok]: val }));
  }

  async function handleIdCard(e) {
    const file = e.target.files[0];
    if (!file) return;
    setStatus({ text: "Reading ID card...", kind: "" });
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result.split(",")[1];
      try {
        const parsed = await extractIdCardFields(base64Data, file.type || "image/jpeg");
        setValues((v) => {
          const next = { ...v };
          Object.keys(parsed).forEach((k) => {
            if (parsed[k] && k in next) next[k] = parsed[k];
          });
          return next;
        });
        setStatus({ text: "Fields filled from ID — please double-check.", kind: "ok" });
      } catch (err) {
        console.error(err);
        setStatus({ text: "Could not read ID card, fill manually.", kind: "err" });
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleGenerate() {
    setBusy(true);
    setStatus({ text: "Asking Claude to format the fields...", kind: "" });
    try {
      const formatted = await smartFormatValues(values);
      setStatus({ text: "Writing document...", kind: "" });
      const merged = { ...values, ...formatted };
      const blob = await generateDocx(t.shellUrl, tokens, merged);
      const nameGuess = (merged.employee_name || values.employee_name || "document").replace(/\s+/g, "_");
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
      <p className="lede">{tokens.length} fields detected in this shell.</p>

      <div className="idcard">
        <div className="ico">🪪</div>
        <div className="txt">
          <b>Upload an ID card photo</b>
          <span>Auto-fill name / personal ID from a photo</span>
        </div>
        <input type="file" id="idCardFile" accept="image/*" onChange={handleIdCard} />
        <button className="btn-outline" onClick={() => document.getElementById("idCardFile").click()}>
          Upload
        </button>
      </div>

      {otherTokens.map((tok) => (
        <div className="field" key={tok}>
          <label>{labelize(tok)}</label>
          <input
            type="text"
            value={values[tok] || ""}
            placeholder={labelize(tok)}
            onChange={(e) => setField(tok, e.target.value)}
          />
        </div>
      ))}

      <div className="row2">
        {dateTokens.map((tok) => (
          <div className="field" key={tok}>
            <label>{labelize(tok)}{tok === "today_date" ? " (auto)" : ""}</label>
            <input
              type="text"
              value={values[tok] || ""}
              placeholder="dd.mm.yyyy"
              onChange={(e) => setField(tok, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="generate-bar">
        <button className="btn-solid" disabled={busy} onClick={handleGenerate}>
          Generate document
        </button>
        <span className={`status mono ${status.kind}`}>{status.text}</span>
      </div>
    </>
  );
}
