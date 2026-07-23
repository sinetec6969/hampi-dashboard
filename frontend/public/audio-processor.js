/**
 * PCMProcessor — AudioWorklet for gapless PCM streaming.
 *
 * Main thread sends resampled Float32 chunks via port.postMessage().
 * process() drains from a queue at the hardware audio rate.
 * Outputs silence during underruns and re-primes (waits for the buffer to
 * refill to target) after each one, growing the target up to 200 ms so the
 * jitter buffer adapts to the observed burst gaps.
 * Posts {depth_ms, target_ms, underruns} stats back to the main thread ~1 Hz.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    // Target buffer depth before playback (samples at context rate).
    // Passed from main thread as processorOptions.targetSamples.
    this._target    = (options.processorOptions || {}).targetSamples || 7200  // ~150 ms @48 kHz
    this._maxTarget = sampleRate * 0.2
    this._primed    = false
    this._chunks    = []   // queue of Float32Array chunks
    this._total     = 0    // unconsumed samples queued
    this._offset    = 0    // read offset into chunks[0]
    this._underruns = 0
    this._frames    = 0

    this.port.onmessage = ({ data }) => {
      if (data instanceof Float32Array && data.length > 0) {
        this._chunks.push(data)
        this._total += data.length

        if (!this._primed && this._total >= this._target) {
          this._primed = true
        }

        // Hard cap: discard oldest chunks beyond 3 seconds of audio
        const cap = sampleRate * 3
        while (this._total > cap && this._chunks.length > 1) {
          const dropped = this._chunks.shift()
          this._total  -= dropped.length - this._offset
          this._offset  = 0
        }
      } else if (data === 'reset') {
        this._chunks    = []
        this._total     = 0
        this._offset    = 0
        this._primed    = false
        this._underruns = 0
      }
    }
  }

  process(_inputs, outputs) {
    const out  = outputs[0][0]
    const need = out.length   // always 128 at context rate

    if (++this._frames % 375 === 0 && (this._primed || this._total > 0)) {
      this.port.postMessage({
        depth_ms:  Math.round(this._total / sampleRate * 1000),
        target_ms: Math.round(this._target / sampleRate * 1000),
        underruns: this._underruns,
      })
    }

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

    if (filled < need) {
      // Underrun: silence, re-prime, and widen the jitter buffer.
      this._underruns++
      this._primed = false
      this._target = Math.min(this._target * 1.33, this._maxTarget)
      for (let i = filled; i < need; i++) out[i] = 0
    }

    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
