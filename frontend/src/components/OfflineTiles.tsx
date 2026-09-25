import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import { leafletLayer } from 'protomaps-leaflet'
import type { GridLayer } from 'leaflet'

// Protomaps extracts served by the backend from tiles/ — world.pmtiles to z6,
// region.pmtiles (Carolinas) to z14. Vector tiles, so both overzoom cleanly.
const REGION_BOUNDS: [[number, number], [number, number]] = [[32.0, -85.5], [37.0, -75.0]]
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>'

export default function OfflineTiles() {
  const map = useMap()
  useEffect(() => {
    // leafletLayer returns an L.GridLayer subclass; its .d.ts just doesn't say so
    const world  = leafletLayer({ url: '/tiles/world.pmtiles', flavor: 'dark', lang: 'en', maxDataZoom: 6, attribution: ATTRIB }) as unknown as GridLayer
    const region = leafletLayer({ url: '/tiles/region.pmtiles', flavor: 'dark', lang: 'en', maxDataZoom: 14, bounds: REGION_BOUNDS }) as unknown as GridLayer
    world.addTo(map)
    region.addTo(map)
    return () => { map.removeLayer(region); map.removeLayer(world) }
  }, [map])
  return null
}
