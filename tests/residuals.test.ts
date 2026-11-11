/**
 * Deterministic residuals helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  acceptF04Descriptor,
  alignsComponentToFoodTerm,
  asUnsorted,
  bareFortifiedFacet,
  buildClosedPickPool,
  cleanupFacets,
  derivativeFacetCombos,
  derivativeProcessPairs,
  dropIncludedDescriptors,
  facetCleanupDescriptors,
  parseFacetCombo,
  systemFacetCleanup,
  decideF26,
  facetDimensionCodeForTerm,
  facetDimensions,
  findDishSpan,
  headerForFacetDimension,
  isCategoryMember,
  memberTermTypes,
  originRolesForBaseType,
  settleOriginCandidates,
  matchOriginEntry,
  limitFacetSelection,
  parsePhrasePresence,
  sharedGroups,
  parseFortification,
  parseAttributeSlots,
  parseGapOmitted,
  parseGapProperties,
  systemAttributeSlots,
  phraseCoveredByFortification,
  dropFortificationRestatements,
  parseF26Relation,
  parseOriginRole,
  orAlternatives,
  rawNoHeatOnRawCommodity,
  recallIngredF04,
  siblingChildrenForF26,
  parseFoodName,
  genusScope,
  parseDifferentiae,
  parseOriginAnswer,
  parseRawCommodity,
  parseNaturalSource,
  originCoversPhrase,
  sourceReplacesCommodity,
  systemRawCommodity,
  systemNaturalSource,
  systemDifferentiae,
  wordsWithin,
  type FortificationClaim,
} from "../src/encode/residuals.js";
import type { FacetDescriptorRef } from "../src/encode/types.js";

const cat = Catalogue.load();

/** First lexically aligned, accepted descriptor on a closed facet (no model). */
function firstAligned(phrase: string, header: string, implied = new Set<string>()): string | null {
  const { alignedAccepted } = buildClosedPickPool(cat, phrase, header, implied, {
    allowRootFallback: false,
  });
  return alignedAccepted[0]?.code ?? null;
}

describe("findDishSpan", () => {
  it("grounds a contiguous dish name and preserves input casing", () => {
    const span = findDishSpan("Homemade Yakitori", "yakitori");
    assert.ok(span);
    assert.equal(span!.span, "Yakitori");
    assert.equal(span!.start, 9);
    assert.equal(span!.end, 17);
  });

  it("rejects ungrounded dish names", () => {
    assert.equal(findDishSpan("chicken skewers", "yakitori"), null);
  });
});

describe("acceptF04Descriptor", () => {
  it("refuses composite-on-composite when base is composite", () => {
    assert.equal(
      acceptF04Descriptor(cat, "A03VV", [], { baseCode: "A03VV", baseTermType: "c" }),
      "composite_on_composite"
    );
    assert.equal(
      acceptF04Descriptor(cat, "A03VY", [], { baseCode: "A03VV", baseTermType: "c" }),
      "composite_on_composite"
    );
  });

  it("keeps RPC meat under a composite base (specify-the-generic)", () => {
    assert.equal(
      acceptF04Descriptor(cat, "A01SP", ["A0EYH"], {
        baseCode: "A03VV",
        baseTermType: "c",
      }),
      "keep"
    );
  });

  it("drops broader-than-implicit and exact restate", () => {
    assert.equal(acceptF04Descriptor(cat, "A0EYH", ["A0EYH"]), "restate");
    assert.equal(acceptF04Descriptor(cat, "A0EYH", ["A01SP"]), "broader");
  });

  it("keeps a named child under an implied F04; drops a generic eggs restatement", () => {
    // Meat stew implies mammals meat (A0EYH); beef names Cow/ox/bull fresh meat.
    assert.equal(
      acceptF04Descriptor(cat, "A01QX", ["A0EYH"], {
        rejectUnderImplied: true,
        phrase: "beef",
      }),
      "keep"
    );
    // Omelette implies Whole eggs; "eggs" only restates that generic — not Hen eggs.
    assert.equal(
      acceptF04Descriptor(cat, "A031G", ["A031F"], {
        rejectUnderImplied: true,
        phrase: "eggs",
      }),
      "already_implied"
    );
    assert.equal(
      acceptF04Descriptor(cat, "A031G", ["A031F"], {
        rejectUnderImplied: true,
        phrase: "hen eggs",
      }),
      "keep"
    );
  });

  it("does not record a narrower kind of the base as an ingredient", () => {
    assert.equal(
      acceptF04Descriptor(cat, "A045L", [], { baseCode: "A045K" }),
      "kind_of_base"
    );
    // Onion bulbs for fresh consumption sits under Onions.
    assert.equal(
      acceptF04Descriptor(cat, "A0DND", [], {
        baseCode: "A00HC",
        rejectUnderImplied: true,
        phrase: "red onions",
      }),
      "kind_of_base"
    );
  });

  it("treats the base's implied source commodity as already stated", () => {
    // Juice, grapefruit implies source Grapefruits.
    assert.equal(acceptF04Descriptor(cat, "A01CY", [], { baseCode: "A03AL" }), "restate");
  });
});

describe("recallIngredF04 rejectUnderImplied", () => {
  it("keeps beef under meat-stew implicit; drops hen eggs for bare eggs", () => {
    const meatImplied = ["A0EYH"];
    const beefHits = recallIngredF04(cat, "beef", meatImplied, {
      baseCode: "A03VY",
      baseTermType: "c",
      rejectUnderImplied: true,
      phrase: "beef",
    });
    assert.ok(
      beefHits.some((h) => h.code === "A01QX"),
      `expected Cow/ox/bull fresh meat; got ${beefHits.map((h) => h.name).join(", ")}`
    );

    const eggImplied = ["A031F", "A07XJ"];
    const eggHits = recallIngredF04(cat, "beaten eggs", eggImplied, {
      baseCode: "A03YQ",
      baseTermType: "c",
      rejectUnderImplied: true,
      phrase: "beaten eggs",
    });
    assert.ok(
      !eggHits.some((h) => h.code === "A031G"),
      `bare/beaten eggs must not keep Hen eggs; got ${eggHits.map((h) => h.name).join(", ")}`
    );
  });
});

describe("alignsComponentToFoodTerm", () => {
  it("matches chicken to Chicken fresh meat", () => {
    assert.equal(alignsComponentToFoodTerm("chicken", "A01SP", "Chicken fresh meat"), true);
  });

  it("matches strawberries to Strawberries", () => {
    assert.equal(alignsComponentToFoodTerm("strawberries", "A01EA", "Strawberries"), true);
  });

  it("does not strip process or link words for alignment", () => {
    assert.equal(
      alignsComponentToFoodTerm("grilled chicken", "A01SP", "Chicken fresh meat"),
      false
    );
    assert.equal(alignsComponentToFoodTerm("with strawberries", "A01EA", "Strawberries"), false);
    assert.equal(alignsComponentToFoodTerm("grilled", "A01SP", "Chicken fresh meat"), false);
  });
});

describe("recallIngredF04", () => {
  it("recalls chocolate-named ingredient terms (model picks later)", () => {
    const hits = recallIngredF04(cat, "chocolate", []);
    assert.ok(hits.length > 0);
    assert.ok(
      hits.some((h) => /chocol/i.test(h.name)),
      `expected a chocolate-named term in ${hits.map((h) => h.name).join(", ")}`
    );
  });

  it("recalls cocoa food terms for cocoa", () => {
    const hits = recallIngredF04(cat, "cocoa", []);
    assert.ok(
      hits.some((h) => h.code === "A03HG" || h.code === "A0C6B"),
      `expected Cocoa powder or Cocoa ingredients in ${hits.map((h) => `${h.code}:${h.name}`).join(", ")}`
    );
  });

  it("recalls sour-cherry cultivars for amarena cherries via head token", () => {
    const hits = recallIngredF04(cat, "amarena cherries", []);
    assert.ok(
      hits.some((h) => h.code === "A0DVS"),
      `expected Sour cherries light red in ${hits.map((h) => `${h.code}:${h.name}`).join(", ")}`
    );
  });
});

describe("recallIngredF04 top hit", () => {
  it("walks chicken to Chicken fresh meat", () => {
    const top = recallIngredF04(cat, "chicken", ["A0EYH"], {
      baseCode: "A03VV",
      baseTermType: "c",
    })[0];
    assert.equal(top?.code, "A01SP");
  });

  it("ranks strawberries on Strawberries", () => {
    assert.equal(recallIngredF04(cat, "strawberries")[0]?.code, "A01EA");
  });

  it("ranks vegetable oil on Vegetable fats and oils, not oil sauces", () => {
    assert.equal(recallIngredF04(cat, "vegetable oil")[0]?.code, "A036N");
  });

  it("ranks butter on Butter, not Butter nut", () => {
    assert.equal(recallIngredF04(cat, "butter")[0]?.code, "A039C");
  });

  it("finds vegetable oil inside a choice with butter", () => {
    const hits = recallIngredF04(cat, "stir-fried in vegetable oil or butter");
    assert.ok(hits.some((hit) => hit.code === "A036N"));
    assert.ok(hits.some((hit) => hit.code === "A039C"));
  });
});

describe("rawNoHeatOnRawCommodity", () => {
  it("refuses Raw, no heat treatment on a raw primary commodity", () => {
    assert.equal(
      rawNoHeatOnRawCommodity("r", { header: "F28", code: "A07HS" }),
      true
    );
  });

  it("keeps that process on a derivative, and keeps any other process on a raw commodity", () => {
    assert.equal(
      rawNoHeatOnRawCommodity("d", { header: "F28", code: "A07HS" }),
      false
    );
    assert.equal(
      rawNoHeatOnRawCommodity("r", { header: "F28", code: "A07GT" }),
      false
    );
  });
});

describe("orAlternatives", () => {
  it("takes the foods on either side of or", () => {
    assert.deepEqual(orAlternatives("stir-fried in vegetable oil or butter"), [
      "vegetable oil",
      "butter",
    ]);
    assert.equal(orAlternatives("from goat, sheep and camel"), null);
  });
});

describe("parseGapProperties", () => {
  it("reads kind-tagged objects", () => {
    assert.deepEqual(
      parseGapProperties({
        properties: [
          { phrase: "chocolate flavour", kind: "ingredient" },
          { phrase: "dried", kind: "process" },
        ],
      }),
      [
        { phrase: "chocolate flavour", kind: "ingredient" },
        { phrase: "dried", kind: "process" },
      ]
    );
  });

  it("reads relation kinds with a lookup name, omitting a name equal to the phrase", () => {
    assert.deepEqual(
      parseGapProperties({
        properties: [
          { phrase: "salted", kind: "added", name: "salt" },
          { phrase: "chocolate-coated", kind: "process", name: "chocolate coating" },
          { phrase: "smoking", kind: "process", name: "smoking" },
          { phrase: "citrus peel", kind: "made_from" },
        ],
      }),
      [
        { phrase: "salted", kind: "added", name: "salt" },
        { phrase: "chocolate-coated", kind: "process", name: "chocolate coating" },
        { phrase: "smoking", kind: "process" },
        { phrase: "citrus peel", kind: "made_from" },
      ]
    );
  });

  it("falls back bare strings and unknown kinds to other", () => {
    assert.deepEqual(parseGapProperties({ properties: ["cocoa", { phrase: "x", kind: "weird" }] }), [
      { phrase: "cocoa", kind: "other" },
      { phrase: "x", kind: "other" },
    ]);
  });
});

describe("parseAttributeSlots", () => {
  it("keeps each attribute phrase and the omissions", () => {
    assert.deepEqual(
      parseAttributeSlots({
        attributes: [{ phrase: "fried in oil" }, { phrase: "fried in oil" }, "frozen"],
        omitted: [{ phrase: "potatoes", reason: "the food itself" }],
      }),
      {
        attributes: ["fried in oil", "frozen"],
        omitted: [{ phrase: "potatoes", reason: "the food itself" }],
      }
    );
  });

  it("states that a qualification stays inside its attribute", () => {
    const prompt = systemAttributeSlots(false);
    assert.match(prompt, /A detail that qualifies an attribute is part of that attribute/);
    assert.match(prompt, /fried in oil/);
  });
});

describe("asUnsorted", () => {
  it("leaves category members for free text and sends the rest to the facet picker", () => {
    assert.deepEqual(
      asUnsorted([
        { phrase: "in sunflower oil", kind: "other", name: "sunflower oil" },
        { phrase: "lentils", kind: "member" },
      ]),
      [
        { phrase: "in sunflower oil", kind: "unsorted", name: "sunflower oil" },
        { phrase: "lentils", kind: "member" },
      ]
    );
  });
});

describe("parseGapOmitted", () => {
  it("reads phrase+reason and bare strings", () => {
    assert.deepEqual(
      parseGapOmitted({
        omitted: [
          { phrase: "mixed", reason: "implied by listing the nuts" },
          "assortment",
          { phrase: "  ", reason: "empty" },
          { phrase: "plain", reason: "  " },
        ],
      }),
      [
        { phrase: "mixed", reason: "implied by listing the nuts" },
        { phrase: "assortment", reason: null },
        { phrase: "plain", reason: null },
      ]
    );
  });

  it("returns empty when absent", () => {
    assert.deepEqual(parseGapOmitted({ properties: [] }), []);
    assert.deepEqual(parseGapOmitted(null), []);
  });
});

describe("parseFortification", () => {
  it("reads null as none", () => {
    assert.deepEqual(parseFortification({ fortification: null }), { status: "none" });
    assert.deepEqual(parseFortification({}), { status: "none" });
    assert.deepEqual(parseFortification(null), { status: "none" });
  });

  it("reads bare", () => {
    assert.deepEqual(parseFortification({ fortification: "bare" }), { status: "bare" });
  });

  it("reads agent list and dedupes", () => {
    assert.deepEqual(
      parseFortification({ fortification: { agents: ["calcium", " Calcium", "vitamin D", ""] } }),
      { status: "agents", agents: ["calcium", "vitamin D"] }
    );
  });

  it("treats an empty agent list as bare", () => {
    assert.deepEqual(parseFortification({ fortification: { agents: [] } }), { status: "bare" });
  });
});

describe("wordsWithin", () => {
  it("matches a food named inside a role phrase", () => {
    assert.equal(wordsWithin("brine", "in brine"), true);
    assert.equal(wordsWithin("Sunflower oil", "in sunflower oil"), true);
    assert.equal(wordsWithin("olives", "in olive oil"), true);
  });

  it("needs every content word", () => {
    assert.equal(wordsWithin("olive oil", "in sunflower oil"), false);
    assert.equal(wordsWithin("water buffalo milk", "buffalo"), false);
    assert.equal(wordsWithin("buffalo", "water buffalo milk"), true);
  });

  it("ignores function words and empty input", () => {
    assert.equal(wordsWithin("in", "in brine"), false);
    assert.equal(wordsWithin("", "in brine"), false);
  });
});

describe("derivative commodity question", () => {
  it("reads a commodity or a natural source, and nothing else", () => {
    assert.equal(parseRawCommodity({ commodity: " kangaroo meat " }), "kangaroo meat");
    assert.equal(parseRawCommodity({ commodity: null }), null);
    assert.equal(parseRawCommodity({ commodity: "" }), null);
    assert.equal(parseRawCommodity({ source: "kangaroo" }), null);
    assert.equal(parseNaturalSource({ source: "pelican" }), "pelican");
    assert.equal(parseNaturalSource(null), null);
  });

  it("treats a later word as the commodity already placed", () => {
    assert.equal(originCoversPhrase("kangaroo", ["kangaroo meat"]), true);
    assert.equal(originCoversPhrase("dried", ["kangaroo meat"]), false);
    assert.equal(originCoversPhrase("kangaroo", []), false);
  });

  it("replaces a weaker commodity with a core or extended source", () => {
    assert.equal(sourceReplacesCommodity(["P"], ["E"]), true);
    assert.equal(sourceReplacesCommodity(["M"], ["E"]), true);
    assert.equal(sourceReplacesCommodity(["H"], ["C"]), true);
    assert.equal(sourceReplacesCommodity(["C"], ["E"]), false);
    assert.equal(sourceReplacesCommodity(["E"], ["E"]), false);
    assert.equal(sourceReplacesCommodity(["P", "C"], ["E"]), false);
    assert.equal(sourceReplacesCommodity(["P"], ["H"]), false);
    assert.equal(sourceReplacesCommodity(["P"], []), false);
    assert.equal(sourceReplacesCommodity([], ["E"]), false);
  });

  it("asks for a raw commodity, and for a natural source only as its own question", () => {
    const commodity = systemRawCommodity(true);
    const source = systemNaturalSource(false);
    assert.match(commodity, /raw commodity this food is made from/);
    assert.match(commodity, /\{"commodity":"<phrase>"\|null\}/);
    assert.match(source, /natural source this food comes from/);
    assert.doesNotMatch(source, /raw commodity/);
    assert.doesNotMatch(commodity, /fresh denotes/);
  });
});

describe("parseFoodName", () => {
  it("keeps a name found in the description", () => {
    assert.equal(parseFoodName({ name: "breakfast cereal" }, "fortified breakfast cereal"), "breakfast cereal");
    assert.equal(parseFoodName({ name: " Tuna " }, "tuna in brine, canned"), "Tuna");
  });

  it("rejects a name not in the description, empty or malformed", () => {
    assert.equal(parseFoodName({ name: "cereal flakes" }, "fortified breakfast cereal"), null);
    assert.equal(parseFoodName({ name: "" }, "tuna"), null);
    assert.equal(parseFoodName({ name: 3 }, "tuna"), null);
    assert.equal(parseFoodName(null, "tuna"), null);
  });
});

describe("parseDifferentiae", () => {
  it("reads trimmed phrases and drops anything else", () => {
    assert.deepEqual(parseDifferentiae({ differentiae: [" Sweet ", "", 3, "Raw"] }), ["Sweet", "Raw"]);
    assert.deepEqual(parseDifferentiae({ differentiae: "Sweet" }), []);
    assert.deepEqual(parseDifferentiae(null), []);
  });
});

describe("genusScope", () => {
  it("stops before the repeated part-consumed instruction", () => {
    assert.equal(
      genusScope(
        "The group includes lemonade. The part consumed/analysed is by default the whole marketed unit."
      ),
      "The group includes lemonade."
    );
    assert.equal(genusScope("The group includes soy sauce."), "The group includes soy sauce.");
    assert.equal(genusScope(undefined), "");
  });
});

describe("systemDifferentiae", () => {
  it("names the country with the description when a country is given", () => {
    const prompt = systemDifferentiae(true);
    assert.match(prompt, /food nomenclature of: `country`/);
    assert.match(prompt, /"the group" is this genus/);
    assert.match(prompt, /"Any type of" this genus does not name a particular kind/);
    assert.match(prompt, /\{"differentiae":\["<phrase>"\]\}/);
  });

  it("omits the country when none is given", () => {
    const prompt = systemDifferentiae(false);
    assert.equal(prompt.includes("`country`"), false);
  });
});

describe("parseOriginAnswer", () => {
  it("reads the definition and trimmed from entries", () => {
    assert.deepEqual(
      parseOriginAnswer({ definition: " Mozzarella made from water buffalo milk ", from: [" water buffalo milk "] }),
      { definition: "Mozzarella made from water buffalo milk", from: ["water buffalo milk"] }
    );
    assert.deepEqual(parseOriginAnswer({ from: ["flour", "eggs"] }), { definition: null, from: ["flour", "eggs"] });
  });

  it("drops empty and non-string entries; malformed answers give nothing", () => {
    assert.deepEqual(parseOriginAnswer({ definition: "", from: ["", 3, "milk"] }), { definition: null, from: ["milk"] });
    assert.deepEqual(parseOriginAnswer({ from: "milk" }), { definition: null, from: [] });
    assert.deepEqual(parseOriginAnswer(null), { definition: null, from: [] });
  });
});

describe("phraseCoveredByFortification", () => {
  const calcium: FortificationClaim = { status: "agents", agents: ["calcium"] };

  it("drops phrases that restate a named agent", () => {
    assert.equal(phraseCoveredByFortification("fortified with calcium", calcium), true);
    assert.equal(phraseCoveredByFortification("calcium-fortified", calcium), true);
    assert.equal(phraseCoveredByFortification("calcium", calcium), true);
  });

  it("drops generic fortification wording once a claim is placed", () => {
    assert.equal(phraseCoveredByFortification("fortified", calcium), true);
    assert.equal(phraseCoveredByFortification("enriched", { status: "bare" }), true);
  });

  it("keeps unrelated leftovers", () => {
    assert.equal(phraseCoveredByFortification("sugar free", calcium), false);
    assert.equal(phraseCoveredByFortification("organic", calcium), false);
    assert.equal(phraseCoveredByFortification("calcium", { status: "none" }), false);
  });

  it("splits a property list", () => {
    const { kept, dropped } = dropFortificationRestatements(
      [
        { phrase: "fortified with calcium", kind: "ingredient" },
        { phrase: "sugar free", kind: "other" },
      ],
      calcium
    );
    assert.deepEqual(
      kept.map((p) => p.phrase),
      ["sugar free"]
    );
    assert.deepEqual(
      dropped.map((p) => p.phrase),
      ["fortified with calcium"]
    );
  });
});

describe("fortification placement helpers", () => {
  it("maps a bare claim to F10 Fortified", () => {
    const facet = bareFortifiedFacet(cat, new Set());
    assert.equal(facet?.header, "F10");
    assert.equal(facet?.code, "A0F6C");
  });

  it("drops F10 Fortified when already implied", () => {
    assert.equal(bareFortifiedFacet(cat, new Set(["F10.A0F6C"])), null);
  });

  it("aligns calcium on F09 to Calcium", () => {
    const { alignedAccepted } = buildClosedPickPool(cat, "calcium", "F09", new Set());
    assert.equal(alignedAccepted[0]?.code, "A0EXH");
  });
});

describe("parseOriginRole / F01 / F27 lexical alignment", () => {
  it("parses origin roles", () => {
    assert.equal(parseOriginRole({ role: "organism" }), "organism");
    assert.equal(parseOriginRole({ role: "made_from" }), "made_from");
    assert.equal(parseOriginRole({ role: "contains" }), "contains");
    assert.equal(parseOriginRole({ role: "F01" }), null);
    assert.equal(parseOriginRole({ role: null }), null);
    assert.equal(parseOriginRole(null), null);
  });

  it("base term type fixes the origin facet, F04 as fallback (Table 8, §3.1.9)", () => {
    // Derivative (mixed juice): try F27 first, then F04 for a minor add-on.
    assert.deepEqual(originRolesForBaseType("d"), ["made_from", "contains"]);
    // Raw commodity: F01 first, then F04.
    assert.deepEqual(originRolesForBaseType("r"), ["organism", "contains"]);
    // Composite: ingredients only.
    assert.deepEqual(originRolesForBaseType("s"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("c"), ["contains"]);
    // Broad / natural source / unknown: type does not settle it → ask the model.
    assert.equal(originRolesForBaseType("g"), null);
    assert.equal(originRolesForBaseType("n"), null);
    assert.equal(originRolesForBaseType(null), null);
  });

  it("same-nature mix overrides RPC/derivative to F27 then F04 (§3.1.10)", () => {
    assert.deepEqual(originRolesForBaseType("r", "mix"), ["made_from", "contains"]);
    assert.deepEqual(originRolesForBaseType("d", "mix"), ["made_from", "contains"]);
    // Composite mixes stay on F04; dish / foodstuff do not change Table 8.
    assert.deepEqual(originRolesForBaseType("c", "mix"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("r", "foodstuff"), ["organism", "contains"]);
    assert.deepEqual(originRolesForBaseType("r", "dish"), ["organism", "contains"]);
  });

  it("a source property gets no F04 fallback on a raw commodity or derivative (§5.14.9)", () => {
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "source"), ["organism"]);
    assert.deepEqual(originRolesForBaseType("d", "foodstuff", "source"), ["made_from"]);
    assert.deepEqual(originRolesForBaseType("r", "mix", "source"), ["made_from"]);
    assert.deepEqual(originRolesForBaseType("d", "mix", "source"), ["made_from"]);
  });

  it("an ingredient property keeps F04 as the minor-ingredient fallback (§3.1.9)", () => {
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "ingredient"), [
      "organism",
      "contains",
    ]);
    assert.deepEqual(originRolesForBaseType("r", "mix", "ingredient"), ["made_from", "contains"]);
  });

  it("keeps every true term, and only the first from a single facet", () => {
    const skin = { header: "F20", code: "A07QR", name: "W/o skin" };
    const bone = { header: "F20", code: "A07QM", name: "W/o bone" };
    const peppers = { header: "F04", code: "A00JA", name: "Sweet peppers" };
    const frying = { header: "F28", code: "A07GT", name: "Stir frying" };
    const source = { header: "F01", code: "A08HL", name: "Thicklip grey mullet (as animal)" };
    const otherSource = { header: "F01", code: "A08HT", name: "Golden grey mullet (as animal)" };
    assert.deepEqual(
      limitFacetSelection(["F28.A07GT", "F04.A00JA"], [frying, peppers]),
      [frying, peppers]
    );
    assert.deepEqual(limitFacetSelection(["F20.A07QR", "F20.A07QM"], [skin, bone]), [skin, bone]);
    assert.deepEqual(
      limitFacetSelection(["F01.A08HL", "F01.A08HT"], [source, otherSource]),
      [source]
    );
    assert.deepEqual(limitFacetSelection([], [skin]), []);
  });

  it("joins a name's origin to the attribute with the same words", () => {
    assert.deepEqual(
      matchOriginEntry("Eutropiichthys vacha", [{ phrase: "raw", roleClaim: false }]),
      { match: "alone" }
    );
    assert.deepEqual(
      matchOriginEntry("whole milk", [
        { phrase: "whole milk", roleClaim: false },
        { phrase: "fruit", roleClaim: false },
      ]),
      { match: "slot", phrase: "whole milk" }
    );
    assert.deepEqual(
      matchOriginEntry("sunflower oil", [{ phrase: "in sunflower oil", roleClaim: true }]),
      { match: "role", phrase: "in sunflower oil" }
    );
  });

  it("keeps the type's origin when the same class is also found as an ingredient", () => {
    const wholeMilk = { header: "F27", code: "A02LY", name: "Cow milk, whole" };
    const asIngredient = { header: "F04", code: "A02LY", name: "Cow milk, whole" };
    const fruit = { header: "F04", code: "A04RK", name: "Fruit used as fruit" };
    assert.deepEqual(settleOriginCandidates([wholeMilk], [asIngredient]), [wholeMilk]);
    assert.deepEqual(settleOriginCandidates([], [fruit]), [fruit]);
    assert.deepEqual(settleOriginCandidates([wholeMilk], [fruit]), [wholeMilk, fruit]);
  });

  it("a made_from property gets the prescribed origin only, like source", () => {
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "made_from"), ["organism"]);
    assert.deepEqual(originRolesForBaseType("d", "foodstuff", "made_from"), ["made_from"]);
    assert.deepEqual(originRolesForBaseType("c", "dish", "made_from"), ["contains"]);
  });

  it("an added property is an ingredient, never the food's origin (§3.1.9, §5.13)", () => {
    // Herbs in butter, salt on peanuts: not F27 / F01.
    assert.deepEqual(originRolesForBaseType("d", "foodstuff", "added"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "added"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("g", "foodstuff", "added"), ["contains"]);
  });

  it("in a same-nature mix, an added component tries F27 before F04 (§3.1.10)", () => {
    // Almonds in mixed nuts; salt has no F27 descriptor, so it still lands on F04.
    assert.deepEqual(originRolesForBaseType("r", "mix", "added"), ["made_from", "contains"]);
    assert.deepEqual(originRolesForBaseType("d", "mix", "added"), ["made_from", "contains"]);
  });

  it("composites keep F04 as the prescribed origin, whatever the property kind", () => {
    assert.deepEqual(originRolesForBaseType("c", "dish", "source"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("s", "foodstuff", "source"), ["contains"]);
    assert.equal(originRolesForBaseType("g", "foodstuff", "source"), null);
  });

  it("mix component phrases resolve as F27 commodities", () => {
    assert.equal(firstAligned("almonds", "F27"), "A014D");
    assert.equal(firstAligned("walnuts", "F27"), "A014R");
    // Bare "cashews" aligns to Cashew apples (A01JE); the nut term needs the headword.
    assert.equal(firstAligned("cashew nuts", "F27"), "A014H");
  });

  it("derivative sources resolve mechanically in F27", () => {
    assert.equal(firstAligned("cucumber", "F27"), "A00JM");
    assert.equal(firstAligned("lemon", "F27"), "A01BY");
  });

  it("catalogue types the juice shelves as expected", () => {
    assert.equal(cat.term("A03DB")?.termType, "d"); // Mixed fruit and vegetable juices
    assert.equal(cat.term("A03DE")?.termType, "s"); // Mixed juices with added ingredients
    assert.equal(cat.term("A03CQ")?.termType, "d"); // Juice, cucumber
  });

  it("places camel as F01 Camel (as animal)", () => {
    assert.equal(firstAligned("camel", "F01"), "A057L");
  });

  it("does not place a process word as F01", () => {
    assert.equal(firstAligned("canned", "F01"), null);
  });

  it("places buffalo under mozzarella as F27 Water buffalo milk", () => {
    const implied = new Set(cat.impliedFacets("A02QJ"));
    assert.equal(firstAligned("buffalo", "F27", implied), "A02MD");
  });

  it("does not place butter as F27 Butter nut or Butter beans", () => {
    assert.equal(firstAligned("butter", "F27"), null);
  });

  it("offers unaligned F27 hits to the model without treating them as aligned", () => {
    const { alignedAccepted, pool } = buildClosedPickPool(cat, "butter", "F27", new Set(), {
      allowRootFallback: false,
    });
    assert.equal(alignedAccepted.length, 0);
    assert.ok(pool.length > 0);
    assert.ok(pool.some((hit) => hit.name.toLowerCase().includes("butter")));
  });
});

describe("sharedGroups / parsePhrasePresence", () => {
  it("reads each or one, and nothing else", () => {
    assert.equal(parsePhrasePresence({ presence: "each" }), "each");
    assert.equal(parsePhrasePresence({ presence: "one" }), "one");
    assert.equal(parsePhrasePresence({ presence: "both" }), null);
    assert.equal(parsePhrasePresence(null), null);
  });

  it("offers the nearest group that contains every named food", () => {
    assert.equal(sharedGroups(cat, "F04", ["A036N", "A039C"])[0]?.code, "A036M");
    assert.equal(sharedGroups(cat, "F27", ["A02MB", "A02MC", "A02ME"])[0]?.code, "A02LT");
    assert.equal(sharedGroups(cat, "F27", ["A02MC", "A0CVV"])[0]?.code, "A02HH");
    assert.deepEqual(sharedGroups(cat, "F27", ["A02MB"]), []);
  });
});

describe("cleanupFacets", () => {
  it("drops a facet that restates an implicit", () => {
    const implied = new Set(cat.impliedFacets("A02QJ"));
    const milk: FacetDescriptorRef = {
      header: "F27",
      code: "A02LT",
      name: "Milk",
    };
    const { facets, dropped } = cleanupFacets(cat, [milk], implied);
    assert.equal(facets.length, 0);
    assert.equal(dropped[0]?.reason, "restate");
  });

  it("keeps specify-the-generic F27 under implied milk", () => {
    const implied = new Set(cat.impliedFacets("A02QJ"));
    const buffalo: FacetDescriptorRef = {
      header: "F27",
      code: "A02MD",
      name: "Water buffalo milk",
    };
    const { facets, dropped } = cleanupFacets(cat, [buffalo], implied);
    assert.equal(dropped.length, 0);
    assert.equal(facets[0]?.code, "A02MD");
  });

  it("drops a broader F04 when a narrower F04 is also present", () => {
    const broad: FacetDescriptorRef = {
      header: "F04",
      code: "A0EYH",
      name: "Mammals and birds meat",
    };
    const narrow: FacetDescriptorRef = {
      header: "F04",
      code: "A01SP",
      name: "Chicken fresh meat",
    };
    const { facets, dropped } = cleanupFacets(cat, [broad, narrow], new Set());
    assert.equal(facets.length, 1);
    assert.equal(facets[0]?.code, "A01SP");
    assert.equal(dropped[0]?.reason, "broader_than_added");
  });

  it("keeps the deeper F01 when single-cardinality has two sources", () => {
    const family: FacetDescriptorRef = {
      header: "F01",
      code: "A0F2A",
      name: "Camelidae (camelids) (as animal)",
    };
    const camel: FacetDescriptorRef = {
      header: "F01",
      code: "A057L",
      name: "Camel (as animal)",
    };
    const { facets, dropped } = cleanupFacets(cat, [family, camel], new Set());
    assert.equal(facets.length, 1);
    assert.equal(facets[0]?.code, "A057L");
    assert.ok(dropped.some((d) => d.reason === "broader_than_added" || d.reason === "cardinality_single"));
  });

  it("drops ingredient calcium and Fortified when the agent is recorded", () => {
    const { facets, dropped } = cleanupFacets(
      cat,
      [
        { header: "F04", code: "A0EXH", name: "Calcium" },
        { header: "F04", code: "A01SP", name: "Chicken fresh meat" },
        { header: "F09", code: "A0EXH", name: "Calcium" },
        { header: "F10", code: "A077L", name: "Sugar free" },
        { header: "F10", code: "A0F6C", name: "Fortified" },
        { header: "F10", code: "A0CRG", name: "Light" },
        { header: "F21", code: "A07SE", name: "Organic production" },
      ],
      new Set()
    );
    assert.deepEqual(
      facets.map((facet) => `${facet.header}.${facet.code}`).sort(),
      ["F04.A01SP", "F09.A0EXH", "F10.A077L", "F10.A0CRG", "F21.A07SE"].sort()
    );
    assert.deepEqual(
      dropped.map((drop) => [drop.reason, `${drop.facet.header}.${drop.facet.code}`]).sort(),
      [
        ["fortified_when_agent_named", "F10.A0F6C"],
        ["same_as_fortification_agent", "F04.A0EXH"],
      ].sort()
    );
  });

  it("keeps a different ingredient beside the named agent", () => {
    const { facets, dropped } = cleanupFacets(
      cat,
      [
        { header: "F04", code: "A0EVF", name: "Chemical elements" },
        { header: "F09", code: "A0EXH", name: "Calcium" },
      ],
      new Set()
    );
    assert.equal(dropped.length, 0);
    assert.deepEqual(
      facets.map((facet) => `${facet.header}.${facet.code}`).sort(),
      ["F04.A0EVF", "F09.A0EXH"]
    );
  });

  it("keeps ingredient calcium and a bare Fortified when no agent is recorded", () => {
    const ingredient = cleanupFacets(
      cat,
      [{ header: "F04", code: "A0EXH", name: "Calcium" }],
      new Set()
    );
    assert.equal(ingredient.dropped.length, 0);
    assert.equal(ingredient.facets[0]?.code, "A0EXH");

    const fortified = cleanupFacets(
      cat,
      [{ header: "F10", code: "A0F6C", name: "Fortified" }],
      new Set()
    );
    assert.equal(fortified.dropped.length, 0);
    assert.equal(fortified.facets[0]?.code, "A0F6C");

    const both = cleanupFacets(
      cat,
      [
        { header: "F04", code: "A0EXH", name: "Calcium" },
        { header: "F10", code: "A0F6C", name: "Fortified" },
      ],
      new Set()
    );
    assert.equal(both.dropped.length, 0);
    assert.deepEqual(
      both.facets.map((facet) => `${facet.header}.${facet.code}`).sort(),
      ["F04.A0EXH", "F10.A0F6C"]
    );
  });
});

describe("facet cleanup economizing", () => {
  const nectar: FacetDescriptorRef[] = [
    { header: "F04", code: "A0EXH", name: "Calcium" },
    { header: "F09", code: "A0EXH", name: "Calcium" },
    { header: "F10", code: "A077L", name: "Sugar free" },
    { header: "F10", code: "A0F6C", name: "Fortified" },
    { header: "F21", code: "A07SE", name: "Organic production" },
    { header: "F26", code: "A07XE", name: "Other" },
  ];

  it("holds generic-term out and names the parent under the recorded facet", () => {
    const descriptors = facetCleanupDescriptors(cat, nectar);
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.code),
      ["F04.A0EXH", "F09.A0EXH", "F10.A077L", "F10.A0F6C", "F21.A07SE"]
    );
    const agent = descriptors.find((descriptor) => descriptor.code === "F09.A0EXH");
    assert.equal(agent?.facet.name, "Fortification-agent");
    assert.equal(agent?.parent?.name, "Chemical elements");
    assert.equal(
      descriptors.find((descriptor) => descriptor.code === "F10.A0F6C")?.parent?.name,
      "Fortification-related info"
    );
    assert.equal(descriptors.find((descriptor) => descriptor.code === "F21.A07SE")?.parent, undefined);
  });

  it("pairs a derivative with the narrower process the catalogue assigns to it", () => {
    const pairs = derivativeProcessPairs(cat, [
      { header: "F04", code: "A01PS", name: "Candied fruits" },
      { header: "F04", code: "A01QE", name: "Citrus fruit peel" },
      { header: "F28", code: "A07JR", name: "Candying" },
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.derivative.code, "F04.A01PS");
    assert.deepEqual(
      pairs[0]?.processes.map((process) => process.code),
      ["F28.A07JR"]
    );
    assert.ok(pairs[0]?.derivative.builtFrom.some((facet) => facet.code === "F28.A07JQ"));
  });

  it("pairs the implicit process itself", () => {
    const pairs = derivativeProcessPairs(cat, [
      { header: "F04", code: "A01PS", name: "Candied fruits" },
      { header: "F28", code: "A07JQ", name: "Preserving with sugars" },
    ]);
    assert.deepEqual(
      pairs[0]?.processes.map((process) => process.code),
      ["F28.A07JQ"]
    );
  });

  it("does not pair a raw commodity, or a process the derivative does not carry", () => {
    const peel = derivativeProcessPairs(cat, [
      { header: "F04", code: "A01QE", name: "Citrus fruit peel" },
      { header: "F28", code: "A07JR", name: "Candying" },
    ]);
    assert.equal(peel.length, 0);
    const smoked = derivativeProcessPairs(cat, [
      { header: "F04", code: "A01PS", name: "Candied fruits" },
      { header: "F28", code: "A07JV", name: "Smoking" },
    ]);
    assert.equal(smoked.length, 0);
  });

  it("keeps the peel on every line and recombines the derivative with the process", () => {
    const combos = derivativeFacetCombos(
      "Chocolate coated confectionery",
      [
        { key: "F04.A01QE", header: "F04", name: "Citrus fruit peel", role: "ingredient" },
        { key: "F04.A01PS", header: "F04", name: "Candied fruits", role: "ingredient" },
        { key: "F28.A07JR", header: "F28", name: "Candying", role: "process" },
      ],
      ["F04.A01PS", "F28.A07JR"]
    );
    assert.equal(combos.length, 4);
    assert.ok(combos.every((combo) => combo.text.includes("ingredient = Citrus fruit peel")));
    const chosen = combos.find((combo) => combo.varying.join("+") === "F28.A07JR");
    assert.equal(
      chosen?.text,
      [
        "Chocolate coated confectionery",
        "ingredient = Citrus fruit peel",
        "process = Candying",
      ].join("\n")
    );
  });

  it("drops only offered descriptors, and never generic-term", () => {
    const { facets, dropped } = dropIncludedDescriptors(nectar, [
      "F04.A0EXH",
      "F10.A0F6C",
      "F26.A07XE",
      "F09.A0EXH extra",
    ]);
    assert.deepEqual(
      facets.map((facet) => `${facet.header}.${facet.code}`),
      ["F09.A0EXH", "F10.A077L", "F21.A07SE", "F26.A07XE"]
    );
    assert.deepEqual(
      dropped.map((facet) => `${facet.header}.${facet.code}`),
      ["F04.A0EXH", "F10.A0F6C"]
    );
  });

  it("reads the id of the chosen description and nothing else", () => {
    assert.equal(parseFacetCombo({ id: " 3 " }), "3");
    assert.equal(parseFacetCombo({ id: "" }), null);
    assert.equal(parseFacetCombo({ drop: ["F04.A01PS"] }), null);
    assert.equal(parseFacetCombo(null), null);
  });

  it("names the country with the description when a country is given", () => {
    const prompt = systemFacetCleanup(true);
    assert.match(prompt, /as precisely and as completely/);
    assert.match(prompt, /without stating the same fact twice/);
    assert.match(prompt, /role and its name/);
    assert.match(prompt, /food nomenclature of: `country`/);
    assert.match(prompt, /\{"id":"<id>"\}/);
  });

  it("omits the country when none is given", () => {
    assert.equal(systemFacetCleanup(false).includes("`country`"), false);
  });
});

describe("buildClosedPickPool", () => {
  it("returns a single aligned F28 hit for canned via canning", () => {
    const { alignedAccepted, pool } = buildClosedPickPool(cat, "canned", "F28", new Set());
    assert.equal(alignedAccepted.length, 1);
    assert.equal(alignedAccepted[0]?.code, "A0BYP");
    assert.equal(pool[0]?.code, "A0BYP");
  });

  it("returns multiple aligned smoking descriptors for smoked", () => {
    const { alignedAccepted } = buildClosedPickPool(cat, "smoked", "F28", new Set());
    assert.ok(alignedAccepted.length >= 2);
    assert.ok(alignedAccepted.some((h) => h.code === "A07JV"));
  });

  it("falls back to process root children for homemade", () => {
    const { alignedAccepted, pool } = buildClosedPickPool(cat, "homemade", "F28", new Set(), {
      allowRootFallback: true,
    });
    assert.equal(alignedAccepted.length, 0);
    assert.ok(pool.length >= 5);
    assert.ok(pool.every((h) => cat.belongsTo(h.code, "process")));
  });

  it("does not use root fallback when disabled", () => {
    const withRoot = buildClosedPickPool(cat, "homemade", "F28", new Set(), {
      allowRootFallback: true,
    });
    const withoutRoot = buildClosedPickPool(cat, "homemade", "F28", new Set(), {
      allowRootFallback: false,
    });
    assert.ok(withRoot.pool.length > 0);
    assert.equal(withoutRoot.pool.length, 0);
  });
});

describe("facetDimensions / headerForFacetDimension", () => {
  it("maps Facets children to Fxx via descendant hierarchyCode", () => {
    assert.equal(headerForFacetDimension(cat, "A0B92"), "F07"); // Fat-content
    assert.equal(headerForFacetDimension(cat, "A0B93"), "F10"); // Qualitative-info
    assert.equal(headerForFacetDimension(cat, "A0B9A"), "F21"); // Production-method
    assert.equal(headerForFacetDimension(cat, "A0B95"), "F28"); // Process
  });

  it("lists A0B8V children without Generic-term", () => {
    const dims = facetDimensions(cat);
    assert.ok(dims.length >= 15);
    assert.ok(dims.every((d) => d.code !== "A0B9F"));
    assert.ok(dims.every((d) => d.header !== "F26"));
    assert.ok(dims.some((d) => d.code === "A0B93" && d.header === "F10"));
    assert.ok(dims.some((d) => d.code === "A0B9A" && d.header === "F21"));
    const process = dims.find((d) => d.code === "A0B95");
    const pack = dims.find((d) => d.code === "A0B97");
    assert.ok(process?.codingGuidance?.toLowerCase().includes("preservation"));
    assert.ok(pack?.codingGuidance?.toLowerCase().includes("container"));
  });

  it("maps descriptors up to their Facets dimension root", () => {
    assert.equal(facetDimensionCodeForTerm(cat, "A0BYP"), "A0B95"); // Canning → Process
    assert.equal(facetDimensionCodeForTerm(cat, "A07SE"), "A0B9A"); // Organic → Production-method
    assert.equal(facetDimensionCodeForTerm(cat, "A077L"), "A0B93"); // Sugar free → Qualitative-info
    assert.equal(facetDimensionCodeForTerm(cat, "A03AM"), null); // food term, not under Facets
  });
});

describe("isCategoryMember", () => {
  it("treats a source property on a category as a member, and nothing else", () => {
    assert.equal(isCategoryMember("category", "source"), true);
    assert.equal(isCategoryMember("category", "made_from"), true);
    assert.equal(isCategoryMember("category", "added"), false);
    assert.equal(isCategoryMember("category", "ingredient"), false);
    assert.equal(isCategoryMember("category", "process"), false);
    assert.equal(isCategoryMember("mix", "source"), false);
    assert.equal(isCategoryMember("foodstuff", "source"), false);
    assert.equal(isCategoryMember(null, "source"), false);
  });
});

describe("memberTermTypes / category members", () => {
  it("constrains only a category whose base is a raw commodity", () => {
    assert.deepEqual([...memberTermTypes("category", "r")!], ["r"]);
    assert.equal(memberTermTypes("category", "d"), null);
    assert.equal(memberTermTypes("category", null), null);
    assert.equal(memberTermTypes("foodstuff", "r"), null);
    assert.equal(memberTermTypes("mix", "r"), null);
  });

  it("drops organisms (F01) when the members must be raw commodities", () => {
    const implied = new Set(cat.impliedFacets("A012R"));
    const open = buildClosedPickPool(cat, "peas", "F01", implied, { allowRootFallback: false });
    assert.ok(open.pool.length > 0, "F01 finds plants when unconstrained");
    const typed = buildClosedPickPool(cat, "peas", "F01", implied, {
      allowRootFallback: false,
      termTypes: new Set(["r"]),
    });
    assert.equal(typed.pool.length, 0);
    assert.equal(typed.alignedAccepted.length, 0);
  });

  it("keeps raw-commodity descriptors on F27", () => {
    const implied = new Set(cat.impliedFacets("A012R"));
    const typed = buildClosedPickPool(cat, "dry peas", "F27", implied, {
      allowRootFallback: false,
      termTypes: new Set(["r"]),
    });
    assert.ok(typed.pool.some((h) => h.code === "A0DCD"));
  });
});

describe("decideF26 / parseF26Relation / siblingChildrenForF26", () => {
  it("gives Other for a missing sibling, at any detail level", () => {
    assert.deepEqual(decideF26(true, "C", "sibling"), { kind: "other" });
    assert.deepEqual(decideF26(true, "H", "sibling"), { kind: "other" });
  });

  it("gives Unspecified on an H/M/P base when the input names nothing narrower", () => {
    for (const level of ["H", "M", "P"]) {
      assert.deepEqual(decideF26(true, level, "parent"), { kind: "unspecified" });
      assert.deepEqual(decideF26(true, level, "none"), { kind: "unspecified" });
      assert.deepEqual(decideF26(true, level, null), { kind: "unspecified" });
    }
  });

  it("gives nothing on a core or extended base unless the input is a missing sibling", () => {
    assert.equal(decideF26(true, "C", "parent").kind, "none");
    assert.equal(decideF26(true, "E", "none").kind, "none");
  });

  it("gives nothing when a child fits, even on a broad base", () => {
    assert.deepEqual(decideF26(true, "P", "same"), { kind: "none", reason: "child_fits_same" });
    assert.deepEqual(decideF26(true, "M", "within"), {
      kind: "none",
      reason: "child_fits_within",
    });
  });

  it("gives nothing when the base has no children", () => {
    assert.deepEqual(decideF26(false, "P", null), { kind: "none", reason: "no_children" });
  });

  it("parses known relations and rejects others", () => {
    assert.equal(parseF26Relation({ relation: " Sibling " }), "sibling");
    assert.equal(parseF26Relation({ relation: "relative" }), null);
    assert.equal(parseF26Relation({ verdict: "sibling" }), null);
    assert.equal(parseF26Relation(null), null);
  });

  it("lists sibling children under egg based dishes", () => {
    const siblings = siblingChildrenForF26(cat, "A03YJ");
    assert.ok(siblings.length >= 3);
    assert.ok(siblings.some((s) => s.code === "A03YN"));
  });
});
