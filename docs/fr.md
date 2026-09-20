# Intégration Wallbox

Cette intégration **surveille et pilote** vos **chargeurs de véhicule électrique Wallbox** via le **cloud Wallbox** : puissance de charge, niveau de batterie, énergies ajoutées (totale / verte / réseau), pause/reprise, verrouillage, courant de charge maximum et mode **« Charge solaire »** (Eco-Smart).

Elle s'inspire de l'[intégration Home Assistant](https://www.home-assistant.io/integrations/wallbox/) et s'appuie sur la même [librairie API](https://pypi.org/project/wallbox/).

## Prérequis

- Un compte **Wallbox** actif (https://my.wallbox.com).
- Votre/vos **chargeur(s)** enregistré(s) sur ce compte.
- Pour **piloter** le chargeur (pause, verrouillage, courant max, Eco-Smart), le compte doit avoir les **droits administrateur** sur la borne.

## Configuration

1. Installez l'intégration depuis le catalogue Gladys.
2. Renseignez l'**identifiant** (l'adresse e-mail de votre compte Wallbox) et le **mot de passe**.
3. Choisissez l'**intervalle de rafraîchissement** (15 à 3600 secondes, 90 par défaut).

L'intégration découvre automatiquement **tous les chargeurs** du compte et publie **un appareil par chargeur**. Aucun accès réseau local requis : tout passe par le **cloud Wallbox**.

## Appareils publiés

Les valeurs sont publiées dans les unités Gladys (kW, kWh, %, km, km/h, A), arrondies à **3 décimales maximum**.

Chaque chargeur expose :

- **Capteurs** : niveau de charge (%), puissance de charge (kW), énergie ajoutée (kWh), énergie verte ajoutée (kWh), énergie du réseau ajoutée (kWh), autonomie ajoutée (km), vitesse de charge (km/h), puissance max disponible (A), statut texte (ex. « Charging », « Paused »), devise.
- **Commandes** : pause / reprise, verrouillage / déverrouillage, courant de charge maximum (A), « Charge solaire » (Désactivé / Eco-Smart / Solaire complet), boutons reprise de programmation et mise à jour du firmware.

Certaines fonctionnalités sont **spécifiques au modèle** et n'apparaissent que si le chargeur les prend en charge (comportement identique à Home Assistant) : par exemple l'énergie déchargée sur les bornes bidirectionnelles (séries **QS**).

## Sécurité

- Le **mot de passe** de votre compte Wallbox est **stocké chiffré par Gladys** et **jamais renvoyé au frontend** (champ `secret`).
- Toutes les requêtes passent par **HTTPS** vers `api.wall-box.com` et `user-api.wall-box.com`.
- Comme il s'agit d'une API **cloud**, le badge de transport de chaque appareil est **cloud** en fonctionnement normal, et passe à **injoignable** si l'API Wallbox ne répond plus ou refuse vos identifiants.

## Dépannage

- **« Wallbox a refusé les identifiants »** : identifiant ou mot de passe incorrect (champ `secret`), ou compte sans droits sur la borne. Vérifiez dans le portail Wallbox.
- **« Cloud Wallbox injoignable »** : problème de réseau ou API Wallbox momentanément indisponible. Le badge passe en **injoignable**.
- **Aucune donnée de décharge / de courant ICP** : votre modèle de chargeur (ex. Pulsar Plus) ne dispose pas de ces mesures — l'intégration ne les publie pas, comme Home Assistant.
- **Pause / reprise inopérante** : certaines bornes n'autorisent la pause que lorsqu'un véhicule est branché, et le compte doit avoir les droits administrateur.

## Limites connues

- L'API Wallbox **limite le débit** (HTTP 429) : une fréquence de rafraîchissement trop basse peut déclencher ces limites. La valeur par défaut de 90 s est un bon compromis. L'intervalle effectif est multiplié par le nombre de chargeurs du compte (90 s x N), comme Home Assistant.
- L'intégration repose sur l'**API publiques non documentées** de Wallbox ; Wallbox peut les modifier sans préavis.
