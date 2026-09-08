#!/usr/bin/env python3
"""Build compact catalogue JSON from an MTX.ecf file.

Reads an ECF ZIP (MTX.xml inside) and writes:

- data/catalogue.json — terms, facet categories, inherited facet sets
- data/search-names.json — short / common / scientific names for search

Default ECF: vendor/efsa-catalogues/ecf_catalogues/MTX.ecf

Usage:
  python3 scripts/build-catalogue.py
  python3 scripts/build-catalogue.py --ecf /path/to/MTX.ecf
  python3 scripts/build-catalogue.py --ecf /path/to/MTX.ecf --out-dir /tmp/mtx-data
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

REPO = Path(__file__).resolve().parent.parent
DEFAULT_ECF = REPO / "vendor/efsa-catalogues/ecf_catalogues/MTX.ecf"
DEFAULT_OUT_DIR = REPO / "data"

FACET_GROUP_RE = re.compile(r"^(F\d{2})\.([A-Z0-9]{5})$")

# Implicit-attribute codes whose values are additional searchable names.
NAME_ATTRIBUTES = {"A01": "scientific", "A02": "common"}


def text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    value = el.text.strip()
    return value or None


def scope_note_text(raw: str | None) -> str | None:
    """MTX scope notes append '£'-separated links; keep the prose only."""
    if raw is None:
        return None
    return raw.split("£", 1)[0].strip() or None


def normalize_facet_group(group: str) -> str | None:
    group = group.strip()
    if "#" in group:  # full-code prefix artifact, e.g. "A01DJ#F01.A05YG"
        group = group.split("#", 1)[1]
    return group if FACET_GROUP_RE.match(group) else None


def build(ecf: Path, out_dir: Path) -> None:
    with ZipFile(ecf) as archive:
        root = ET.fromstring(archive.read("MTX.xml"))
    catalogue = root.find("catalogue")
    assert catalogue is not None

    version = text(catalogue.find("catalogueVersion/version"))

    facet_categories: dict[str, dict] = {}
    for attr in catalogue.findall("catalogueAttributes/attribute"):
        code = text(attr.find("attributeDesc/code"))
        if code is None or not re.match(r"^F\d{2}$", code):
            continue
        name = text(attr.find("attributeDesc/name")) or ""
        facet_categories[code] = {
            "label": text(attr.find("attributeDesc/label")),
            "hierarchyCode": name,  # e.g. "process"; matches hierarchyAssignments
            "cardinality": text(attr.find("attributeDesc/attributeSingleOrRepeatable")),
            "scopeNote": scope_note_text(text(attr.find("attributeDesc/scopeNote"))),
        }

    terms: dict[str, dict] = {}
    names: dict[str, list[str]] = {}
    dropped_facet_groups = 0
    inherited_terms = 0
    inherited_sets: list[str] = []
    inherited_set_index: dict[str, int] = {}
    # allFacets is expected to CONTAIN what the term declares. If it ever does
    # not, the difference we store is not "inherited" and the union is not the
    # implied set, so say so loudly rather than shipping a wrong field name.
    lost_declared: dict[str, list[str]] = {}
    for term in catalogue.iter("term"):
        code = text(term.find("termDesc/termCode"))
        if code is None:
            continue

        term_type = detail_level = None
        implicit: list[str] = []
        all_facets: list[str] = []
        extra_names: list[str] = []
        short_name = text(term.find("termDesc/termShortName"))
        if short_name:
            extra_names.append(short_name)
        for ia in term.findall("implicitAttributes/implicitAttribute"):
            attr_code = text(ia.find("attributeCode"))
            if attr_code == "termType":
                term_type = text(ia.find("attributeValues/attributeValue"))
            elif attr_code == "detailLevel":
                detail_level = text(ia.find("attributeValues/attributeValue"))
            elif attr_code in NAME_ATTRIBUTES:
                for value in ia.findall("attributeValues/attributeValue"):
                    if value.text and value.text.strip():
                        extra_names.append(value.text.strip())
            elif attr_code in ("implicitFacets", "allFacets"):
                target = implicit if attr_code == "implicitFacets" else all_facets
                for value in ia.findall("attributeValues/attributeValue"):
                    if value.text:
                        for group in value.text.split("$"):
                            normalized = normalize_facet_group(group)
                            if normalized:
                                target.append(normalized)
                            elif group.strip() and attr_code == "implicitFacets":
                                # allFacets always leads with the bare term code,
                                # which is not a malformed group.
                                dropped_facet_groups += 1

        assignments: dict[str, list] = {}
        for ha in term.findall("hierarchyAssignments/hierarchyAssignment"):
            hier = text(ha.find("hierarchyCode"))
            if hier is None:
                continue
            assignments[hier] = [
                text(ha.find("parentCode")),
                text(ha.find("reportable")) == "true",
            ]

        declared = sorted(set(implicit))
        inherited = sorted(set(all_facets) - set(declared))
        lost = sorted(set(declared) - set(all_facets))
        if lost:
            lost_declared[code] = lost

        record: dict = {
            "name": text(term.find("termDesc/termExtendedName")),
            "termType": term_type,
            "detailLevel": detail_level,
            "scopeNote": scope_note_text(text(term.find("termDesc/termScopeNote"))),
            "implicitFacets": declared,
            "hierarchies": assignments,
        }
        if inherited:
            key = "$".join(inherited)
            index = inherited_set_index.get(key)
            if index is None:
                index = len(inherited_sets)
                inherited_set_index[key] = index
                inherited_sets.append(key)
            record["inherited"] = index
            inherited_terms += 1
        status = text(term.find("termVersion/status"))
        if status != "APPROVED":
            record["status"] = status
        terms[code] = record

        # De-duplicate names case-insensitively while preserving order; drop
        # any that merely restate the extended name.
        seen_names = {(record["name"] or "").lower()}
        deduped: list[str] = []
        for value in extra_names:
            key = value.lower()
            if key not in seen_names:
                seen_names.add(key)
                deduped.append(value)
        if deduped:
            names[code] = deduped

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "catalogue.json"
    names_out = out_dir / "search-names.json"

    out.write_text(json.dumps({
        "catalogue": "MTX",
        "version": version,
        "facetCategories": facet_categories,
        "inheritedFacetSets": inherited_sets,
        "terms": terms,
    }, ensure_ascii=False, separators=(",", ":")))

    names_out.write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")))

    size_mb = out.stat().st_size / 1024 / 1024
    names_mb = names_out.stat().st_size / 1024 / 1024
    print(f"Wrote {len(terms)} terms, {len(facet_categories)} facet categories "
          f"(MTX v{version}) to {out} ({size_mb:.1f} MB)")
    print(f"Wrote extra searchable names for {len(names)} terms to {names_out} "
          f"({names_mb:.1f} MB)")
    print(f"  source ECF: {ecf}")
    print(f"  {inherited_terms} terms inherit a facet their own implicitFacets does not declare, "
          f"over {len(inherited_sets)} distinct sets")
    if dropped_facet_groups:
        print(f"  dropped {dropped_facet_groups} malformed implicit facet groups")
    if lost_declared:
        print(f"  WARNING: {len(lost_declared)} terms declare a facet allFacets omits, "
              f"e.g. {list(lost_declared.items())[:3]}. 'inheritedFacets' no longer means "
              f"what it says; check MTX before trusting the implied-facet view.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ecf",
        type=Path,
        default=DEFAULT_ECF,
        help=f"path to MTX.ecf (default: {DEFAULT_ECF})",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=f"directory for catalogue.json and search-names.json (default: {DEFAULT_OUT_DIR})",
    )
    args = parser.parse_args()
    if not args.ecf.is_file():
        raise SystemExit(f"ECF not found: {args.ecf}")
    build(args.ecf.resolve(), args.out_dir.resolve())


if __name__ == "__main__":
    main()
