# Spanish study widgets

The Spanish layout's study widgets after Flashcards (`docs/spanish-flashcards.md`). Ian's decisions (2026-11-25):

- **One daily tile: Word of the day.** Any part of speech; its example sentence is the sentence of the day. No separate Verb of the day or Sentence of the day.
- **A verb's page gets a Conjugation tab** with that verb's table. (Idea, not built: a noun's or adjective's page could get a Forms tab: el gato / los gatos; rápido, rápida, rápidos, rápidas.)
- **Then, one PR each:** Conjugation table (this), Streak and Weak spot (progress on the Pi, as Flashcards), Quick quiz, Tense drill, Listen.

## Conjugation table (`conjugate`)

- Verbs: `app/spanish-verbs.js`, built by `node dev/build-spanish-verbs.js ../conjugate-me/data/verbs.json` from Conjugate Me (Jehle data, CC BY-NC-SA 3.0): the 70 Flashcards verbs plus every Word of the day verb (110). Six Word of the day verbs Conjugate Me lacks are made from a regular model (`MADE` in the script). Eight tenses: presente, pretérito, imperfecto, futuro, condicional, pretérito perfecto, presente de subjuntivo, imperativo. Five persons (no vosotros); the imperative has no yo.
- Amber: a form that is not what the regular -ar/-er/-ir pattern gives (irregular or a spelling change: busqué). Worked out by the build script, stored as a bit mask per tense.
- Which verb: today's Word of the day when it is a verb, else a Flashcards verb (a new one each day). A verb picked on the tile or page stays until the day ends.
- TV tile (3x2 and up): engage on OK. Left and Right change the tense, OK shows the next verb (A to Z), Back leaves, holding OK opens the page. Strip: one line. Narrow: the verb.
- Page (always full screen): search box, Today's word chip, letters, verb list, table. Focus does the work: a letter lists its verbs, a verb shows its table; OK on a letter jumps to its first verb. The search box takes the TV keyboard or a USB one; Enter shows the results. Search finds a verb by its start, its English ("to have") or any form ("tuve" -> tener, pretérito, yo, ringed in the table). Accents are optional.
- Wall tablet: taps (the tile's ◀ ▶ arrows change the tense). Phone: the touch app's Conjugation table view, typing filters as you go.
- Word of the day: a verb's page has Word and Conjugation tabs (focus switches them); other words keep the page as it was. The table comes from `window.HUB_CONJ`.
- Tests: `node dev/conjugate-test.js` (`CONJ_SHOTS=dir` keeps pictures).
