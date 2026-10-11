class FamiliarCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.size = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      this.pending.push(new Float32Array(input));
      this.size += input.length;
      if (this.size >= sampleRate * 0.04) {
        const joined = new Float32Array(this.size);
        let offset = 0;
        for (const part of this.pending) {
          joined.set(part, offset);
          offset += part.length;
        }
        this.port.postMessage({ samples: joined, rate: sampleRate }, [
          joined.buffer,
        ]);
        this.pending = [];
        this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor("familiar-capture", FamiliarCapture);
