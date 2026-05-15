import PlaceholderPage from './PlaceholderPage'

export default function ADSBPage() {
  return (
    <PlaceholderPage
      icon="✈️"
      title="ADS-B Aircraft Tracking"
      color="#4488ff"
      description="Live aircraft map from 1090 MHz ADS-B transponder broadcasts decoded by dump1090-fa."
      features={[
        'Live Leaflet map — aircraft plotted as heading-aware icons',
        'Click aircraft: callsign, squawk, altitude, speed, vertical rate, ICAO hex',
        'Track history — last N positions drawn as a polyline per aircraft',
        'Altitude colour-coded icons (ground / low / mid / high)',
        'Side table: sortable by distance, altitude, or callsign',
        'ICAO → airline/registration lookup via local aircraft.json database',
      ]}
      hardware={[
        'Dedicated RTL-SDR dongle on 1090 MHz',
        'dump1090-fa or readsb in PATH',
        'Raspberry Pi 5 recommended for simultaneous DMR + ADS-B',
      ]}
    />
  )
}
