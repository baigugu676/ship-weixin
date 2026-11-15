// Production is served by FastAPI on the same HTTPS origin as the webpage.
// Vite development can use the local backend or an explicitly configured URL.
const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE_URL = configuredBase
  ? configuredBase.replace(/\/+$/, "")
  : import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname || "127.0.0.1"}:8000`
    : "";
