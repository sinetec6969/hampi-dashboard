import PlaceholderPage from './PlaceholderPage'

export default function MeshtasticPage() {
  return (
    <PlaceholderPage
      icon="🕸️"
      title="Meshtastic Mesh Network"
      color="#aa66ff"
      description="Monitor a Meshtastic LoRa mesh network via USB serial using the meshtastic Python package."
      features={[
        'Node map — positions plotted on Leaflet, labelled with short names',
        'Click node: long name, hardware model, firmware, last heard, SNR/RSSI, battery',
        'Message log — channel text messages with sender, timestamp, hop count',
        'Node list table: sortable, online/offline based on last heard (<15 min = online)',
        'Telemetry display: battery voltage, temperature, and environment data when reported',
        'Traceroute results shown when available',
      ]}
      hardware={[
        'Meshtastic-compatible LoRa device connected via USB (no SDR required)',
        'meshtastic Python package (pip install meshtastic)',
        'No RF TX licence required for receive-only monitoring',
      ]}
    />
  )
}
