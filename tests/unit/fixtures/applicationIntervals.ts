/** jsdom's animation-frame driver uses its own interval. */
export function applicationIntervals<Args extends unknown[], Result>(timer: {
  mock: { calls: Args[]; results: Array<{ value: Result }> };
}): Array<{ args: Args; handle: Result }> {
  return timer.mock.calls.flatMap((args, index) =>
    args[1] === 1000 / 60 ? [] : [{ args, handle: timer.mock.results[index].value }]);
}
