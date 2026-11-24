"""Prepare an OTP 2.8.1 graph with pinned engine and attributed NYC data.

This writes runtime data only. Use a new directory when refreshing a serving graph.
"""
import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

VERSION = "2.8.1"
JAR_SHA256 = "eb4224cb0f59ed913ee240d17838091a0e6da2d81d8216c31c07c51502831697"
JAR_URL = f"https://github.com/opentripplanner/OpenTripPlanner/releases/download/v{VERSION}/otp-shaded-{VERSION}.jar"
OSM_URL = "https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf"
MTA = "https://rrgtfsfeeds.s3.amazonaws.com/"
FEEDS = {
    "manhattan": ("gtfs_m.zip", ["bus"]),
    "brooklyn": ("gtfs_b.zip", ["bus"]),
    "bronx": ("gtfs_bx.zip", ["bus"]),
    "queens": ("gtfs_q.zip", ["bus"]),
    "staten-island": ("gtfs_si.zip", ["bus"]),
    "bus-company": ("gtfs_busco.zip", ["bus"]),
    "subway": ("gtfs_subway.zip", ["subway", "rail"]),
    "rail": ("gtfslirr.zip", ["rail"]),
}
TIMEZONE = "America/New_York"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def read_rows(archive, name):
    try:
        stream = archive.open(name)
    except KeyError:
        return []
    with io.TextIOWrapper(stream, encoding="utf-8-sig", newline="") as reader:
        return list(csv.DictReader(reader))


def parse_day(value):
    return dt.datetime.strptime(value.strip(), "%Y%m%d").date()


def feed_info(path, feed_id, source, modes):
    with zipfile.ZipFile(path) as archive:
        agency = read_rows(archive, "agency.txt")
        if not agency or {row.get("agency_timezone", "").strip() for row in agency} != {TIMEZONE}:
            raise ValueError(f"{feed_id}: expected an NYC agency timezone.")
        for required in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
            if required not in archive.namelist() or archive.getinfo(required).file_size <= 0:
                raise ValueError(f"{feed_id}: missing {required}.")
        calendars = read_rows(archive, "calendar.txt")
        exceptions = [row for row in read_rows(archive, "calendar_dates.txt") if row.get("exception_type") == "1"]
        start = [parse_day(row["start_date"]) for row in calendars] + [parse_day(row["date"]) for row in exceptions]
        end = [parse_day(row["end_date"]) for row in calendars] + [parse_day(row["date"]) for row in exceptions]
        if not start or not end:
            raise ValueError(f"{feed_id}: no usable service dates.")
        published = (read_rows(archive, "feed_info.txt") or [{}])[0]
        first, last = min(start), max(end)
        if published.get("feed_start_date"):
            first = max(first, parse_day(published["feed_start_date"]))
        if published.get("feed_end_date"):
            last = min(last, parse_day(published["feed_end_date"]))
        if last < first:
            raise ValueError(f"{feed_id}: inconsistent service dates.")
    return {
        "id": feed_id, "url": source, "modes": modes, "timeZone": TIMEZONE, "version": published.get("feed_version"),
        "validFrom": first.isoformat(), "validThrough": last.isoformat(),
        "retrievedAt": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat(),
        "sha256": digest(path),
    }


def download(url, path, max_bytes, validate):
    temp = path.with_suffix(path.suffix + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "PathForAll data bootstrap/8"})
        with urllib.request.urlopen(request, timeout=60) as response, temp.open("wb") as output:
            if not response.url.startswith("https://"):
                raise ValueError("A download attempted to leave HTTPS.")
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("Input exceeds its download size budget.")
                output.write(chunk)
        validate(temp)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def write_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("otp-data"))
    parser.add_argument("--osm-file", type=Path, help="Operator-supplied OSM PBF (opt in with --osm-source HTTPS URL)")
    parser.add_argument("--osm-source", help="Attribution URL for --osm-file")
    parser.add_argument("--ferry-gtfs", type=Path, help="Optional authorized GTFS file, named ferry.zip in the runtime directory")
    parser.add_argument("--ferry-source", help="Authoritative HTTPS origin URL for --ferry-gtfs")
    parser.add_argument("--reuse-downloads", action="store_true", help="Use already downloaded, validated calendar-covering inputs")
    parser.add_argument("--reuse-streets", action="store_true", help="Load streetGraph.obj built with the same OSM hash and OTP version")
    parser.add_argument("--heap", default="6g", help="JVM heap limit, e.g. 6g")
    parser.add_argument("--prepare-only", action="store_true", help="Validate inputs and create build configuration, but do not publish readiness metadata")
    args = parser.parse_args()
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if not re.fullmatch(r"[1-9][0-9]*[mg]", args.heap):
        parser.error("--heap must be a JVM size like 6g.")
    if args.osm_file and (not args.osm_source or not args.osm_source.startswith("https://")):
        parser.error("--osm-file requires its attributed HTTPS --osm-source.")
    if args.ferry_gtfs and (not args.ferry_source or not args.ferry_source.startswith("https://")):
        parser.error("--ferry-gtfs requires its authorized HTTPS --ferry-source.")
    today = dt.datetime.now(ZoneInfo(TIMEZONE)).date().isoformat()

    def prepare_feed(item):
        feed_id, (name, modes) = item
        path, url = directory / (feed_id + ".zip"), MTA + name
        def validated(file):
            record = feed_info(file, feed_id, url, modes)
            if record["validThrough"] < today:
                raise ValueError(f"{feed_id}: service calendar expired.")
            return record
        if not (args.reuse_downloads and path.is_file()):
            try:
                download(url, path, 192 * 1024**2, validated)
            except (OSError, ValueError, zipfile.BadZipFile):
                if not path.is_file():
                    raise
                print(f"{feed_id}: download failed; checking cached schedule", flush=True)
        info = validated(path)
        print(f"{feed_id}: valid through {info['validThrough']}; version {info['version']}", flush=True)
        return info

    jar = directory / ("otp-shaded-" + VERSION + ".jar")
    def check_jar(file):
        if digest(file) != JAR_SHA256:
            raise ValueError("OTP release SHA-256 mismatch.")
    if not jar.is_file():
        download(JAR_URL, jar, 256 * 1024**2, check_jar)
    check_jar(jar)

    osm = args.osm_file.resolve() if args.osm_file else directory / "new-york.osm.pbf"
    if not args.osm_file and not (args.reuse_downloads and osm.is_file()):
        download(OSM_URL, osm, 512 * 1024**2, lambda path: check_osm(path))
    check_osm(osm)
    osm_record = {
        "url": args.osm_source or OSM_URL, "license": "ODbL 1.0; OpenStreetMap contributors",
        "retrievedAt": dt.datetime.fromtimestamp(osm.stat().st_mtime, dt.timezone.utc).isoformat(),
        "sha256": digest(osm),
    }
    coverage = osm.with_suffix(".coverage.json")
    if coverage.is_file():
        osm_record["bounds"] = json.loads(coverage.read_text())["bounds"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        feeds = list(pool.map(prepare_feed, FEEDS.items()))
    paths = {record["id"]: directory / (record["id"] + ".zip") for record in feeds}
    if args.ferry_gtfs:
        record = feed_info(args.ferry_gtfs, "ferry", args.ferry_source, ["ferry"])
        if record["validThrough"] < today:
            raise ValueError("The ferry feed has expired.")
        paths["ferry"] = args.ferry_gtfs.resolve()
        feeds.append(record)

    build_config = {
        "osm": [{"source": osm.as_uri(), "timeZone": TIMEZONE}],
        "transitFeeds": [{"type": "gtfs", "feedId": record["id"], "source": paths[record["id"]].as_uri()} for record in feeds],
    }
    write_json(directory / "build-config.json", build_config)
    if args.prepare_only:
        return
    if args.reuse_streets:
        street_manifest = json.loads((directory / "street-provenance.json").read_text())
        if street_manifest != {"otpVersion": VERSION, "osmSha256": osm_record["sha256"]}:
            raise ValueError("Cannot reuse a street graph with different input or engine version.")
    java = ["java", "-Xmx" + args.heap, "-XX:+UseSerialGC", "-XX:ActiveProcessorCount=3", "-jar", str(jar)]
    (directory / "manifest.json").unlink(missing_ok=True)
    if not args.reuse_streets:
        subprocess.run(java + ["--buildStreet", "--abortOnUnknownConfig", str(directory)], check=True)
        write_json(directory / "street-provenance.json", {"otpVersion": VERSION, "osmSha256": osm_record["sha256"]})
    subprocess.run(java + ["--loadStreet", "--save", "--abortOnUnknownConfig", str(directory)], check=True)
    graph = directory / "graph.obj"
    if not graph.is_file() or not graph.stat().st_size:
        raise ValueError("OTP did not build a graph.")
    write_json(directory / "manifest.json", {
        "schema": 1, "otpVersion": VERSION, "graphBuiltAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "graphSha256": digest(graph), "osm": osm_record, "feeds": feeds,
    })
    print(f"Built {graph}; start OTP and check /api/ready.", flush=True)


def check_osm(path):
    with path.open("rb") as source:
        if b"OSMHeader" not in source.read(128):
            raise ValueError("Input is not an OSM PBF.")


if __name__ == "__main__":
    main()
