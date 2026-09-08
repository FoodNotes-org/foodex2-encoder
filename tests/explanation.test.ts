import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExplanation } from "../src/encode/explanation.js";
import type { EncodeOk } from "../src/encode/types.js";

describe("buildExplanation", () => {
  it("explains a lexical hit in one clear line", () => {
    const result: EncodeOk = {
      status: "ok",
      code: "A02LC",
      baseTerm: { code: "A02LC", name: "Smoked salmon" },
      method: "lexical",
      facets: [],
      freeText: null,
      audit: [],
    };
    assert.deepEqual(buildExplanation(result), [
      'Matched the catalogue name "Smoked salmon" (A02LC) by identical wording.',
    ]);
  });

  it("summarises route, walk, pick and residual placements for traversal", () => {
    const result: EncodeOk = {
      status: "ok",
      code: "A040Z#F26.A07XE$F28.A07GR",
      baseTerm: { code: "A040Z", name: "Rice dishes" },
      method: "traversal",
      fit: "broad",
      food: "fried rice with chicken",
      descriptionKind: "dish",
      facets: [
        { header: "F26", code: "A07XE", name: "Stir frying" },
        { header: "F28", code: "A07GR", name: "Cooking in water" },
      ],
      freeText: [],
      scored: [
        {
          code: "A040Z",
          name: "Rice dishes",
          match: "broad",
          detailLevel: "C",
          fit: "broad",
          shortlisted: true,
        },
        {
          code: "A03PV",
          name: "Pasta-based dishes",
          match: "related",
          detailLevel: "C",
          fit: "broad",
          shortlisted: true,
        },
      ],
      walks: [
        {
          walk: "whole_item",
          compareAs: "fried rice with chicken",
          status: "completed",
          classifySteps: 4,
        },
      ],
      audit: [
        {
          step: "residuals_place",
          detail: {
            from: "input",
            resolutions: [
              {
                phrase: "fried",
                kind: "process",
                placed: "facet",
                facet: { header: "F26", code: "A07XE", name: "Stir frying" },
              },
              {
                phrase: "chicken",
                kind: "ingredient",
                placed: "freeText",
                freeText: { label: "ingredient", value: "chicken" },
              },
            ],
          },
        },
      ],
    };

    assert.deepEqual(buildExplanation(result), [
      "Read the description as a named dish.",
      "Walked the food tree for the whole description.",
      "Chose Rice dishes (A040Z) as a broad fit among 2 shortlisted candidates.",
      '"fried" encoded as Stir frying (F26.A07XE).',
      '"chicken" left as ingredient=chicken (no matching facet).',
    ]);
  });

  it("falls back to listing facets when place resolutions are absent", () => {
    const result: EncodeOk = {
      status: "ok",
      code: "A02LC#F28.A07JE",
      baseTerm: { code: "A02LC", name: "Smoked salmon" },
      method: "lexical",
      facets: [{ header: "F28", code: "A07JE", name: "Smoking" }],
      freeText: [{ label: "brand", value: "Acme" }],
      audit: [],
    };
    assert.deepEqual(buildExplanation(result), [
      'Matched the catalogue name "Smoked salmon" (A02LC) by identical wording.',
      "Added facet Smoking (F28.A07JE).",
      "Left as brand=Acme.",
    ]);
  });
});
