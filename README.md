# Explorer Parcoursup — navigation par priorisation

Outil web statique pour explorer le **catalogue des formations Parcoursup**, non pas par
cases à cocher mais par **tri de cartes** : à chaque étage de l'arborescence, on classe les
groupes par ordre de préférence, puis on entre dans celui qu'on a mis en tête.

## Données

Jeu de données `fr-esr-cartographie_formations_parcoursup` (ministère de l'Enseignement
supérieur et de la Recherche), servi par l'**API Opendatasoft Explore v2.1** :

```
https://data.enseignementsup-recherche.gouv.fr/api/explore/v2.1/catalog/datasets/fr-esr-cartographie_formations_parcoursup
```

Pas de clé d'API. Le second portail (`data.education.gouv.fr`) sert de secours automatique
si le premier ne répond pas.

Trois appels seulement :

| Usage | Requête |
|---|---|
| Schéma du jeu de données | `GET /catalog/datasets/{id}` |
| Cartes d'un niveau | `GET /catalog/datasets/{id}/records?select=<champ> as valeur, count(*) as nb&group_by=<champ>&where=…` |
| Formations d'une branche | `GET /catalog/datasets/{id}/records?where=…&limit=100&offset=…` |

L'interface se limite au tri de cartes et à la descente dans l'arborescence : ni filtre, ni
recherche, ni export.

## Lancer

Le navigateur refuse les requêtes cross-origin depuis `file://` : il faut servir les
fichiers en HTTP.

```bash
python3 -m http.server 8000
# puis http://localhost:8000
```

Aucune dépendance, aucune étape de build.

## Comment ça marche

- **Niveaux détectés depuis le schéma.** Les noms de champs du jeu de données sont courts
  (`tf`, `fl`, `nm`, `nmc`…) et peuvent changer ; l'application lit le schéma au démarrage
  et résout les champs par nom puis par libellé. Si la détection échoue, et seulement dans
  ce cas, l'interface demande de désigner les deux niveaux.
- **Priorisation.** Glisser-déposer, ou les boutons ↑/↓. Le rang de chaque étage est
  conservé dans le fil d'Ariane et forme la priorité finale d'un vœu (`1.3.2` = 1ʳᵉ branche,
  3ᵉ sous-branche, 2ᵉ formation).
- **Rien n'est éliminé.** Classer n'est pas filtrer : les branches non retenues restent
  accessibles en remontant le fil d'Ariane.

## Limites connues

- L'arborescence native du catalogue est **peu profonde** (type de formation → filière) et
  son premier étage est un *type de diplôme* (BTS, Licence, CPGE…), pas un domaine
  d'intérêt. Une couche « domaines » définie à la main par-dessus les filières rendrait le
  tri de cartes plus naturel — c'est la prochaine étape.
- L'API plafonne `limit` à 100 et `limit + offset` à 10 000 : la liste des formations d'une
  branche se charge par pages. Pour dépasser ça, il faudrait ingérer l'export complet
  (`/exports/json`) dans une base locale.
- Le lien vers la fiche n'est affiché que si le jeu de données fournit une URL exploitable.
- Aucune donnée candidat : l'open data ne couvre que le catalogue public.
