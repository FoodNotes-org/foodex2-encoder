import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toUserEncodeResult } from "../src/encode/user-result.js";
import type { EncodeOk, EncodeRejected } from "../src/encode/types.js";

describe("toUserEncodeResult", () => {
  it("keeps the readable fields and drops the trail", () => {
    const internal: EncodeOk = {
      status: "ok",
      code: "A040Z#F26.A07XE",
      baseTerm: { code: "A040Z", name: "Rice dishes" },
      method: "traversal",
      fit: "broad",
      facets: [{ header: "F26", code: "A07XE", name: "Stir frying" }],
      freeText: [{ label: "ingredient", value: "chicken" }],
      candidates: [{ code: "A040Z", name: "Rice dishes", match: "broad" }],
      scored: [],
      walks: [
        {
          walk: "whole_item",
          compareAs: "fried rice with chicken",
          status: "completed",
          classifySteps: 3,
        },
      ],
      steps: [],
      audit: [{ step: "input", detail: { raw: "fried rice with chicken" } }],
      food: "fried rice with chicken",
      descriptionKind: "dish",
    };

    assert.deepEqual(toUserEncodeResult(internal), {
      status: "ok",
      code: "A040Z#F26.A07XE",
      baseTerm: { code: "A040Z", name: "Rice dishes" },
      facets: [{ header: "F26", code: "A07XE", name: "Stir frying" }],
      freeText: [{ label: "ingredient", value: "chicken" }],
      fit: "broad",
      method: "traversal",
      explanation: [
        "Read the description as a named dish.",
        "Walked the food tree for the whole description.",
        "Chose Rice dishes (A040Z) as a broad fit.",
        "Added facet Stir frying (F26.A07XE).",
        "Left as ingredient=chicken.",
      ],
    });
  });

  it("surfaces only the rejection message", () => {
    const internal: EncodeRejected = {
      status: "rejected",
      reason: "empty_input",
      message: "Input is empty",
      audit: [{ step: "input", detail: { raw: "" } }],
    };
    assert.deepEqual(toUserEncodeResult(internal), {
      status: "rejected",
      message: "Input is empty",
    });
  });
});
