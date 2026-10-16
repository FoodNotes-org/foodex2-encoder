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
  bareFortifiedFacet,
  buildClosedPickPool,
  cleanupFacets,
  decideF26,
  facetDimensionCodeForTerm,
  facetDimensions,
  findDishSpan,
  headerForFacetDimension,
  isCategoryMember,
  memberTermTypes,
  originRolesForBaseType,
  parseFortification,
  parseGapOmitted,
  parseGapProperties,
  phraseCoveredByFortification,
  dropFortificationRestatements,
  parseF26Relation,
  parseOriginRole,
  recallIngredF04,
  siblingChildrenForF26,
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

  it("a made_from property gets the prescribed origin only, like source", () => {
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "made_from"), ["organism"]);
    assert.deepEqual(originRolesForBaseType("d", "foodstuff", "made_from"), ["made_from"]);
    assert.deepEqual(originRolesForBaseType("c", "dish", "made_from"), ["contains"]);
  });

  it("an added property is always an ingredient, never the food's origin (§3.1.9, §5.13)", () => {
    // Herbs in butter, salt on peanuts: not F27 / F01.
    assert.deepEqual(originRolesForBaseType("d", "foodstuff", "added"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("r", "foodstuff", "added"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("r", "mix", "added"), ["contains"]);
    assert.deepEqual(originRolesForBaseType("g", "foodstuff", "added"), ["contains"]);
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

  it("does not place butter in an empty F27 model-pick pool", () => {
    const { alignedAccepted, pool } = buildClosedPickPool(cat, "butter", "F27", new Set(), {
      allowRootFallback: false,
    });
    assert.equal(alignedAccepted.length, 0);
    assert.equal(pool.length, 0);
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
