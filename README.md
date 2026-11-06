# Kilometerstand

Kleines Handy-Dashboard für den Kilometerstand eines Autos: Stand eintragen, Verlauf mit Prognose, gefahrene Kilometer pro Zeitraum und eine Warnung, wenn die versicherten Kilometer vor Ende des Versicherungsjahres erreicht werden.

Die Seite selbst enthält keine Daten. Die Ablesungen liegen in einem privaten Repo und werden über einen kleinen Cloudflare-Worker (`relay/worker.js`) gelesen und geschrieben. Ohne Zugangscode zeigt die Seite nichts an.
