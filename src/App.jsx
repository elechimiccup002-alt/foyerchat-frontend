/* ————————————————————————————————————————————
   FOYER — App.jsx integrata col backend reale
   Auth email+password con verifica, profili e foto dal server,
   chat in tempo reale via Socket.io, DM, like ai prompt.
——————————————————————————————————————————— */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api, connectSocket, assetUrl } from "./api.js";

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=JetBrains+Mono:wght@400;500&display=swap');
.font-display { font-family: 'Bricolage Grotesque', sans-serif; }
.font-body { font-family: 'DM Sans', sans-serif; }
.font-mono2 { font-family: 'JetBrains Mono', monospace; }
.snap-y-strong { scroll-snap-type: y mandatory; }
.snap-card { scroll-snap-align: start; scroll-snap-stop: always; }
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(10px);} to { opacity: 1; transform: translateY(0);} }
.fade-up { animation: fadeUp .35s ease both; }
@keyframes pulseDot { 0%,100% { transform: scale(1); opacity:1;} 50% { transform: scale(1.6); opacity:.5;} }
.pulse-dot { animation: pulseDot 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .fade-up, .pulse-dot { animation: none; } }
`;

const GRAD = "linear-gradient(135deg,#6C4DFF 0%,#B44DFF 55%,#FF4D8D 100%)";
const BTN_BG = "#2f3344";
const BTN_TXT = "#fd94e6";
const BANNER_BG = "#c46ef4";

const AVATAR_CHOICES = [5, 33, 51, 8, 20, 64].map((n) => `https://i.pravatar.cc/300?img=${n}`);

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/* ———— filtro immagini sensibili (euristica client-side, demo) ————
   In produzione il controllo autorevole va fatto server-side
   (AWS Rekognition / Google Vision / Hive) prima del salvataggio. */
const SKIN_THRESHOLD = 0.42;
function analyzeImageSensitivity(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 96 / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let skin = 0, total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          total++;
          if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
              Math.abs(r - g) > 15 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15) skin++;
        }
        resolve(total > 0 && skin / total > SKIN_THRESHOLD);
      } catch { resolve(false); }
    };
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

/* comprime l'immagine prima dell'invio in chat (limite 1MB del server) */
function compressImage(file, maxSide = 900, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* Ogni foto caricata viene preparata qui, nel browser, in tre versioni:
   grande (max 1280px), miniatura per la griglia (480px) e una sfocata minuscola
   (20px). La sfocata è un file a parte: è l'unica che il server manda agli altri
   quando la foto è nascosta, quindi l'originale non si può recuperare da fuori. */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
function drawToBlob(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}
async function makePhotoVariants(file) {
  const img = await loadImageFile(file);
  const [full, thumb, blur] = await Promise.all([
    drawToBlob(img, 1280, 0.82),
    drawToBlob(img, 480, 0.75),
    drawToBlob(img, 20, 0.5),
  ]);
  return { full, thumb, blur };
}

/* ———— blocchi base ———— */
function Avatar({ src, name = "", size = 40, ring = false, online = false }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <img src={src ? assetUrl(src) : AVATAR_CHOICES[0]} alt={name} className="rounded-full object-cover w-full h-full"
        style={ring ? { boxShadow: "0 0 0 2px #fff, 0 0 0 4px #6C4DFF55" } : {}} />
      {online && (
        <span className="absolute bottom-0 right-0 rounded-full border-2 border-white"
          style={{ width: size / 3.2, height: size / 3.2, background: "#22C55E" }} />
      )}
    </div>
  );
}

function Badge({ children }) {
  return (
    <span className="font-mono2 text-[11px] px-2.5 py-1 rounded-full text-white" style={{ background: "linear-gradient(135deg,#FF4D8D,#FF7AB8)" }}>
      {children}
    </span>
  );
}

function GenderChip({ gender }) {
  if (!gender) return null;
  return (
    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full font-mono2 text-[11px] font-bold align-middle"
      style={{ background: BTN_BG, color: BTN_TXT }}>
      {gender}
    </span>
  );
}

function LockIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 018 0v4"/>
    </svg>
  );
}
function EyeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
function PencilIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
    </svg>
  );
}

function HeartIcon({ filled, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "#FF4D8D" : "none"} stroke={filled ? "#FF4D8D" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 000-7.8z"/>
    </svg>
  );
}

const ROSE_COST_LABEL = "1,99";

function SendIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
    </svg>
  );
}

function ClockIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
    </svg>
  );
}

function ShieldCheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/>
    </svg>
  );
}

function CheckIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  );
}

function SparkleHeartIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21s-7.5-4.8-10-9.3C.3 7.9 2.4 4 6.2 4c2 0 3.5 1 4.8 2.6C12.3 5 13.8 4 15.8 4 19.6 4 21.7 7.9 20 11.7 19.5 12.6 19.6 11.7 12 21z"/>
    </svg>
  );
}

function UsersIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  );
}

function DotsIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
    </svg>
  );
}

/* stato della relazione tra me e un altro utente, ricavato dalle liste del server */
const EMPTY_RELATIONS = { friends: [], incoming: [], outgoing: [], blocked: [], muted: [] };
function relStatus(userId, relations) {
  const has = (list) => (list || []).some((u) => u.id === userId);
  return {
    isFriend: has(relations.friends),
    incoming: has(relations.incoming),   // mi ha mandato una richiesta
    outgoing: has(relations.outgoing),   // gli ho mandato una richiesta
    blocked: has(relations.blocked),
    muted: has(relations.muted),
  };
}

const outlineBtn = "rounded-2xl font-body font-bold text-sm border border-neutral-200 text-neutral-600 hover:bg-neutral-50 transition-colors focus:outline-none focus:ring-2 focus:ring-pink-400";

/* pulsante "amicizia" che cambia in base allo stato (aggiungi / accetta / annulla / amici) */
function FriendControl({ userId, relations, actions }) {
  const st = relStatus(userId, relations);
  if (st.blocked) {
    return <BtnPrimary onClick={() => actions.unblock(userId)} className="w-full py-3 text-sm">Sblocca</BtnPrimary>;
  }
  if (st.isFriend) {
    return (
      <div className="w-full py-3 rounded-2xl text-center text-sm font-bold border border-neutral-200 text-neutral-600 flex items-center justify-center gap-2">
        <UsersIcon size={16} /> Amici
      </div>
    );
  }
  if (st.incoming) {
    return (
      <div className="flex gap-2">
        <BtnPrimary onClick={() => actions.accept(userId)} className="flex-1 py-3 text-sm">Accetta richiesta</BtnPrimary>
        <button onClick={() => actions.decline(userId)} className={`flex-1 py-3 ${outlineBtn}`}>Rifiuta</button>
      </div>
    );
  }
  if (st.outgoing) {
    return <button onClick={() => actions.decline(userId)} className={`w-full py-3 ${outlineBtn}`}>Richiesta inviata · Annulla</button>;
  }
  return <BtnPrimary onClick={() => actions.addFriend(userId)} className="w-full py-3 text-sm">Aggiungi agli amici</BtnPrimary>;
}

function SheetItem({ label, onClick, danger }) {
  return (
    <button onClick={onClick}
      className={`w-full text-left px-4 py-3 rounded-xl font-body font-semibold text-[15px] transition-colors focus:outline-none focus:ring-2 focus:ring-pink-400 ${
        danger ? "text-pink-600 hover:bg-pink-50" : "text-neutral-800 hover:bg-neutral-100"}`}>
      {label}
    </button>
  );
}

/* menu azioni su un utente: amico / blocca / silenzia.
   Amico → solo "silenzia" o "elimina amico". Non amico → aggiungi, blocca, silenzia. */
function UserActionSheet({ target, relations, actions, onClose, hideViewProfile }) {
  const [confirm, setConfirm] = useState(null);

  useEffect(() => { setConfirm(null); }, [target?.id]);
  useEffect(() => {
    if (!target) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;
  const st = relStatus(target.id, relations);
  const run = async (fn) => { await fn(target.id); onClose(); };
  const dangerous = (key, label, confirmLabel, fn) => (
    <SheetItem danger label={confirm === key ? confirmLabel : label}
      onClick={() => (confirm === key ? run(fn) : setConfirm(key))} />
  );
  const muteItem = st.muted
    ? <SheetItem label="Riattiva notifiche" onClick={() => run(actions.unmute)} />
    : <SheetItem label="Silenzia" onClick={() => run(actions.mute)} />;

  return (
    <div className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-xs bg-white sm:rounded-3xl rounded-t-3xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] fade-up shadow-2xl font-body">
        <div className="flex items-center gap-3 px-3 py-3">
          <Avatar src={target.avatar} name={target.name} size={40} />
          <div className="min-w-0">
            <div className="font-display font-bold text-neutral-900 truncate">@{target.handle}</div>
            <div className="font-mono2 text-[11px] text-neutral-400">
              {st.isFriend ? "amico" : st.incoming ? "ti ha chiesto l'amicizia" : st.outgoing ? "richiesta inviata" : st.blocked ? "bloccato" : "non è nei tuoi amici"}
            </div>
          </div>
        </div>
        <div className="border-t border-neutral-100 pt-1 space-y-0.5">
          {!hideViewProfile && !st.blocked && (
            <SheetItem label="Vedi profilo" onClick={() => { onClose(); actions.openProfile(target.id); }} />
          )}
          {st.blocked ? (
            <SheetItem label="Sblocca" onClick={() => run(actions.unblock)} />
          ) : st.isFriend ? (
            <>
              {muteItem}
              {dangerous("remove", "Elimina amico", "Tocca ancora per eliminare", actions.decline)}
            </>
          ) : (
            <>
              {st.incoming && <SheetItem label="Accetta richiesta" onClick={() => run(actions.accept)} />}
              {st.incoming && <SheetItem label="Rifiuta richiesta" onClick={() => run(actions.decline)} />}
              {st.outgoing && <SheetItem label="Annulla richiesta" onClick={() => run(actions.decline)} />}
              {!st.incoming && !st.outgoing && <SheetItem label="Aggiungi agli amici" onClick={() => run(actions.addFriend)} />}
              {muteItem}
              {dangerous("block", "Blocca", "Tocca ancora per bloccare", actions.block)}
            </>
          )}
        </div>
        <button onClick={onClose} className="w-full mt-1 py-3 text-neutral-400 text-sm font-semibold hover:text-neutral-600">Annulla</button>
      </div>
    </div>
  );
}

function BtnPrimary({ children, className = "", ...rest }) {
  return (
    <button {...rest}
      className={`rounded-2xl font-body font-bold hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-pink-400 ${className}`}
      style={{ background: BTN_BG, color: BTN_TXT }}>
      {children}
    </button>
  );
}

/* ———— autenticazione (registrazione + verifica + login) ———— */
function AuthModal({ open, reason, onClose, onAuthed }) {
  const [mode, setMode] = useState("register"); // register | verify | login
  const [form, setForm] = useState({ age: "", email: "", password: "", handle: "", city: "", gender: "" });
  const [avatar, setAvatar] = useState(AVATAR_CHOICES[0]);
  const [adult, setAdult] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  /* se una registrazione è rimasta a metà (email non ancora verificata),
     riapri direttamente sullo step del codice invece di far ripartire tutto */
  useEffect(() => {
    if (!open) return;
    setErr(""); setCode(""); setBusy(false);
    const pending = localStorage.getItem("foyer_pending_email");
    if (pending) {
      setForm((f) => ({ ...f, email: pending }));
      setMode("verify");
    } else {
      setMode("register");
    }
  }, [open]);

  const startOver = () => {
    localStorage.removeItem("foyer_pending_email");
    setForm({ age: "", email: "", password: "", handle: "", city: "", gender: "" });
    setMode("register"); setErr(""); setCode("");
  };

  const resendCode = async () => {
    setErr(""); setBusy(true);
    try {
      await api("/api/auth/resend-code", { method: "POST", body: { email: form.email } });
      setErr("Nuovo codice inviato.");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const doRegister = async () => {
    setErr("");
    if (!form.gender) return setErr("Seleziona F o M.");
    if (!adult) return setErr("Conferma di avere almeno 18 anni.");
    setBusy(true);
    try {
      await api("/api/auth/register", { method: "POST", body: { ...form, age: parseInt(form.age, 10) } });
      localStorage.setItem("foyer_pending_email", form.email.trim().toLowerCase());
      setMode("verify");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const doVerify = async () => {
    setErr(""); setBusy(true);
    try {
      const { token, user } = await api("/api/auth/verify", { method: "POST", body: { email: form.email, code } });
      localStorage.removeItem("foyer_pending_email");
      /* salva l'avatar scelto */
      await api("/api/me", { method: "PATCH", token, body: { avatar } });
      onAuthed(token, { ...user, avatar });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const doLogin = async () => {
    setErr(""); setBusy(true);
    try {
      const { token, user } = await api("/api/auth/login", { method: "POST", body: { email: form.email, password: form.password } });
      onAuthed(token, user);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const input = "w-full rounded-xl border border-neutral-200 px-4 py-3 text-[15px] outline-none focus:ring-2 focus:ring-violet-400";

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-md bg-white sm:rounded-3xl rounded-t-3xl p-6 fade-up shadow-2xl font-body max-h-[92vh] overflow-y-auto no-scrollbar">

        {mode === "verify" ? (
          <>
            <div className="font-display text-2xl font-extrabold text-neutral-900">Controlla la posta</div>
            <p className="text-neutral-500 text-sm mt-1">
              Abbiamo inviato un codice a 6 cifre a <span className="font-bold text-neutral-800">{form.email}</span>.
            </p>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="······" inputMode="numeric" autoFocus
              className="w-full mt-4 rounded-xl border border-neutral-200 px-4 py-3.5 text-center font-mono2 text-2xl tracking-[0.5em] outline-none focus:ring-2 focus:ring-violet-400" />
            {err && <div className="text-sm text-pink-600 font-medium mt-2">{err}</div>}
            <BtnPrimary onClick={doVerify} disabled={busy} className="w-full mt-4 py-3.5 text-base disabled:opacity-50">
              {busy ? "Verifico…" : "Verifica ed entra"}
            </BtnPrimary>
            <div className="flex items-center justify-between mt-2">
              <button onClick={resendCode} disabled={busy} className="text-neutral-400 text-sm hover:text-neutral-600 disabled:opacity-50">
                Non arrivato? Reinvia codice
              </button>
              <button onClick={startOver} className="text-neutral-400 text-sm hover:text-neutral-600">
                Ricomincia con un’altra email
              </button>
            </div>
          </>
        ) : mode === "login" ? (
          <>
            <div className="font-display text-2xl font-extrabold text-neutral-900">Bentornato</div>
            <p className="text-neutral-500 text-sm mt-1">Accedi con email e password.</p>
            <div className="mt-5 space-y-3.5">
              <input value={form.email} onChange={set("email")} placeholder="Email" type="email" className={input} />
              <input value={form.password} onChange={set("password")} placeholder="Password" type="password" className={input}
                onKeyDown={(e) => e.key === "Enter" && doLogin()} />
              {err && <div className="text-sm text-pink-600 font-medium">{err}</div>}
              <BtnPrimary onClick={doLogin} disabled={busy} className="w-full py-3.5 text-base disabled:opacity-50">
                {busy ? "Accedo…" : "Accedi"}
              </BtnPrimary>
              <button onClick={() => { setMode("register"); setErr(""); }} className="w-full py-2 text-neutral-400 text-sm hover:text-neutral-600">
                Non hai un account? Registrati
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="font-display text-2xl font-extrabold text-neutral-900">Crea il tuo profilo</div>
            <p className="text-neutral-500 text-sm mt-1">{reason}</p>
            <div className="mt-5 space-y-3.5">
              <input value={form.handle} onChange={set("handle")} placeholder="Nickname (es. luca.rm)" className={input} />
              <input value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value.replace(/\D/g, "") }))}
                placeholder="Età" inputMode="numeric" className={input} />
              <input value={form.email} onChange={set("email")} placeholder="Email" type="email" className={input} />
              <input value={form.password} onChange={set("password")} placeholder="Password (min 8 caratteri)" type="password" className={input} />
              <input value={form.city} onChange={set("city")} placeholder="Città (facoltativa)" className={input} />

              <div>
                <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400 mb-2">genere</div>
                <div className="flex gap-2">
                  {["F", "M"].map((g) => (
                    <button key={g} type="button" onClick={() => setForm((f) => ({ ...f, gender: g }))}
                      className={`flex-1 py-2.5 rounded-xl font-body font-bold text-sm border transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400 ${
                        form.gender === g ? "border-transparent" : "border-neutral-200 text-neutral-500 hover:border-pink-200"
                      }`}
                      style={form.gender === g ? { background: BTN_BG, color: BTN_TXT } : {}}>
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400 mb-2">scegli un avatar</div>
                <div className="flex gap-2 flex-wrap">
                  {AVATAR_CHOICES.map((src) => (
                    <button key={src} onClick={() => setAvatar(src)}
                      className={`rounded-full focus:outline-none focus:ring-2 focus:ring-violet-400 ${avatar === src ? "ring-2 ring-pink-500 ring-offset-2" : ""}`}>
                      <Avatar src={src} size={44} />
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-sm text-neutral-600 cursor-pointer select-none">
                <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-0.5 accent-pink-500" />
                Confermo di avere almeno 18 anni e accetto le regole della community.
              </label>

              {err && <div className="text-sm text-pink-600 font-medium">{err}</div>}
              <BtnPrimary onClick={doRegister} disabled={busy} className="w-full py-3.5 text-base disabled:opacity-50">
                {busy ? "Invio…" : "Continua → verifica email"}
              </BtnPrimary>
              <button onClick={() => { setMode("login"); setErr(""); }} className="w-full py-2 text-neutral-400 text-sm hover:text-neutral-600">
                Hai già un account? Accedi
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ———— foglio profilo altrui ———— */
/* una foto: nitida, oppure — se il titolare l'ha nascosta — la versione sfocata
   (un file diverso, non un filtro sopra l'originale) con un lucchetto */
function PhotoView({ photo, className = "", thumb = false }) {
  if (photo.hidden) {
    return (
      <div className={`relative overflow-hidden bg-neutral-300 ${className}`}>
        {photo.blur
          ? <img src={assetUrl(photo.blur)} alt="" className="w-full h-full object-cover" style={{ filter: "blur(6px)", transform: "scale(1.15)" }} />
          : <div className="w-full h-full" style={{ background: GRAD }} />}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/25 text-white">
          <LockIcon size={22} />
          <span className="font-body text-[11px] font-bold">Solo amici</span>
        </div>
      </div>
    );
  }
  return <img src={assetUrl(thumb ? (photo.thumb || photo.url) : photo.url)} alt="" loading="lazy" decoding="async" className={className} />;
}

/* foto scorrevoli: tocco a sinistra/destra, barra a tacche in stile storie */
function PhotoCarousel({ photos, className = "", children }) {
  const list = photos || [];
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [list.length]);
  const cur = list[Math.min(idx, Math.max(list.length - 1, 0))];
  const go = (d) => setIdx((i) => Math.min(Math.max(i + d, 0), list.length - 1));
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {cur
        ? <PhotoView photo={cur} className="absolute inset-0 w-full h-full object-cover" />
        : <div className="absolute inset-0" style={{ background: GRAD }} />}
      {list.length > 1 && (
        <>
          <button onClick={() => go(-1)} aria-label="Foto precedente" className="absolute left-0 top-0 bottom-0 w-[42%] z-10 focus:outline-none" />
          <button onClick={() => go(1)} aria-label="Foto successiva" className="absolute right-0 top-0 bottom-0 w-[42%] z-10 focus:outline-none" />
        </>
      )}
      {children}
      {list.length > 1 && (
        <div className="absolute top-3 left-4 right-24 flex gap-1 pointer-events-none">
          {list.map((_, i) => (
            <div key={i} className="flex-1 h-1 rounded-full bg-white/35 overflow-hidden">
              <div className="h-full bg-white transition-all" style={{ width: i <= idx ? "100%" : "0%" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* come posso contattare questa persona? Lo stato arriva dal server (user.contact):
   open | request | rose | pending | incoming | closed | self */
function ContactControl({ user, onContact, onRose }) {
  const c = user.contact;
  if (!c || c === "self") return null;
  if (c === "open") return <BtnPrimary onClick={() => onContact(user)} className="w-full py-3.5 text-base">Scrivi a {user.name}</BtnPrimary>;
  if (c === "incoming") return <BtnPrimary onClick={() => onContact(user)} className="w-full py-3.5 text-base">Accetta la richiesta di messaggio</BtnPrimary>;
  if (c === "pending") {
    return (
      <div className="w-full py-3.5 rounded-2xl text-center text-sm font-bold border border-neutral-200 text-neutral-500 flex items-center justify-center gap-2">
        <ClockIcon size={16} /> Richiesta inviata
      </div>
    );
  }
  if (c === "request") {
    return (
      <div className="space-y-2">
        <BtnPrimary onClick={() => onContact(user)} className="w-full py-3.5 text-base">Chiedi di scrivere</BtnPrimary>
        <button onClick={() => onRose(user)} className={`w-full py-3 ${outlineBtn}`}>🌹 Invia una rosa · {ROSE_COST_LABEL}</button>
      </div>
    );
  }
  if (c === "rose") {
    return (
      <div className="space-y-2">
        <BtnPrimary onClick={() => onRose(user)} className="w-full py-3.5 text-base">🌹 Invia una rosa per scrivere · {ROSE_COST_LABEL}</BtnPrimary>
        <p className="font-body text-[12px] text-neutral-400 text-center">@{user.handle} accetta messaggi solo da chi invia una rosa. Decide comunque lei/lui.</p>
      </div>
    );
  }
  if (c === "closed" && !user.unverified) {
    return <p className="font-body text-[13px] text-neutral-400 text-center">Non è possibile scrivere a questa persona.</p>;
  }
  return null;
}

function ProfileSheet({ user, token, onClose, onMessage, onRose, relations, actions, onOpenActions }) {
  const [likes, setLikes] = useState({}); // idx -> {liked, count}

  useEffect(() => {
    if (!user) return;
    const prevBody = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prevBody; window.removeEventListener("keydown", onKey); };
  }, [user, onClose]);

  if (!user) return null;

  /* vista limitata (profilo privato e non siamo amici): il backend manda solo
     nickname/età/genere — niente foto né bio. Si può comunque chiedere l'amicizia. */
  if (user.restricted) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div onClick={(e) => e.stopPropagation()}
          className="relative w-full sm:max-w-sm bg-white sm:rounded-3xl rounded-t-3xl p-8 fade-up shadow-2xl font-body text-center">
          <div className="absolute top-4 right-4 flex gap-2">
            <button onClick={() => onOpenActions(user)} aria-label="Altre azioni" title="Altre azioni"
              className="w-9 h-9 rounded-full bg-neutral-100 text-neutral-500 flex items-center justify-center hover:bg-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-400"><DotsIcon size={16} /></button>
            <button onClick={onClose} aria-label="Chiudi" title="Chiudi (ESC)"
              className="w-9 h-9 rounded-full bg-neutral-100 text-neutral-500 flex items-center justify-center hover:bg-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-400">✕</button>
          </div>
          <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4 mt-2" style={{ background: BTN_BG, color: BTN_TXT }}>
            <LockIcon size={26} />
          </div>
          <div className="font-display text-2xl font-extrabold text-neutral-900 flex items-center justify-center gap-2">
            @{user.handle}, {user.age} <GenderChip gender={user.gender} />
          </div>
          {user.age_verified && (
            <span className="font-mono2 text-[11px] px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-green-700 inline-flex items-center gap-1.5 mt-2">
              <ShieldCheckIcon size={12} /> età verificata
            </span>
          )}
          <p className="font-body text-neutral-500 mt-2">
            {user.unverified
              ? "Questo profilo non ha ancora verificato l'età, quindi non è visibile."
              : "Questo profilo è privato. Diventa amico per vederlo."}
          </p>
          {!user.unverified && (
            <div className="mt-5 text-left space-y-2.5">
              <FriendControl userId={user.id} relations={relations} actions={actions} />
              <ContactControl user={user} onContact={onMessage} onRose={onRose} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const toggleLike = async (idx) => {
    try {
      const r = await api(`/api/likes/${user.id}/${idx}`, { method: "POST", token });
      setLikes((l) => ({ ...l, [idx]: r }));
    } catch (e) { console.error(e); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto overscroll-contain no-scrollbar bg-white sm:rounded-3xl rounded-t-3xl fade-up shadow-2xl">
        {/* X sempre visibile anche scorrendo (+ ESC) */}
        <div className="sticky top-3 z-20 h-0 flex justify-end gap-2 pr-3">
          <button onClick={() => onOpenActions(user)} aria-label="Altre azioni: amico, silenzia, blocca" title="Altre azioni"
            className="w-10 h-10 rounded-full bg-black/50 text-white backdrop-blur flex items-center justify-center hover:bg-black/70 shadow-lg focus:outline-none focus:ring-2 focus:ring-white"><DotsIcon size={18} /></button>
          <button onClick={onClose} aria-label="Chiudi profilo (o premi ESC)" title="Chiudi (ESC)"
            className="w-10 h-10 rounded-full bg-black/50 text-white backdrop-blur flex items-center justify-center hover:bg-black/70 shadow-lg focus:outline-none focus:ring-2 focus:ring-white">✕</button>
        </div>

        <PhotoCarousel photos={user.photos} className="h-72">
          <div className="absolute inset-0 pointer-events-none" style={{ background: "linear-gradient(180deg,transparent 40%,rgba(0,0,0,.65))" }} />
          <div className="absolute bottom-4 left-5 right-5 flex items-end justify-between pointer-events-none">
            <div>
              <div className="font-display text-white text-3xl font-bold leading-none flex items-center gap-2">
                {user.name}, {user.age} <GenderChip gender={user.gender} />
              </div>
              <div className="font-mono2 text-white/80 text-xs mt-1.5">@{user.handle}</div>
            </div>
            <Avatar src={user.avatar} name={user.name} size={52} ring />
          </div>
        </PhotoCarousel>

        <div className="p-5 space-y-5 font-body">
          <div className="flex flex-wrap gap-2 items-center">
            <Badge>✉️ email verificata</Badge>
            {user.streak > 1 && <Badge>🔥 streak {user.streak}</Badge>}
            {user.age_verified && (
              <span className="font-mono2 text-[11px] px-2.5 py-1 rounded-full bg-green-50 border border-green-200 text-green-700 flex items-center gap-1.5">
                <ShieldCheckIcon size={12} /> età verificata
              </span>
            )}
            <span className="font-mono2 text-[11px] px-2.5 py-1 rounded-full bg-neutral-100 border border-neutral-200 text-neutral-700 flex items-center gap-1.5">
              <UsersIcon size={12} /> {user.friend_count ?? 0} amici
            </span>
          </div>

          {(user.vibe || user.bio) && (
            <div>
              <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400 mb-1">vibe</div>
              <div className="font-display text-lg font-semibold text-neutral-900">{user.vibe || "—"}</div>
              <p className="text-neutral-600 mt-1.5">{user.bio}</p>
            </div>
          )}

          {(user.prompts || []).length > 0 && (
            <div className="space-y-3">
              {user.prompts.map(([q, a], idx) => {
                const st = likes[idx];
                return (
                  <div key={idx} className="rounded-2xl border border-neutral-200 p-4 bg-neutral-50">
                    <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400">{q}</div>
                    <div className="font-display text-lg text-neutral-900 mt-1">{a}</div>
                    <div className="flex items-center gap-2.5 mt-3">
                      <button onClick={() => toggleLike(idx)}
                        aria-label="Metti like a questo prompt"
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-pink-400 ${
                          st?.liked ? "border-pink-200 bg-pink-50 text-pink-600" : "border-neutral-200 bg-white text-neutral-600 hover:border-pink-200"}`}>
                        <HeartIcon filled={!!st?.liked} size={15} /> {st?.count ?? ""}
                      </button>
                      <BtnPrimary onClick={() => onMessage(user, q)} className="px-3 py-1.5 rounded-full text-sm">
                        Rispondi a questo
                      </BtnPrimary>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(user.photos || []).length > 0 && (
            <div>
              <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400 mb-2">foto</div>
              <div className="grid grid-cols-3 gap-1.5 rounded-2xl overflow-hidden">
                {user.photos.map((p) => (
                  <div key={p.id} className="relative aspect-square">
                    <PhotoView photo={p} thumb className="w-full h-full object-cover hover:opacity-90 transition-opacity" />
                  </div>
                ))}
              </div>
            </div>
          )}

          <FriendControl userId={user.id} relations={relations} actions={actions} />
          <ContactControl user={user} onContact={onMessage} onRose={onRose} />
          <div className="h-2" />
        </div>
      </div>
    </div>
  );
}

/* ———— sezione "Amici" nel mio profilo ———— */
function PersonRow({ u, onOpen, children, isOnline }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onOpen}
        className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-400">
        <Avatar src={u.avatar} name={u.name} size={36} online={isOnline?.(u.id)} />
        <span className="block font-display font-bold text-neutral-900 truncate">@{u.handle}</span>
      </button>
      {children}
    </div>
  );
}

function FriendsSection({ relations, actions, isOnline }) {
  const { friends, incoming, outgoing, blocked, muted } = relations;
  const pill = "px-3 py-1.5 rounded-full text-xs font-bold";
  const ghost = `${pill} border border-neutral-200 text-neutral-600 hover:bg-white transition-colors`;
  return (
    <div className="rounded-2xl border border-neutral-200 p-4 bg-neutral-50 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400">amici · {friends.length}</div>
        <span className="text-neutral-400"><UsersIcon size={16} /></span>
      </div>

      {incoming.length > 0 && (
        <div className="space-y-2.5">
          <div className="font-body text-[13px] font-bold text-neutral-700">Richieste ricevute · {incoming.length}</div>
          {incoming.map((u) => (
            <PersonRow key={u.id} u={u} isOnline={isOnline} onOpen={() => actions.openProfile(u.id)}>
              <BtnPrimary onClick={() => actions.accept(u.id)} className={pill}>Accetta</BtnPrimary>
              <button onClick={() => actions.decline(u.id)} className={ghost}>Rifiuta</button>
            </PersonRow>
          ))}
        </div>
      )}

      {friends.length > 0 ? (
        <div className="space-y-2.5">
          {friends.map((u) => (
            <PersonRow key={u.id} u={u} isOnline={isOnline} onOpen={() => actions.openProfile(u.id)}>
              <button onClick={() => actions.openActions(u)} aria-label={`Azioni per ${u.handle}`} title="Silenzia o elimina amico"
                className="w-8 h-8 rounded-full text-neutral-400 hover:bg-white hover:text-neutral-700 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-violet-400">
                <DotsIcon size={16} />
              </button>
            </PersonRow>
          ))}
        </div>
      ) : incoming.length === 0 && (
        <p className="text-neutral-400 text-sm">Nessun amico ancora. Apri un profilo o una chat e tocca "Aggiungi agli amici".</p>
      )}

      {outgoing.length > 0 && (
        <div className="space-y-2.5">
          <div className="font-body text-[13px] font-bold text-neutral-700">In attesa di risposta · {outgoing.length}</div>
          {outgoing.map((u) => (
            <PersonRow key={u.id} u={u} isOnline={isOnline} onOpen={() => actions.openProfile(u.id)}>
              <button onClick={() => actions.decline(u.id)} className={ghost}>Annulla</button>
            </PersonRow>
          ))}
        </div>
      )}

      {(blocked.length > 0 || muted.length > 0) && (
        <details className="group">
          <summary className="cursor-pointer select-none font-body text-[13px] font-bold text-neutral-500 hover:text-neutral-700">
            Bloccati e silenziati · {blocked.length + muted.length}
          </summary>
          <div className="space-y-2.5 mt-3">
            {blocked.map((u) => (
              <PersonRow key={`b-${u.id}`} u={u} isOnline={isOnline} onOpen={() => {}}>
                <span className="font-mono2 text-[10px] text-neutral-400">bloccato</span>
                <button onClick={() => actions.unblock(u.id)} className={ghost}>Sblocca</button>
              </PersonRow>
            ))}
            {muted.map((u) => (
              <PersonRow key={`m-${u.id}`} u={u} isOnline={isOnline} onOpen={() => actions.openProfile(u.id)}>
                <span className="font-mono2 text-[10px] text-neutral-400">silenziato</span>
                <button onClick={() => actions.unmute(u.id)} className={ghost}>Riattiva</button>
              </PersonRow>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ———— il mio profilo: foto (upload/elimina), bio/vibe, prompt ———— */
const PROMPT_IDEAS = [
  "Il modo migliore per rompere il ghiaccio con me è…",
  "Non dirlo a nessuno, ma…",
  "La mia idea di un secondo appuntamento perfetto…",
  "Sono pessimo/a a nascondere quando…",
  "Mi conquisti se…",
  "Green flag immediata…",
];

function MyProfileSheet({ open, me, token, onClose, onUpdate, relations, relActions, isOnline }) {
  const fileRef = useRef(null);
  const avatarInputRef = useRef(null);
  const [bio, setBio] = useState("");
  const [vibe, setVibe] = useState("");
  const [editing, setEditing] = useState(false);
  const [prompts, setPrompts] = useState([]);
  const [avatarHover, setAvatarHover] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [ageBusy, setAgeBusy] = useState(false);
  const [ageConfigured, setAgeConfigured] = useState(true); // true finché non sappiamo il contrario, evita un lampo "non disponibile"

  useEffect(() => {
    if (!open || !token) return;
    api("/api/verify-age/status", { token }).then((s) => setAgeConfigured(s.configured)).catch(() => {});
  }, [open, token]);

  const startAgeVerify = async () => {
    setAgeBusy(true); setErr("");
    try {
      const r = await api("/api/verify-age/start", { method: "POST", token });
      if (r.already) onUpdate((m) => ({ ...m, age_verified: true }));
      else if (r.url) window.open(r.url, "_blank", "noopener");
    } catch (e) { setErr(e.message); }
    setAgeBusy(false);
  };
  const [editingPrompts, setEditingPrompts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open && me) {
      setBio(me.bio || ""); setVibe(me.vibe || "");
      setPrompts(me.prompts?.length ? me.prompts : []);
      setEditing(false); setEditingPrompts(false); setErr("");
    }
  }, [open, me]);

  useEffect(() => {
    if (!open) return;
    const prevBody = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prevBody; window.removeEventListener("keydown", onKey); };
  }, [open, onClose]);

  if (!open || !me) return null;
  const photos = me.photos || [];

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, 6 - photos.length);
    e.target.value = "";
    setBusy(true); setErr("");
    for (const f of files) {
      try {
        const v = await makePhotoVariants(f);
        const fd = new FormData();
        fd.append("photo", v.full, "photo.jpg");
        fd.append("thumb", v.thumb, "thumb.jpg");
        fd.append("blur", v.blur, "blur.jpg");
        const saved = await api("/api/me/photos", { method: "POST", token, body: fd, formData: true });
        onUpdate((m) => ({ ...m, photos: [...(m.photos || []), saved] }));
      } catch (er) { setErr(er.message || "Non riesco a leggere questa immagine"); }
    }
    setBusy(false);
  };

  const removePhoto = async (photo) => {
    try {
      await api(`/api/me/photos/${photo.id}`, { method: "DELETE", token });
      onUpdate((m) => ({ ...m, photos: (m.photos || []).filter((p) => p.id !== photo.id) }));
    } catch (er) { setErr(er.message); }
  };

  /* "Sfocata": se accesa, ai non amici il server manda solo la versione sfocata di
     questa foto (profilo e griglia); nitida resta solo per me e per i miei amici */
  const toggleFriendsOnly = async (photo) => {
    const next = !photo.friends_only;
    const setFlag = (val) => onUpdate((m) => ({ ...m, photos: (m.photos || []).map((p) => (p.id === photo.id ? { ...p, friends_only: val } : p)) }));
    setFlag(next);
    try {
      await api(`/api/me/photos/${photo.id}`, { method: "PATCH", token, body: { friends_only: next } });
    } catch (er) {
      setFlag(!next); // rollback se la chiamata fallisce
      setErr(er.message);
    }
  };

  /* "DM privati": chi vuole scriverti deve inviare una rosa (tu accetti o rifiuti sempre) */
  const toggleDmPrivate = async () => {
    const next = !me.dm_private;
    onUpdate((m) => ({ ...m, dm_private: next }));
    try {
      await api("/api/me", { method: "PATCH", token, body: { dm_private: next } });
    } catch (er) {
      onUpdate((m) => ({ ...m, dm_private: !next }));
      setErr(er.message);
    }
  };

  const togglePrivate = async () => {
    const next = !me.private;
    onUpdate((m) => ({ ...m, private: next }));
    try {
      await api("/api/me", { method: "PATCH", token, body: { private: next } });
    } catch (er) {
      onUpdate((m) => ({ ...m, private: !next }));
      setErr(er.message);
    }
  };

  const uploadAvatarFile = async (file) => {
    if (!file || !file.type?.startsWith("image/")) return;
    setAvatarBusy(true); setErr("");
    try {
      const img = await loadImageFile(file);
      const small = await drawToBlob(img, 512, 0.85);
      const fd = new FormData();
      fd.append("avatar", small, "avatar.jpg");
      const res = await api("/api/me/avatar", { method: "POST", token, body: fd, formData: true });
      onUpdate((m) => ({ ...m, avatar: res.avatar }));
    } catch (er) { setErr(er.message); }
    setAvatarBusy(false);
  };

  const onAvatarInputChange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) uploadAvatarFile(f);
  };

  const onAvatarDrop = (e) => {
    e.preventDefault();
    setAvatarDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadAvatarFile(f);
  };

  const saveEdits = async () => {
    setBusy(true); setErr("");
    try {
      const updated = await api("/api/me", { method: "PATCH", token, body: { bio: bio.trim(), vibe: vibe.trim() } });
      onUpdate((m) => ({ ...m, bio: updated.bio, vibe: updated.vibe }));
      setEditing(false);
    } catch (er) { setErr(er.message); }
    setBusy(false);
  };

  const savePrompts = async () => {
    setBusy(true); setErr("");
    try {
      const clean = prompts.filter(([q, a]) => q.trim() && a.trim()).slice(0, 3);
      await api("/api/me/prompts", { method: "PUT", token, body: { prompts: clean } });
      onUpdate((m) => ({ ...m, prompts: clean }));
      setEditingPrompts(false);
    } catch (er) { setErr(er.message); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto overscroll-contain no-scrollbar bg-white sm:rounded-3xl rounded-t-3xl fade-up shadow-2xl">
        <div className="sticky top-3 z-20 h-0 flex justify-end pr-3">
          <button onClick={onClose} aria-label="Chiudi il mio profilo (o premi ESC)" title="Chiudi (ESC)"
            className="w-10 h-10 rounded-full bg-black/50 text-white backdrop-blur flex items-center justify-center hover:bg-black/70 shadow-lg focus:outline-none focus:ring-2 focus:ring-white">✕</button>
        </div>

        <div className="relative h-48" style={{ background: GRAD }}>
          <div className="absolute bottom-4 left-5 right-5 flex items-end justify-between">
            <div>
              <div className="font-display text-white text-3xl font-bold leading-none flex items-center gap-2">
                @{me.handle}, {me.age} <GenderChip gender={me.gender} />
              </div>
              <div className="font-mono2 text-white/80 text-xs mt-1.5">nickname pubblico</div>
            </div>
            <div
              className="relative rounded-full cursor-pointer"
              onMouseEnter={() => setAvatarHover(true)}
              onMouseLeave={() => setAvatarHover(false)}
              onClick={() => avatarInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setAvatarDragOver(true); }}
              onDragLeave={() => setAvatarDragOver(false)}
              onDrop={onAvatarDrop}
              role="button"
              tabIndex={0}
              aria-label="Cambia foto profilo: clicca o trascina un'immagine qui"
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") avatarInputRef.current?.click(); }}>
              <Avatar src={me.avatar} name={me.handle} size={56} ring />
              {(avatarHover || avatarDragOver || avatarBusy) && (
                <div className="absolute inset-0 rounded-full flex items-center justify-center bg-black/45 text-white transition-opacity">
                  {avatarBusy ? (
                    <span className="font-mono2 text-[9px]">…</span>
                  ) : (
                    <PencilIcon size={18} />
                  )}
                </div>
              )}
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarInputChange} />
            </div>
          </div>
        </div>

        <div className="p-5 space-y-5 font-body">
          <div className="flex flex-wrap gap-2 items-center">
            <Badge>✉️ email verificata</Badge>
            <span className="font-mono2 text-[11px] px-2.5 py-1 rounded-full bg-neutral-100 border border-neutral-200 text-neutral-700">
              🔥 streak {me.streak || 1}
            </span>
          </div>

          {/* bio + vibe */}
          <div className="rounded-2xl border border-neutral-200 p-4 bg-neutral-50 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400">chi sono</div>
              <BtnPrimary onClick={editing ? saveEdits : () => setEditing(true)} disabled={busy}
                className="text-sm px-3 py-1 rounded-full disabled:opacity-50">
                {editing ? (busy ? "Salvo…" : "Salva") : "Modifica"}
              </BtnPrimary>
            </div>
            {editing ? (
              <>
                <input value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="La tua vibe in 2-3 parole"
                  className="w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-violet-400" />
                <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Racconta qualcosa di te…" rows={3}
                  className="w-full rounded-xl border border-neutral-200 px-3.5 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-violet-400 resize-none" />
              </>
            ) : (
              <>
                <div className="font-display text-lg font-semibold text-neutral-900">{me.vibe || "Aggiungi la tua vibe ✨"}</div>
                <p className="text-neutral-600">{me.bio || "Nessuna bio ancora — le persone con una bio ricevono molti più messaggi."}</p>
              </>
            )}
          </div>

          {/* prompt del profilo */}
          <div className="rounded-2xl border border-neutral-200 p-4 bg-neutral-50 space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400">i miei prompt · max 3</div>
              <BtnPrimary onClick={editingPrompts ? savePrompts : () => setEditingPrompts(true)} disabled={busy}
                className="text-sm px-3 py-1 rounded-full disabled:opacity-50">
                {editingPrompts ? (busy ? "Salvo…" : "Salva") : "Modifica"}
              </BtnPrimary>
            </div>
            {editingPrompts ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-1.5">
                    <select
                      value={prompts[i]?.[0] || ""}
                      onChange={(e) => setPrompts((p) => { const c = [...p]; c[i] = [e.target.value, c[i]?.[1] || ""]; return c; })}
                      className="w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-400 bg-white">
                      <option value="">— scegli un prompt —</option>
                      {PROMPT_IDEAS.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                    {prompts[i]?.[0] && (
                      <input value={prompts[i]?.[1] || ""} placeholder="La tua risposta…"
                        onChange={(e) => setPrompts((p) => { const c = [...p]; c[i] = [c[i][0], e.target.value]; return c; })}
                        className="w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-violet-400" />
                    )}
                  </div>
                ))}
              </div>
            ) : (me.prompts || []).length > 0 ? (
              me.prompts.map(([q, a], i) => (
                <div key={i}>
                  <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400">{q}</div>
                  <div className="font-display text-base text-neutral-900">{a}</div>
                </div>
              ))
            ) : (
              <p className="text-neutral-400 text-sm">Nessun prompt ancora — i profili con prompt ricevono molti più like.</p>
            )}
          </div>

          {/* le mie foto */}
          <div>
            <div className="font-mono2 text-[11px] uppercase tracking-widest text-neutral-400 mb-2">le mie foto · {photos.length}/6</div>
            <div className="grid grid-cols-3 gap-1.5">
              {photos.map((p, idx) => (
                <div key={p.id} className="relative aspect-square rounded-xl overflow-hidden">
                  <img src={assetUrl(p.thumb || p.url)} alt={`foto ${idx + 1}`} className="w-full h-full object-cover" />
                  <button onClick={() => removePhoto(p)} aria-label={`Elimina foto ${idx + 1}`}
                    className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/60 text-white text-xs flex items-center justify-center hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white">🗑</button>
                  {idx === 0 && <span className="absolute top-1.5 left-1.5 font-mono2 text-[9px] text-white bg-black/60 rounded px-1.5 py-0.5">principale</span>}
                  <button
                    onClick={() => toggleFriendsOnly(p)}
                    aria-pressed={!!p.friends_only}
                    aria-label={p.friends_only ? "Foto sfocata per gli altri: tocca per mostrarla nitida a tutti" : "Foto visibile a tutti: tocca per sfocarla agli altri"}
                    title="Sfocata per chi non è tuo amico"
                    className="absolute bottom-0 left-0 right-0 flex items-center justify-between gap-1 px-1.5 py-1.5 bg-black/60 backdrop-blur-sm text-white focus:outline-none focus:ring-2 focus:ring-white">
                    <span className="font-body font-semibold text-[10px] leading-none whitespace-nowrap">Sfocata</span>
                    <span className="w-7 h-4 rounded-full flex items-center px-0.5 shrink-0 transition-colors"
                      style={{ background: p.friends_only ? BTN_TXT : "rgba(255,255,255,0.35)" }}>
                      <span className="w-3 h-3 rounded-full shadow transition-transform"
                        style={{ background: p.friends_only ? BTN_BG : "#fff", transform: p.friends_only ? "translateX(12px)" : "translateX(0)" }} />
                    </span>
                  </button>
                </div>
              ))}
              {photos.length < 6 && (
                <button onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Aggiungi una foto"
                  className="aspect-square rounded-xl border-2 border-dashed border-neutral-300 flex flex-col items-center justify-center gap-1 text-neutral-400 hover:border-pink-300 hover:text-pink-400 transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-pink-400">
                  <span className="text-2xl leading-none">{busy ? "…" : "+"}</span>
                  <span className="font-mono2 text-[10px]">{busy ? "carico" : "aggiungi"}</span>
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={addPhotos} />
            <p className="font-body text-[12px] text-neutral-400 mt-2">La prima foto è quella principale; massimo 6. Le foto si vedono a tutti: accendi "Sfocata" solo su quelle che non vuoi mostrare. Chi non è tuo amico ne vede una versione sfocata con un lucchetto (per far venire curiosità), nitida solo per te e per i tuoi amici.</p>
          </div>

          {err && <div className="text-sm text-pink-600 font-medium">{err}</div>}

          {/* amici, richieste, bloccati */}
          <FriendsSection relations={relations} actions={relActions} isOnline={isOnline} />

          {/* privacy: profilo privato o no */}
          <button
            onClick={togglePrivate}
            className="w-full flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 p-4 bg-neutral-50 text-left focus:outline-none focus:ring-2 focus:ring-pink-400">
            <span className="flex items-center gap-3">
              <span className="shrink-0" style={{ color: me.private ? "#FF4D8D" : "#a3a3a3" }}>
                <LockIcon size={20} />
              </span>
              <span>
                <span className="block font-display font-bold text-neutral-900">Profilo privato</span>
                <span className="block font-body text-[13px] text-neutral-500">
                  {me.private
                    ? "Chi non è tuo amico vede solo che il profilo è privato."
                    : "Chiunque apra il tuo profilo vede foto, bio e prompt."}
                </span>
              </span>
            </span>
            <span className="shrink-0 w-12 h-7 rounded-full flex items-center px-1 transition-colors"
              style={{ background: me.private ? BTN_BG : "#e5e5e5" }}>
              <span className="w-5 h-5 rounded-full bg-white shadow transition-transform"
                style={{ transform: me.private ? "translateX(20px)" : "translateX(0)", background: me.private ? BTN_TXT : "white" }} />
            </span>
          </button>

          {/* messaggi: aperti a tutti i verificati, o solo con una rosa */}
          <button
            onClick={toggleDmPrivate} aria-pressed={!!me.dm_private}
            className="w-full flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 p-4 bg-neutral-50 text-left focus:outline-none focus:ring-2 focus:ring-pink-400">
            <span className="flex items-center gap-3">
              <span className="shrink-0" style={{ color: me.dm_private ? "#FF4D8D" : "#a3a3a3" }}>
                <SendIcon size={20} />
              </span>
              <span>
                <span className="block font-display font-bold text-neutral-900">DM privati</span>
                <span className="block font-body text-[13px] text-neutral-500">
                  {me.dm_private
                    ? "Per scriverti serve una rosa. Tu accetti o rifiuti sempre."
                    : "Chiunque sia verificato può chiederti di scrivere. Tu accetti o rifiuti."}
                </span>
              </span>
            </span>
            <span className="shrink-0 w-12 h-7 rounded-full flex items-center px-1 transition-colors"
              style={{ background: me.dm_private ? BTN_BG : "#e5e5e5" }}>
              <span className="w-5 h-5 rounded-full bg-white shadow transition-transform"
                style={{ transform: me.dm_private ? "translateX(20px)" : "translateX(0)", background: me.dm_private ? BTN_TXT : "white" }} />
            </span>
          </button>

          <div className="rounded-2xl border border-neutral-200 p-4 bg-neutral-50 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0" style={{ color: me.age_verified ? "#16A34A" : "#a3a3a3" }}>
                <ShieldCheckIcon size={22} />
              </span>
              <div className="min-w-0">
                <div className="font-display font-bold text-neutral-900">
                  {me.age_verified ? "Età verificata" : "Verifica la tua età"}
                </div>
                <div className="font-body text-[13px] text-neutral-500">
                  {me.age_verified
                    ? "Il tuo profilo mostra il badge agli altri."
                    : ageConfigured
                    ? "Facoltativo per ora — rende il profilo più affidabile."
                    : "Non ancora disponibile su questo sito."}
                </div>
              </div>
            </div>
            {!me.age_verified && ageConfigured && (
              <BtnPrimary onClick={startAgeVerify} disabled={ageBusy} className="px-4 py-2.5 text-sm shrink-0 disabled:opacity-50">
                {ageBusy ? "…" : "Verifica"}
              </BtnPrimary>
            )}
          </div>

          <div className="rounded-xl bg-neutral-50 border border-neutral-200 px-3.5 py-2.5 font-mono2 text-[11px] text-neutral-500">
            ✉️ {me.email} · account verificato
          </div>
          <div className="h-2" />
        </div>
      </div>
    </div>
  );
}

/* ———— chat ———— */
function ChatImage({ src, sensitive }) {
  const [revealed, setRevealed] = useState(false);
  if (!sensitive || revealed) return <img src={src} alt="condivisa" className="rounded-xl mb-2 max-h-64 object-cover" />;
  return (
    <button onClick={() => setRevealed(true)}
      className="relative rounded-xl mb-2 overflow-hidden block focus:outline-none focus:ring-2 focus:ring-pink-400"
      aria-label="Immagine potenzialmente sensibile, tocca per mostrarla">
      <img src={src} alt="" className="max-h-64 object-cover" style={{ filter: "blur(22px)", transform: "scale(1.1)" }} />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/30 text-white">
        <EyeIcon size={20} />
        <span className="font-body text-xs font-bold">Contenuto sensibile</span>
        <span className="font-mono2 text-[10px] text-white/70">tocca per mostrare</span>
      </span>
    </button>
  );
}

function MessageRow({ msg, mine, onOpenProfile }) {
  return (
    <div className={`flex gap-2.5 ${mine ? "flex-row-reverse" : ""} fade-up`}>
      {!mine && (
        <button onClick={() => onOpenProfile(msg.user_id)} className="focus:outline-none focus:ring-2 focus:ring-violet-400 rounded-full self-end"
          aria-label={`Apri il profilo di ${msg.name}`}>
          <Avatar src={msg.avatar} name={msg.name} size={32} />
        </button>
      )}
      <div className={`max-w-[75%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
        {!mine && <span className="font-mono2 text-[11px] text-neutral-400 mb-1 ml-1">@{msg.handle}</span>}
        <div className={`rounded-2xl px-4 py-2.5 font-body text-[15px] leading-snug ${
          mine ? "text-white rounded-br-md" : "bg-white border border-neutral-200 text-neutral-900 rounded-bl-md"}`}
          style={mine ? { background: GRAD } : {}}>
          {msg.image && <ChatImage src={msg.image} sensitive={!!msg.sensitive} />}
          {msg.text}
        </div>
        <span className={`font-mono2 text-[10px] text-neutral-400 mt-1 ${mine ? "mr-1" : "ml-1"}`}>{fmtTime(msg.created_at)}</span>
      </div>
    </div>
  );
}

function ChatView({ room, meId, isGuest, gateBlocked, onVerify, messages, onSend, onOpenProfile, requireAuth, dmOther, onOpenActions }) {
  const [text, setText] = useState("");
  const [pendingImg, setPendingImg] = useState(null);
  const fileRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, room?.id]);

  if (!room) return null;
  const isDm = room.id.startsWith("dm-");
  /* i guest leggono soltanto; scrivere richiede un account; la stanza rosa e i
     messaggi privati richiedono anche la verifica dell'età (quando è attiva) */
  const needsVerify = gateBlocked && (isDm || room.access === "members");
  const canWrite = !isGuest && !needsVerify;
  const canView = !(room.access === "members" && (isGuest || gateBlocked));

  if (!canView) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: "#FAFAFC" }}>
        <div className="text-center max-w-sm px-8 fade-up">
          <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4" style={{ background: BTN_BG, color: BTN_TXT }}>
            <LockIcon size={26} />
          </div>
          <div className="font-display text-2xl font-extrabold text-neutral-900">La stanza rosa è riservata</div>
          <p className="font-body text-neutral-500 mt-2">
            {isGuest ? "Qui entrano solo profili registrati e con l'età verificata." : "Per entrare devi prima verificare la tua età."}
          </p>
          {isGuest ? (
            <BtnPrimary onClick={() => requireAuth("La stanza rosa è riservata ai profili registrati.")} className="mt-5 px-8 py-3.5">
              Crea il profilo ed entra
            </BtnPrimary>
          ) : (
            <BtnPrimary onClick={onVerify} className="mt-5 px-8 py-3.5">Verifica la tua età</BtnPrimary>
          )}
        </div>
      </div>
    );
  }

  const submit = () => {
    if (!text.trim() && !pendingImg) return;
    onSend(room.id, text.trim(), pendingImg);
    setText(""); setPendingImg(null);
  };

  const pickImage = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const src = await compressImage(f);
      const sensitive = await analyzeImageSensitivity(src);
      setPendingImg({ src, sensitive });
    } catch { /* file illeggibile, ignora */ }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-neutral-200 bg-white/80 backdrop-blur flex items-center gap-3">
        <div className="w-2.5 h-9 rounded-full" style={{ background: room.hue || "#FF4D8D" }} />
        <div className="min-w-0 flex-1">
          <div className="font-display font-bold text-lg text-neutral-900 truncate flex items-center gap-2">
            {isDm ? room.name : `#${room.name}`}
            {room.access === "view" && <span className="text-neutral-400"><EyeIcon /></span>}
            {room.access === "members" && <span className="text-pink-500"><LockIcon /></span>}
          </div>
          <div className="font-body text-[13px] text-neutral-500 truncate">{room.topic}</div>
        </div>
        {isDm && dmOther && (
          <button onClick={() => onOpenActions(dmOther)} aria-label="Azioni: aggiungi agli amici, silenzia, blocca" title="Amico · Silenzia · Blocca"
            className="shrink-0 rounded-full hover:ring-2 hover:ring-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-400 transition-shadow">
            <Avatar src={dmOther.avatar} name={dmOther.name} size={38} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4" style={{ background: "#FAFAFC" }}>
        {messages.length === 0 && (
          <p className="text-center font-body text-sm text-neutral-400 pt-8">Nessun messaggio ancora — rompi il ghiaccio!</p>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} msg={m} mine={m.user_id === meId} onOpenProfile={onOpenProfile} />
        ))}
        <div ref={bottomRef} />
      </div>

      {canWrite ? (
        <div className="border-t border-neutral-200 bg-white p-3 sm:p-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {pendingImg && (
            <div className="mb-2.5 relative inline-block">
              <img src={pendingImg.src} alt="anteprima allegato" className="h-20 rounded-xl object-cover"
                style={pendingImg.sensitive ? { filter: "blur(8px)" } : {}} />
              {pendingImg.sensitive && (
                <span className="absolute bottom-1 left-1 right-8 font-mono2 text-[9px] text-white bg-black/60 rounded px-1.5 py-0.5">⚠ verrà inviata sfocata</span>
              )}
              <button onClick={() => setPendingImg(null)} aria-label="Rimuovi immagine"
                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-neutral-900 text-white text-xs flex items-center justify-center">✕</button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <button onClick={() => fileRef.current?.click()}
              aria-label="Allega un'immagine" title="Allega immagine"
              className="w-11 h-11 shrink-0 rounded-2xl border border-neutral-200 flex items-center justify-center text-neutral-500 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-violet-400">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={pickImage} />
            <textarea value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              placeholder={`Scrivi ${isDm ? `a ${room.name}` : `in #${room.name}`}`}
              rows={1}
              className="flex-1 resize-none rounded-2xl border border-neutral-200 px-4 py-3 font-body text-[15px] outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent max-h-32" />
            <button onClick={submit}
              aria-label="Invia messaggio"
              className="w-11 h-11 shrink-0 rounded-2xl flex items-center justify-center hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-violet-400"
              style={{ background: BTN_BG, color: BTN_TXT }}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-neutral-200 bg-white p-4 flex items-center justify-between gap-3">
          <div className="font-body text-sm text-neutral-500 flex items-center gap-2">
            <EyeIcon /> {isGuest ? "Stai leggendo come guest. Registrati per scrivere." : "Per scrivere qui devi prima verificare la tua età."}
          </div>
          {isGuest ? (
            <BtnPrimary onClick={() => requireAuth("Registrati per scrivere nelle stanze.")} className="shrink-0 px-5 py-2.5 rounded-xl text-sm">
              Registrati
            </BtnPrimary>
          ) : (
            <BtnPrimary onClick={onVerify} className="shrink-0 px-5 py-2.5 rounded-xl text-sm">Verifica l'età</BtnPrimary>
          )}
        </div>
      )}
    </div>
  );
}

/* richieste di messaggio ricevute (le rose in cima), con Accetta / Rifiuta.
   Chi rifiuta non viene avvisato. */
function RequestsList({ requests, onAccept, onDecline, isOnline }) {
  if (!requests || requests.length === 0) return null;
  return (
    <div>
      <div className="font-mono2 text-[10px] uppercase tracking-[0.2em] text-white/40 px-1 mb-2">richieste di messaggio · {requests.length}</div>
      <div className="space-y-1.5">
        {requests.map((r) => (
          <div key={r.from.id} className="flex items-center gap-2 rounded-xl p-1.5" style={{ background: r.rose ? "rgba(255,77,141,0.16)" : "transparent" }}>
            <Avatar src={r.from.avatar} name={r.from.name} size={34} online={isOnline?.(r.from.id)} />
            <div className="min-w-0 flex-1">
              <div className="font-body font-semibold text-[13px] text-white/90 truncate">@{r.from.handle}</div>
              {r.rose && <div className="font-mono2 text-[10px]" style={{ color: "#FF9AC4" }}>🌹 ti ha inviato una rosa</div>}
            </div>
            <button onClick={() => onAccept(r.from)} aria-label={`Accetta la richiesta di ${r.from.handle}`} title="Accetta"
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 focus:outline-none focus:ring-2 focus:ring-white"
              style={{ background: BTN_BG, color: BTN_TXT }}>
              <CheckIcon size={15} />
            </button>
            <button onClick={() => onDecline(r.from)} aria-label={`Rifiuta la richiesta di ${r.from.handle}`} title="Rifiuta"
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-white/60 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ———— pannello "chi ti ha messo like" / "i tuoi match", tab Persone ———— */
function LikesMatchesPanel({ likesMe, matches, requests, onAcceptRequest, onDeclineRequest, onOpenProfile, onLikeBack, onMessage, isOnline }) {
  const Row = ({ u, right }) => (
    <div className="flex items-center gap-2">
      <button onClick={() => onOpenProfile(u.id)}
        className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-400">
        <Avatar src={u.avatar} name={u.name} size={36} online={isOnline(u.id)} />
        <span className="block font-body font-semibold text-[14px] truncate text-white/90">@{u.handle}</span>
      </button>
      {right}
    </div>
  );
  return (
    <div className="space-y-6">
      <RequestsList requests={requests} onAccept={onAcceptRequest} onDecline={onDeclineRequest} isOnline={isOnline} />
      <div>
        <div className="font-mono2 text-[10px] uppercase tracking-[0.2em] text-white/40 px-1 mb-2">chi ti ha messo like · {likesMe.length}</div>
        {likesMe.length === 0 ? (
          <p className="font-body text-[13px] text-white/40 px-1">Nessuno ancora — torna a dare un'occhiata più tardi.</p>
        ) : (
          <div className="space-y-2">
            {likesMe.map((u) => (
              <Row key={u.id} u={u} right={
                <button onClick={() => onLikeBack(u.id)} aria-label={`Metti like a ${u.handle}`} title="Metti like"
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 focus:outline-none focus:ring-2 focus:ring-white"
                  style={{ background: BTN_BG, color: BTN_TXT }}>
                  <SparkleHeartIcon size={14} />
                </button>
              } />
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="font-mono2 text-[10px] uppercase tracking-[0.2em] text-white/40 px-1 mb-2">i tuoi match · {matches.length}</div>
        {matches.length === 0 ? (
          <p className="font-body text-[13px] text-white/40 px-1">Ancora nessun match — continua a scorrere.</p>
        ) : (
          <div className="space-y-2">
            {matches.map((u) => (
              <Row key={u.id} u={u} right={
                <button onClick={() => onMessage(u)} aria-label={`Scrivi a ${u.handle}`} title="Scrivi"
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-white/60 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                </button>
              } />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ———— feed persone ———— */
/* una tessera della griglia: foto di copertina, nome ed età, e due azioni rapide
   (mi piace e scrivere). Il server dice per ogni persona come si può contattare. */
function PersonTile({ p, onOpenProfile, onLike, onContact, onRose, isOnline }) {
  const photos = p.photos || [];
  const cover = photos.find((ph) => !ph.hidden) || photos[0] || null;
  const c = p.contact;
  const tileBtn = "w-8 h-8 rounded-full flex items-center justify-center backdrop-blur focus:outline-none focus:ring-2 focus:ring-white transition-transform active:scale-95";
  return (
    <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-neutral-200 shadow-sm">
      <button onClick={() => onOpenProfile(p)} aria-label={`Apri il profilo di ${p.handle}`}
        className="absolute inset-0 w-full h-full text-left focus:outline-none focus:ring-2 focus:ring-violet-400">
        {cover ? (
          <PhotoView photo={cover} thumb className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: GRAD }}>
            {p.restricted
              ? <span className="text-white/90"><LockIcon size={40} /></span>
              : <Avatar src={p.avatar} name={p.name} size={72} ring />}
          </div>
        )}
      </button>

      <div className="absolute inset-x-0 bottom-0 p-2.5 pt-12 pointer-events-none" style={{ background: "linear-gradient(180deg,transparent,rgba(8,6,20,.85))" }}>
        <div className="flex items-center gap-1.5 text-white pr-[4.75rem]">
          {isOnline(p.id) && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#22C55E" }} title="Online" />}
          <span className="font-display font-bold text-[15px] leading-none truncate">{p.name}</span>
          <span className="font-semibold text-white/75 text-[13px] leading-none shrink-0">{p.age}</span>
          {p.age_verified && <span className="text-green-300 shrink-0" title="Età verificata"><ShieldCheckIcon size={13} /></span>}
        </div>
      </div>

      <div className="absolute right-2 bottom-2 flex gap-1.5">
        <button onClick={() => onLike(p)} disabled={!!p.liked}
          aria-label={p.liked ? `Hai messo mi piace a ${p.handle}` : `Metti mi piace a ${p.handle}`} aria-pressed={!!p.liked}
          title={p.liked ? "Ti piace" : "Mi piace"} className={tileBtn}
          style={{ background: p.liked ? BTN_BG : "rgba(255,255,255,0.22)", color: "#fff" }}>
          <HeartIcon filled={!!p.liked} size={15} />
        </button>
        {(c === "open" || c === "request") && (
          <button onClick={() => onContact(p)} aria-label={c === "open" ? `Scrivi a ${p.handle}` : `Chiedi di scrivere a ${p.handle}`}
            title={c === "open" ? "Scrivi" : "Chiedi di scrivere"} className={tileBtn}
            style={{ background: BTN_BG, color: BTN_TXT }}>
            <SendIcon size={14} />
          </button>
        )}
        {c === "rose" && (
          <button onClick={() => onRose(p)} aria-label={`Invia una rosa a ${p.handle} per scrivere`} title={`Rosa · ${ROSE_COST_LABEL}`}
            className={`${tileBtn} text-[15px]`} style={{ background: BTN_BG }}>
            <span aria-hidden="true">🌹</span>
          </button>
        )}
        {c === "incoming" && (
          <button onClick={() => onContact(p)} aria-label={`Accetta la richiesta di ${p.handle}`} title="Accetta la richiesta di messaggio"
            className={tileBtn} style={{ background: BTN_BG, color: BTN_TXT }}>
            <CheckIcon size={15} />
          </button>
        )}
        {c === "pending" && (
          <span className={`${tileBtn} cursor-default`} title="Richiesta inviata" style={{ background: "rgba(255,255,255,0.22)", color: "#fff" }}>
            <ClockIcon size={14} />
          </span>
        )}
      </div>
    </div>
  );
}

function PeopleGrid({ people, hasMore, loading, onLoadMore, onOpenProfile, onLike, onContact, onRose, isOnline }) {
  const sentinel = useRef(null);

  /* scorrimento infinito: quando si arriva vicino al fondo, carica la pagina dopo */
  useEffect(() => {
    if (!hasMore || loading) return;
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) onLoadMore(); }, { rootMargin: "600px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, onLoadMore, people.length]);

  if (people.length === 0 && !loading) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center">
        <div>
          <div className="font-display text-2xl font-bold text-neutral-800">Nessuno qui, per ora.</div>
          <p className="font-body text-neutral-500 mt-2">Sei tra i primi! Invita qualcuno e questa griglia prenderà vita.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto no-scrollbar p-3 sm:p-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2.5 sm:gap-3">
        {people.map((p) => (
          <PersonTile key={p.id} p={p} isOnline={isOnline}
            onOpenProfile={onOpenProfile} onLike={onLike} onContact={onContact} onRose={onRose} />
        ))}
      </div>
      <div ref={sentinel} className="h-20 flex items-center justify-center font-mono2 text-[11px] text-neutral-400">
        {loading ? "carico…" : !hasMore && people.length > 0 ? "Hai visto tutti." : ""}
      </div>
    </div>
  );
}

function RoomsRail({ rooms, dms, activeId, onPick, unread, mutedIds, onAvatar, isOnline, requests, onAcceptRequest, onDeclineRequest }) {
  return (
    <div className="space-y-6">
      <RequestsList requests={requests} onAccept={onAcceptRequest} onDecline={onDeclineRequest} isOnline={isOnline} />
      <div>
        <div className="font-mono2 text-[10px] uppercase tracking-[0.2em] text-white/40 px-3 mb-2">stanze</div>
        <div className="space-y-1">
          {rooms.map((r) => {
            const active = r.id === activeId;
            return (
              <button key={r.id} onClick={() => onPick(r.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-3 focus:outline-none focus:ring-2 focus:ring-violet-400 ${active ? "bg-white/12" : "hover:bg-white/6"}`}>
                <span className="w-2 h-8 rounded-full shrink-0" style={{ background: active ? r.hue : "#ffffff22" }} />
                <span className={`font-body font-semibold text-[14px] truncate flex items-center gap-1.5 ${active ? "text-white" : "text-white/75"}`}>
                  #{r.name}
                  {r.access === "view" && <span className="text-white/40"><EyeIcon size={12} /></span>}
                  {r.access === "members" && <span style={{ color: "#FF4D8D" }}><LockIcon size={12} /></span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {dms.length > 0 && (
        <div>
          <div className="font-mono2 text-[10px] uppercase tracking-[0.2em] text-white/40 px-3 mb-2">messaggi</div>
          <div className="space-y-1">
            {dms.map((d) => {
              const active = d.id === activeId;
              const muted = mutedIds.has(d.other?.id);
              const hasUnread = unread.has(d.id) && !muted;
              return (
                <div key={d.id} className={`flex items-center gap-1 pl-2 pr-3 py-1.5 rounded-xl transition-colors ${active ? "bg-white/12" : "hover:bg-white/6"}`}>
                  {/* l'icona apre il menu: aggiungi agli amici / silenzia / blocca */}
                  <button onClick={() => onAvatar(d.other)} aria-label={`Azioni per ${d.other?.name}: amico, silenzia, blocca`} title="Amico · Silenzia · Blocca"
                    className="rounded-full shrink-0 hover:ring-2 hover:ring-white/40 focus:outline-none focus:ring-2 focus:ring-violet-400 transition-shadow">
                    <Avatar src={d.other?.avatar} name={d.other?.name} size={30} online={isOnline(d.other?.id)} />
                  </button>
                  <button onClick={() => onPick(d.id)}
                    className="flex-1 min-w-0 flex items-center gap-2 text-left px-1.5 py-1.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-400">
                    <span className={`font-body font-semibold text-[14px] truncate ${active ? "text-white" : "text-white/75"}`}>{d.other?.name}</span>
                    {muted && <span className="text-[11px] shrink-0" title="Silenziato">🔕</span>}
                    {hasUnread && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#FF4D8D" }} aria-label="Nuovi messaggi" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ———————————————— APP ———————————————— */
/* conferma prima di spendere: cos'è la rosa e cosa succede se viene rifiutata */
function RoseConfirm({ person, tokens, onCancel, onConfirm }) {
  useEffect(() => {
    if (!person) return;
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [person, onCancel]);
  if (!person) return null;
  const enough = (tokens || 0) >= 1.99;
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-sm bg-white sm:rounded-3xl rounded-t-3xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] fade-up shadow-2xl font-body">
        <div className="text-4xl text-center" aria-hidden="true">🌹</div>
        <div className="font-display text-xl font-extrabold text-neutral-900 text-center mt-2">Una rosa per @{person.handle}</div>
        <p className="text-neutral-500 text-sm text-center mt-2">
          La rosa mette la tua richiesta di messaggio in cima e in evidenza. @{person.handle} decide comunque se accettare:
          se rifiuta non puoi riprovare e la rosa non viene restituita.
        </p>
        <div className="mt-4 rounded-xl bg-neutral-50 border border-neutral-200 px-3.5 py-2.5 font-mono2 text-[12px] text-neutral-600 space-y-1">
          <div className="flex justify-between"><span>Costo</span><span>{ROSE_COST_LABEL}</span></div>
          <div className="flex justify-between"><span>Il tuo saldo</span><span>{(tokens || 0).toFixed(2)}</span></div>
        </div>
        {!enough && <p className="text-pink-600 text-sm mt-2 text-center">Saldo insufficiente. La ricarica non è ancora disponibile.</p>}
        <BtnPrimary onClick={() => onConfirm(person)} disabled={!enough} className="w-full mt-4 py-3.5 text-base disabled:opacity-50">
          Invia la rosa · {ROSE_COST_LABEL}
        </BtnPrimary>
        <button onClick={onCancel} className="w-full py-2 mt-1 text-neutral-400 text-sm hover:text-neutral-600">Annulla</button>
      </div>
    </div>
  );
}

/* serve la verifica dell'età: spiega perché e la avvia */
function AgeGateModal({ open, onClose, onVerify }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-sm bg-white sm:rounded-3xl rounded-t-3xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] fade-up shadow-2xl font-body text-center">
        <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-3" style={{ background: BTN_BG, color: BTN_TXT }}>
          <ShieldCheckIcon size={30} />
        </div>
        <div className="font-display text-xl font-extrabold text-neutral-900">Verifica la tua età</div>
        <p className="text-neutral-500 text-sm mt-2">
          Per usare Persone, i messaggi privati e la stanza rosa devi prima verificare di essere maggiorenne.
          Si fa una volta sola, e così ogni persona che incontri qui ha fatto lo stesso.
        </p>
        <BtnPrimary onClick={onVerify} className="w-full mt-5 py-3.5 text-base">Verifica ora</BtnPrimary>
        <button onClick={onClose} className="w-full py-2 mt-1 text-neutral-400 text-sm hover:text-neutral-600">Non ora</button>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("foyer_token"));
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("rooms");
  const [rooms, setRooms] = useState([]);
  const [dms, setDms] = useState([]);
  const [people, setPeople] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [profile, setProfile] = useState(null);
  const [myProfileOpen, setMyProfileOpen] = useState(false);
  const [auth, setAuth] = useState({ open: false, reason: "" });
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const socketRef = useRef(null);
  const activeIdRef = useRef(null);
  const [toast, setToast] = useState(null);
  const [relations, setRelations] = useState(EMPTY_RELATIONS);
  const [actionTarget, setActionTarget] = useState(null);
  const [onlineIds, setOnlineIds] = useState(() => new Set());
  const [likesMe, setLikesMe] = useState([]);
  const [matches, setMatches] = useState([]);
  const [peopleNext, setPeopleNext] = useState(null);        // cursore della prossima pagina della griglia
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [dmRequests, setDmRequests] = useState({ incoming: [], outgoing: [] });
  const [gateOpen, setGateOpen] = useState(false);           // finestra "verifica la tua età"
  const [roseTarget, setRoseTarget] = useState(null);        // persona a cui sto per mandare una rosa
  const isOnline = useCallback((id) => onlineIds.has(id), [onlineIds]);
  const [unread, setUnread] = useState(() => new Set()); // id delle DM con messaggi non letti
  /* ref: servono ai listener del socket, che vivono più a lungo di un singolo render */
  const relationsRef = useRef(EMPTY_RELATIONS);
  const dmsRef = useRef([]);
  const meIdRef = useRef(null);
  const profileIdRef = useRef(null);
  const refreshRef = useRef({});
  const peopleNextRef = useRef(null);
  const loadingMoreRef = useRef(false);

  const refreshDmRequests = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/dm-requests", { token }).then(setDmRequests).catch(console.error);
  }, [token]);

  const refreshLikesMe = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/swipes/likes-me", { token }).then(setLikesMe).catch(console.error);
  }, [token]);
  const refreshMatches = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/swipes/matches", { token }).then(setMatches).catch(console.error);
  }, [token]);
  const refreshOnline = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/online", { token }).then((ids) => setOnlineIds(new Set(ids))).catch(console.error);
  }, [token]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const isGuest = !token || !me;
  /* il gate è attivo sul server e io non ho ancora verificato l'età */
  const gateBlocked = !!(me?.age_gate && !me?.age_verified);
  const requireAuth = (reason) => setAuth({ open: true, reason });

  /* profilo mio al load se ho il token */
  useEffect(() => {
    if (!token) { setMe(null); return; }
    api("/api/me", { token })
      .then(setMe)
      .catch(() => { localStorage.removeItem("foyer_token"); setToken(null); });
  }, [token]);

  /* stanze */
  useEffect(() => {
    api("/api/rooms").then((rs) => {
      setRooms(rs);
      if (!activeIdRef.current && rs[0]) setActiveId(rs[0].id);
    }).catch(console.error);
  }, []);

  /* ricarichi dal server: feed Persone, DM, amici/bloccati, profilo eventualmente aperto */
  const PEOPLE_PAGE = 36;
  const refreshPeople = useCallback(() => {
    if (!token) return Promise.resolve();
    setPeopleLoading(true);
    return api(`/api/people?limit=${PEOPLE_PAGE}`, { token })
      .then((r) => { setPeople(r.people); setPeopleNext(r.next); })
      .catch((e) => { if (e.code !== "AGE_GATE") console.error(e); }) // senza verifica la griglia resta chiusa
      .finally(() => setPeopleLoading(false));
  }, [token]);

  /* scorrimento infinito: aggiunge la pagina dopo, senza ripetizioni */
  const loadMorePeople = useCallback(() => {
    if (!token || !peopleNextRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setPeopleLoading(true);
    api(`/api/people?limit=${PEOPLE_PAGE}&cursor=${encodeURIComponent(peopleNextRef.current)}`, { token })
      .then((r) => {
        setPeople((cur) => {
          const known = new Set(cur.map((p) => p.id));
          return [...cur, ...r.people.filter((p) => !known.has(p.id))];
        });
        setPeopleNext(r.next);
      })
      .catch(console.error)
      .finally(() => { loadingMoreRef.current = false; setPeopleLoading(false); });
  }, [token]);

  /* aggiornamento in tempo reale (qualcuno ha cambiato profilo/foto): aggiorna le tessere già
     caricate e aggiunge i nuovi in cima, senza far saltare la posizione di scorrimento */
  const mergePeople = useCallback(() => {
    if (!token) return Promise.resolve();
    return api(`/api/people?limit=${PEOPLE_PAGE}`, { token })
      .then((r) => {
        setPeople((cur) => {
          const fresh = new Map(r.people.map((p) => [p.id, p]));
          const known = new Set(cur.map((p) => p.id));
          return [...r.people.filter((p) => !known.has(p.id)), ...cur.map((p) => fresh.get(p.id) || p)];
        });
      })
      .catch((e) => { if (e.code !== "AGE_GATE") console.error(e); });
  }, [token]);
  const refreshDms = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/dms", { token }).then(setDms).catch(console.error);
  }, [token]);
  const refreshRelations = useCallback(() => {
    if (!token) return Promise.resolve();
    return api("/api/relations", { token }).then(setRelations).catch(console.error);
  }, [token]);
  const refreshOpenProfile = useCallback(() => {
    const id = profileIdRef.current;
    if (!id || !token) return;
    api(`/api/people/${id}`, { token })
      .then((p) => { if (profileIdRef.current === id) setProfile(p); }) // se nel frattempo l'ho chiuso, non riaprirlo
      .catch(() => { if (profileIdRef.current === id) setProfile(null); }); // es. mi ha bloccato: sparisce
  }, [token]);

  relationsRef.current = relations;
  dmsRef.current = dms;
  meIdRef.current = me?.id || null;
  profileIdRef.current = profile?.id || null;
  peopleNextRef.current = peopleNext;
  refreshRef.current = { people: mergePeople, peopleReset: refreshPeople, dms: refreshDms, relations: refreshRelations, profile: refreshOpenProfile, likesMe: refreshLikesMe, matches: refreshMatches, dmRequests: refreshDmRequests };

  /* persone + DM + relazioni quando loggato */
  useEffect(() => {
    if (isGuest) { setPeople([]); setPeopleNext(null); setDms([]); setRelations(EMPTY_RELATIONS); setLikesMe([]); setMatches([]); setOnlineIds(new Set()); setDmRequests({ incoming: [], outgoing: [] }); return; }
    refreshPeople(); refreshDms(); refreshRelations(); refreshLikesMe(); refreshMatches(); refreshOnline(); refreshDmRequests();
  }, [isGuest, token]); // eslint-disable-line react-hooks/exhaustive-deps

  /* aprendo "Persone" il feed si ricarica sempre: niente più pagina da aggiornare a mano */
  useEffect(() => {
    if (tab === "people" && !isGuest) refreshPeople();
  }, [tab, isGuest, refreshPeople]);

  /* se cambiano i miei amici/bloccati mentre un profilo è aperto, lo aggiorno
     (es. mi accettano l'amicizia → compaiono le foto "solo amici") */
  const relKey = relations.friends.map((u) => u.id).join(",") + "|" + relations.blocked.map((u) => u.id).join(",");
  useEffect(() => { refreshOpenProfile(); }, [relKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* socket: (ri)connessione al cambio di auth */
  useEffect(() => {
    const s = connectSocket(token);
    socketRef.current = s;
    let tPeople = null, tRel = null;

    s.on("message", (msg) => {
      const isDmMsg = typeof msg.room_id === "string" && msg.room_id.startsWith("dm-");
      if (msg.room_id === activeIdRef.current) {
        setMessages((m) => [...m, msg]);
      } else if (isDmMsg && msg.user_id !== meIdRef.current) {
        /* qualcuno mi scrive mentre guardo altro: la DM compare in lista con la sua icona */
        if (!dmsRef.current.some((d) => d.id === msg.room_id)) refreshRef.current.dms?.();
        const isMuted = relationsRef.current.muted.some((u) => u.id === msg.user_id);
        if (!isMuted) setUnread((u) => new Set(u).add(msg.room_id));
      }
    });
    /* un profilo è cambiato (privato, foto "solo amici", avatar…): ricarico feed e profilo aperto */
    s.on("people-changed", () => {
      clearTimeout(tPeople);
      tPeople = setTimeout(() => { refreshRef.current.people?.(); refreshRef.current.profile?.(); }, 300);
    });
    /* richiesta/accettazione/blocco: ricarico relazioni e DM */
    s.on("relations-changed", () => {
      clearTimeout(tRel);
      tRel = setTimeout(() => { refreshRef.current.relations?.(); refreshRef.current.dms?.(); }, 200);
    });
    /* presenza online vera: il server avvisa solo quando qualcuno entra/esce per la prima/ultima volta */
    s.on("presence", ({ userId, online }) => {
      setOnlineIds((cur) => {
        const next = new Set(cur);
        online ? next.add(userId) : next.delete(userId);
        return next;
      });
    });
    /* qualcuno mi ha messo like e ora è reciproco: lo sapevo già, lui no */
    s.on("match-changed", () => { refreshRef.current.likesMe?.(); refreshRef.current.matches?.(); setToast("Hai un nuovo match 🎉"); });
    /* qualcuno chiede di scrivermi (o mi manda una rosa) */
    s.on("dm-request-received", () => { refreshRef.current.dmRequests?.(); setToast("Hai una nuova richiesta di messaggio."); });
    /* una richiesta è stata accettata (o rifiutata da me): si apre la conversazione, cambiano gli stati sulle tessere */
    s.on("dm-request-accepted", () => { refreshRef.current.dmRequests?.(); refreshRef.current.dms?.(); refreshRef.current.people?.(); refreshRef.current.profile?.(); });
    s.on("age-verified", () => {
      setMe((m) => (m ? { ...m, age_verified: true } : m));
      setToast("Età verificata! Ora puoi usare Persone e i messaggi privati.");
      refreshRef.current.peopleReset?.(); refreshRef.current.likesMe?.(); refreshRef.current.matches?.();
    });
    s.on("errorMsg", (e) => { console.warn("socket:", e); setToast(e); });
    s.on("connect_error", (e) => { console.warn("socket connect_error:", e.message); setToast(`Connessione al server fallita: ${e.message}`); });
    return () => { clearTimeout(tPeople); clearTimeout(tRel); s.disconnect(); };
  }, [token]);

  /* cambio stanza: carica cronologia + join socket */
  useEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) return;
    setUnread((u) => { if (!u.has(activeId)) return u; const n = new Set(u); n.delete(activeId); return n; });
    setMessages([]);
    const isDm = activeId.startsWith("dm-");
    const path = isDm ? `/api/dms/${activeId}/messages` : `/api/rooms/${activeId}/messages`;
    api(path, { token }).then(setMessages).catch((e) => {
      if (!String(e.message).includes("riservata")) console.error(e);
    });
    socketRef.current?.emit("join", { roomId: activeId });
    return () => socketRef.current?.emit("leave", { roomId: activeId });
  }, [activeId, token]);

  const handleSend = useCallback((roomId, text, imageObj) => {
    socketRef.current?.emit("message", {
      roomId, text, image: imageObj?.src || null, sensitive: !!imageObj?.sensitive,
    });
  }, []);

  const openProfileById = async (userId) => {
    if (isGuest) return requireAuth("Registrati per vedere i profili.");
    if (userId === me?.id) return setMyProfileOpen(true);
    if (String(userId).startsWith("guest-")) return; // i guest non hanno un profilo
    try { setProfile(await api(`/api/people/${userId}`, { token })); }
    catch (e) { handleApiError(e); }
  };

  const openDm = async (user, promptQ) => {
    setProfile(null);
    try {
      const dm = await api(`/api/dms/${user.id}`, { method: "POST", token });
      const list = await api("/api/dms", { token });
      /* una DM vuota aperta da altri non è in lista: la aggiungo io per poterla usare */
      setDms(list.some((d) => d.id === dm.id)
        ? list
        : [...list, { ...dm, other: { id: user.id, name: user.name, handle: user.handle, avatar: user.avatar } }]);
      setTab("rooms");
      setActiveId(dm.id);
      if (promptQ) {
        /* apre la conversazione già contestualizzata sul prompt */
        setTimeout(() => {
          socketRef.current?.emit("message", { roomId: dm.id, text: `(rispondo al tuo prompt: "${promptQ}")` });
        }, 400);
      }
    } catch (e) {
      if (e.code === "REQUEST_REQUIRED") await sendRequest(user, false);
      else handleApiError(e);
    }
  };

  /* azioni su un utente: amicizia, blocco, silenzia */
  const relCall = useCallback(async (method, path, okMsg) => {
    try {
      await api(path, { method, token });
      await Promise.all([refreshRelations(), refreshPeople(), refreshDms()]);
      if (okMsg) setToast(okMsg);
    } catch (e) { setToast(e.message); }
  }, [token, refreshRelations, refreshPeople, refreshDms]);

  const relActions = {
    addFriend: (id) => relCall("POST", `/api/friends/${id}`, "Richiesta di amicizia inviata"),
    accept: (id) => relCall("POST", `/api/friends/${id}/accept`, "Ora siete amici"),
    decline: (id) => relCall("DELETE", `/api/friends/${id}`),   // rifiuta / annulla / elimina amico
    block: async (id) => {
      await relCall("POST", `/api/blocks/${id}`, "Utente bloccato");
      setPeople((cur) => cur.filter((p) => p.id !== id));
      /* se stavo chattando con lui, torno alla prima stanza */
      setActiveId((cur) => (dmsRef.current.find((d) => d.id === cur)?.other?.id === id ? (rooms[0]?.id || null) : cur));
    },
    unblock: (id) => relCall("DELETE", `/api/blocks/${id}`, "Utente sbloccato"),
    mute: (id) => relCall("POST", `/api/mutes/${id}`, "Utente silenziato"),
    unmute: (id) => relCall("DELETE", `/api/mutes/${id}`, "Notifiche riattivate"),
    openProfile: (id) => openProfileById(id),
    openActions: (u) => setActionTarget(u),
  };

  /* errori dell'API: se manca la verifica età si apre la finestra giusta, altrimenti un avviso */
  const handleApiError = useCallback((e) => {
    if (e?.code === "AGE_GATE") setGateOpen(true);
    else setToast(e?.message || "Qualcosa è andato storto");
  }, []);

  const startAgeVerify = useCallback(async () => {
    try {
      const r = await api("/api/verify-age/start", { method: "POST", token });
      if (r.already) { setMe((m) => (m ? { ...m, age_verified: true } : m)); setGateOpen(false); }
      else if (r.url) window.open(r.url, "_blank", "noopener");
    } catch (e) { setToast(e.message); }
  }, [token]);

  /* aggiorna lo stato "come posso contattarlo" sulla tessera e sul profilo aperto */
  const setContactState = (userId, contact) => {
    setPeople((cur) => cur.map((p) => (p.id === userId ? { ...p, contact } : p)));
    setProfile((cur) => (cur && cur.id === userId ? { ...cur, contact } : cur));
  };

  /* mi piace sulla tessera (resta segnato; se è reciproco è un match) */
  const onLike = useCallback(async (person) => {
    if (person.liked) return;
    const setLiked = (liked, extra = {}) => setPeople((cur) => cur.map((p) => (p.id === person.id ? { ...p, liked, ...extra } : p)));
    setLiked(true);
    try {
      const r = await api(`/api/swipes/${person.id}`, { method: "POST", token, body: { action: "like" } });
      if (r.match) { setLiked(true, { matched: true, contact: "open" }); setToast(`È un match con @${person.handle}! 🎉`); refreshMatches(); }
    } catch (e) { setLiked(false); handleApiError(e); }
  }, [token, refreshMatches, handleApiError]);

  /* richiesta di messaggio, gratuita o con una rosa (priorità a pagamento) */
  const sendRequest = async (person, rose) => {
    try {
      const r = await api(`/api/dm-requests/${person.id}`, { method: "POST", token, body: { rose } });
      if (typeof r.tokens === "number") setMe((m) => (m ? { ...m, tokens: r.tokens } : m));
      if (r.dm) {
        /* si poteva già scrivere (o la richiesta era incrociata): apro direttamente la chat */
        await refreshDms();
        setProfile(null); setTab("rooms"); setActiveId(r.dm.id);
        if (r.accepted) setToast("Richiesta accettata: ora potete scrivervi.");
      } else {
        setContactState(person.id, "pending");
        refreshDmRequests();
        setToast(rose ? `Rosa inviata a @${person.handle} 🌹` : `Richiesta inviata a @${person.handle}`);
      }
    } catch (e) {
      if (e.code === "ROSE_REQUIRED") { setContactState(person.id, "rose"); setToast(e.message); }
      else handleApiError(e);
    }
    setRoseTarget(null);
  };

  /* il pulsante "scrivi" fa la cosa giusta in base a come si può contattare la persona */
  const contactAction = (person, promptQ) => {
    switch (person.contact) {
      case "open": return openDm(person, promptQ);
      case "request": return sendRequest(person, false);
      case "rose": return setRoseTarget(person);
      case "incoming": return acceptRequest(person);
      case "pending": return setToast("Hai già inviato una richiesta: aspetta la risposta.");
      case "closed": return setToast("Non è possibile scrivere a questa persona.");
      default: return undefined;
    }
  };

  const acceptRequest = async (from) => {
    try {
      const r = await api(`/api/dm-requests/${from.id}/accept`, { method: "POST", token });
      await Promise.all([refreshDmRequests(), refreshDms()]);
      setContactState(from.id, "open");
      setMobileRailOpen(false); setProfile(null); setTab("rooms"); setActiveId(r.dm.id);
    } catch (e) { handleApiError(e); }
  };

  /* rifiuto silenzioso: chi ha chiesto non riceve nessun avviso */
  const declineRequest = async (from) => {
    try {
      await api(`/api/dm-requests/${from.id}/decline`, { method: "POST", token });
      setContactState(from.id, "closed");
      refreshDmRequests();
    } catch (e) { handleApiError(e); }
  };

  /* "metti like" direttamente dal pannello "chi ti ha messo like" */
  const onLikeBack = useCallback(async (userId) => {
    setLikesMe((cur) => cur.filter((u) => u.id !== userId));
    try {
      const r = await api(`/api/swipes/${userId}`, { method: "POST", token, body: { action: "like" } });
      if (r.match) setToast("È un match! 🎉");
      refreshMatches();
      setPeople((cur) => cur.map((p) => (p.id === userId ? { ...p, liked: true, matched: !!r.match, contact: r.match ? "open" : p.contact } : p)));
    } catch (e) { refreshLikesMe(); handleApiError(e); }
  }, [token, refreshMatches, refreshLikesMe, handleApiError]);

  /* bloccati e silenziati: i loro messaggi nelle stanze non si vedono; le DM dei bloccati spariscono */
  const blockedIds = useMemo(() => new Set(relations.blocked.map((u) => u.id)), [relations]);
  const mutedIds = useMemo(() => new Set(relations.muted.map((u) => u.id)), [relations]);
  const isDmActive = !!activeId?.startsWith("dm-");
  const visibleMessages = isDmActive
    ? messages
    : messages.filter((m) => !blockedIds.has(m.user_id) && !mutedIds.has(m.user_id));
  const visibleDms = dms.filter((d) => !blockedIds.has(d.other?.id));
  const dmOther = isDmActive ? dms.find((d) => d.id === activeId)?.other : null;

  const onAuthed = (tkn, user) => {
    localStorage.setItem("foyer_token", tkn);
    setToken(tkn);
    setMe(user);
    setAuth({ open: false, reason: "" });
  };

  const logout = () => {
    localStorage.removeItem("foyer_token");
    setToken(null); setMe(null); setDms([]); setPeople([]);
    setRelations(EMPTY_RELATIONS); setUnread(new Set()); setActionTarget(null); setProfile(null);
    setLikesMe([]); setMatches([]); setOnlineIds(new Set());
    setPeopleNext(null); setDmRequests({ incoming: [], outgoing: [] }); setGateOpen(false); setRoseTarget(null);
  };

  const activeRoom =
    rooms.find((r) => r.id === activeId) ||
    (activeId?.startsWith("dm-")
      ? { id: activeId, name: dms.find((d) => d.id === activeId)?.other?.name || "DM", topic: "messaggi diretti", access: "open", hue: "#FF4D8D" }
      : null);

  return (
    <div className="h-screen h-[100dvh] w-full font-body flex flex-col overflow-hidden" style={{ background: "#FAFAFC" }}>
      <style>{FONT_CSS}</style>

      <header className="h-14 sm:h-16 shrink-0 flex items-center justify-between gap-2 px-2.5 sm:px-6 border-b border-white/10 pt-[env(safe-area-inset-top)]" style={{ background: BANNER_BG }}>
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
          <button className="md:hidden w-8 h-8 sm:w-9 sm:h-9 shrink-0 rounded-xl bg-white/10 text-white flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-violet-400"
            onClick={() => setMobileRailOpen((v) => !v)}
            aria-label={tab === "people" ? "Chi ti ha messo like e i tuoi match" : "Apri elenco stanze"}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
          </button>
          <div className="font-display text-white text-lg sm:text-2xl font-extrabold tracking-tight select-none shrink-0">
            foyer<span style={{ color: "#FF4D8D" }}>.</span>
          </div>
          <span className="hidden lg:inline font-mono2 text-[11px] text-white/60 mt-1 truncate">trova la tua stanza</span>
        </div>

        <nav className="flex items-center gap-0.5 sm:gap-1 bg-white/10 rounded-2xl p-1 shrink-0">
          {[["rooms", "Stanze"], ["people", "Persone"]].map(([key, label]) => (
            <button key={key} onClick={() => { setTab(key); setMobileRailOpen(false); }}
              className={`px-2.5 sm:px-5 py-1.5 sm:py-2 rounded-xl font-body font-bold text-xs sm:text-sm transition-colors whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-violet-400 ${tab === key ? "" : "text-white/70 hover:text-white"}`}
              style={tab === key ? { background: BTN_BG, color: BTN_TXT } : {}}>
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 shrink-0">
          {!isGuest && (
            <>
              <span className="hidden sm:inline font-mono2 text-[12px] text-white bg-white/15 px-2.5 py-1 rounded-full shrink-0" title="Streak giornaliera">
                🔥 {me.streak || 1}
              </span>
              <span className="hidden sm:flex items-center gap-1 font-mono2 text-[12px] text-white bg-white/15 px-2.5 py-1 rounded-full shrink-0" title="Saldo per le rose">
                <span aria-hidden="true">🌹</span> {(me.tokens ?? 0).toFixed(2)}
              </span>
            </>
          )}
          {isGuest ? (
            <BtnPrimary onClick={() => requireAuth("Crea il tuo profilo per sbloccare tutte le stanze.")} className="px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm whitespace-nowrap">
              Registrati
            </BtnPrimary>
          ) : (
            <>
              <button onClick={() => setMyProfileOpen(true)} aria-label="Apri il mio profilo"
                className="relative rounded-full focus:outline-none focus:ring-2 focus:ring-white hover:opacity-90 transition-opacity shrink-0">
                <Avatar src={me.avatar} name={me.name} size={32} ring />
                {relations.incoming.length + dmRequests.incoming.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white" style={{ background: "#FF4D8D" }}
                    title={`${relations.incoming.length} richieste di amicizia, ${dmRequests.incoming.length} di messaggio`} />
                )}
              </button>
              <button onClick={logout} className="hidden sm:inline font-mono2 text-[11px] text-white/70 hover:text-white shrink-0" title="Esci">esci</button>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        {tab === "rooms" && (
          <>
            <aside className="hidden md:block w-72 shrink-0 overflow-y-auto no-scrollbar p-4" style={{ background: "#14121F" }}>
              <RoomsRail rooms={rooms} dms={visibleDms} activeId={activeId} onPick={setActiveId}
                unread={unread} mutedIds={mutedIds} onAvatar={setActionTarget} isOnline={isOnline}
                requests={dmRequests.incoming} onAcceptRequest={acceptRequest} onDeclineRequest={declineRequest} />
            </aside>
            {mobileRailOpen && (
              <div className="md:hidden absolute inset-0 z-40 flex">
                <div className="w-72 max-w-[80%] h-full overflow-y-auto no-scrollbar p-4 fade-up" style={{ background: "#14121F" }}>
                  <RoomsRail rooms={rooms} dms={visibleDms} activeId={activeId}
                    onPick={(id) => { setActiveId(id); setMobileRailOpen(false); }}
                    unread={unread} mutedIds={mutedIds} onAvatar={(u) => { setMobileRailOpen(false); setActionTarget(u); }} isOnline={isOnline}
                    requests={dmRequests.incoming} onAcceptRequest={acceptRequest} onDeclineRequest={declineRequest} />
                </div>
                <div className="flex-1 bg-black/50" onClick={() => setMobileRailOpen(false)} />
              </div>
            )}
            <main className="flex-1 min-w-0">
              <ChatView room={activeRoom} meId={me?.id} isGuest={isGuest} gateBlocked={gateBlocked} onVerify={startAgeVerify} messages={visibleMessages}
                onSend={handleSend} onOpenProfile={openProfileById} requireAuth={requireAuth}
                dmOther={dmOther} onOpenActions={setActionTarget} />
            </main>
          </>
        )}

        {tab === "people" && (
          <>
            {!isGuest && (
              <>
                {/* desktop: pannello sempre visibile, stesso posto della lista stanze */}
                <aside className="hidden md:block w-72 shrink-0 overflow-y-auto no-scrollbar p-4" style={{ background: "#14121F" }}>
                  <LikesMatchesPanel likesMe={likesMe} matches={matches} isOnline={isOnline}
                    requests={dmRequests.incoming} onAcceptRequest={acceptRequest} onDeclineRequest={declineRequest}
                    onOpenProfile={openProfileById} onLikeBack={onLikeBack} onMessage={openDm} />
                </aside>
                {/* mobile: lo stesso hamburger in alto a sinistra lo apre come cassetto */}
                {mobileRailOpen && (
                  <div className="md:hidden absolute inset-0 z-40 flex">
                    <div className="w-72 max-w-[80%] h-full overflow-y-auto no-scrollbar p-4 fade-up" style={{ background: "#14121F" }}>
                      <LikesMatchesPanel likesMe={likesMe} matches={matches} isOnline={isOnline}
                        requests={dmRequests.incoming} onAcceptRequest={acceptRequest} onDeclineRequest={declineRequest}
                        onOpenProfile={(id) => { setMobileRailOpen(false); openProfileById(id); }}
                        onLikeBack={onLikeBack} onMessage={(u) => { setMobileRailOpen(false); openDm(u); }} />
                    </div>
                    <div className="flex-1 bg-black/50" onClick={() => setMobileRailOpen(false)} />
                  </div>
                )}
              </>
            )}
            <main className="flex-1 min-w-0">
              {isGuest ? (
                <div className="h-full flex items-center justify-center p-6" style={{ background: "#FAFAFC" }}>
                  <div className="text-center max-w-sm fade-up">
                    <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4" style={{ background: BTN_BG, color: BTN_TXT }}>
                      <LockIcon size={26} />
                    </div>
                    <div className="font-display text-2xl font-extrabold text-neutral-900">Persone è riservato agli iscritti</div>
                    <p className="font-body text-neutral-500 mt-2">Registrati con la tua email per scorrere e aprire i profili.</p>
                    <BtnPrimary onClick={() => requireAuth("Registrati con la tua email per scorrere i profili.")} className="mt-5 px-8 py-3.5">
                      Registrati con l'email
                    </BtnPrimary>
                  </div>
                </div>
              ) : gateBlocked ? (
                <div className="h-full flex items-center justify-center p-6" style={{ background: "#FAFAFC" }}>
                  <div className="text-center max-w-sm fade-up">
                    <div className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-4" style={{ background: BTN_BG, color: BTN_TXT }}>
                      <ShieldCheckIcon size={30} />
                    </div>
                    <div className="font-display text-2xl font-extrabold text-neutral-900">Verifica la tua età per entrare</div>
                    <p className="font-body text-neutral-500 mt-2">
                      Qui si incontrano persone maggiorenni verificate. Ci vuole un attimo e si fa una volta sola.
                    </p>
                    <BtnPrimary onClick={startAgeVerify} className="mt-5 px-8 py-3.5">Verifica ora</BtnPrimary>
                  </div>
                </div>
              ) : (
                <PeopleGrid people={people} hasMore={!!peopleNext} loading={peopleLoading} onLoadMore={loadMorePeople}
                  onOpenProfile={(p) => openProfileById(p.id)} onLike={onLike}
                  onContact={(p) => contactAction(p)} onRose={setRoseTarget} isOnline={isOnline} />
              )}
            </main>
          </>
        )}
      </div>

      <ProfileSheet user={profile} token={token} onClose={() => setProfile(null)} onMessage={contactAction} onRose={setRoseTarget}
        relations={relations} actions={relActions} onOpenActions={setActionTarget} />
      <MyProfileSheet open={myProfileOpen} me={me} token={token} onClose={() => setMyProfileOpen(false)}
        onUpdate={(fn) => setMe((m) => (m ? fn(m) : m))}
        relations={relations} isOnline={isOnline}
        relActions={{ ...relActions, openProfile: (id) => { setMyProfileOpen(false); openProfileById(id); } }} />
      <UserActionSheet target={actionTarget} relations={relations} actions={relActions}
        onClose={() => setActionTarget(null)} hideViewProfile={!!profile && profile.id === actionTarget?.id} />
      <AuthModal open={auth.open} reason={auth.reason} onClose={() => setAuth({ open: false, reason: "" })} onAuthed={onAuthed} />
      <RoseConfirm person={roseTarget} tokens={me?.tokens} onCancel={() => setRoseTarget(null)} onConfirm={(p) => sendRequest(p, true)} />
      <AgeGateModal open={gateOpen} onClose={() => setGateOpen(false)} onVerify={startAgeVerify} />

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] max-w-sm w-[90%] fade-up">
          <div className="rounded-2xl shadow-2xl px-4 py-3 flex items-start gap-3 font-body text-sm"
            style={{ background: BTN_BG, color: BTN_TXT }}>
            <span className="flex-1">{toast}</span>
            <button onClick={() => setToast(null)} aria-label="Chiudi avviso" className="opacity-70 hover:opacity-100">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
