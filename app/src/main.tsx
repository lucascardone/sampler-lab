import React from "react";
import ReactDOM from "react-dom/client";
// Dev only (?mock=1 / ?mock=phone): fake core for reviewing screens in a browser.
import "./dev/mockCore";
// Must run before anything touches Tauri: in a phone's browser it bridges to the PC.
import { isRemote } from "./remote/shim";
import "@fontsource-variable/archivo/standard.css";
import "./i18n";
import App from "./App";
import "./App.css";
import { MobileApp } from "./features/mobile/MobileApp";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isRemote ? <MobileApp /> : <App />}</React.StrictMode>,
);
