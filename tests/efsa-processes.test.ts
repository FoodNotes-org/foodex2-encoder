import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import { catalogueLookup } from "../src/rules/catalogue-lookup.js";
import { REPORTING_HIERARCHY } from "../src/rules/check.js";
import {
  FACET_ONLY_ROWS,
  judgeTreatment,
  NEW_FOOD_TREATMENTS,
  TREATMENT_PRIORITY,
  treatmentPriority,
} from "../src/rules/processes.js";

const cat = Catalogue.load();
const lookup = catalogueLookup(cat);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5))
  );
}

test("every process code exists, is current and sits in the process hierarchy", () => {
  const codes = [
    ...NEW_FOOD_TREATMENTS.map((row) => row.code),
    ...FACET_ONLY_ROWS.flatMap((row) => row.codes),
    ...TREATMENT_PRIORITY.flatMap((row) => row.processes),
  ];
  for (const code of codes) {
    const term = lookup.term(code);
    assert.ok(term, `${code} missing`);
    assert.notEqual(term.status, "DEPRECATED", `${code} deprecated`);
    assert.ok(term.hierarchies.process, `${code} not a process`);
  }
});

test("every group a treatment applies to is in the reporting hierarchy", () => {
  for (const row of NEW_FOOD_TREATMENTS) {
    for (const group of [...row.validatorGroups, ...row.alsoGroups]) {
      assert.ok(lookup.term(group)?.hierarchies[REPORTING_HIERARCHY], `${row.code}: ${group}`);
    }
  }
});

test("each Tables 4/5 code names the process EFSA names", () => {
  for (const row of NEW_FOOD_TREATMENTS) {
    const name = lookup.term(row.code)!.name;
    const shared = [...words(row.process)].some((w) => words(name).has(w));
    assert.ok(shared, `${row.code}: EFSA "${row.process}", catalogue "${name}"`);
  }
});

test("the 7 treatments in both Tables 4/5 and 22 are all settled by the foods they apply to", () => {
  const table22 = new Set(FACET_ONLY_ROWS.flatMap((row) => row.codes));
  const overlap = NEW_FOOD_TREATMENTS.filter((row) => {
    const ancestors = lookup.term(row.code)!.hierarchies.process!.ancestors;
    return [row.code, ...ancestors].some((code) => table22.has(code));
  });
  assert.deepEqual(
    overlap.map((row) => row.code).sort(),
    ["A07GG", "A07GR", "A07GX", "A07GY", "A07HC", "A07HJ", "A0C6N"]
  );
  for (const row of overlap) {
    assert.ok(row.validatorGroups.length + row.alsoGroups.length > 0, `${row.code} has no foods`);
  }
});

const CASES: Array<[string, string, string, string]> = [
  // treatment, food, expected kind, what it shows
  ["A07GL", "A031G", "new_food", "boiled egg: cooking eggs makes a new food"],
  ["A07GL", "A00ZT", "facet", "boiled potato: boiling is a facet"],
  ["A07GL", "A02BV", "facet", "boiled cod"],
  ["A07GL", "A01RG", "facet", "boiled pork"],
  ["A07GR", "A00ZT", "new_food", "fried potato: fries"],
  ["A07GR", "A00JR", "facet", "fried courgette"],
  ["A07GT", "A01SP", "facet", "stir-fried chicken"],
  ["A07GS", "A024F", "facet", "pan-fried chorizo"],
  ["A07GM", "A04AC", "facet", "stewed pork mince"],
  ["A07KQ", "A02BV", "facet", "frozen cod"],
  ["A0BYP", "A02BV", "new_food", "canned cod"],
  ["A0BYP", "A03AM", "facet", "canned orange juice: canning applies to the fruit, not the juice"],
  ["A07JV", "A02BV", "new_food", "smoked cod"],
  ["A0C03", "A000R", "new_food", "quinoa flour"],
  ["A07HC", "A0D9J", "new_food", "toasted coffee beans"],
  ["A07LC", "A031G", "new_food", "egg out of its shell"],
  ["A07HP", "A014D", "facet", "chocolate-coated almonds: Table 22"],
  ["A0C0G", "A000R", "judge", "gelling: EFSA's words only"],
  ["A07LK", "A001D", "unlisted", "parboiled rice: in no table"],
];

for (const [treatment, food, kind, label] of CASES) {
  test(`judgeTreatment: ${label}`, () => {
    assert.equal(judgeTreatment(lookup, treatment, food).kind, kind);
  });
}

test("Table 6: canned outranks smoked, salted outranks dried; brining is 'in brine'", () => {
  const rank = (code: string) => treatmentPriority(lookup, code);
  assert.ok(rank("A0BYP")! < rank("A07JV")!);
  assert.ok(rank("A07JP")! < rank("A07KG")!);
  assert.equal(TREATMENT_PRIORITY[rank("A0F2N")!]!.group, "In vinegar or brine");
  assert.equal(rank("A16ET"), rank("A07JV"));
  assert.equal(rank("A07KQ"), null);
});
