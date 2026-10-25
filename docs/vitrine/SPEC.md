# Fiche de vitrine : format et écarts

La page `index.html` est **générée** depuis `vitrine.json` par `node scripts/generate-vitrine.mjs`. Ne pas la modifier à la main.

```
node scripts/generate-vitrine.mjs             # écrit index.html
node scripts/generate-vitrine.mjs --verifier  # échoue si index.html n'est pas à jour (utilisable en CI)
```

## D'où vient le format

Il reprend la convention des vitrines de [Widgets-Grist](https://github.com/nic01asFr/Widgets-Grist) (`skills/vitrine.md`) : une fiche unique, des champs nommés et lus, une page dont les sections suivent toujours le même ordre. Les champs de leur spec sont gardés avec le même nom et le même sens ; les écarts sont listés ci-dessous. Ce n'est pas leur générateur : celui-ci est écrit pour des widgets Grist (manifeste, `published/`) et n'a pas été réutilisé.

## Champs repris tels quels

`nom`, `pitch`, `couleur`, `tags`, `depot`, `constat`, `points`, `usages`, `statut` (`niveau`, `texte`), `journal` (`version`, `texte`), et dans `produit` : `eyebrow`, `accroche`, `chiffres` (`valeur`, `libelle`), `titreContextes`, `contextes` (`titre`, `texte`, `pourquoi`, `images`), `titreSequence`, `sequence`.

## Champs ajoutés ici

| Champ | Rôle | Pourquoi |
|---|---|---|
| `liensDocs` | base des liens vers les documents | un seul endroit à changer quand la branche est fusionnée ; les liens relatifs vers des `.md` ne s'affichent pas en page web |
| `produit.introContextes` | phrase datant les captures | un nombre sans date de capture se périme sans qu'on le voie |
| `produit.architecture` | titre, intro, schéma SVG, cartes | un serveur MCP a plusieurs accès à un même état : un schéma l'explique mieux qu'une liste |
| `produit.technique` | tableau sujet / fait / où, bloc « Essayer » | public d'équipes techniques qui veulent reprendre une partie |
| `produit.savoir` | blocs « vérifié / non vérifié / avant usage plus large / à ne pas en attendre » | dire les limites au même endroit, avec le même poids que les points forts |
| `produit.docs` | liste de documents (`libelle`, `doc`) | même raison que `liensDocs` |
| `produit.pied` | texte de pied de page | crédits et licence |

## Champs de leur spec non repris

`peau`, `encart`, `forum`, `principal`, `archives`, `produit.apercu`, `produit.parcours` et `produit.annexes` : ils servent à un catalogue de widgets (démonstration intégrée, fil de forum, versions archivées). Aucun n'a de sens ici pour l'instant.

## Ce qui change dans le comportement

- **Un champ inconnu est une erreur.** Leur doc signale qu'un champ inventé est « silencieusement ignoré » ; ici le générateur s'arrête en disant lequel.
- **Une image, un schéma ou un document introuvable est une erreur**, ainsi qu'une image sans texte alternatif.
- **`--verifier`** permet de détecter une page restée en retard sur sa fiche.

## Pistes pour leur spec (hypothèses, non implémentées)

- Un contrôle du même type (champ inconnu, fichier absent) dans leur `generate-vitrine.js`.
- Une manière de dater les captures dans la fiche plutôt que dans un texte libre.
- Un bloc « limites » de premier rang, au lieu de le loger dans `parcours.savoir`.
