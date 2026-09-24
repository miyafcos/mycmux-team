/** Bounded, silent marks that CDP can read from an isolated test profile. */
export interface PerfMark {
  name: string;
  atMs: number;
  id?: string;
}

const CAPACITY = 2048;
const marks: PerfMark[] = [];
let next = 0;
let placementSampling = false;
let placement = { frames: 0, totalMs: 0, maxMs: 0, hostQueries: 0 };

export function isPlacementSamplingEnabled(): boolean { return placementSampling; }

export function recordPlacementSample(durationMs: number, hostQueries: number): void {
  placement.frames += 1;
  placement.totalMs += durationMs;
  placement.maxMs = Math.max(placement.maxMs, durationMs);
  placement.hostQueries += hostQueries;
}

export function recordPerf(name: string, id?: string): void {
  const mark: PerfMark = { name, atMs: performance.timeOrigin + performance.now(), id };
  if (marks.length < CAPACITY) marks.push(mark);
  else {
    marks[next] = mark;
    next = (next + 1) % CAPACITY;
  }
}

export function readPerf(): PerfMark[] {
  return marks.length < CAPACITY
    ? marks.slice()
    : marks.slice(next).concat(marks.slice(0, next));
}

export function clearPerf(): void {
  marks.length = 0;
  next = 0;
}

export function installPerfTimeline(): void {
  Object.assign(window, {
    __MYCMUX_PERF__: {
      read: readPerf,
      clear: clearPerf,
      mark: recordPerf,
      setPlacementSampling: (enabled: boolean) => {
        placementSampling = enabled;
        placement = { frames: 0, totalMs: 0, maxMs: 0, hostQueries: 0 };
      },
      readPlacement: () => ({ ...placement }),
    },
  });
  recordPerf("frontend.start");
}
