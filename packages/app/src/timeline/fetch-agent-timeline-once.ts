import type {
  DaemonClient,
  FetchAgentTimelineOptions,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";

type TimelineClient = Pick<DaemonClient, "fetchAgentTimeline">;
type TimelineRequest = FetchAgentTimelineOptions | undefined;
type TimelinePage = FetchAgentTimelinePayload;
type TimelineResponseHandler = NonNullable<NonNullable<TimelineRequest>["onResponse"]>;

interface TimelineRead {
  promise: Promise<TimelinePage>;
  handlers: TimelineResponseHandler[];
}

const inFlightByClient = new WeakMap<object, Map<string, TimelineRead>>();

export function fetchAgentTimelineOnce(
  client: TimelineClient,
  agentId: string,
  request: TimelineRequest,
): Promise<TimelinePage> {
  let inFlight = inFlightByClient.get(client);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByClient.set(client, inFlight);
  }

  const { onResponse, ...wireRequest } = request ?? {};
  const key = `${agentId}:${JSON.stringify(wireRequest)}`;
  const existing = inFlight.get(key);
  if (existing) {
    if (onResponse) existing.handlers.push(onResponse);
    return existing.promise;
  }

  const handlers = onResponse ? [onResponse] : [];
  const reads = inFlight;
  const fetch = client.fetchAgentTimeline(agentId, {
    ...wireRequest,
    async onResponse(page) {
      // Once merging begins, new readers must own a new delivery, not join after its receipt.
      reads.delete(key);
      const results = await Promise.allSettled(handlers.map(async (handler) => handler(page)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
    },
  });
  const read = { promise: fetch, handlers };
  inFlight.set(key, read);
  const clear = () => {
    if (reads.get(key) === read) reads.delete(key);
  };
  void fetch.then(clear, clear);
  return fetch;
}
