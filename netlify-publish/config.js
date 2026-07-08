(function () {
  const configured = window.COMPLETION_IQ_API_BASE || "";
  const stored = localStorage.getItem("completionIqApiBase") || "";
  const base = (configured || stored || "").replace(/\/$/, "");
  window.COMPLETION_IQ_API_BASE = base;
  window.completionIqApiUrl = function (path) {
    return `${base}${path}`;
  };
})();
