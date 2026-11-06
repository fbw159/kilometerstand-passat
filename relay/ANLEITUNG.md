# Worker „kilometerstand-passat“ einrichten (für Claude in Cowork)

Ziel: `https://kilometerstand-passat.fbw159.workers.dev` liest und schreibt `daten.json` im privaten Repo `fbw159/kilometerstand-passat-daten`. Die Seite https://fbw159.github.io/kilometerstand-passat/ ruft ihn mit dem Zugangscode im Header `X-Zugang` auf. Im Code steht nur der SHA-256 des Codes, den Link mit Code hat Börje.

**Stand 06.11.2026: eingerichtet.** Worker hochgeladen, workers.dev an, Secret `GITHUB_TOKEN` gesetzt, `/status` liefert `github_status: 200`, Speichern und Löschen getestet.

Vorgehen wie beim Worker `schiffe-flugzeuge` (siehe Projekt-Doc `claude/github-veroeffentlichung.md` im Claude-Projekt „Dashboards“, Abschnitt Cloudflare):

1. Im eingebauten Browser `dash.cloudflare.com` öffnen (Börje ist angemeldet), Account-ID aus der Adresse nehmen.
2. `relay/worker.js` im Dashboard-Tab von `https://raw.githubusercontent.com/fbw159/kilometerstand-passat/main/relay/worker.js` holen, SHA-256 mit der Datei im Repo vergleichen.
3. Hochladen: `fetch('/api/v4/accounts/<Account-ID>/workers/scripts/kilometerstand-passat', {method:'PUT', credentials:'include', body: FormData})` mit `metadata` = `{"main_module":"worker.js","compatibility_date":"2026-10-01","keep_bindings":["secret_text"]}` und der Datei `worker.js` als `application/javascript+module`.
4. workers.dev einschalten: `POST /api/v4/accounts/<Account-ID>/workers/scripts/kilometerstand-passat/subdomain` mit `{"enabled":true,"previews_enabled":false}`.
5. Secret setzen: `PUT /api/v4/accounts/<Account-ID>/workers/scripts/kilometerstand-passat/secrets` mit `{"name":"GITHUB_TOKEN","text":"<Inhalt von github-token.txt>","type":"secret_text"}`. Token nie ausgeben, in keine Datei schreiben, nicht in Befehle tippen: im Dashboard-Tab ein ECDH-Schlüsselpaar (P-256) erzeugen, mit dessen öffentlichem Schlüssel den Token in der Cloud verschlüsseln (AES-GCM), im Tab entschlüsseln und direkt senden.
6. Prüfen: `https://kilometerstand-passat.fbw159.workers.dev/status` muss `{"ok":true,"token_gesetzt":true,"github_status":200}` liefern. `/daten` ohne Code muss 401 liefern. Danach Börjes Link einmal im eingebauten Browser öffnen: oben muss der Zählerstand stehen.

Bei späteren Code-Änderungen nur Schritt 2 und 3 wiederholen (`keep_bindings` behält das Secret).
