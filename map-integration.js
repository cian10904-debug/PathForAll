// @ts-check
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { NYC_CENTER } from "./osm-network.js";

export function createBaseMap() {
  // Vite changes the module location, so MapLibre's relative worker URL is not valid.
  maplibregl.setWorkerUrl(mapWorkerUrl);
  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: [
            import.meta.env.VITE_MAP_RASTER_TILES ||
              "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [NYC_CENTER[0], NYC_CENTER[1]],
    zoom: 10.2,
    maxZoom: 19,
    attributionControl: {},
  });

  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "bottom-right",
  );
  return map;
}
