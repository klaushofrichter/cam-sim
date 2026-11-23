const LIST_CAP = 1000;
// Lists keep only their most recent entries, so a long-running simulator
// doesn't grow without bound.
function pushCapped(list: string[], v: string): void {
  list.push(v);
  if (list.length > LIST_CAP) list.splice(0, list.length - LIST_CAP);
}

// What tests read back through /sim/api/state (the cams mock's /__state and more).
export class Counters {
  logins = 0;
  loginAttempts = 0;
  devInfoCalls = 0;
  activeStreams = 0;
  streamsOpened = 0;
  downloads = 0;
  activeDownloads = 0;
  droppedDownloads = 0;
  downloadOrder: string[] = [];
  searches = 0;
  setCalls: string[] = [];
  reboots = 0;
  ftpUploads = 0;
  ftpFailures = 0;
  ftpDropped = 0;
  baichuanSessions = 0; // logged-in Baichuan connections now (not history)
  baichuanLogins = 0;
  baichuanDownloads = 0;
  baichuanStops = 0; // cmd 9 (stop) received after a login, whether or not a download was running
  droppedBaichuanDownloads = 0;

  noteDownload(start: string): void {
    pushCapped(this.downloadOrder, start);
  }

  noteSet(cmd: string): void {
    pushCapped(this.setCalls, cmd);
  }

  reset(): void {
    // Active counts describe open connections; they are not history.
    const { activeStreams, activeDownloads, baichuanSessions } = this;
    Object.assign(this, new Counters(), { activeStreams, activeDownloads, baichuanSessions });
  }

  snapshot() {
    return { ...this, downloadOrder: [...this.downloadOrder], setCalls: [...this.setCalls] };
  }
}
