# EFSA FoodEx2 business rules: research notes

What EFSA's own checking tools enforce on a FoodEx2 code, where each rule comes
from, and which ones this repository's shared rules module implements. The
facet cardinality table is in [cardinality.yaml](cardinality.yaml); disagreements
between EFSA sources are in [conflicts.yaml](conflicts.yaml).

Researched 2026-10 against MTX 17.1.

## Sources

| Source | What it is | Version / date |
| --- | --- | --- |
| [openefsa/catalogue-browser](https://github.com/openefsa/catalogue-browser) `doc/CatalogueBrowser_business_rules_v3.xlsx` | EFSA's rule sheet: ID, trigger, message, where applied, severity, behaviour in EFSA's data collection framework (DCF), examples | committed 2020-09-22 |
| same repo, `business-rules/warningMessages.txt` | The messages and severities the tools load at run time | matches the sheet |
| same repo, `business-rules/BR_Data.csv` | Forbidden processes per food group, with ordinal codes (used by BR16, BR19, BR27) | committed 2020-05-20 |
| same repo, `src/main/java/business_rules/TermRules.java` | The rule logic shared by the Catalogue Browser and the ICT | Catalogue Browser 1.2.15, last changed 2024-05-13 |
| [openefsa/interpreting-and-checking-tool](https://github.com/openefsa/interpreting-and-checking-tool) | The ICT: an Excel add-on that calls `TermRules` | ICT 1.2.13, last commit 2026-08-05 |
| [ICT user guide, EN-1727](https://www.efsa.europa.eu/en/supporting/pub/en-1727) | Installation and use | 2019; **not consulted** (the PDF download is blocked for scripts; see Gaps) |
| FoodEx2 guidance revision 2 (EN-804), Table 20 | Facet cardinality and applicability | 2015 |
| MTX catalogue (`MTX.ecf`) | Facet flags (`attributeSingleOrRepeatable`) and facet descriptions | 17.1 |

## Licence

The Catalogue Browser, the ICT and the business-rules-engine are all licensed
under the **European Union Public Licence 1.2** (EUPL), a copyleft licence. This
repository is MIT. So:

- No EFSA code is copied here. Each rule is rewritten from its documented
  behaviour (the rule sheet and messages) and from reading what the code does.
- The rule IDs and EFSA's message wording are quoted as references, with credit.
- `BR_Data.csv` is EFSA data under the EUPL. It is vendored unmodified, with
  its licence, in `vendor/efsa-business-rules/`, and read at build time
  (`npm run build:rules`) rather than inlined into MIT code.

## Severity

EFSA rates each rule at two levels: the "semaphore" (the colour shown in the
browser) and the "text level" (the message). The tools use NONE, LOW, HIGH and
ERROR. The DCF column says what happens when a dataset is submitted.

Our `validate` maps EFSA's text level: **HIGH or ERROR becomes an error, LOW
becomes a warning, NONE is not reported.** This follows the source-precedence
rule: what EFSA's checking tool enforces comes first.

## The rules

Applied in: CB = Catalogue Browser, ICT = Interpreting and Checking Tool,
DCF = EFSA's submission system. "v1" = implemented in the first version of the
shared module; "later" = planned; "n/a" = nothing to implement.

| ID | What it checks (our wording) | Applied in | EFSA level | DCF | Our severity | Status |
| --- | --- | --- | --- | --- | --- | --- |
| BR01 | Raw commodity: an F27 source commodity must narrow down one of the implied F27 commodities (or the base term itself) | CB/ICT/DCF | HIGH | Error | error | later |
| BR02 | (empty) | | NONE | | | n/a |
| BR03 | Composite food (term type s or c) must not have F01 Source; use F04 Ingredient | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR04 | Composite food must not have F27 Source-commodities; use F04 Ingredient | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR05 | Derivative with an implied F27: an added F27 must narrow down the implied one | CB/ICT/DCF | HIGH | Error | error | later |
| BR06 | Derivative: F01 Source only when an F27 is present | CB/ICT/DCF | HIGH | Error | error | later |
| BR07 | Derivative: F01 Source only when there is a single F27 | CB/ICT/DCF | HIGH | Error | error | later |
| BR08 | Base term not reportable in the Reporting hierarchy (skipped when the term is dismissed) | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR09 | (empty) | | NONE | | | n/a |
| BR10 | Non-specific base term (detail level P), unless F01 or F27 is added | CB/ICT/DCF | LOW | LOW | warning | v1 |
| BR11 | Generic F28 process "Processed" (A0C0R) or its children A0CHR, A0CHS | CB/ICT/DCF | LOW | LOW | warning | v1 |
| BR12 | F04 Ingredient on a raw commodity or derivative, unless the term is "flavoured" or the ingredient narrows down an implied one | CB/ICT/DCF | LOW | LOW | warning | v1 |
| BR13 | F03 powder or paste states (A06JD, A07Y3, A07Y2, A06JG, A06JF, A06JE, A07Y4) on a raw commodity; use the derivative | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR14 | Not documented ("only applied on ICT and DCF"); EFSA's example repeats the same F04 twice | ICT/DCF | HIGH | LOW | | gap |
| BR15 | Not documented ("only applied on DCF") | DCF | LOW | LOW | | gap |
| BR16 | A stated descriptor less detailed than an implied one of the same facet (an ancestor of it), for base terms in a forbidden-process food group | CB/ICT/DCF | HIGH | LOW | error | v1 |
| BR17 | A facet descriptor (term type f) used as base term | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR18 | (empty) | | NONE | | | n/a |
| BR19 | Raw commodity with a process that creates an existing derivative (per `BR_Data.csv`, looked up through the Reporting hierarchy) | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR20 | Deprecated base term | CB/ICT/DCF | HIGH | Error | error | v1 |
| BR21 | Dismissed base term: not reportable, not deprecated, and nothing reportable beneath it, in the Reporting hierarchy | CB/ICT | HIGH | (planned) | error | v1 |
| BR22 | "Base term successfully added" (information only) | CB/ICT | NONE | | | n/a |
| BR23 | Hierarchy term (detail level H) used as base term, when it is in the Exposure hierarchy | CB/ICT/DCF | LOW | LOW | warning | v1 |
| BR24 | Hierarchy term used as base term, when it is not in the Exposure hierarchy | CB/ICT | HIGH | | error | v1 |
| BR25 | More than one descriptor in a facet with single cardinality | ICT/DCF | HIGH | Error | error | v1 (see cardinality.yaml) |
| BR26 | Two processes with the same ordinal code (EFSA has disabled this rule) | CB/ICT | HIGH | | | n/a |
| BR27 | Two processes, implied or stated, whose ordinal codes share the integer part (for example 1.1 and 1.2): they create another existing derivative | CB/ICT | HIGH | | error | later |
| BR28 | Reconstitution (A07MR) or dilution (A07MQ) on a concentrate or powder term (name or scope note says "concentrate" or "powder") | CB/ICT | HIGH | (planned) | error | v1 |
| BR29 | Malformed code, or a term that doesn't exist | ICT | ERROR | | error | v1 |
| BR30 | Facet category doesn't exist | ICT | ERROR | | error | v1 |
| BR31 | Descriptor isn't in the hierarchy of its facet category | ICT | ERROR | | error | v1 |

Rules of our own (labelled as ours in results, never as EFSA's):

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

## Gaps

- **BR25 and BR14 are not in the open-source code.** `TermRules.java` has no
  cardinality or duplicate check; they run in the ICT's Excel macros or on
  EFSA's servers. We know them from the rule sheet only. EFSA's BR25 note says
  it was "aligned with repeatable hierarchies on MTX 11.2", and its example is
  apple juice with two F01 sources (`A039M#F01.A05YH$F01.A05YG`), so BR25 follows
  the catalogue flag. Whether it honours the exceptions in the descriptions
  (F03 "with solid particles", F17 "burned spots") is unknown.
- **BR15 has no description at all**, and BR14 only an example.
- **BR16 has two definitions.** The 2020 rule sheet compares ordinal codes; the
  current code checks hierarchy ancestry, and EFSA's own example no longer fails
  under it. We follow the code (`conflicts.yaml`, `definition-BR16`).
- **Server-side checks.** The DCF column shows EFSA applies rules on submission,
  some with a different severity from the browser (BR16 is HIGH in the tools but
  LOW in the DCF). We can't see the DCF.
- **Data-collection rules.** [openefsa/business-rules-engine](https://github.com/openefsa/business-rules-engine)
  holds extra rules per data collection (chemical contaminants, pesticide
  residues, veterinary drug residues, zoonoses). They depend on the collection,
  so `validate` doesn't apply them and says so.
- **Version lag.** The rule sheet is from 2020 and `BR_Data.csv` from May 2020;
  the catalogue is MTX 17.1 (2026). All 30 food groups and 80 processes in
  `BR_Data.csv` still exist and are approved in 17.1; 8 process labels have been
  renamed since. Terms added after 2020 have no forbidden-process entries.
- **ICT user guide not consulted.** The PDF is behind a bot block. If you
  download it into the Atlas's `_private/references/efsa/`, check whether it adds
  anything beyond the rule sheet.
- **Not compared against EFSA's own checker.** Our rules are tested against
  every example in EFSA's rule sheet, but not run side by side with the ICT,
  which needs desktop Excel and the Catalogue Browser. A sample of 60 codes
  with our findings is ready in the Atlas's
  `_private/plans/ict-comparison-sample.json` if that becomes possible.
