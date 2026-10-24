import type { GameEvent, Ship } from "../shared/types";
import { bearing, clamp, dist } from "../shared/math";
import { HULLS, throttleSpeed } from "../shared/config";
import { RADIO_ORDERS, type RadioOrder } from "../shared/radio";

type Listener = { x: number; z: number; heading: number };
const FILES = {
  gun: "/audio/naval-gun.wav",
  heavy: "/audio/heavy-cannon.wav",
  tail: "/audio/distant-boom.wav",
  engine: "/audio/engine-loop.wav",
  wake: "/audio/wake-loop.wav",
  pressure: "/audio/torpedo-pressure.wav",
  splash: "/audio/torpedo-splash.wav",
};
const RADIO_FILES = Object.fromEntries(
  Object.keys(RADIO_ORDERS).map((k) => [k, `/audio/radio/${k}.wav?v=neural-1`]),
);
type VesselLoop = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
};
export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private reverb: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loaded: Promise<void> | null = null;
  private lastWarning = 0;
  private voices = 0;
  private shotsPlayed = 0;
  private torpedoesPlayed = 0;
  private loops = new Map<string, VesselLoop>();
  private engineGain = 0;
  private wakeGain = 0;
  private engineRate = 0;
  private lastOrders: { throttle: number; rudder: number } | null = null;
  private radioQueue = new Map<string, RadioOrder>();
  private radioSource: AudioBufferSourceNode | null = null;
  private radioUntil = 0;
  private radioOrder: RadioOrder | null = null;
  private radioPlayed = 0;
  radioEnabled = true;
  enabled = true;
  volume = 0.72;
  private sourceData = Promise.all(
    Object.entries({ ...FILES, ...RADIO_FILES }).map(async ([key, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw Error(`Audio asset unavailable: ${key}`);
      return [key, await response.arrayBuffer()] as const;
    }),
  );
  unlock() {
    if (!this.ctx) {
      const c = (this.ctx = new AudioContext());
      const highpass = c.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 24;
      highpass.Q.value = 0.7;
      const lowShelf = c.createBiquadFilter();
      lowShelf.type = "lowshelf";
      lowShelf.frequency.value = 95;
      lowShelf.gain.value = 4;
      const limiter = c.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.35;
      this.master = c.createGain();
      this.master.gain.value = this.volume;
      this.dry = c.createGain();
      this.dry.gain.value = 0.8;
      this.dry.connect(highpass);
      const outputLimiter = c.createDynamicsCompressor();
      outputLimiter.threshold.value = -1.5;
      outputLimiter.knee.value = 0;
      outputLimiter.ratio.value = 20;
      outputLimiter.attack.value = 0.001;
      outputLimiter.release.value = 0.1;
      highpass
        .connect(lowShelf)
        .connect(limiter)
        .connect(this.master)
        .connect(outputLimiter)
        .connect(c.destination);
      const convolver = c.createConvolver(),
        impulse = c.createBuffer(2, c.sampleRate * 3.7, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        let memory = 0;
        for (let n = 0; n < data.length; n++) {
          const time = n / c.sampleRate;
          memory = memory * 0.87 + (Math.random() * 2 - 1) * 0.13;
          data[n] =
            memory * Math.exp(-time * 1.65) * Math.min(1, time / 0.045) * 0.45;
        }
        for (const [time, gain] of [
          [0.13, 0.18],
          [0.29, 0.11],
          [0.51, 0.06],
        ])
          data[Math.floor((time + ch * 0.013) * c.sampleRate)] += gain;
      }
      convolver.buffer = impulse;
      this.reverb = c.createGain();
      this.reverb.gain.value = 0.23;
      this.reverb.connect(convolver);
      convolver.connect(highpass);
      this.loaded = this.sourceData
        .then(async (items) => {
          for (const [key, data] of items)
            this.buffers.set(key, await c.decodeAudioData(data));
        })
        .catch((e) => console.error(e));
    }
    void this.ctx.resume();
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.clearRadio();
    this.setVolume(this.volume);
    return this.enabled;
  }
  setVolume(value: number) {
    this.volume = clamp(value, 0, 1);
    if (this.ctx && this.master)
      this.master.gain.setTargetAtTime(
        this.enabled ? this.volume : 0,
        this.ctx.currentTime,
        0.025,
      );
  }
  get diagnostics() {
    return {
      ready:
        this.buffers.size ===
        Object.keys(FILES).length + Object.keys(RADIO_FILES).length,
      recordedAssets: Object.keys(FILES).filter((k) => this.buffers.has(k)),
      radioAssets: Object.keys(RADIO_FILES).filter((k) => this.buffers.has(k)),
      activeVoices: this.voices,
      shotsPlayed: this.shotsPlayed,
      volume: this.volume,
      torpedoesPlayed: this.torpedoesPlayed,
      vessel: {
        engineGain: this.engineGain,
        wakeGain: this.wakeGain,
        engineRate: this.engineRate,
        loops: this.loops.size,
      },
      radio: {
        enabled: this.radioEnabled,
        played: this.radioPlayed,
        order: this.radioOrder,
        text: this.radioOrder ? RADIO_ORDERS[this.radioOrder] : "",
        queued: this.radioQueue.size,
      },
    };
  }
  private loop(key: string): VesselLoop | undefined {
    if (this.loops.has(key)) return this.loops.get(key);
    const c = this.ctx,
      raw = this.buffers.get(key);
    if (!c || !raw || !this.dry) return;
    // Fold the recording's tail into its head so the wrap has no discontinuity.
    const fade = Math.floor(raw.sampleRate * 0.4),
      length = raw.length - fade;
    const buffer = c.createBuffer(raw.numberOfChannels, length, raw.sampleRate);
    for (let ch = 0; ch < raw.numberOfChannels; ch++) {
      const input = raw.getChannelData(ch),
        out = buffer.getChannelData(ch);
      out.set(input.subarray(0, length));
      for (let n = 0; n < fade; n++)
        out[n] = (input[n] * n) / fade + input[length + n] * (1 - n / fade);
    }
    const source = c.createBufferSource(),
      gain = c.createGain(),
      filter = c.createBiquadFilter();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 0;
    filter.type = "lowpass";
    source.connect(filter).connect(gain).connect(this.dry);
    source.start();
    const loop = { source, gain, filter };
    this.loops.set(key, loop);
    return loop;
  }
  updateVessel(ship: Ship | null) {
    const c = this.ctx;
    if (!c) return;
    const active = !!ship?.alive;
    if (!active) {
      this.lastOrders = null;
      this.clearRadio();
    } else if (ship) {
      const rudder = Math.sign(ship.input.rudder);
      if (this.lastOrders) {
        if (ship.input.throttle !== this.lastOrders.throttle)
          this.order(
            `${ship.input.throttle < this.lastOrders.throttle && ship.input.throttle > 1 ? "slow" : "throttle"}-${ship.input.throttle}` as RadioOrder,
          );
        if (rudder !== this.lastOrders.rudder)
          this.order(
            rudder < 0
              ? "helm-left"
              : rudder > 0
                ? "helm-right"
                : "helm-center",
          );
      }
      this.lastOrders = { throttle: ship.input.throttle, rudder };
    }
    this.pumpRadio();
    const speed = active
      ? clamp(Math.abs(ship!.speed) / HULLS[ship!.hull].speed, 0, 1)
      : 0;
    const load = active
      ? clamp(Math.abs(throttleSpeed[ship!.input.throttle]) - speed, 0, 1)
      : 0;
    const duck = this.radioSource ? 0.4 : 1;
    this.dry?.gain.setTargetAtTime(
      this.radioSource ? 0.58 : 0.8,
      c.currentTime,
      0.08,
    );
    this.engineGain = active ? (0.1 + speed * 0.25 + load * 0.07) * duck : 0;
    this.wakeGain = active ? Math.pow(speed, 1.5) * 0.5 * duck : 0;
    this.engineRate = active
      ? (ship!.hull === "battleship"
          ? 0.68
          : ship!.hull === "destroyer"
            ? 0.9
            : 0.78) +
        speed * 0.45 +
        load * 0.09
      : 0;
    for (const key of ["engine", "wake"]) {
      const loop = active ? this.loop(key) : this.loops.get(key);
      if (!loop) continue;
      loop.gain.gain.setTargetAtTime(
        key === "engine" ? this.engineGain : this.wakeGain,
        c.currentTime,
        0.25,
      );
      loop.source.playbackRate.setTargetAtTime(
        key === "engine" ? this.engineRate : 0.8 + speed * 0.4,
        c.currentTime,
        0.45,
      );
      loop.filter.frequency.setTargetAtTime(
        key === "engine" ? 420 + speed * 1600 : 1800 + speed * 4200,
        c.currentTime,
        0.3,
      );
    }
  }
  private order(order: RadioOrder) {
    if (!this.enabled || !this.radioEnabled) return;
    this.radioQueue.set(order.startsWith("helm") ? "helm" : "engine", order);
  }
  toggleRadio() {
    this.radioEnabled = !this.radioEnabled;
    if (!this.radioEnabled) this.clearRadio();
    return this.radioEnabled;
  }
  private clearRadio() {
    this.radioQueue.clear();
    if (this.radioSource) {
      this.radioSource.stop();
      this.radioSource = null;
    }
    this.radioOrder = null;
  }
  private pumpRadio() {
    const c = this.ctx;
    if (
      !c ||
      !this.master ||
      !this.enabled ||
      !this.radioEnabled ||
      this.radioSource ||
      c.currentTime < this.radioUntil
    )
      return;
    const first = this.radioQueue.entries().next().value as
      [string, RadioOrder] | undefined;
    if (!first) return;
    const [group, order] = first,
      buffer = this.buffers.get(order);
    if (!buffer) return;
    this.radioQueue.delete(group);
    const source = c.createBufferSource(),
      gain = c.createGain();
    source.buffer = buffer;
    gain.gain.value = 0.88;
    source.connect(gain).connect(this.master);
    this.radioSource = source;
    this.radioOrder = order;
    this.radioPlayed++;
    this.radioUntil = c.currentTime + buffer.duration + 0.18;
    source.onended = () => {
      if (this.radioSource === source) {
        this.radioSource = null;
        this.radioOrder = null;
      }
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  }
  private play(
    key: string,
    at: number,
    gain: number,
    rate: number,
    pan: number,
    cutoff = 16000,
    bass = false,
  ) {
    const c = this.ctx,
      buffer = this.buffers.get(key);
    if (!c || !buffer || !this.dry || !this.reverb || this.voices > 28) return;
    const source = c.createBufferSource(),
      filter = c.createBiquadFilter(),
      level = c.createGain(),
      stereo = c.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    filter.type = bass ? "bandpass" : "lowpass";
    filter.frequency.value = bass ? 65 : cutoff;
    filter.Q.value = bass ? 0.65 : 0.5;
    level.gain.value = gain;
    stereo.pan.value = pan;
    source.connect(filter).connect(level).connect(stereo);
    stereo.connect(this.dry);
    if (!bass) stereo.connect(this.reverb);
    this.voices++;
    source.onended = () => {
      this.voices--;
      source.disconnect();
      filter.disconnect();
      level.disconnect();
      stereo.disconnect();
    };
    source.start(at);
  }
  event(e: GameEvent, own: boolean, listener?: Listener) {
    if (!this.ctx || !this.enabled) return;
    if (!this.buffers.has("splash")) {
      void this.loaded?.then(() => {
        if (this.buffers.has("splash")) this.event(e, own, listener);
      });
      return;
    }
    const c = this.ctx,
      position = listener ?? { x: e.x, z: e.z, heading: 0 },
      distance = own && e.type === "shot" ? 0 : dist(position, e),
      pan = -Math.sin(bearing(position, e) - position.heading) * 0.8;
    const attenuation =
        own && e.type === "shot" ? 1 : 1 / Math.pow(1 + distance / 190, 0.85),
      at = c.currentTime + Math.min(3, distance / 343),
      cutoff = 16000 / (1 + distance / 190);
    if (e.type === "shot" && e.text === "MINE") {
      this.play("pressure", at, attenuation * 0.22, 1.4, pan, 1800);
      this.play("splash", at + 0.1, attenuation * 0.4, 0.85, pan, cutoff);
      return;
    }
    if (e.type === "shot" && e.text === "RBU") {
      for (let n = 0; n < (e.count ?? 6); n++)
        this.play(
          "pressure",
          at + n * 0.075,
          attenuation * 0.32,
          1.8,
          pan,
          cutoff,
        );
      this.play("gun", at, attenuation * 0.25, 1.35, pan, cutoff);
      return;
    }
    if (e.type === "intercept") {
      this.play("heavy", at, attenuation * 0.35, 1.2, pan, 1800);
      return;
    }
    if (e.type === "shot" && e.text !== "TORP") {
      this.shotsPlayed++;
      const heavy = (e.caliber ?? 203) >= 300,
        secondary = e.text === "SECONDARY";
      const weight = secondary ? 0.22 : heavy ? 1 : 0.68,
        spread = Math.min(1.35, 1 + (e.turrets?.length ?? 1) * 0.08);
      this.play(
        "gun",
        at,
        attenuation * weight * spread,
        heavy ? 0.82 : secondary ? 1.3 : 1,
        pan,
        cutoff,
      );
      if (!secondary) {
        this.play(
          "heavy",
          at + 0.018,
          attenuation * (heavy ? 0.65 : 0.32),
          heavy ? 0.72 : 0.95,
          pan * 0.6,
          Math.min(cutoff, 2400),
        );
        this.play(
          "tail",
          at + 0.08,
          attenuation * (heavy ? 0.76 : 0.37),
          heavy ? 0.67 : 0.9,
          pan,
          Math.min(cutoff, 950),
        );
        this.play(
          "heavy",
          at + 0.012,
          attenuation * (heavy ? 1.2 : 0.55),
          0.48,
          pan * 0.25,
          100,
          true,
        );
      }
    } else if (e.type === "hit" || e.type === "sink") {
      const big =
        e.type === "sink" ||
        e.result === "torpedo" ||
        e.result === "citadel" ||
        e.result === "mine";
      this.play(
        "heavy",
        at,
        attenuation * (big ? 0.75 : 0.25),
        big ? 0.73 : 1.1,
        pan,
        cutoff,
      );
      if (big) {
        this.play("tail", at + 0.06, attenuation * 0.75, 0.72, pan, 1200);
        this.play("heavy", at, attenuation * 0.8, 0.45, pan, 100, true);
      }
    } else if (e.type === "splash") {
      if (e.text === "island")
        this.play("heavy", at, attenuation * 0.35, 1.1, pan, cutoff);
      else {
        const large = (e.caliber ?? 203) >= 300;
        this.play(
          "splash",
          at,
          attenuation * (large ? 1.45 : 1.05),
          large ? 0.76 : 0.96,
          pan,
          cutoff,
        );
        this.play(
          "heavy",
          at + 0.015,
          attenuation * (large ? 0.45 : 0.2),
          0.65,
          pan,
          100,
          true,
        );
        if (large)
          this.play("tail", at + 0.05, attenuation * 0.32, 0.85, pan, 1100);
      }
    } else if (e.type === "shot" && e.text === "TORP") {
      this.torpedoesPlayed++;
      // A tube pressure burst followed by three staggered water entries.
      this.play("pressure", at, attenuation * 0.95, 0.9, pan, cutoff);
      for (let n = 0; n < 3; n++)
        this.play(
          "splash",
          at + 0.14 + n * 0.11,
          attenuation * 0.42,
          0.88 + n * 0.055,
          pan,
          Math.min(cutoff, 8000),
        );
    } else if (e.type === "level") this.tone(900, 0.2, 0.045);
  }
  private tone(frequency: number, duration: number, gain: number) {
    if (!this.ctx || !this.enabled || !this.master) return;
    const c = this.ctx,
      o = c.createOscillator(),
      g = c.createGain();
    o.type = "sine";
    o.frequency.value = frequency;
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(c.currentTime + duration);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }
  /** Rising two-note chime for collecting a supply crate. */
  pickup() {
    this.tone(660, 0.18, 0.07);
    setTimeout(() => this.tone(990, 0.28, 0.07), 110);
  }
  warning() {
    if (performance.now() - this.lastWarning < 1200) return;
    this.lastWarning = performance.now();
    this.tone(800, 0.15, 0.06);
  }
}
