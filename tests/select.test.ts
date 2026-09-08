/**
 * Deterministic selection helpers (no LLM).
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalogue } from "../src/catalogue.js";
import {
  selectableFitTier,
  relatedUnderBroad,
  tieBreakRank,
  selectScore,
  fitPoints,
  DETAIL_LEVEL_BONUS,
} from "../src/encode/select.js";
import type { BaseTermCandidate, CandidateFit } from "../src/encode/types.js";

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

describe("related under broad", () => {
  it("promotes related descendants of the broad shelf", () => {
    const cat = Catalogue.load();
    const pool: BaseTermCandidate[] = [
      { code: "A03YJ", name: "Egg based dishes", match: "broad" },
      { code: "A03YQ", name: "Omelette with vegetables", match: "broad" },
      { code: "A03YK", name: "Cheese omelette", match: "related" },
      { code: "A031S", name: "Hen egg yolk", match: "related" },
    ];
    const byCode = new Map<string, CandidateFit>([
      ["A03YJ", "broad"],
      ["A03YQ", "related"],
      ["A03YK", "related"],
      ["A031S", "related"],
    ]);
    const promoted = relatedUnderBroad(
      cat,
      byCode,
      pool,
      new Set(["A03YJ"])
    );
    assert.deepEqual(
      promoted.map((c) => c.code).sort(),
      ["A03YK", "A03YQ"]
    );
  });

  it("promotes nothing when related is not under the broad", () => {
    const cat = Catalogue.load();
    const pool: BaseTermCandidate[] = [
      { code: "A03YJ", name: "Egg based dishes", match: "broad" },
      { code: "A031S", name: "Hen egg yolk", match: "related" },
    ];
    const byCode = new Map<string, CandidateFit>([
      ["A03YJ", "broad"],
      ["A031S", "related"],
    ]);
    assert.deepEqual(
      relatedUnderBroad(cat, byCode, pool, new Set(["A03YJ"])),
      []
    );
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
