/**
 * PCMProcessor — AudioWorklet for gapless PCM streaming.
 *
 * Main thread sends resampled Float32 chunks via port.postMessage().
 * process() drains from a queue at the hardware audio rate.
 * Outputs silence during underruns; re-primes automatically when enough
 * samples have accumulated to hide the initial network jitter.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    // Target buffer depth before first playback (samples at context rate).
    // Passed from main thread as processorOptions.targetSamples.
    this._target  = (options.processorOptions || {}).targetSamples || 4800  // ~100 ms @48 kHz
    this._primed  = false
    this._chunks  = []   // queue of Float32Array chunks
    this._total   = 0    // total samples queued
    this._offset  = 0    // read offset into chunks[0]

    this.port.onmessage = ({ data }) => {
      if (data instanceof Float32Array && data.length > 0) {
        this._chunks.push(data)
        this._total += data.length

        if (!this._primed && this._total >= this._target) {
          this._primed = true
        }

        // Hard cap: discard oldest chunks beyond 3 seconds of audio
        const cap = sampleRate * 3
        while (this._total - this._offset > cap && this._chunks.length > 1) {
          const dropped = this._chunks.shift()
          this._total  -= dropped.length
          this._offset  = 0
        }
      } else if (data === 'reset') {
        this._chunks  = []
        this._total   = 0
        this._offset  = 0
        this._primed  = false
      }
    }
  }

  process(_inputs, outputs) {
    const out  = outputs[0][0]
    const need = out.length   // always 128 at context rate

    if (!this._primed) {
      out.fill(0)
      return true
    }

    let filled = 0
    while (filled < need) {
      if (this._chunks.length === 0) break

      const chunk = this._chunks[0]
      const avail = chunk.length - this._offset
      const take  = Math.min(avail, need - filled)

      out.set(chunk.subarray(this._offset, this._offset + take), filled)
      filled        += take
      this._offset  += take
      this._total   -= take

      if (this._offset >= chunk.length) {
        this._chunks.shift()
        this._offset = 0
      }
    }

    // Silence for underrun frames
    for (let i = filled; i < need; i++) out[i] = 0

    // Re-prime if we fully drained (next transmission needs buffering)
    if (this._chunks.length === 0 && filled < need) {
      this._primed = false
    }

    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
