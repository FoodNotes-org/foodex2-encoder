import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
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
    override: null,
    ...over,
  };
}

test("fixture loads", () => {
  const cases = loadBaseAttributeCases(join(import.meta.dirname, "..", "eval", "base-attributes.yaml"));
  assert.ok(cases.length > 40);
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
