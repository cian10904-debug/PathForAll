"""Create a bounded, routing-only PBF from a local attributed OSM extract.

Requires osmium==4.3.2. Complete ways and their tagged nodes are preserved;
ways outside the rectangle can be retained when referenced by a relation.
"""
import argparse
import json
import os
from pathlib import Path

import osmium


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--bounds", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"),
                        default=[-74.28, 40.46, -73.68, 40.94])
    args = parser.parse_args()
    west, south, east, north = args.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        parser.error("Invalid bounds.")
    if args.source.resolve() == args.destination.resolve():
        parser.error("Choose a different output path.")
    kept = set()
    with osmium.BackReferenceWriter(args.destination, args.source, overwrite=True, remove_tags=False, relation_depth=1) as writer:
        for item in osmium.FileProcessor(args.source).with_locations():
            if item.is_way():
                if not (item.tags.get("highway") or item.tags.get("railway") or item.tags.get("route") == "ferry"
                        or item.tags.get("public_transport") or item.tags.get("amenity") == "ferry_terminal"):
                    continue
                if any(node.location.valid() and west <= node.lon <= east and south <= node.lat <= north for node in item.nodes):
                    writer.add(item)
                    kept.add(item.id)
            elif item.is_relation():
                if (item.tags.get("type", "").startswith("restriction") or item.tags.get("highway") or item.tags.get("route") == "ferry") and any(m.type == "w" and m.ref in kept for m in item.members):
                    writer.add(item)
    osm_time = args.source.stat().st_mtime
    os.utime(args.destination, (osm_time, osm_time))
    args.destination.with_suffix(".coverage.json").write_text(json.dumps({
        "bounds": {"west": west, "south": south, "east": east, "north": north}, "sourceFile": args.source.name,
        "description": "Conservative application bounds; this extract does not guarantee full street connectivity."
    }, indent=2) + "\n")
    print(f"Retained {len(kept)} routing ways; {args.destination.stat().st_size:,} bytes.")


if __name__ == "__main__":
    main()
