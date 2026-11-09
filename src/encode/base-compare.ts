/**
 * For a foodstuff, decide whether a treatment creates a new kind of food.
 * The base-term walk then compares the raw food, or the food that treatment
 * produces, and may only land on a term of the matching catalogue type.
 */

import { countryParagraph } from "../country.js";
import { chatJson } from "../llm.js";

export interface NatureTreatment {
  code: string;
  name: string;
  appliesTo: string;
  leadsTo: string;
}

/** Treatments that create a new kind of food, and the foods they apply to. */
export const NATURE_TREATMENTS: readonly NatureTreatment[] = [
  { code: "A0CRH", name: "Seasoning", appliesTo: "Meat, milk", leadsTo: "Sausages and other charcuterie, cheese" },
  { code: "A07KD", name: "Curing", appliesTo: "Meat, milk", leadsTo: "Sausages and other charcuterie, cheese" },
  { code: "A0C6F", name: "Ripening", appliesTo: "Meat, milk", leadsTo: "Sausages and other charcuterie, cheese" },
  { code: "A07JP", name: "Preserving by salt", appliesTo: "Vegetables, meat, fish, seafood", leadsTo: "Salt preserves" },
  { code: "A07JQ", name: "Preserving by sugars", appliesTo: "Fruit, chestnuts", leadsTo: "Sugar preserves and candied foods" },
  { code: "A07KG", name: "Drying", appliesTo: "Meat, fish, seafood, milk, egg, vegetables, legumes, fruit", leadsTo: "Dried food" },
  { code: "A07JT", name: "Marinating", appliesTo: "Meat, fish, seafood", leadsTo: "Marinated meat, fish, or seafood" },
  { code: "A07KC", name: "Pickling", appliesTo: "Vegetables", leadsTo: "Pickled vegetables" },
  { code: "A0CQZ", name: "Fermentation", appliesTo: "Milk, vegetables, meat", leadsTo: "Fermented products, cheese, charcuterie" },
  { code: "A0BYP", name: "Canning or jarring", appliesTo: "Vegetables, fruit, meat, fish, seafood", leadsTo: "Preserves" },
  { code: "A07JV", name: "Smoking", appliesTo: "Meat, fish, seafood", leadsTo: "Smoked meat, fish, or seafood" },
  { code: "A0C00", name: "Winemaking", appliesTo: "Grape and other fruits", leadsTo: "Wine" },
  { code: "A0C01", name: "Beer production", appliesTo: "Malted cereals", leadsTo: "Beer" },
  { code: "A0C6E", name: "Cheesemaking", appliesTo: "Milk", leadsTo: "Cheese" },
  { code: "A07MH", name: "Churning", appliesTo: "Milk, cream", leadsTo: "Butter" },
  { code: "A0C02", name: "Oil production", appliesTo: "Oil fruits and oilseeds", leadsTo: "Oils and fats" },
  { code: "A0C03", name: "Grain milling", appliesTo: "Cereal grains", leadsTo: "Flours and groats" },
  { code: "A0C0B", name: "Starch production", appliesTo: "Cereal grains and similar starch sources", leadsTo: "Starch" },
  { code: "A0C04", name: "Sugar production", appliesTo: "Sugar plants", leadsTo: "Sugar" },
  { code: "A0C6N", name: "Pulping or mashing", appliesTo: "Fruit, vegetables", leadsTo: "Purée" },
  { code: "A07GG", name: "Cooking in water", appliesTo: "Eggs", leadsTo: "Hardened egg products" },
  { code: "A07GR", name: "Frying", appliesTo: "Potatoes", leadsTo: "Fries, chips, and other potato snacks" },
  { code: "A07GX", name: "Baking", appliesTo: "Cereal milling products and other ingredients", leadsTo: "Bakery products" },
  { code: "A07GY", name: "Roasting", appliesTo: "Potatoes", leadsTo: "Roasted potatoes" },
  { code: "A07HC", name: "Toasting", appliesTo: "Coffee beans", leadsTo: "Toasted coffee" },
  { code: "A07HJ", name: "Caramelization", appliesTo: "Sugar", leadsTo: "Caramel" },
  { code: "A07LF", name: "Extrusion", appliesTo: "Cereals", leadsTo: "Extruded snacks and breakfast cereals" },
  { code: "A07LG", name: "Flaking", appliesTo: "Cereals", leadsTo: "Cereal flakes" },
  { code: "A07LH", name: "Flattening or rolling", appliesTo: "Cereals", leadsTo: "Rolled cereals" },
  { code: "A07LL", name: "Puffing", appliesTo: "Cereals", leadsTo: "Puffed cereals" },
  { code: "A0C0G", name: "Gelling", appliesTo: "Milk, water", leadsTo: "Desserts and jellies" },
  { code: "A07MF", name: "Distillation", appliesTo: "Fruits or sugary or starchy sources", leadsTo: "Alcohol and related products" },
  { code: "A0EJP", name: "Separation in liquid phase", appliesTo: "Milk", leadsTo: "Cream" },
  { code: "A07MK", name: "Brewing or infusion", appliesTo: "Infusion materials, cacao, coffee", leadsTo: "Hot drinks" },
  { code: "A07LN", name: "Juicing", appliesTo: "Fruit, vegetables", leadsTo: "Fruit and vegetable juices" },
  { code: "A07MJ", name: "Extraction", appliesTo: "Meat, fish, yeast, infusion materials", leadsTo: "Extracts" },
  { code: "A07KF", name: "Concentration", appliesTo: "Milk, juices", leadsTo: "Concentrates" },
  { code: "A07ML", name: "Crystallisation", appliesTo: "Natural sources of purified ingredients", leadsTo: "Purified ingredients such as protein, carbohydrate, and salt" },
];

const TREATMENT_CODES = new Set(NATURE_TREATMENTS.map((treatment) => treatment.code));

export function baseTermTypesForTreatment(treatment: string | null): ReadonlySet<string> {
  return new Set(treatment === null ? ["r"] : ["d"]);
}

export function parseBaseCompare(
  content: unknown
): { treatment: string | null; compareAs: string } | null {
  if (content === null || typeof content !== "object") return null;
  const body = content as { treatment?: unknown; compareAs?: unknown };
  const compareAs = typeof body.compareAs === "string" ? body.compareAs.trim() : "";
  if (compareAs === "") return null;
  if (body.treatment === null) return { treatment: null, compareAs };
  if (typeof body.treatment !== "string") return null;
  const treatment = body.treatment.trim().toUpperCase();
  if (!TREATMENT_CODES.has(treatment)) return null;
  return { treatment, compareAs };
}

function systemBaseCompare(withCountry: boolean): string {
  return `You are an expert in food classification.

Your task is to decide which of these treatments, if any, creates a new kind of this food, and which food the catalogue base term should denote.

Given:
- \`description\`: the food description.
- \`treatments\`: treatments that create a new kind of food. Each has a \`code\`, a \`name\`, the foods it \`appliesTo\`, and the kind of food it \`leadsTo\`.
${countryParagraph(withCountry, "description")}
A treatment counts only when this food is one of the foods it applies to.

\`compareAs\` is the food the base term should denote. When no treatment counts, it is the raw food, without treatments that do not create a new kind. When a treatment counts, it is the food that treatment produces.

Reply with JSON only:
{"treatment":"<code>"|null,"compareAs":"<food>"}
`;
}

export interface BaseCompare {
  compareAs: string;
  /** Null when the reply could not be read: do not filter term types. */
  termTypes: ReadonlySet<string> | null;
  detail: Record<string, unknown>;
}

/** Foodstuff only. A dish or a mix keeps the description as given. */
export async function resolveBaseCompare(
  description: string,
  country: string | null,
  model: string
): Promise<BaseCompare> {
  const withCountry = country !== null && country !== "";
  const picked = await chatJson({
    model,
    system: systemBaseCompare(withCountry),
    user: JSON.stringify(
      {
        description,
        ...(withCountry ? { country } : {}),
        treatments: NATURE_TREATMENTS,
      },
      null,
      2
    ),
  });
  const parsed = parseBaseCompare(picked.content);
  if (parsed === null) {
    return {
      compareAs: description,
      termTypes: null,
      detail: { model: picked.model, parsed: false, compareAs: description },
    };
  }
  const termTypes = baseTermTypesForTreatment(parsed.treatment);
  return {
    compareAs: parsed.compareAs,
    termTypes,
    detail: {
      model: picked.model,
      treatment: parsed.treatment,
      compareAs: parsed.compareAs,
      termTypes: [...termTypes],
    },
  };
}
