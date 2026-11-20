// Cloudflare Worker „kilometerstand-passat“ – Speicher für https://fbw159.github.io/kilometerstand-passat/
// Liest und schreibt daten.json im privaten Repo fbw159/kilometerstand-passat-daten.
// Jede Eingabe und jedes Löschen wird dort ein eigener Commit (Ablesungen, Wartung, Versicherung).
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

      if (request.method === "POST" && ["/eintrag", "/loeschen", "/wartung", "/versicherung"].includes(pfad)) {
        const text = await request.text();
        if (text.length > 4000) return antwort(413, { fehler: "Anfrage zu groß." });
        let body;
        try { body = JSON.parse(text); } catch (e) { return antwort(400, { fehler: "Ungültige Anfrage." }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return antwort(400, { fehler: "Ungültige Anfrage." });

        if (pfad === "/wartung") return antwort(200, await aendern(env, d => wartungAendern(d, body)));
        if (pfad === "/versicherung") return antwort(200, await aendern(env, d => versicherungAendern(d, body)));
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
  const datum = pruefeDatum(b.datum);
  const km = Number(b.km);
  if (!Number.isInteger(km) || km < 0 || km > 2000000) throw new Fehler(400, "Der Kilometerstand ist ungültig.");
  const notiz = kurz(b.notiz, 140);
  const e = { id: neueId(), datum, km };
  if (notiz) e.notiz = notiz;
  return e;
}

// ---------- Versicherung ----------
// Versicherte km pro Jahr und Beginn des Versicherungsjahres (läuft jeweils 12 Monate ab dem Beginn).
function versicherungAendern(d, b) {
  const km = ganzzahl(b.km_pro_jahr, 1000, 200000, "Der Wert für km pro Jahr");
  if (km == null) throw new Fehler(400, "Bitte die versicherten km pro Jahr eintragen.");
  const beginn = pruefeDatum(b.beginn);
  const alt = d.versicherung || {};
  if (alt.km_pro_jahr === km && alt.beginn === beginn) return null; // nichts geändert
  d.versicherung = { ...alt, km_pro_jahr: km, beginn };
  const vorher = [];
  if (alt.km_pro_jahr && alt.km_pro_jahr !== km) vorher.push(`${zahl(alt.km_pro_jahr)} km`);
  if (alt.beginn && alt.beginn !== beginn) vorher.push(`Beginn ${de(alt.beginn)}`);
  return `Versicherung: ${zahl(km)} km pro Jahr, Beginn ${de(beginn)}` + (vorher.length ? ` (vorher ${vorher.join(", ")})` : "");
}

// ---------- Wartung ----------
// Punkte wie Service, Ölwechsel, TÜV: Intervall in km und/oder Monaten (was zuerst kommt),
// dazu die Einträge, wann es erledigt wurde. „monatsende“: fällig bis Ende des Monats (wie beim TÜV).
function wartungAendern(d, b) {
  const aktion = String(b.aktion || "");
  const liste = d.wartung;
  if (aktion === "punkt") {
    const name = kurz(b.name, 40);
    if (!name) throw new Fehler(400, "Bitte einen Namen eingeben.");
    const km = ganzzahl(b.km, 100, 1000000, "Das km-Intervall");
    const monate = ganzzahl(b.monate, 1, 240, "Das Monats-Intervall");
    if (km == null && monate == null) throw new Fehler(400, "Bitte ein Intervall in km oder Monaten angeben.");
    const monatsende = b.monatsende === true;
    let p = b.id ? liste.find(x => x.id === String(b.id)) : null;
    if (b.id && !p) throw new Fehler(404, "Diesen Wartungspunkt gibt es nicht mehr.");
    const neu = !p;
    if (neu) { p = { id: neueId(), name, km, monate, monatsende, erledigt: [] }; liste.push(p); }
    else Object.assign(p, { name, km, monate, monatsende });
    return `Wartung: ${name} ${neu ? "angelegt" : "geändert"} (${intervallText(p)})`;
  }
  if (aktion === "punkt-loeschen") {
    const i = liste.findIndex(x => x.id === String(b.id || ""));
    if (i < 0) return null; // schon weg
    const [p] = liste.splice(i, 1);
    return `Wartung: ${p.name} gelöscht`;
  }
  if (aktion === "erledigt" || aktion === "erledigt-loeschen") {
    const p = liste.find(x => x.id === String(b.punkt || ""));
    if (!p) {
      if (aktion === "erledigt-loeschen") return null;
      throw new Fehler(404, "Diesen Wartungspunkt gibt es nicht mehr.");
    }
    if (aktion === "erledigt-loeschen") {
      const i = p.erledigt.findIndex(x => x.id === String(b.id || ""));
      if (i < 0) return null;
      const [e] = p.erledigt.splice(i, 1);
      return `Wartung: ${p.name} vom ${de(e.datum)} gelöscht`;
    }
    const datum = pruefeDatum(b.datum);
    const km = ganzzahl(b.km, 0, 2000000, "Der Kilometerstand");
    if (p.km && km == null) throw new Fehler(400, "Bitte den Kilometerstand eintragen.");
    const notiz = kurz(b.notiz, 140);
    let e = b.id ? p.erledigt.find(x => x.id === String(b.id)) : null;
    if (b.id && !e) throw new Fehler(404, "Diesen Eintrag gibt es nicht mehr.");
    const neu = !e;
    if (neu) { e = { id: neueId(), datum }; p.erledigt.push(e); }
    e.datum = datum;
    if (km != null) e.km = km; else delete e.km;
    if (notiz) e.notiz = notiz; else delete e.notiz;
    sortieren(p.erledigt);
    const wo = km != null ? ` bei ${zahl(km)} km` : "";
    return neu ? `Wartung: ${p.name} erledigt am ${de(datum)}${wo}` : `Wartung: ${p.name} geändert, jetzt ${de(datum)}${wo}`;
  }
  throw new Fehler(400, "Unbekannte Wartungs-Aktion.");
}

function intervallText(p) {
  const teile = [];
  if (p.km) teile.push(`${zahl(p.km)} km`);
  if (p.monate) teile.push(`${p.monate} Monate${p.monatsende ? " bis Monatsende" : ""}`);
  return "alle " + teile.join(" oder ");
}

function normalWartung(l) {
  return (Array.isArray(l) ? l : [])
    .filter(p => p && typeof p === "object" && p.name)
    .map(p => ({
      id: String(p.id || neueId()),
      name: String(p.name),
      km: Number.isInteger(p.km) && p.km > 0 ? p.km : null,
      monate: Number.isInteger(p.monate) && p.monate > 0 ? p.monate : null,
      monatsende: p.monatsende === true,
      erledigt: sortieren((Array.isArray(p.erledigt) ? p.erledigt : [])
        .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.datum))
        .map(e => {
          const x = { id: String(e.id || neueId()), datum: e.datum };
          if (e.km != null && e.km !== "" && Number.isFinite(Number(e.km))) x.km = Number(e.km);
          if (e.notiz) x.notiz = String(e.notiz);
          return x;
        })),
    }));
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
  d.wartung = normalWartung(d.wartung);
  return d;
}

// Nach Datum, bei gleichem Datum nach km (Einträge ohne km zuerst).
function sortieren(l) {
  return l.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : (a.km ?? -1) - (b.km ?? -1)));
}

// Eine Ablesung bzw. ein Wartungseintrag pro Zeile, damit die Commits auf GitHub gut lesbar sind.
function alsText(d) {
  const zeilen = Object.entries(d).filter(([k]) => k !== "eintraege" && k !== "wartung").map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const punkte = (d.wartung || []).map(p => {
    const { erledigt, ...kopf } = p;
    const anfang = "    " + JSON.stringify(kopf).slice(0, -1) + ',"erledigt":[';
    return erledigt.length ? `${anfang}\n${erledigt.map(e => "      " + JSON.stringify(e)).join(",\n")}\n    ]}` : `${anfang}]}`;
  });
  zeilen.push(`  "wartung": [${punkte.length ? `\n${punkte.join(",\n")}\n  ` : ""}]`);
  zeilen.push(`  "eintraege": [\n${d.eintraege.map(e => "    " + JSON.stringify(e)).join(",\n")}\n  ]`);
  return "{\n" + zeilen.join(",\n") + "\n}\n";
}

// ---------- Hilfen ----------
function pruefeDatum(wert) {
  const datum = String(wert || "");
  const d = new Date(datum + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || isNaN(d) || d.toISOString().slice(0, 10) !== datum) throw new Fehler(400, "Das Datum ist ungültig.");
  if (datum > new Date(Date.now() + 36 * 3600e3).toISOString().slice(0, 10)) throw new Fehler(400, "Das Datum liegt in der Zukunft.");
  return datum;
}
function ganzzahl(wert, min, max, was) {
  if (wert == null || wert === "") return null;
  const n = Number(wert);
  if (!Number.isInteger(n) || n < min || n > max) throw new Fehler(400, `${was} ist ungültig.`);
  return n;
}
const kurz = (s, max) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const neueId = () => crypto.randomUUID().slice(0, 8);
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
