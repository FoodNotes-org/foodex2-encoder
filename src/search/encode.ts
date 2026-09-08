/**
 * Shared search text normalization.
 *
 * Ported verbatim (with types) from foodex2-atlas `search/encode.mjs` so the
 * lexical index and query encode text identically. Do not fork the logic.
 */

/** Decompose accented characters and drop the combining marks. */
export function stripDiacritics(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Diacritic-free, lower-cased form. Preserves punctuation and spacing. */
export function normalizeForSearch(text: string): string {
  return stripDiacritics(String(text ?? "")).toLowerCase();
}

/** Collapse anything that is not a-z/0-9 into single spaces. */
export function normalizeForWordMatching(text: string): string {
  return normalizeForSearch(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Minimal English plural folding (Harman-style S-stemmer) so singular and
 * plural forms share one vocabulary entry. Conservative: -us/-ss endings and
 * -aes/-ees/-oes plurals are left unchanged.
 */
export function foldPlural(token: string): string {
  const len = token.length;
  if (len < 4 || token[len - 1] !== "s") return token;
  const prev = token[len - 2];
  if (prev === "u" || prev === "s") return token; // citrus, glass
  if (prev === "e") {
    if (len >= 5 && token[len - 3] === "i" && token[len - 4] !== "a" && token[len - 4] !== "e") {
      return token.slice(0, len - 3) + "y"; // berries -> berry
    }
    const beforeEs = token[len - 3];
    if (beforeEs === "a" || beforeEs === "e" || beforeEs === "o") return token; // potatoes, shoes
  }
  return token.slice(0, len - 1); // apples -> apple
}

/** Split into plural-folded word tokens after word-matching normalization. */
export function tokenize(text: string): string[] {
  const normalized = normalizeForWordMatching(text);
  if (!normalized) return [];
  return normalized.split(/\s+/).map(foldPlural);
}

/**
 * Sliding-window character trigrams of an already-normalized token. Tokens
 * shorter than 3 chars yield the whole token as a single gram.
 */
export function trigrams(token: string): string[] {
  const t = String(token ?? "");
  if (t.length < 3) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i <= t.length - 3; i++) out.push(t.slice(i, i + 3));
  return out;
}

/**
 * Simplified Double Metaphone (primary code only). Lightweight phonetic
 * encoder; captures the common English sound classes needed for "sounds like"
 * matching (e.g. "keenwah" -> "quinoa").
 */
export function doubleMetaphone(word: string): string {
  if (!word) return "";
  const str = String(word).toUpperCase().replace(/[^A-Z]/g, "");
  if (str.length === 0) return "";

  const len = str.length;
  const charAt = (p: number): string => (p >= 0 && p < len ? (str[p] as string) : "");
  const isVowel = (c: string): boolean => c !== "" && "AEIOU".includes(c);

  let primary = "";
  let pos = 0;

  if (isVowel(charAt(0))) {
    primary += "A";
    pos++;
  }

  while (pos < len && primary.length < 6) {
    const c = charAt(pos);
    const next = charAt(pos + 1);
    const next2 = charAt(pos + 2);

    switch (c) {
      case "A":
      case "E":
      case "I":
      case "O":
      case "U":
        pos++;
        break;
      case "B":
        primary += "P";
        pos += next === "B" ? 2 : 1;
        break;
      case "C":
        if (next === "H") {
          primary += "X";
          pos += 2;
        } else if (next === "K") {
          primary += "K";
          pos += 2;
        } else if ("EIY".includes(next)) {
          primary += "S";
          pos++;
        } else {
          primary += "K";
          pos++;
        }
        break;
      case "D":
        if (next === "G" && "EIY".includes(next2)) {
          primary += "J";
          pos += 3;
        } else {
          primary += "T";
          pos += next === "D" ? 2 : 1;
        }
        break;
      case "F":
        primary += "F";
        pos += next === "F" ? 2 : 1;
        break;
      case "G":
        if (next === "H") {
          if (pos === 0) {
            primary += "K";
            pos += 2;
          } else {
            pos += 2;
          }
        } else if ("EIY".includes(next)) {
          primary += "J";
          pos++;
        } else {
          primary += "K";
          pos += next === "G" ? 2 : 1;
        }
        break;
      case "H":
        if (isVowel(next) && (pos === 0 || isVowel(charAt(pos - 1)))) {
          primary += "H";
        }
        pos++;
        break;
      case "J":
        primary += "J";
        pos += next === "J" ? 2 : 1;
        break;
      case "K":
        primary += "K";
        pos += next === "K" ? 2 : 1;
        break;
      case "L":
        primary += "L";
        pos += next === "L" ? 2 : 1;
        break;
      case "M":
        primary += "M";
        pos += next === "M" ? 2 : 1;
        break;
      case "N":
        primary += "N";
        pos += next === "N" ? 2 : 1;
        break;
      case "P":
        if (next === "H") {
          primary += "F";
          pos += 2;
        } else {
          primary += "P";
          pos += next === "P" ? 2 : 1;
        }
        break;
      case "Q":
        primary += "K";
        pos += next === "Q" ? 2 : 1;
        break;
      case "R":
        primary += "R";
        pos += next === "R" ? 2 : 1;
        break;
      case "S":
        if (next === "H") {
          primary += "X";
          pos += 2;
        } else if (next === "C" && "EIY".includes(next2)) {
          primary += "S";
          pos += 3;
        } else {
          primary += "S";
          pos += next === "S" ? 2 : 1;
        }
        break;
      case "T":
        if (next === "H") {
          primary += "0";
          pos += 2;
        } else if (next === "I" && "OA".includes(next2)) {
          primary += "X";
          pos += 3;
        } else {
          primary += "T";
          pos += next === "T" ? 2 : 1;
        }
        break;
      case "V":
        primary += "F";
        pos += next === "V" ? 2 : 1;
        break;
      case "W":
        if (pos === 0 && isVowel(next)) primary += "A";
        pos++;
        break;
      case "X":
        primary += "KS";
        pos += next === "X" ? 2 : 1;
        break;
      case "Y":
        if (isVowel(next)) primary += "A";
        pos++;
        break;
      case "Z":
        primary += "S";
        pos += next === "Z" ? 2 : 1;
        break;
      default:
        pos++;
    }
  }

  return primary;
}
