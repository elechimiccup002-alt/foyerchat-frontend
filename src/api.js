/* ————————————————————————————————————————————
   api.js — livello di comunicazione col backend
   Imposta VITE_API_URL nell'ambiente (o .env):
   VITE_API_URL=https://foyer-backend.onrender.com
——————————————————————————————————————————— */
import { io } from "socket.io-client";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

/* fetch con gestione token + errori uniformata */
export async function api(path, { method = "GET", body, token, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !formData) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: formData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

/* connessione socket (token opzionale: senza sei guest in sola lettura) */
export function connectSocket(token) {
  return io(API_URL, { auth: token ? { token } : {} });
}

/* url assoluto per le foto servite dal backend */
export const assetUrl = (u) => (u?.startsWith("http") ? u : `${API_URL}${u}`);
