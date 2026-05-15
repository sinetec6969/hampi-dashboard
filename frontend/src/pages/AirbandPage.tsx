import PlaceholderPage from './PlaceholderPage'

export default function AirbandPage() {
  return (
    <PlaceholderPage
      icon="🛩"
      title="Airband AM Reception"
      color="#44ccff"
      description="VHF airband voice reception (118–137 MHz) with AM demodulation and configurable frequency scanner."
      features={[
        'AM demodulation — envelope detection with AGC, same SDR pipeline as DMR',
        'Scanner mode — cycle a named frequency list with configurable dwell time',
        'Squelch — hold on active frequency when signal detected; resume scan on silence',
        'Frequency list from config.yaml (ATIS, Ground, Tower, Approach, Guard, CTAF…)',
        'Audio playback via existing AudioWorklet pipeline',
        'Active frequency highlighted in the frequency list panel',
      ]}
      hardware={[
        'RTL-SDR dongle (second dongle recommended for simultaneous DMR + airband)',
        'Coverage: 118–137 MHz VHF airband',
        'Whip or discone antenna with coverage in the 100–200 MHz range',
      ]}
    />
  )
}
