import { useState } from "react";
import { DOC_TYPES } from "./docTypes.js";
import DocForm from "./DocForm.jsx";

export default function App() {
  const [activeKey, setActiveKey] = useState(null);
  const [offline, setOffline] = useState(false);

  return (
    <>
      <header>
        <button className="logo-mark" onClick={() => setActiveKey(null)}>
          <span className="logo">NACEW</span>
          <span className="logo-sub mono">DOCUMENT GENERATOR</span>
        </button>
        <div className="header-right">
          <button
            className={`mode-toggle mono${offline ? " is-offline" : ""}`}
            onClick={() => setOffline((v) => !v)}
            title={
              offline
                ? "Working offline — no Claude calls. Click to go back online."
                : "Working online — Claude fills in what it can. Click to go offline."
            }
          >
            <span className="dot" />
            {offline ? "Offline" : "Online"}
          </button>
          {activeKey && (
            <button className="backbtn mono" onClick={() => setActiveKey(null)}>
              &larr; back
            </button>
          )}
        </div>
      </header>

      <main>
        {activeKey ? (
          <DocForm docKey={activeKey} offline={offline} />
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
