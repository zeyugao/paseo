import { describe, expect, test } from "vitest";
import { TimelineDeliveryWindow, type TimelineDeliveryPermit } from "./timeline-delivery.js";

const PAGE_BYTES = 16 * 1024;
const RESERVATION_BYTES = 96 * 1024;
const BUDGET_BYTES = 2 * 1024 * 1024;

interface PendingDelivery {
  permit: TimelineDeliveryPermit;
  release: () => void;
}

function createClock() {
  let time = 0;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

async function requirePermit(window: TimelineDeliveryWindow): Promise<TimelineDeliveryPermit> {
  const permit = await window.acquire();
  if (permit === null) throw new Error("Expected an admitted timeline delivery");
  return permit;
}

async function flushDeliveries(): Promise<void> {
  // Admission and the deferred physical-send/receipt completion each resume once.
  await Promise.resolve();
  await Promise.resolve();
}

async function createBacklog() {
  const clock = createClock();
  const abort = new AbortController();
  const window = new TimelineDeliveryWindow({
    signal: abort.signal,
    adaptive: true,
    now: clock.now,
  });
  let pageBytes = PAGE_BYTES;
  const ready: PendingDelivery[] = [];
  const work: Promise<void>[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    work.push(
      window.acquire().then(async (permit) => {
        if (permit === null) return undefined;
        const { promise, resolve } = Promise.withResolvers<void>();
        permit.prepared(pageBytes);
        ready.push({ permit, release: resolve });
        await promise;
        permit.complete();
        return undefined;
      }),
    );
  }
  await flushDeliveries();

  async function completeNext(ms: number): Promise<void> {
    clock.advance(ms);
    const delivery = ready.shift();
    if (delivery === undefined) throw new Error("No prepared delivery to complete");
    delivery.release();
    await flushDeliveries();
  }

  async function growTo(concurrency: number): Promise<void> {
    for (let index = 0; index < 200 && window.concurrency < concurrency; index += 1) {
      // A fixed 100ms service time per delivery scales goodput with useful slots.
      await completeNext(100 / window.concurrency);
    }
    expect(window.concurrency).toBe(concurrency);
    expect(ready).toHaveLength(concurrency);
  }

  async function finish(): Promise<void> {
    abort.abort();
    for (const delivery of ready) delivery.release();
    await Promise.all(work);
  }

  return {
    window,
    clock,
    abort,
    ready,
    completeNext,
    growTo,
    finish,
    setPageBytes(bytes: number) {
      pageBytes = bytes;
    },
  };
}

describe("TimelineDeliveryWindow", () => {
  test("admits preparation serially first and grows when parallel deliveries improve goodput", async () => {
    const backlog = await createBacklog();
    expect(backlog.window.concurrency).toBe(1);
    expect(backlog.ready).toHaveLength(1);

    await backlog.growTo(3);
    expect(backlog.window.inFlight).toBe(3);
    expect(backlog.window.outstandingBytes).toBe(3 * PAGE_BYTES);

    await backlog.growTo(8);
    for (let index = 0; index < 80; index += 1) await backlog.completeNext(12.5);
    expect(backlog.window.concurrency).toBe(8);
    expect(backlog.ready).toHaveLength(8);
    await backlog.finish();
  });

  test("requires enough completions and elapsed time before probing", async () => {
    const backlog = await createBacklog();
    for (let index = 0; index < 7; index += 1) await backlog.completeNext(100);
    expect(backlog.window.concurrency).toBe(1);
    await backlog.completeNext(100);
    expect(backlog.window.concurrency).toBe(2);
    await backlog.finish();

    const fast = await createBacklog();
    for (let index = 0; index < 20; index += 1) await fast.completeNext(1);
    expect(fast.window.concurrency).toBe(1);
    await fast.completeNext(480);
    expect(fast.window.concurrency).toBe(2);
    await fast.finish();
  });

  test("does not count completions admitted under the previous concurrency", async () => {
    const backlog = await createBacklog();
    await backlog.growTo(3);
    // The remaining two-slot flight cannot count toward the new probe's sample.
    await backlog.completeNext(1_000);
    for (let index = 0; index < 7; index += 1) await backlog.completeNext(100);
    expect(backlog.window.concurrency).toBe(3);
    await backlog.completeNext(100);
    expect(backlog.window.concurrency).toBe(1);
    await backlog.finish();
  });

  test("does not treat idle time or demand without backlog as evidence for growth", async () => {
    const clock = createClock();
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({
      signal: abort.signal,
      adaptive: true,
      now: clock.now,
    });
    for (let index = 0; index < 20; index += 1) {
      const permit = await requirePermit(window);
      permit.prepared(PAGE_BYTES);
      clock.advance(100);
      permit.complete();
      clock.advance(1_000);
    }
    expect(window.concurrency).toBe(1);
    expect(window.inFlight).toBe(0);
    expect(window.outstandingBytes).toBe(0);
    abort.abort();
  });

  test("rolls a plateau back one slot and waits through cooldown before probing again", async () => {
    const backlog = await createBacklog();
    await backlog.growTo(4);
    // Four slots deliver no more bytes per second than the proven three slots.
    for (let index = 0; index < 18; index += 1) await backlog.completeNext(100 / 3);
    expect(backlog.window.concurrency).toBe(3);
    expect(backlog.ready).toHaveLength(3);

    for (let index = 0; index < 120; index += 1) await backlog.completeNext(100 / 3);
    expect(backlog.window.concurrency).toBe(3);
    await backlog.growTo(4);
    await backlog.finish();
  });

  test("halves concurrency on a sustained drop in successful delivery goodput", async () => {
    const backlog = await createBacklog();
    await backlog.growTo(4);
    for (let index = 0; index < 10; index += 1) await backlog.completeNext(150);
    expect(backlog.window.concurrency).toBe(2);
    expect(backlog.ready).toHaveLength(3);
    await backlog.completeNext(150);
    expect(backlog.ready).toHaveLength(2);

    for (let index = 0; index < 8; index += 1) await backlog.completeNext(150);
    expect(backlog.window.concurrency).toBe(2);
    await backlog.finish();
  });

  test("backs off admission when the oldest active delivery becomes stale", async () => {
    const backlog = await createBacklog();
    await backlog.growTo(4);
    backlog.clock.advance(10_000);
    const waiting = backlog.window.acquire();
    expect(backlog.window.concurrency).toBe(2);
    expect(backlog.window.inFlight).toBe(4);
    backlog.abort.abort();
    expect(await waiting).toBeNull();
    await backlog.finish();
  });

  test("reserves preparation bytes and updates the reservation only once", async () => {
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({ signal: abort.signal, adaptive: true });
    const permit = await requirePermit(window);
    expect(window.outstandingBytes).toBe(RESERVATION_BYTES);
    permit.prepared(PAGE_BYTES);
    permit.prepared(BUDGET_BYTES);
    expect(window.outstandingBytes).toBe(PAGE_BYTES);
    permit.complete();
    permit.complete();
    permit.cancel();
    permit.prepared(BUDGET_BYTES);
    expect(window.inFlight).toBe(0);
    expect(window.outstandingBytes).toBe(0);
    abort.abort();
  });

  test("stops admitting preparation under byte pressure and permits consecutive oversized pages", async () => {
    const backlog = await createBacklog();
    await backlog.growTo(4);
    // Preparing work is allowed to overshoot; no new work starts until it drains.
    backlog.setPageBytes(BUDGET_BYTES * 2);
    await backlog.completeNext(0);
    expect(backlog.window.concurrency).toBe(2);
    expect(backlog.window.outstandingBytes).toBe(BUDGET_BYTES * 2 + 3 * PAGE_BYTES);
    expect(backlog.ready).toHaveLength(4);
    for (let index = 0; index < 3; index += 1) await backlog.completeNext(0);
    expect(backlog.window.inFlight).toBe(1);
    expect(backlog.window.outstandingBytes).toBe(BUDGET_BYTES * 2);
    expect(backlog.ready).toHaveLength(1);
    await backlog.completeNext(0);
    expect(backlog.window.inFlight).toBe(1);
    expect(backlog.window.outstandingBytes).toBe(BUDGET_BYTES * 2);
    expect(backlog.ready).toHaveLength(1);
    await backlog.finish();
  });

  test("cancelled work releases its reservation without contributing successful samples", async () => {
    const clock = createClock();
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({
      signal: abort.signal,
      adaptive: true,
      now: clock.now,
    });
    let permit = await requirePermit(window);
    for (let index = 0; index < 20; index += 1) {
      const next = window.acquire();
      permit.prepared(PAGE_BYTES);
      clock.advance(100);
      permit.cancel();
      permit.complete();
      const admitted = await next;
      if (admitted === null) throw new Error("Cancellation must release the next delivery");
      permit = admitted;
    }
    expect(window.concurrency).toBe(1);
    expect(window.outstandingBytes).toBe(RESERVATION_BYTES);
    permit.cancel();
    expect(window.outstandingBytes).toBe(0);
    abort.abort();
  });

  test("aborting releases every queued acquire and active permit exactly once", async () => {
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({ signal: abort.signal, adaptive: true });
    const active = await requirePermit(window);
    active.prepared(PAGE_BYTES);
    const waiting = [window.acquire(), window.acquire(), window.acquire()];
    abort.abort();
    expect(await Promise.all(waiting)).toEqual([null, null, null]);
    active.complete();
    active.cancel();
    active.prepared(BUDGET_BYTES);
    expect(window.inFlight).toBe(0);
    expect(window.outstandingBytes).toBe(0);
    expect(await window.acquire()).toBeNull();

    const alreadyClosed = new TimelineDeliveryWindow({ signal: abort.signal, adaptive: true });
    expect(await alreadyClosed.acquire()).toBeNull();
  });

  test("preserves admission order and releases remaining waiters after a large burst", async () => {
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({ signal: abort.signal, adaptive: false });
    let permit = await requirePermit(window);
    const order: number[] = [];
    const waiting: Array<Promise<TimelineDeliveryPermit | null>> = [];
    for (let index = 0; index < 2_100; index += 1) {
      waiting.push(
        window.acquire().then((admitted) => {
          if (admitted !== null) order.push(index);
          return admitted;
        }),
      );
    }
    for (let index = 0; index < 1_100; index += 1) {
      permit.complete();
      const admitted = await waiting[index]!;
      if (admitted === null) throw new Error("Expected FIFO admission before abort");
      permit = admitted;
    }
    expect(order).toEqual(Array.from({ length: 1_100 }, (_, index) => index));
    abort.abort();
    expect(await Promise.all(waiting.slice(1_100))).toEqual(
      Array.from({ length: 1_000 }, () => null),
    );
    permit.cancel();
    expect(window.inFlight).toBe(0);
    expect(window.outstandingBytes).toBe(0);
  });

  test("legacy delivery stays serial under sustained queued demand", async () => {
    const clock = createClock();
    const abort = new AbortController();
    const window = new TimelineDeliveryWindow({
      signal: abort.signal,
      adaptive: false,
      now: clock.now,
    });
    let permit = await requirePermit(window);
    let admitted = 0;
    for (let index = 0; index < 30; index += 1) {
      const next = window.acquire().then((value) => {
        admitted += 1;
        return value;
      });
      permit.prepared(PAGE_BYTES);
      clock.advance(100);
      await flushDeliveries();
      expect(admitted).toBe(index);
      expect(window.inFlight).toBe(1);
      permit.complete();
      const nextPermit = await next;
      if (nextPermit === null) throw new Error("Expected serial legacy delivery");
      permit = nextPermit;
    }
    expect(window.concurrency).toBe(1);
    expect(admitted).toBe(30);
    permit.cancel();
    abort.abort();
  });
});
