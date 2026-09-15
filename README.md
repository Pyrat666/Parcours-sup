# Parcoursup — tri de cartes

Page unique qui affiche les formations du catalogue Parcoursup sous forme de cartes que l'on
classe par ordre de préférence, avant d'entrer dans celle placée en tête et de recommencer au
niveau suivant.

L'arborescence par défaut est `fl` → `tf` → `nmc` → `nm` → `amg`. Le bouton de réglage permet
de la réordonner — au même geste de tri de cartes — et de désactiver les niveaux dont on ne
veut pas ; les niveaux ignorés disparaissent du parcours.

Ces cinq champs sont les facettes du portail et ne décrivent que la formation : `nmc` est son
nom court et `nm` son nom long, non la commune et l'établissement. Le panneau de réglage
propose donc **tous** les champs textuels du jeu de données, les cinq par défaut actifs et le
reste désactivé, de sorte que l'établissement ou la commune puissent devenir des niveaux.

## Données

Jeu de données `fr-esr-cartographie_formations_parcoursup` (ministère de l'Enseignement
supérieur et de la Recherche), via l'**API Opendatasoft Explore v2.1**, sans clé :

| Usage | Requête |
|---|---|
| Schéma | `GET /catalog/datasets/{id}` |
| Cartes d'un niveau | `GET /catalog/datasets/{id}/records?group_by=<champ>&where=…` |
| Formations d'une branche | `GET /catalog/datasets/{id}/records?where=…&limit=100&offset=…` |

## Lancer

Le navigateur bloque les requêtes cross-origin depuis `file://`, il faut servir en HTTP :

```bash
python3 -m http.server 8000
```

Aucune dépendance, aucune étape de build.

## Notes

- Le glissement repose sur les Pointer Events, la poignée portant `touch-action: none` :
  l'API drag-and-drop HTML5 n'émet rien sur écran tactile.
- Les noms de colonnes du jeu de données sont courts (`tf`, `fl`, `nm`…) et susceptibles de
  changer ; ils sont résolus depuis le schéma au démarrage. Si la détection échoue, et
  seulement dans ce cas, la page demande de désigner les deux niveaux.
- L'API plafonne `limit` à 100 et `limit + offset` à 10 000, d'où le chargement par pages au
  dernier niveau.
- `?schema` affiche le dictionnaire des champs du jeu de données (nom, type, libellé), dont
  les noms de colonnes sont trop courts pour être devinés.
- L'ordre des niveaux n'est pas conservé d'une visite à l'autre : il repart de la valeur par
  défaut à chaque chargement de la page.
