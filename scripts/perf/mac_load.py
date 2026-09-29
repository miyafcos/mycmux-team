"""Record interval load without excluding measurements on a busy Mac."""
import os
import threading
import time


class LoadRecorder:
    def __init__(self):
        self.samples = []
        self.lock = threading.Lock()
        threading.Thread(target=self._sample, daemon=True).start()

    def _sample(self):
        while True:
            row = self.begin()
            with self.lock:
                self.samples.append(row)
            time.sleep(1)

    @staticmethod
    def begin():
        return {"epoch": time.time(), "load1": os.getloadavg()[0]}

    def finish(self, start):
        end = self.begin()
        with self.lock:
            rows = [start] + [r for r in self.samples if start["epoch"] < r["epoch"] < end["epoch"]] + [end]
        elapsed = end["epoch"] - start["epoch"]
        mean = sum((b["epoch"] - a["epoch"]) * (a["load1"] + b["load1"]) / 2
                   for a, b in zip(rows, rows[1:])) / elapsed if elapsed else end["load1"]
        return {"intervalStart": start["epoch"], "intervalEnd": end["epoch"],
                "loadStart": start["load1"], "loadEnd": end["load1"], "loadMean": mean,
                "highLoad": mean > 20, "loadIntervalSamples": rows}
