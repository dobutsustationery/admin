"""Extract Amifa product facts from recorded supplier CSV imports, never quantities.
Usage: python3 scripts/amazon/extract-supplier-specs.py BACKUP_JSON OUTPUT_JSON
The checked-in amazon-supplier-specs.json was extracted on 2026-11-11. Keep the
source event IDs so values can be traced to the supplier's original document.
"""
import csv
import io
import json
import re
import sys

with open(sys.argv[1]) as source:
    documents = json.load(source)["collections"]["broadcast"]["documents"]

def timestamp(document):
    value = document["data"].get("timestamp", {})
    return value.get("_seconds", value.get("seconds", 0))

facts = {}
for document in sorted(documents, key=timestamp):
    payload = document["data"].get("payload", {})
    if not isinstance(payload, dict):
        continue
    for value in payload.values():
        if not isinstance(value, str) or not re.search("material", value, re.I) or not re.search("spec", value, re.I):
            continue
        rows = list(csv.reader(io.StringIO(value)))
        for index, row in enumerate(rows):
            columns = [cell.strip().lower() for cell in row]
            if "material" not in columns:
                continue
            material = columns.index("material")
            specification = next((i for i, name in enumerate(columns) if name in ("spec", "specification", "size")), None)
            jan = next((i for i, name in enumerate(columns) if re.search(r"bar.?code|jan", name)), None)
            if specification is None or jan is None:
                continue
            for data in rows[index + 1:]:
                if max(material, specification, jan) >= len(data):
                    continue
                key = re.sub(r"[^0-9]", "", data[jan])
                if len(key) == 13 and data[material].strip():
                    facts[key] = {"material": data[material].strip(), "specification": data[specification].strip(), "sourceEvent": document["id"]}
with open(sys.argv[2], "w") as output:
    json.dump(dict(sorted(facts.items())), output, indent=2)
    output.write("\n")
print(f"Extracted {len(facts)} supplier specifications")
