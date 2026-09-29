# SMS QoS Monitor — App Android (récepteur)

Cette app tourne sur chaque téléphone équipé d'une SIM de test. Elle écoute les
SMS entrants, détecte ceux qui contiennent un code de test (`QOS-XXXXXX`) —
en réalité elle transmet **tous** les SMS reçus, le tri se fait côté backend —
et les envoie au backend avec l'heure de réception réelle du téléphone.

## Build

1. Ouvre le dossier `android-app/` dans Android Studio (Koala ou plus récent).
2. Laisse Gradle synchroniser (les dépendances sont dans `app/build.gradle`).
3. Build > Generate Signed Bundle/APK, ou simplement `Run` sur un téléphone
   branché en USB avec le débogage activé.

En ligne de commande (si le SDK Android est installé) :
```bash
cd android-app
./gradlew assembleDebug
# APK généré dans app/build/outputs/apk/debug/app-debug.apk
```

## Installation sur chaque téléphone de test

1. Installe l'APK sur le téléphone (avec sa SIM de test insérée).
2. Au premier lancement, accorde les permissions SMS demandées.
3. Renseigne :
   - **URL du backend** : l'adresse publique de ton serveur (ex: `https://qos.tondomaine.com`). Doit être en HTTPS en production (le manifest bloque le trafic non chiffré).
   - **Clé API du device** : générée via `POST /api/devices` côté backend (voir README du backend). Chaque téléphone a sa propre clé.
4. Laisse le téléphone allumé, chargé, avec une connexion data active en permanence. C'est la contrainte principale de ce type de setup : si le téléphone est éteint ou hors couverture, les tests envoyés vers lui remonteront en `timeout`, faussant tes stats — ce qui est en fait un signal utile (ça t'alerte que ce point de collecte n'est plus fiable).

## Points d'attention pour un POC sérieux

- **Un téléphone = un point de mesure**, pas un fournisseur. Une route (voir backend) associe un fournisseur d'envoi à un device de réception donné. Tu peux avoir plusieurs routes qui pointent vers le même téléphone si tu veux comparer plusieurs fournisseurs sur le même opérateur destinataire.
- **Désactive l'optimisation de batterie** pour cette app dans les paramètres Android (Paramètres > Batterie > Sans restriction), sinon le système peut tuer le processus et retarder la détection des SMS.
- Le receiver est déclaré en dur dans le manifest (pas en dynamique) : il reçoit les SMS même si l'app n'a pas été ouverte récemment, tant que le téléphone est allumé.
