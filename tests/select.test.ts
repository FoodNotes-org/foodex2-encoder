/**
 * Deterministic selection helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  selectableFitTier,
  tieBreakRank,
  selectScore,
  fitPoints,
  broadShelfScore,
  nearestGenericGroup,
  sameNatureGroup,
  parseMinorShare,
  PROCESS_BONUS,
  DETAIL_LEVEL_BONUS,
} from "../src/encode/select.js";
import { otherSiblingFields } from "../src/encode/select-classify.js";
import type { BaseTermCandidate, CandidateFit } from "../src/encode/types.js";

describe("otherSiblingFields", () => {
  const cat = Catalogue.load();

  it("names the parent and the other children for a term called other", () => {
    assert.deepEqual(otherSiblingFields(cat, "A023X", "Cooked other poultry meat"), {
      parent: "Cooked cured (or seasoned) poultry meat",
      siblings: ["Cooked turkey meat", "Corned turkey"],
    });
  });

  it("adds nothing when the name does not say other", () => {
    assert.equal(
      otherSiblingFields(cat, "A023S", "Cooked cured (or seasoned) poultry meat"),
      undefined
    );
  });
});

describe("selectable fit tier", () => {
  it("prefers exact over broad", () => {
    const pool: BaseTermCandidate[] = [
      { code: "A03YJ", name: "Egg based dishes", match: "broad" },
      { code: "A03YL", name: "Eggs benedict", match: "broad" },
    ];
    const byCode = new Map<string, CandidateFit>([
      ["A03YJ", "broad"],
      ["A03YL", "exact"],
    ]);
    const tier = selectableFitTier(byCode, pool);
    assert.equal(tier?.fit, "exact");
    assert.deepEqual([...(tier?.codes ?? [])], ["A03YL"]);
  });

  it("falls back to broad when no exact", () => {
    const pool: BaseTermCandidate[] = [
      { code: "A03YJ", name: "Egg based dishes", match: "broad" },
      { code: "A031R", name: "Hen egg mixed whole", match: "related" },
    ];
    const byCode = new Map<string, CandidateFit>([
      ["A03YJ", "broad"],
      ["A031R", "related"],
    ]);
    const tier = selectableFitTier(byCode, pool);
    assert.equal(tier?.fit, "broad");
    assert.deepEqual([...(tier?.codes ?? [])], ["A03YJ"]);
  });

  it("returns null when only narrow/related/none", () => {
    const pool: BaseTermCandidate[] = [
      { code: "A01RS", name: "Kangaroo fresh meat", match: "narrow" },
      { code: "A03YL", name: "Eggs benedict", match: "related" },
    ];
    const byCode = new Map<string, CandidateFit>([
      ["A01RS", "narrow"],
      ["A03YL", "none"],
    ]);
    assert.equal(selectableFitTier(byCode, pool), null);
  });
});

describe("select score (fit class absolute; C/E/P within class)", () => {
  it("keeps exact ahead of broad even when broad has a detail bonus", () => {
    const cat = Catalogue.load();
    const exactM = selectScore(cat, "A04KS", "exact"); // M
    const broadP = selectScore(cat, "A04KT", "broad"); // P
    assert.equal(exactM.detailLevelBonus, 0);
    assert.equal(broadP.detailLevelBonus, DETAIL_LEVEL_BONUS);
    assert.ok(exactM.fitPoints > broadP.fitPoints);
  });

  it("lets exact+C beat broad+P on both fit points and combined score", () => {
    const cat = Catalogue.load();
    const rice = selectScore(cat, "A003F", "exact"); // C
    const catchAll = selectScore(cat, "A04KT", "broad"); // P
    assert.equal(rice.detailLevelBonus, DETAIL_LEVEL_BONUS);
    assert.equal(catchAll.detailLevelBonus, DETAIL_LEVEL_BONUS);
    assert.ok(rice.fitPoints > catchAll.fitPoints);
    assert.ok(rice.score > catchAll.score);
  });

  it("maps fit classes to points", () => {
    assert.equal(fitPoints("exact"), 4);
    assert.equal(fitPoints("broad"), 3);
    assert.equal(fitPoints("narrow"), 2);
    assert.equal(fitPoints("related"), 3);
    assert.equal(fitPoints("none"), 0);
    assert.equal(fitPoints(null), 0);
  });
});

describe("tie-break within shortlist", () => {
  it("prefers the more specific term among several broad fits", () => {
    const cat = Catalogue.load();
    const parent: BaseTermCandidate = {
      code: "A03YJ",
      name: "Egg based dishes",
      match: "broad",
    };
    const child: BaseTermCandidate = {
      code: "A03YL",
      name: "Eggs benedict",
      match: "broad",
    };
    const shortlist = new Set(["A03YJ", "A03YL"]);
    const parentRank = tieBreakRank(cat, parent, shortlist).rank;
    const childRank = tieBreakRank(cat, child, shortlist).rank;
    assert.ok(childRank[0]! < parentRank[0]!);
  });

  it("prefers non-specific (P) when specificity ties", () => {
    const cat = Catalogue.load();
    const nonSpecific: BaseTermCandidate = {
      code: "A04KT",
      name: "Cereal and cereal-like flours not separately listed",
      match: "broad",
    };
    const generic: BaseTermCandidate = {
      code: "A185Q",
      name: "Pulses flour",
      match: "broad",
    };
    const shortlist = new Set(["A04KT", "A185Q"]);
    const pRank = tieBreakRank(cat, nonSpecific, shortlist);
    const mRank = tieBreakRank(cat, generic, shortlist);
    assert.equal(pRank.moreSpecific, true);
    assert.equal(mRank.moreSpecific, true);
    assert.equal(pRank.nonSpecific, true);
    assert.equal(mRank.nonSpecific, false);
    assert.ok(pRank.rank[1]! < mRank.rank[1]!);
  });
});

describe("broadShelfScore", () => {
  const cat = Catalogue.load();

  it("puts a generic shelf that carries a process above a core shelf that does not", () => {
    const smokedFish = broadShelfScore(cat, "A0EYS");
    const sturgeon = broadShelfScore(cat, "A029E");
    assert.equal(smokedFish.processBonus, PROCESS_BONUS);
    assert.equal(sturgeon.processBonus, 0);
    assert.ok(smokedFish.score > sturgeon.score);
  });

  it("keeps a core shelf above a generic shelf when both carry a process", () => {
    const milled = broadShelfScore(cat, "A0C0Z");
    const groats = broadShelfScore(cat, "A0BY1");
    assert.equal(milled.processBonus, PROCESS_BONUS);
    assert.equal(groats.processBonus, PROCESS_BONUS);
    assert.ok(milled.score > groats.score);
  });

  it("scores two core shelves that each carry one process as equal", () => {
    const confectionery = broadShelfScore(cat, "A034R");
    const candied = broadShelfScore(cat, "A01PS");
    assert.equal(confectionery.score, candied.score);
  });

  it("counts several processes once", () => {
    const pepperoni = broadShelfScore(cat, "A025B");
    const smokedFish = broadShelfScore(cat, "A0EYS");
    assert.equal(pepperoni.processBonus, smokedFish.processBonus);
  });
});

describe("same nature of a mix", () => {
  const cat = Catalogue.load();
  const leaves =
    "mixed leafy vegetables (Italian corn salads, Roman rocket, lollo rosso, radicchio)";
  const withOutsiders =
    "mixed vegetable salad of carrots, sunflower seeds, Italian corn salads, Roman rocket, lollo rosso and radicchio";

  function named(code: string, fit: "related" | "broad") {
    return { code, name: cat.term(code)?.name ?? code, fit };
  }

  const leafCodes = ["A00KV", "A00LN", "A00LB", "A00LG"];

  it("stops at the generic group, not the heading above it", () => {
    assert.equal(nearestGenericGroup(cat, "A00LB"), "A00KR");
    assert.equal(nearestGenericGroup(cat, "A00QH"), "A00QF");
    assert.notEqual(nearestGenericGroup(cat, "A00QH"), "A00FJ");
  });

  it("uses the generic group the named leaves share", () => {
    const found = sameNatureGroup(
      cat,
      leaves,
      [
        ...leafCodes.map((code) => named(code, "related")),
        named("A00LM", "related"),
        named("A00KR", "broad"),
        named("A042C", "broad"),
      ],
      new Set(["A00KR", "A042C"])
    );
    assert.equal(found?.group, "A00KR");
    assert.deepEqual(found?.outside, []);
  });

  it("keeps a strict majority and reports the foods outside it", () => {
    const found = sameNatureGroup(
      cat,
      withOutsiders,
      [
        ...leafCodes.map((code) => named(code, "related")),
        named("A00QH", "related"),
        named("A015L", "related"),
        named("A00KR", "broad"),
        named("A042D", "broad"),
      ],
      new Set(["A00KR", "A042D"])
    );
    assert.equal(found?.group, "A00KR");
    assert.deepEqual(found?.outside, ["A00QH", "A015L"]);
  });

  it("has no result when the named foods split evenly", () => {
    const found = sameNatureGroup(
      cat,
      "carrots and lollo rosso",
      [named("A00QH", "related"), named("A00LB", "related"), named("A00KR", "broad")],
      new Set(["A00KR", "A00QF"])
    );
    assert.equal(found, null);
  });

  it("has no result when the walk did not accept the generic group", () => {
    const found = sameNatureGroup(
      cat,
      leaves,
      [...leafCodes.map((code) => named(code, "related")), named("A042C", "broad")],
      new Set(["A042C"])
    );
    assert.equal(found, null);
  });
});

describe("parseMinorShare", () => {
  it("is true only when the reply says minor", () => {
    assert.equal(parseMinorShare({ minor: true }), true);
    assert.equal(parseMinorShare({ minor: false }), false);
    assert.equal(parseMinorShare({}), false);
    assert.equal(parseMinorShare(null), false);
  });
});
