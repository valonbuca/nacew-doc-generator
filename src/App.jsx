import { useState } from "react";
import { DOC_TYPES } from "./docTypes.js";
import DocForm from "./DocForm.jsx";

export default function App() {
  const [activeKey, setActiveKey] = useState(null);

  return (
    <>
      <header>
        <div>
          <div className="logo">NACEW · OS</div>
          <div className="logo-sub mono">DOCUMENT GENERATOR</div>
        </div>
        {activeKey && (
          <button className="backbtn mono" onClick={() => setActiveKey(null)}>
            &larr; back
          </button>
        )}
      </header>

      <main>
        {activeKey ? (
          <DocForm docKey={activeKey} />
        ) : (
          <>
            <div className="tag mono">[ NACEW &middot; SHELL LIBRARY ]</div>
            <h1>What are we building today?</h1>
            <p className="lede">
              Pick a document type. Fill in the details. Claude does the writing — you keep the shell.
            </p>
            <div className="grid">
              {Object.entries(DOC_TYPES).map(([key, t]) => (
                <div
                  key={key}
                  className={`buildcard ${t.available ? "" : "disabled"}`}
                  onClick={() => t.available && setActiveKey(key)}
                >
                  <div className="bar" />
                  <h3>{t.label}</h3>
                  <p>{t.blurb}</p>
                  <div className="arrow">{t.available ? "→" : "—"}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}
