const PREPARATION_BYTES = 96 * 1024;
const BYTE_BUDGET = 2 * 1024 * 1024;
const MAX_CONCURRENCY = 8;
const MIN_SAMPLE_COUNT = 8;
const MIN_SAMPLE_MS = 500;
const COOLDOWN_MS = 5_000;
const MIN_PROBE_GAIN = 1.1;
const CONGESTION_GOODPUT_RATIO = 0.75;
const CONGESTION_LATENCY_RATIO = 2;
const STALE_DELIVERY_MS = 10_000;

export interface TimelineDeliveryPermit {
  prepared(bytes: number): void;
  complete(): void;
  cancel(): void;
}

interface TimelineDeliveryOptions {
  signal: AbortSignal;
  adaptive: boolean;
  now?: () => number;
}

interface DeliveryMeasurement {
  concurrency: number;
  goodput: number;
  latency: number;
}

interface DeliverySample {
  startedAt: number;
  count: number;
  bytes: number;
  latency: number;
}

interface ActiveDelivery {
  startedAt: number;
  generation: number;
}

type DeliveryWaiter = (permit: TimelineDeliveryPermit | null) => void;

/** One physical source shares admission across root and child history deliveries. */
export class TimelineDeliveryWindow {
  private readonly adaptive: boolean;
  private readonly now: () => number;
  private readonly waiters: Array<DeliveryWaiter | null> = [];
  private waiterHead = 0;
  private readonly deliveries = new Set<ActiveDelivery>();
  private closed = false;
  private limit = 1;
  private generation = 0;
  private bytes = 0;
  private preparationBytes = PREPARATION_BYTES;
  private sample: DeliverySample | null = null;
  private baseline: DeliveryMeasurement | null = null;
  private cooldownUntil = 0;

  constructor(options: TimelineDeliveryOptions) {
    this.adaptive = options.adaptive;
    this.now = options.now ?? performance.now.bind(performance);
    if (options.signal.aborted) {
      this.closed = true;
      return;
    }
    options.signal.addEventListener("abort", () => this.abort(), { once: true });
  }

  get concurrency(): number {
    return this.limit;
  }

  get outstandingBytes(): number {
    return this.bytes;
  }

  get inFlight(): number {
    return this.deliveries.size;
  }

  acquire(): Promise<TimelineDeliveryPermit | null> {
    if (this.closed) return Promise.resolve(null);
    let resume!: DeliveryWaiter;
    const promise = new Promise<TimelineDeliveryPermit | null>((resolve) => {
      resume = resolve;
    });
    this.checkStale(this.now());
    this.waiters.push(resume);
    this.drain();
    return promise;
  }

  private canAdmit(): boolean {
    if (this.deliveries.size >= this.limit) return false;
    // Reservations are estimates: an already preparing page may exceed the budget.
    // The empty-window exception also lets the next oversized page make progress.
    return this.deliveries.size === 0 || this.bytes + this.preparationBytes <= BYTE_BUDGET;
  }

  private isSaturated(): boolean {
    const hasBacklog = this.waiterHead < this.waiters.length;
    const atLimit = this.deliveries.size >= this.limit;
    const hasByteHeadroom = this.bytes + this.preparationBytes <= BYTE_BUDGET;
    return hasBacklog && atLimit && hasByteHeadroom;
  }

  private drain(): void {
    while (this.waiterHead < this.waiters.length && this.canAdmit()) {
      const resolve = this.waiters[this.waiterHead]!;
      this.waiters[this.waiterHead] = null;
      this.waiterHead += 1;
      resolve(this.admit());
    }
    if (this.waiterHead === this.waiters.length) {
      this.waiters.length = 0;
      this.waiterHead = 0;
    } else if (this.waiterHead >= 1_024 && this.waiterHead * 2 >= this.waiters.length) {
      this.waiters.splice(0, this.waiterHead);
      this.waiterHead = 0;
    }
    if (!this.adaptive || !this.isSaturated()) {
      this.sample = null;
      return;
    }
    if (this.sample === null) {
      this.sample = { startedAt: this.now(), count: 0, bytes: 0, latency: 0 };
    }
  }

  private admit(): TimelineDeliveryPermit {
    const startedAt = this.now();
    const delivery = { startedAt, generation: this.generation };
    let reservedBytes = this.preparationBytes;
    let prepared = false;
    let settled = false;
    this.deliveries.add(delivery);
    this.bytes += reservedBytes;

    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      if (this.closed) return;
      this.checkStale(this.now());
      const currentGeneration = delivery.generation === this.generation;
      const successfulSample = success && prepared && currentGeneration;
      if (successfulSample && this.isSaturated()) {
        this.record(reservedBytes, this.now() - startedAt);
      } else {
        // Old admissions, cancellation and demand gaps cannot validate a probe.
        this.sample = null;
      }
      this.deliveries.delete(delivery);
      this.bytes -= reservedBytes;
      this.drain();
    };

    return {
      prepared: (bytes) => {
        if (settled || prepared || this.closed) return;
        prepared = true;
        // Reuse the observed size so consecutive oversized pages do not fan out
        // before their actual sizes are known.
        this.preparationBytes = Math.max(PREPARATION_BYTES, bytes);
        this.bytes += bytes - reservedBytes;
        reservedBytes = bytes;
        if (this.bytes > BYTE_BUDGET) this.backoff(this.now());
        this.drain();
      },
      complete: () => finish(true),
      cancel: () => finish(false),
    };
  }

  private record(bytes: number, latency: number): void {
    if (this.sample === null) return;
    this.sample.count += 1;
    this.sample.bytes += bytes;
    this.sample.latency += latency;
    const now = this.now();
    const elapsed = now - this.sample.startedAt;
    if (this.sample.count < MIN_SAMPLE_COUNT || elapsed < MIN_SAMPLE_MS) return;
    const measurement: DeliveryMeasurement = {
      concurrency: this.limit,
      goodput: this.sample.bytes / elapsed,
      latency: this.sample.latency / this.sample.count,
    };
    this.sample = null;
    if (now < this.cooldownUntil) return;

    if (this.baseline !== null) {
      const goodputRatio = measurement.goodput / this.baseline.goodput;
      // More useful parallel work naturally raises per-delivery latency. Compare
      // latency per slot so that this expected increase is not congestion.
      const latencyPerSlot = measurement.latency / measurement.concurrency;
      const baselineLatencyPerSlot = this.baseline.latency / this.baseline.concurrency;
      const lostGoodput = goodputRatio < CONGESTION_GOODPUT_RATIO;
      const inflatedLatency = latencyPerSlot > baselineLatencyPerSlot * CONGESTION_LATENCY_RATIO;
      if (lostGoodput || inflatedLatency) {
        this.backoff(now);
        return;
      }
      const probing = this.limit > this.baseline.concurrency;
      if (probing && goodputRatio < MIN_PROBE_GAIN) {
        // A plateau rejects just the extra slot, not the proven operating point.
        this.resize(this.baseline.concurrency);
        this.baseline = null;
        this.cooldownUntil = now + COOLDOWN_MS;
        return;
      }
    }

    this.baseline = measurement;
    this.resize(Math.min(MAX_CONCURRENCY, this.limit + 1));
  }

  private resize(limit: number): void {
    if (limit === this.limit) return;
    this.limit = limit;
    this.generation += 1;
    this.sample = null;
  }

  private checkStale(now: number): void {
    const oldest = this.deliveries.values().next().value;
    if (oldest === undefined) return;
    const latency = this.baseline === null ? 0 : this.baseline.latency;
    const deadline = Math.max(STALE_DELIVERY_MS, latency * 4);
    if (now - oldest.startedAt >= deadline) this.backoff(now);
  }

  private backoff(now: number): void {
    this.sample = null;
    if (now < this.cooldownUntil) return;
    this.resize(Math.max(1, Math.floor(this.limit / 2)));
    this.baseline = null;
    this.cooldownUntil = now + COOLDOWN_MS;
  }

  private abort(): void {
    this.closed = true;
    this.deliveries.clear();
    this.bytes = 0;
    this.sample = null;
    this.baseline = null;
    for (let index = this.waiterHead; index < this.waiters.length; index += 1) {
      this.waiters[index]!(null);
    }
    this.waiters.length = 0;
    this.waiterHead = 0;
  }
}
