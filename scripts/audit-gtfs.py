"""Independently compare sampled OTP ride times to exact GTFS stop records."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import zipfile
from collections import defaultdict
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("results", type=Path)
parser.add_argument("graph_directory", type=Path)
args = parser.parse_args()
results = json.loads(args.results.read_text())
manifest = json.loads((args.graph_directory / "manifest.json").read_text())
feeds = {record["id"]: record for record in manifest["feeds"]}
checks = defaultdict(list)
for result in results["results"]:
    for route in result.get("routes", []):
        for leg in route["rides"]:
            feed, trip = leg["tripId"].split(":", 1)
            checks[feed].append((result["id"], trip, leg))

passed, failures = 0, []
for feed, cases in sorted(checks.items()):
    path = args.graph_directory / (feed + ".zip")
    with path.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != feeds[feed]["sha256"]:
            raise ValueError("GTFS hash does not match the graph manifest: " + feed)
    wanted = {trip for _, trip, _ in cases}
    stop_times = defaultdict(list)
    with zipfile.ZipFile(path) as archive, io.TextIOWrapper(archive.open("stop_times.txt"), encoding="utf-8-sig") as file:
        for row in csv.DictReader(file):
            if row["trip_id"] in wanted:
                stop_times[row["trip_id"]].append(row)
    for case_id, trip, leg in cases:
        bounds = []
        service_noon = datetime.strptime(leg["serviceDate"], "%Y%m%d").replace(hour=12, tzinfo=ZoneInfo(feeds[feed]["timeZone"]))
        origin = service_noon.astimezone(timezone.utc) - timedelta(hours=12)
        for field, clock, endpoint in [("departure_time", "scheduledDepartureTime", "fromId"), ("arrival_time", "scheduledArrivalTime", "toId")]:
            target = datetime.fromisoformat(leg[clock].replace("Z", "+00:00"))
            stop = leg[endpoint].split(":", 1)[-1]
            sequences = []
            for row in stop_times[trip]:
                if row["stop_id"] != stop or not row[field]:
                    continue
                hour, minute, second = (int(number) for number in row[field].split(":"))
                if abs((target - (origin + timedelta(hours=hour,minutes=minute,seconds=second))).total_seconds()) <= 1:
                    sequences.append(int(row["stop_sequence"]))
            bounds.append(sequences)
        if any(board < exit for board in bounds[0] for exit in bounds[1]):
            passed += 1
        else:
            failures.append({"case":case_id,"feed":feed,"trip":trip,"matchingSequences":bounds})
print(json.dumps({"rideOccurrences":sum(map(len, checks.values())), "matchedTimesAndOrder":passed, "failures":failures},indent=2))
raise SystemExit(1 if not passed or failures else 0)
