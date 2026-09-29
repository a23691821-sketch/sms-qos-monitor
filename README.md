# SMS QoS Monitor

Solution de monitoring de la qualité de service SMS : envoi périodique de SMS
de test via tes fournisseurs, réception réelle sur des téléphones Android
équipés de tes SIM de test, corrélation automatique, et dashboard de métriques
(taux de délivrance, latence, écarts DLR vs réception réelle).

## Comment ça marche

```
┌─────────────┐   1. envoie SMS test    ┌──────────────┐
│   Backend    │ ──────────────────────▶│  Fournisseur │
│  (scheduler) │        (API HTTP)       │     SMS      │
└──────┬───────┘                         └──────┬───────┘
       │                                        │ 2. livre le SMS
       │ 4. corrèle envoi/réception              ▼
       │    calcule latence            ┌──────────────────┐
       │                                │  Téléphone +     │
       └───────────◀────────────────── │  SIM de test      │
         3. webhook "SMS reçu"          │  (app Android)    │
            (code + heure réelle)       └──────────────────┘

              ┌──────────────┐
              │  Dashboard    │ ◀── consulte l'API de stats
              │  (navigateur) │
              └──────────────┘
```

Chaque SMS de test contient un code unique (`QOS-XXXXXX`). Le backend
l'envoie, horodate l'envoi, puis attend que l'app Android du téléphone
destinataire lui signale la réception réelle avec son propre horodatage. La
différence entre les deux, c'est la latence bout-en-bout réelle — pas
seulement ce que déclare le fournisseur via son DLR (accusé de réception),
qui peut être optimiste ou carrément faux selon les opérateurs.

## Démarrage rapide

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env          # ajuste ADMIN_API_KEY notamment
cp config/providers.example.json config/providers.json
# édite config/providers.json avec les vraies infos de tes fournisseurs SMS
npm start
```

Le dashboard est servi sur `http://localhost:3000/dashboard.html`, l'API sur
`http://localhost:3000/api`.

### 2. Déclarer un téléphone de test (device)

```bash
curl -X POST http://localhost:3000/api/devices \
  -H "x-admin-key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name": "SIM Orange CI - Abidjan", "phoneNumber": "+225xxxxxxxxx"}'
```

Récupère l'`apiKey` retournée : c'est celle à saisir dans l'app Android
installée sur ce téléphone.

### 3. Installer l'app Android

Voir `android-app/README.md`. En résumé : build l'APK, installe-le sur le
téléphone avec la SIM de test, renseigne l'URL du backend + la clé API du
device.

### 4. Créer une route de test

Une route = "j'envoie via tel fournisseur, vers tel numéro (la SIM de test),
toutes les X minutes".

```bash
curl -X POST http://localhost:3000/api/routes \
  -H "x-admin-key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Fournisseur A -> Orange CI",
    "providerId": "exemple_json_api",
    "country": "CI",
    "operator": "Orange",
    "destinationNumber": "+225xxxxxxxxx",
    "deviceId": 1,
    "intervalMinutes": 15
  }'
```

Le scheduler prend le relai automatiquement : toutes les minutes, il vérifie
quelles routes doivent être testées selon leur `intervalMinutes`.

Pour tester immédiatement sans attendre le premier cycle :
```bash
curl -X POST http://localhost:3000/api/routes/1/run-now -H "x-admin-key: <ADMIN_API_KEY>"
```

### 5. Regarder le dashboard

`http://localhost:3000/dashboard.html` — taux de délivrance, latence, détail
par route, log des tests récents.

## Déploiement en production

- **Backend** : le fichier SQLite convient très bien pour un POC/petit volume
  (quelques routes, tests toutes les 15 min). Héberge le backend sur une VM
  avec une IP/domaine joignable en HTTPS publiquement (l'app Android doit
  pouvoir l'atteindre depuis le réseau mobile). Un reverse proxy (Caddy ou
  nginx) devant Express pour le TLS est le plus simple.
- **Process manager** : lance `npm start` sous `pm2` ou un service `systemd`
  pour qu'il redémarre automatiquement.
- **Volumétrie plus importante** : si tu montes en échelle (beaucoup de
  routes/pays), remplace SQLite par PostgreSQL et ajoute une vraie queue
  (BullMQ) pour les envois — l'architecture logique reste identique.

## Ajouter un fournisseur SMS

Ouvre `backend/config/providers.json` et ajoute une entrée. Le format générique
HTTP couvre la plupart des cas (REST JSON, form-encoded, query params). Si un
fournisseur a une signature/auth vraiment spécifique (HMAC, OAuth avec refresh
token...), crée `backend/src/providers/<id>.js` exportant `{ send(cfg, vars) }`
et enregistre-le dans `CUSTOM_PROVIDERS` en haut de `backend/src/providers/index.js`.

## Interpréter les résultats

- **Taux de délivrance** : `délivrés / total`. En dessous de 95% de façon
  soutenue sur une route = signal d'alerte fournisseur.
- **Timeout** : le SMS n'a jamais été reçu par le téléphone de test dans le
  délai configuré (`TIMEOUT_MINUTES`, 15 min par défaut). Ajuste ce délai
  selon la latence normale de tes corridors (l'Afrique de l'Ouest et
  certaines routes intercontinentales peuvent légitimement prendre plus de
  temps que l'Europe).
- **Écart DLR** (`dlr_mismatch` dans l'API) : le fournisseur a déclaré le SMS
  "delivered" via son DLR, mais il n'est jamais arrivé sur le téléphone. C'est
  souvent le signal le plus intéressant commercialement : ça prouve qu'un
  fournisseur sur-déclare sa qualité.

## Limites connues de ce POC

- Un seul téléphone par point de mesure : si le téléphone tombe en panne ou
  perd le réseau, toutes les routes qui pointent vers lui remontent en
  timeout — ce qui est correct mais peut masquer un vrai problème fournisseur
  derrière un problème de device. Pour la prod, prévoir une supervision de la
  santé des devices eux-mêmes (le champ `last_seen_at` sur `/api/devices`
  aide déjà un peu : un device qui n'a rien reçu depuis longtemps est suspect).
- Pas d'authentification sur le dashboard lui-même (seules les routes
  d'administration sont protégées par `ADMIN_API_KEY`). Pour un déploiement
  exposé publiquement, ajoute une auth basique devant `/dashboard.html` (ou
  restreins l'accès réseau).
