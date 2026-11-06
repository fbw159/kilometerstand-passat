// Cloudflare Worker „kilometerstand-passat“ – Speicher für https://fbw159.github.io/kilometerstand-passat/
// Liest und schreibt daten.json im privaten Repo fbw159/kilometerstand-passat-daten.
// Jede Eingabe und jedes Löschen wird dort ein eigener Commit.
//
// Secret GITHUB_TOKEN: GitHub-Token mit Schreibrecht „Contents“ auf das Daten-Repo.
// Zugang: Die Seite schickt den Zugangscode im Header X-Zugang. Hier steht nur sein SHA-256.

const REPO = "fbw159/kilometerstand-passat-daten";
const DATEI = "daten.json";
const HERKUNFT = ["https://fbw159.github.io"];
const ZUGANG_SHA256 = "05bcf687e2397c17ce5171d7a8cddc34b33917c2911f5dc1a124db8b3def4e9b";
const VERSICHERUNG = { km_pro_jahr: 12000, beginn: null };

class Fehler extends Error {
  constructor(status, text) { super(text); this.status = status; }
}

export default {
  async fetch(request, env) {
    const herkunft = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": HERKUNFT.includes(herkunft) ? herkunft : HERKUNFT[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Zugang",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const antwort = (status, obj) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const pfad = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (pfad === "/") return antwort(200, { ok: true, dienst: "kilometerstand-passat" });
      if (pfad === "/status") {
        // Zur Prüfung nach dem Einrichten: kommt der Worker an das Daten-Repo? Gibt keine Daten heraus.
        let github = null;
        if (env.GITHUB_TOKEN) github = (await gh(env, "GET")).status;
        return antwort(200, { ok: true, token_gesetzt: !!env.GITHUB_TOKEN, github_status: github });
      }
      if (!(await zugangOk(request.headers.get("X-Zugang")))) return antwort(401, { fehler: "Zugangscode stimmt nicht." });
      if (!env.GITHUB_TOKEN) return antwort(500, { fehler: "Im Speicher fehlt der GitHub-Schlüssel." });

      if (request.method === "GET" && pfad === "/daten") return antwort(200, (await lesen(env)).daten);

      if (request.method === "POST" && (pfad === "/eintrag" || pfad === "/loeschen")) {
        const text = await request.text();
        if (text.length > 4000) return antwort(413, { fehler: "Anfrage zu groß." });
        let body;
        try { body = JSON.parse(text); } catch (e) { return antwort(400, { fehler: "Ungültige Anfrage." }); }

        if (pfad === "/eintrag") {
          const e = neuerEintrag(body);
          return antwort(200, await aendern(env, d => {
            d.eintraege.push(e);
            return `Kilometerstand ${zahl(e.km)} km am ${de(e.datum)}`;
          }));
        }
        const id = String((body && body.id) || "");
        return antwort(200, await aendern(env, d => {
          const i = d.eintraege.findIndex(x => x.id === id);
          if (i < 0) return null; // schon weg, z. B. vom anderen Handy gelöscht
          const [x] = d.eintraege.splice(i, 1);
          return `Eintrag gelöscht: ${zahl(x.km)} km am ${de(x.datum)}`;
        }));
      }
      return antwort(404, { fehler: "Unbekannte Adresse." });
    } catch (err) {
      if (err instanceof Fehler) return antwort(err.status, { fehler: err.message });
      return antwort(500, { fehler: "Fehler im Speicher." });
    }
  },
};

// ---------- GitHub ----------
function gh(env, methode, body) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${DATEI}`, {
    method: methode,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kilometerstand-worker",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function lesen(env) {
  const r = await gh(env, "GET");
  if (r.status === 404) return { daten: normal({}), sha: null };
  if (!r.ok) throw new Fehler(502, `GitHub antwortet nicht wie erwartet (Fehler ${r.status}).`);
  const j = await r.json();
  let daten;
  try { daten = JSON.parse(ausBase64(j.content || "")); } catch (e) { throw new Fehler(500, "daten.json ist beschädigt."); }
  return { daten: normal(daten), sha: j.sha };
}

// Liest frisch, ändert, schreibt. Hat das andere Handy gerade gespeichert, wird es erneut versucht.
async function aendern(env, aenderung) {
  for (let versuch = 0; versuch < 4; versuch++) {
    const { daten, sha } = await lesen(env);
    const nachricht = aenderung(daten);
    if (!nachricht) return daten;
    sortieren(daten.eintraege);
    daten.aktualisiert = new Date().toISOString();
    const r = await gh(env, "PUT", { message: nachricht, content: inBase64(alsText(daten)), ...(sha ? { sha } : {}) });
    if (r.ok) return daten;
    if (r.status === 409 || r.status === 422) continue;
    throw new Fehler(502, `GitHub hat nicht gespeichert (Fehler ${r.status}).`);
  }
  throw new Fehler(503, "Gerade speichert jemand anderes. Bitte gleich nochmal versuchen.");
}

// ---------- Daten ----------
function neuerEintrag(b) {
  const datum = String((b && b.datum) || "");
  const d = new Date(datum + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || isNaN(d) || d.toISOString().slice(0, 10) !== datum) throw new Fehler(400, "Das Datum ist ungültig.");
  if (datum > new Date(Date.now() + 36 * 3600e3).toISOString().slice(0, 10)) throw new Fehler(400, "Das Datum liegt in der Zukunft.");
  const km = Number(b.km);
  if (!Number.isInteger(km) || km < 0 || km > 2000000) throw new Fehler(400, "Der Kilometerstand ist ungültig.");
  const notiz = String(b.notiz || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 140);
  const e = { id: crypto.randomUUID().slice(0, 8), datum, km };
  if (notiz) e.notiz = notiz;
  return e;
}

function normal(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  if (!d.versicherung || typeof d.versicherung !== "object") d.versicherung = { ...VERSICHERUNG };
  d.eintraege = (Array.isArray(d.eintraege) ? d.eintraege : [])
    .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.datum) && Number.isFinite(Number(e.km)))
    .map(e => {
      const x = { id: String(e.id || `${e.datum}-${e.km}`), datum: e.datum, km: Number(e.km) };
      if (e.notiz) x.notiz = String(e.notiz);
      return x;
    });
  sortieren(d.eintraege);
  return d;
}

function sortieren(l) {
  return l.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : a.km - b.km));
}

// Eine Ablesung pro Zeile, damit die Commits auf GitHub gut lesbar sind.
function alsText(d) {
  const kopf = Object.entries(d).filter(([k]) => k !== "eintraege").map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const zeilen = d.eintraege.map(e => "    " + JSON.stringify(e));
  return "{\n" + [...kopf, `  "eintraege": [\n${zeilen.join(",\n")}\n  ]`].join(",\n") + "\n}\n";
}

// ---------- Hilfen ----------
async function zugangOk(code) {
  if (!code || code.length > 200) return false;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return [...h].map(b => b.toString(16).padStart(2, "0")).join("") === ZUGANG_SHA256;
}
function inBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function ausBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
const zahl = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const de = s => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
