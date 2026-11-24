// Validate the actual operations against the official, pinned OTP release SDL.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildSchema, parse, validate } from "graphql";
import { HEALTH_QUERY, OTP_VERSION, PLAN_QUERY } from "../server/otp-query.js";

const source =
  "https://raw.githubusercontent.com/opentripplanner/OpenTripPlanner/v" +
  OTP_VERSION +
  "/application/src/main/resources/org/opentripplanner/apis/gtfs/schema.graphqls";
const pinnedSha256 =
  "6d9cdf488d2b15fb4c39db8adca1fee29da861afaf8539d03acdbb038383e903";
let text;
if (process.argv[2]) {
  text = await readFile(process.argv[2], "utf8");
} else {
  const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(
      "Official OTP schema download failed: HTTP " + response.status,
    );
  text = await response.text();
}
if (createHash("sha256").update(text).digest("hex") !== pinnedSha256)
  throw new Error("Pinned OTP schema checksum mismatch.");
const schema = buildSchema(text);
for (const query of [HEALTH_QUERY, PLAN_QUERY]) {
  const errors = validate(schema, parse(query));
  if (errors.length)
    throw new Error(errors.map((error) => error.message).join("\n"));
}
console.log(
  "Readiness and route operations conform to OTP " +
    OTP_VERSION +
    " release schema.",
);
