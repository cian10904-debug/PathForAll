// @ts-check
/** Merge saved and one-trip requirements without modifying either source. */
export function effectiveNeeds(profileNeeds, tripNeeds) {
  const needs = structuredClone(profileNeeds);
  applyNeedTextsToObject(needs, needs.customNeeds || []);

  const trip = tripNeeds;
  [
    "avoidStairs",
    "requireElevator",
    "preferSmooth",
    "preferShade",
    "preferWellLit",
    "avoidRain",
    "minimizeTransfers",
    "requireCurb",
    "requireVerifiedCurbAccess",
    "wheelchairMode",
  ].forEach((key) => {
    if (trip[key] === true) needs[key] = true;
  });
  if (Number.isFinite(trip.maxSlope))
    needs.maxSlope = Number.isFinite(needs.maxSlope)
      ? Math.min(needs.maxSlope, trip.maxSlope)
      : trip.maxSlope;
  needs.customNeeds = [
    ...(needs.customNeeds || []),
    ...(trip.customNeeds || []),
  ];
  applyNeedTextsToObject(needs, trip.customNeeds || []);
  return needs;
}

export function emptyTripNeeds() {
  return {
    avoidStairs: false,
    requireElevator: false,
    preferSmooth: false,
    preferShade: false,
    preferWellLit: false,
    avoidRain: false,
    minimizeTransfers: false,
    requireCurb: false,
    wheelchairMode: false,
    maxSlope: null,
    customNeeds: [],
  };
}

export function applyNeedTextsToObject(needs, texts) {
  for (const value of texts || []) {
    const text = String(value).toLowerCase();
    if (/wheelchair|wheel chair|轮椅|silla de ruedas/.test(text)) {
      needs.wheelchairMode = true;
      needs.avoidStairs = true;
      needs.requireCurb = true;
      needs.requireElevator = true;
    }
    if (/stairs|steps|step-free|楼梯|台阶|escaleras/.test(text))
      needs.avoidStairs = true;
    if (/elevator|lift|电梯|ascensor/.test(text)) needs.requireElevator = true;
    if (/curb|kerb|坡道|路缘|rampa/.test(text)) needs.requireCurb = true;
    if (/rough|uneven|smooth|surface|颠簸|平滑|路面|superficie/.test(text))
      needs.preferSmooth = true;
    if (/shade|heat|sun|阴凉|遮阴|高温|sombra|calor/.test(text))
      needs.preferShade = true;
    if (
      /well[- ]?lit|better[- ]?lit|lighting|bright(er)? route|照明|iluminad/.test(
        text,
      )
    )
      needs.preferWellLit = true;
    if (/rain|covered|dry|下雨|避雨|有顶棚|lluvia|cubierto/.test(text))
      needs.avoidRain = true;
    if (/transfer|crowd|少换乘|拥挤|换乘|transbordo|multitud/.test(text))
      needs.minimizeTransfers = true;
    const slope = text.match(
      /(?:slope|incline|坡度|斜坡|pendiente)[^0-9]{0,14}(\d{1,2})\s*%?/,
    );
    if (slope) {
      const value = Math.min(12, Math.max(2, Number(slope[1])));
      needs.maxSlope = Number.isFinite(needs.maxSlope)
        ? Math.min(needs.maxSlope, value)
        : value;
    }
  }
}
