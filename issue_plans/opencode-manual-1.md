# Piano

## Obiettivo
Creare il file `CHANGELOG.md` nella radice del repository contenente una voce di livello 2 (`##`), in modo da dare inizio allo storico modifiche del progetto in formato leggibile (stile Keep a Changelog).

## Task
1. **Creare `CHANGELOG.md` alla radice** (`CHANGELOG.md`)
   - Nuovo file, non esistente (verificato: nessun `CHANGELOG*` nel repo).
   - Contenuto minimo: intestazione di livello 2 (`## …`) come prima voce dello storico, preceduta eventualmente da un titolo `# Changelog`.
   - La voce `##` deve riferirsi allo stato attuale del progetto (es. versione iniziale / rilascio iniziale) e, opzionalmente, elencare i cambiamenti già presenti nei commit iniziali (`1af3fbe` … `9d1f86d`) con sotto-sezioni `- Added` / `- Fixed` / `- Changed`.
   - Allineamento con la lingua usata nel repo (README in italiano) o con l'inglese dello standard Keep a Changelog: usare la stessa lingua del resto della documentazione.
2. **Collegare il changelog alla documentazione** (`README.md`)
   - Aggiungere un riferimento al file nella sezione `## Contenuto` (voce `- CHANGELOG.md — storico delle modifiche.`), così il file è scopribile.

## Acceptance Criteria
- [ ] Esiste `CHANGELOG.md` esattamente nella radice del repository (stesso livello di `README.md`).
- [ ] Il file contiene almeno una riga che inizia con `## ` (heading di livello 2).
- [ ] La riga `## ` è ben formata: `##` seguito da spazio e testo (nessun `###` o `#` usato al suo posto).
- [ ] Il file è in Markdown valido (nessuna riga malformata, encoding UTF-8, termina con newline finale).
- [ ] `README.md` include il puntatore a `CHANGELOG.md` nella sezione `## Contenuto`.
- [ ] Nessun altro file del repository è stato modificato (diff limitato a `CHANGELOG.md` + `README.md`).
- [ ] La lingua del contenuto è coerente con la documentazione esistente.

## Verifica
```bash
# 1. Il file esiste alla radice
test -f CHANGELOG.md && echo OK

# 2. Contiene un heading di livello 2
grep -n '^## ' CHANGELOG.md

# 3. Struttura headings del file
grep -n '^#' CHANGELOG.md

# 4. Encoding/ newline finale
file CHANGELOG.md && tail -c 1 CHANGELOG.md | xxd

# 5. Diff limitato ai file previsti
git status --porcelain
git diff --stat

# 6. Render Markdown (opzionale)
npx --yes markdownlint-cli2 CHANGELOG.md README.md
```
Controllo manuale: aprire `CHANGELOG.md` e verificare che la prima riga dopo l'eventuale titolo `# Changelog` sia una voce `## …`; verificare che la sezione `## Contenuto` di `README.md` citi `CHANGELOG.md`.
