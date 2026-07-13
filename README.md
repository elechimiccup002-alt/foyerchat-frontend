# Foyer frontend — integrato con le API

## Avvio locale (col backend acceso su :3001)
```bash
npm install
npm run dev
# apri http://localhost:5173
```

## Deploy su Vercel
1. Carica la cartella su GitHub
2. Vercel → Add New → Project → importa il repo
3. Environment Variables: `VITE_API_URL` = url del backend su Render
   (es. https://foyer-backend.onrender.com)
4. Deploy

## Note
- Tailwind è caricato via CDN in index.html: perfetto per i test,
  per la produzione conviene l'installazione con PostCSS
- Il token di accesso è salvato in localStorage (sessione persistente)
- Il "prompt del giorno" della demo non è ancora collegato al server:
  ora i prompt del profilo si gestiscono da "Il mio profilo" → I miei prompt
