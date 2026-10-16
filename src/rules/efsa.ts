/**
 * EFSA FoodEx2 business rules implemented here. Messages are EFSA's own wording
 * from the Catalogue Browser rule sheet (openefsa/catalogue-browser,
 * business-rules/warningMessages.txt, EUPL 1.2); the checks themselves are
 * written from the documented behaviour. See rules/efsa-business-rules.md.
 */

export const EFSA_RULES_SOURCE =
  "EFSA FoodEx2 business rules (Catalogue Browser 1.2.15 / ICT 1.2.13 rule sheet)";

export interface EfsaRule {
  severity: "error" | "warning";
  message: string;
}

export const EFSA_RULES: Record<string, EfsaRule> = {
  BR03: {
    severity: "error",
    message: "The F01 source facet is not allowed in composite food. Choose instead an F04 ingredient facet.",
  },
  BR04: {
    severity: "error",
    message:
      "The F27 source-commodities facet is not allowed in composite food. Choose instead an F04 ingredient facet.",
  },
  BR08: { severity: "error", message: "The use of this term is forbidden in the reporting hierarchy." },
  BR10: { severity: "warning", message: "The use of non-specific terms as base term is discouraged." },
  BR11: { severity: "warning", message: "The use of generic terms under F28 process facet is discouraged." },
  BR12: {
    severity: "warning",
    message:
      "The F04 ingredient facet can only be used as a minor ingredient to derivative or raw primary commodity terms.",
  },
  BR13: {
    severity: "error",
    message:
      "The F03 physical state facet reported creates a new derivative nature and therefore cannot be applied to raw primary commodity.",
  },
  BR16: { severity: "error", message: "Reporting facets less detailed than the implicit facets is discouraged." },
  BR17: { severity: "error", message: "Reporting facets as base term is forbidden." },
  BR19: {
    severity: "error",
    message:
      "Processes that create a new derivative nature cannot be applied to raw commodity base terms. Start from the exsisting derivative base term instead.",
  },
  BR20: { severity: "error", message: "The selected term cannot be used since it is deprecated." },
  BR21: { severity: "error", message: "The selected term cannot be used since it is dismissed." },
  BR23: { severity: "warning", message: "The use of hierarchy terms as base term is discouraged." },
  BR24: { severity: "error", message: "The hierarchy term selected does not belong to the exposure hierarchy." },
  BR25: { severity: "error", message: "Reporting more than one facet is forbidden for this category." },
  BR28: {
    severity: "error",
    message:
      "Processes that create a new derivative nature cannot be applied to exsisting derivative base terms. Start from the reconstituted/diluted term instead.",
  },
  BR29: { severity: "error", message: "The code does not follow the required structure or is misspelled." },
  BR30: { severity: "error", message: "The category does not exist." },
  BR31: { severity: "error", message: "The facet is not valid for the facet category." },
};

/** EFSA rules not implemented yet (see rules/efsa-business-rules.md). */
export const EFSA_RULES_NOT_CHECKED = ["BR01", "BR05", "BR06", "BR07", "BR14", "BR15", "BR27"];

/** BR11: "Processed" and its children. */
export const GENERIC_PROCESSES = new Set(["A0C0R", "A0CHR", "A0CHS"]);

/** BR13: powder and paste physical states. */
export const RAW_FORBIDDEN_STATES = new Set(["A06JD", "A07Y3", "A07Y2", "A06JG", "A06JF", "A06JE", "A07Y4"]);

/** BR28: reconstitution and dilution. */
export const RECONSTITUTION_PROCESSES = new Set(["A07MR", "A07MQ"]);
