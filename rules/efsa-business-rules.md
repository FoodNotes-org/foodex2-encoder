# EFSA FoodEx2 business rules

Where the rule checks in `src/rules/` come from, how they map to EFSA's
severities, and what they cannot check. Which EFSA rules are implemented, with
their messages, is in `src/rules/efsa.ts` (`EFSA_RULES`, `EFSA_RULES_NOT_CHECKED`).
Facet cardinality is in [cardinality.yaml](cardinality.yaml); disagreements
between EFSA sources, and the source-precedence rule used to settle them, are
in [conflicts.yaml](conflicts.yaml).

## Sources

| Source | What it is | Version / date |
| --- | --- | --- |
| [openefsa/catalogue-browser](https://github.com/openefsa/catalogue-browser) `doc/CatalogueBrowser_business_rules_v3.xlsx` | EFSA's rule sheet: ID, trigger, message, where applied, severity, behaviour in EFSA's data collection framework (DCF), examples | committed 2020-09-22 |
| same repo, `business-rules/warningMessages.txt` | The messages and severities the tools load at run time | matches the sheet |
| same repo, `business-rules/BR_Data.csv` | Forbidden processes per food group, with ordinal codes (used by BR16, BR19, BR27) | committed 2020-05-20 |
| same repo, `src/main/java/business_rules/TermRules.java` | The rule logic shared by the Catalogue Browser and the ICT | Catalogue Browser 1.2.15, last changed 2024-05-13 |
| [openefsa/interpreting-and-checking-tool](https://github.com/openefsa/interpreting-and-checking-tool) | The ICT: an Excel add-on that calls `TermRules` | ICT 1.2.13 |
| FoodEx2 guidance revision 2 (EN-804), Table 20 | Facet cardinality and applicability | 2015 |
| MTX catalogue (`MTX.ecf`) | Facet flags (`attributeSingleOrRepeatable`) and facet descriptions | 17.1 |

## Licence

The Catalogue Browser and the ICT are licensed under the **European Union
Public Licence 1.2** (EUPL), a copyleft licence. This repository is MIT. So:

- No EFSA code is copied here. Each rule is rewritten from its documented
  behaviour (the rule sheet and messages) and from reading what the code does.
- Rule IDs and EFSA's message wording are quoted as references, with credit.
- `BR_Data.csv` is EFSA data under the EUPL. It is vendored unmodified, with
  its licence, in `vendor/efsa-business-rules/`, and read at build time
  (`npm run build:rules`) rather than inlined into MIT code.

## Severity

EFSA rates each rule at two levels: the "semaphore" (the colour shown in the
browser) and the "text level" (the message), each NONE, LOW, HIGH or ERROR.
We follow the text level: **HIGH or ERROR becomes an error, LOW a warning,
NONE is not reported.**

## Rules of our own

Labelled as ours in results, never as EFSA's:

- **Contradicts an implied facet.** For a single-cardinality facet, a stated
  descriptor that is neither the implied one nor beneath it replaces what the
  base term already says. A more specific descriptor beneath the implied one is
  fine. Warning.
- **Repeats an implied facet.** Stating a descriptor the base term already
  implies adds nothing. Warning.
- **Broader than implied.** A stated descriptor that is an ancestor of one the
  base term implies adds nothing. Warning; for base terms in EFSA's
  forbidden-process food groups this is BR16 instead.
- **Facet description says one.** For the facets in `conflicts.yaml` where
  EFSA's flag allows several but its own description says one. Warning.

## Limits

- **BR14, BR15 and BR25 are not in the open-source code.** They run in the
  ICT's Excel macros or on EFSA's servers, so they are known from the rule
  sheet only. BR15 has no description and BR14 only an example. BR25 follows
  the catalogue's cardinality flag (see `cardinality.yaml`).
- **BR16 has two definitions.** The 2020 rule sheet compares ordinal codes; the
  current code checks hierarchy ancestry. We follow the code (`conflicts.yaml`,
  `definition-BR16`).
- **Checks on submission.** EFSA also checks codes when a dataset is submitted
  (the DCF), some with a different severity. We can't see those checks, so a
  code with no errors here is not guaranteed to be accepted.
- **Data-collection rules.** [openefsa/business-rules-engine](https://github.com/openefsa/business-rules-engine)
  holds extra rules per data collection (chemical contaminants, pesticide
  residues, veterinary drug residues, zoonoses). They depend on the collection
  and are not applied.
- **Version lag.** `BR_Data.csv` is from 2020; the catalogue is MTX 17.1.
  Terms added since have no forbidden-process entries.
