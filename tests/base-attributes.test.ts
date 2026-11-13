import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  checkFacets,
  checkRun,
  loadBaseAttributeCases,
  type BaseAttributeCase,
  type BaseAttributeFacts,
} from "../src/eval/base-attributes.js";

const cat = Catalogue.load();

function kase(over: Partial<BaseAttributeCase>): BaseAttributeCase {
  return {
    id: "t",
    input: "t",
    country: "EU",
    source: "test",
    families: [],
    rules: [],
    base: ["A02BV"],
    forbidBase: [],
    newFood: [],
    facetOnly: [],
    misread: [],
    form: [],
    facets: null,
    open: false,
    ...over,
  };
}

function facts(over: Partial<BaseAttributeFacts>): BaseAttributeFacts {
  return {
    status: "ok",
    reason: null,
    pick: "A02BV",
    pickName: null,
    method: "traversal",
    route: "foodstuff",
    nature: [],
    stated: [],
    processGroup: null,
    compareAs: null,
    removed: [],
    facets: null,
    code: null,
    ...over,
  };
}

test("fixture loads", () => {
  const cases = loadBaseAttributeCases(join(import.meta.dirname, "..", "eval", "base-attributes.yaml"));
  assert.ok(cases.length > 40);
  assert.ok(cases.every((c) => c.facets !== null));
  assert.deepEqual(cases.find((c) => c.id === "cofid-duck-roasted")?.facets, [
    "F28.A07GY",
    "F20.A07QQ",
    "F20.A0F4T",
  ]);
  assert.deepEqual(cases.find((c) => c.id === "new-smoked-salmon")?.facets, []);
});

test("facets: a narrower process satisfies the expected one, an unrelated one is extra", () => {
  const check = checkFacets(cat, ["F28.A07GG"], ["F28.A07GL", "F20.A0F1S"]);
  assert.deepEqual(check.facetsMissing, []);
  assert.deepEqual(check.facetsExtra, ["F20.A0F1S"]);
  assert.equal(check.facetsPass, false);
});

test("facets: a broader process does not satisfy a narrower expected one", () => {
  const check = checkFacets(cat, ["F28.A07GL"], ["F28.A07GG"]);
  assert.deepEqual(check.facetsMissing, ["F28.A07GL"]);
  assert.deepEqual(check.facetsExtra, ["F28.A07GG"]);
});

test("facets: not scored for a base-only run or a case without facets", () => {
  assert.equal(checkFacets(cat, ["F28.A07GL"], null).facetsPass, null);
  assert.equal(checkFacets(cat, null, ["F28.A07GL"]).facetsPass, null);
  assert.equal(checkFacets(cat, [], []).facetsPass, true);
});

test("a broader treatment judged new food counts against a facet-only boiling", () => {
  const c = kase({ facetOnly: ["A07GL"] });
  const check = checkRun(cat, c, facts({ nature: ["A07GG"] }));
  assert.deepEqual(check.wronglyNewFood, ["A07GL"]);
  assert.equal(check.treatmentsPass, false);
});

test("a narrower treatment satisfies new food; any-of alternatives accepted", () => {
  const c = kase({ newFood: ["A07GG", "A07JQ|A07KG"] });
  const check = checkRun(cat, c, facts({ nature: ["A07GL", "A07KG"] }));
  assert.deepEqual(check.newFoodMissing, []);
  assert.equal(check.treatmentsPass, true);
});

test("form words must reach the classifier, in the food or as a treatment applied", () => {
  const c = kase({ form: ["frozen"] });
  assert.deepEqual(checkRun(cat, c, facts({ compareAs: "egg, whole" })).formLost, ["frozen"]);
  assert.deepEqual(checkRun(cat, c, facts({ compareAs: "egg, whole, frozen" })).formLost, []);
  assert.deepEqual(checkRun(cat, c, facts({ compareAs: "egg, whole", removed: ["frozen"] })).formLost, []);
});

test("forbidden base fails; identical wording leaves treatments unjudged", () => {
  const c = kase({ base: ["A00ZT"], forbidBase: ["A011P"] });
  const check = checkRun(cat, c, facts({ pick: "A011P", method: "lexical", route: null }));
  assert.equal(check.basePass, false);
  assert.equal(check.treatmentsPass, null);
});
