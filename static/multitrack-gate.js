class MultitrackNoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -80, minValue: -80, maxValue: -20, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.25, minValue: 0.035, maxValue: 0.5, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.level = 0;
    this.gain = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const threshold = Math.pow(10, (parameters.threshold[0] ?? -80) / 20);
    const release = parameters.release[0] ?? 0.25;
    const attackCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.008));
    const releaseCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.025));
    const closeCoefficient = 1 - Math.exp(-1 / (sampleRate * release));
    const openCoefficient = 1 - Math.exp(-1 / (sampleRate * 0.008));

    for (let frame = 0; frame < output[0].length; frame++) {
      let peak = 0;
      for (let channel = 0; channel < input.length; channel++) peak = Math.max(peak, Math.abs(input[channel][frame] || 0));
      const levelCoefficient = peak > this.level ? attackCoefficient : releaseCoefficient;
      this.level += (peak - this.level) * levelCoefficient;
      const target = this.level >= threshold ? 1 : 0;
      this.gain += (target - this.gain) * (target ? openCoefficient : closeCoefficient);
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = (input[Math.min(channel, input.length - 1)]?.[frame] || 0) * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('multitrack-noise-gate', MultitrackNoiseGate);
