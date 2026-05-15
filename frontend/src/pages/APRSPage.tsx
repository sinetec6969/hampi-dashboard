import PlaceholderPage from './PlaceholderPage'

export default function APRSPage() {
  return (
    <PlaceholderPage
      icon="📻"
      title="APRS Packet Radio"
      color="#ff8844"
      description="Decode Automatic Packet Reporting System traffic on 144.390 MHz via direwolf TNC."
      features={[
        'Station map with standard APRS symbol icons (two-table symbol set)',
        'Click station: callsign, last heard, comment, path, packet type',
        'Scrollable packet log — timestamp, callsign, type, decoded summary',
        'Weather packet display (temperature, wind, rain) when WX data present',
        'Objects and items plotted on map alongside mobile stations',
        'Digipeater / igate capability via direwolf (optional TX path)',
      ]}
      hardware={[
        'RTL-SDR dongle (shared with DMR via time-division, or dedicated)',
        'direwolf in PATH',
        'Tuned to 144.390 MHz (North America) or regional equivalent',
      ]}
    />
  )
}
