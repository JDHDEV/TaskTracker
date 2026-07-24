import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getStoredPalette, polarityOf } from "./lib/palettes";
import "./styles.css";

// No-flash: apply the persisted palette (accent + neutrals) and its polarity to
// <html> synchronously, before React's first render, so the first paint is
// already themed. App's effect keeps them in sync on every later change. A
// module-level statement (not an inline <script>) keeps this inside the app
// bundle, so no CSP relaxation is needed (script-src stays 'self').
const initialPalette = getStoredPalette();
document.documentElement.dataset.palette = initialPalette;
document.documentElement.dataset.theme = polarityOf(initialPalette);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
