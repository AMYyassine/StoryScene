# Storyscene — démarrer et tester la première version

L’application est en anglais. Ce guide accompagne le code du nouveau prototype local, distinct des anciennes versions.

## Démarrer sur Windows

1. Décompresser entièrement `Storyscene_Local_v1.zip`.
2. Ouvrir le dossier `storyscene`.
3. Double-cliquer sur `start.bat` et laisser le terminal ouvert.
4. Le navigateur s’ouvre sur **http://127.0.0.1:8000**. Si nécessaire, ouvrir cette adresse manuellement.

Python doit être installé avec son lanceur `py`. Cette livraison a été testée avec Python **3.12.14**. Le premier lancement installe les dépendances dans `.venv` et nécessite Internet. Le code reste modifiable dans VS Code.

L’application et les données restent sur votre ordinateur. Les requêtes d’IA en ligne transmettent le contexte du récit à Hugging Face. Aucun déploiement public n’est effectué.

## Première démonstration, sans clé API

L’histoire **The Midnight Archive** s’ouvre lors du premier lancement. Le badge **Sample walkthrough** indique une démonstration préparée : aucune IA n’est appelée dans ce mode.

1. Cliquer sur la scène **The key**. Le texte correspondant apparaît dans un encadré bleu. Les passages hérités et les conséquences potentielles utilisent d’autres couleurs.
2. À droite, comparer les deux cartes **Rose** : l’une désigne la scène, l’autre le chapitre.
3. Cliquer sur Rose dans une illustration. Choisir **This scene** ou **This chapter** dans la clarification. La référence reste disponible à droite.
4. Glisser **Rose · scene** dans le prompt, ou cliquer sur la flèche de sa carte.
5. Saisir : **Remove Rose from this scene.**
6. En **Check-in**, cliquer **Execute**. Lire les observations : le texte ne change pas.
7. Passer en **Edit**. Le changement de mode efface l’ancienne instruction pour éviter une exécution involontaire. Ressaisir la demande puis **Execute**.
8. Cliquer **Compare** pour voir l’avant/après. **Reject** restaure le récit ; **Accept** conserve la variante. Les deux parcours préservent des versions récupérables.
9. Ouvrir **Versions**, sélectionner l’original et cliquer **Create variant**. Choisir un point de départ, puis explorer cette nouvelle branche.

La démonstration préparée ne traite que le retrait de Rose dans les passages d’origine de cet exemple. Pour une autre demande ou une histoire personnelle, activer Hugging Face. Cette limitation évite de présenter des règles fixes comme une IA générale.

## Manipulation directe

- **Personnage → scène** : glisser un personnage depuis la liste vers une scène prépare une demande d’ajout. Compléter l’action attendue dans le prompt avant d’exécuter.
- **Scène → scène** : déplacer une carte sur une autre prépare son déplacement après celle-ci. En Edit, le texte est réordonné dans un état provisoire à accepter ou refuser. En Check-in, cela prépare seulement une hypothèse à analyser.
- **Menu `···` d’une scène** : remplacer son texte, ajouter une scène, déplacer avant/après ou retirer la scène. Une nouvelle scène peut aussi commencer un nouveau chapitre.
- **Crayon** : entourer un personnage ou un passage, préciser la portée, puis tracer un trait qui se termine dans la zone du prompt. Les traits non reconnus restent des annotations.
- **Texte sélectionné → Reference** : conserver une référence à un passage précis. Les boutons offrent une alternative au crayon et au glisser-déposer.
- **Séparateur vertical** : déplacer la barre pour ajuster la largeur du manuscrit. Au clavier, utiliser les flèches lorsque le séparateur a le focus.

Une carte réutilisable conserve **l’élément, sa portée et son contexte**. Si sa cible disparaît ou si le passage cité change, elle est signalée comme obsolète et doit être sélectionnée de nouveau.

## Importer votre histoire

Cliquer **Import** : copier-coller, fichier TXT UTF-8, PDF avec texte sélectionnable ou DOCX. Vérifier l’extraction, puis choisir :

- **AI structure** : analyse sémantique via Hugging Face.
- **Local grouping** : découpage mécanique en passages, utile pour explorer l’interface sans IA.

Les nombres de chapitres, sections par chapitre et scènes peuvent être précisés. Une scène utilise au minimum un passage ; les contraintes impossibles sont refusées.

Le document Word ou PDF est importé sous forme de texte. La mise en page d’origine et ses styles ne sont pas conservés. Vous pouvez ensuite utiliser gras, italique, soulignement, titre et marquage dans l’éditeur.

## Connecter Hugging Face

1. Ouvrir **AI settings**, en haut à droite.
2. Choisir **Hugging Face**.
3. Entrer l’identifiant exact d’un modèle proposé par un fournisseur d’inférence, éventuellement avec le suffixe `:provider`.
4. Entrer votre jeton `hf_…`, avec la permission **Inference Providers**.
5. Cliquer **Save settings**.

Ne partagez pas votre clé dans le chat. Elle reste en mémoire dans le serveur local et n’apparaît ni dans les projets ni dans les exports. Après un redémarrage, il faut la saisir à nouveau, sauf si `HF_TOKEN` et `HF_MODEL` ont été définis comme variables d’environnement.

Les paramètres enregistrés ne prouvent pas encore qu’un modèle répond : le premier appel réel vérifiera votre configuration, les droits et la disponibilité du fournisseur. Aucune génération réelle n’a été testée dans cette livraison sans votre configuration.

Documentation : https://huggingface.co/docs/inference-providers/tasks/chat-completion

## Créer une histoire depuis zéro

Menu du projet → **A fresh page** → mode **Edit** → **Create story**.

Donner l’idée et, éventuellement, les nombres de chapitres et de scènes. L’IA propose un plan. Modifier les personnages, titres et événements, puis **Approve outline**. Cliquer ensuite séparément **Draft story**. Le premier récit reste provisoire jusqu’à votre acceptation.

## Sauvegarde et retour arrière

- La base locale est `data/storyscene.sqlite3`.
- Les écritures manuelles sont sauvegardées après une pause ; `Ctrl+S` force la sauvegarde.
- Un résultat provisoire est conservé même si vous fermez l’application.
- Refuser après une retouche manuelle restaure l’état précédent et conserve le brouillon refusé dans **Versions**.
- **Export → Project backup** exporte le projet avec son historique. Le même panneau permet de restaurer ce JSON comme nouveau projet.
- **Export → Manuscript** fournit le texte seul.

## Ce qui reste à améliorer après cette version

Le prototype couvre les parcours principaux, avec des limites explicites :

- Les gestes libres complexes, l’écriture manuscrite et les signes oui/non au crayon ne sont pas encore interprétés. Utiliser les boutons Accept/Reject.
- Les scènes utilisent des illustrations vectorielles symboliques, avec une animation légère ; ce ne sont pas des GIF générés pour chaque scène.
- L’analyse d’un roman long n’est pas encore découpée en contextes. Une requête IA supérieure à **60 000 caractères, structure comprise**, est refusée sans troncature.
- Les images scannées nécessitent un OCR externe. Les références textuelles multi-paragraphes se créent actuellement séparément.
- Le modèle peut se tromper dans ses interprétations : absence de problème détecté ne signifie pas cohérence garantie.
- Ollama, la collaboration simultanée et la fusion des variantes ne sont pas implémentés.

Les tests automatisés vérifient les imports et les règles du serveur. La syntaxe JavaScript a été vérifiée. Le contrôle interactif dans un navigateur n’était pas disponible ici : le rendu, le crayon et le glisser-déposer doivent donc encore être parcourus sur votre ordinateur. Les étapes de démonstration ci-dessus constituent le premier test à faire ensemble.
