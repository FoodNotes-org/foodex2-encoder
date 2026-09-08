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
  buildClosedPickPool,
  chooseF26Unspecified,
  cleanupFacets,
  facetDimensionCodeForTerm,
  facetDimensions,
  findDishSpan,
  headerForFacetDimension,
  originRolesForBaseType,
  parseGapProperties,
  parseOriginRole,
  promptF26Other,
  recallIngredF04,
  siblingChildrenForF26,
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

  it("falls back bare strings and unknown kinds to other", () => {
    assert.deepEqual(parseGapProperties({ properties: ["cocoa", { phrase: "x", kind: "weird" }] }), [
      { phrase: "cocoa", kind: "other" },
      { phrase: "x", kind: "other" },
    ]);
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

describe("chooseF26Unspecified / siblingChildrenForF26", () => {
  it("assigns Unspecified for a hierarchy-term base", () => {
    const facet = chooseF26Unspecified(cat, "A026T");
    assert.ok(facet);
    assert.equal(facet!.header, "F26");
    assert.equal(facet!.code, "A07XD");
  });

  it("does not assign Unspecified for a non-hierarchy base", () => {
    assert.equal(chooseF26Unspecified(cat, "A02QJ"), null);
    assert.equal(chooseF26Unspecified(cat, "A0F3J"), null);
    assert.equal(chooseF26Unspecified(cat, "A03YJ"), null);
  });

  it("lists sibling children under egg based dishes", () => {
    const siblings = siblingChildrenForF26(cat, "A03YJ");
    assert.ok(siblings.length >= 3);
    assert.ok(siblings.some((s) => s.code === "A03YN"));
  });

  it("formats sibling names as a JSON array so commas in names stay inside elements", () => {
    const prompt = promptF26Other("venison", [
      "Deer, fallow fresh meat",
      "Deer, red fresh meat",
      "Roe deer meat",
    ]);
    assert.match(
      prompt,
      /\["Deer, fallow fresh meat","Deer, red fresh meat","Roe deer meat"\]/
    );
    assert.ok(prompt.includes('"parent"'));
    assert.ok(prompt.includes('"sibling"'));
    assert.ok(prompt.includes('"relative"'));
    assert.ok(prompt.includes('"non-related"'));
  });
});
