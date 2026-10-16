/**
 * FoodEx2 coding rules shared by the encoder and the FoodEx2 Atlas. No I/O:
 * callers supply terms through a TermLookup.
 */

export * from "./types.js";
export { parseCode, statedCodes, impliedCodes } from "./parse.js";
export {
  checkCode,
  cardinalityKey,
  conflict,
  facetCardinality,
  impliedRelation,
  isAtOrUnder,
  isHierarchyTerm,
  EXPOSURE_HIERARCHY,
  REPORTING_HIERARCHY,
  RULES_MTX_RELEASE,
  type CheckResult,
  type ImpliedRelation,
} from "./check.js";
export { EFSA_RULES, EFSA_RULES_NOT_CHECKED, EFSA_RULES_SOURCE } from "./efsa.js";
