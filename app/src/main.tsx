import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Disable right-click and dev shortcuts in production feel.
// Toggle debug mode with Ctrl+Shift+D.
let debugMode = false;

document.addEventListener("contextmenu", (e) => {
  if (!debugMode) e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  // Ctrl+Shift+D toggles debug mode
  if (e.ctrlKey && e.shiftKey && e.key === "D") {
    debugMode = !debugMode;
    console.log(`Debug mode: ${debugMode ? "ON" : "OFF"}`);
    return;
  }

  if (debugMode) return;

  // Block refresh shortcuts
  if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
    e.preventDefault();
  }
  // Block devtools
  if (e.ctrlKey && e.shiftKey && e.key === "I") {
    e.preventDefault();
  }
  if (e.key === "F12") {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
