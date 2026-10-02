const LIST_CAP = 1000;

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
  droppedBaichuanDownloads = 0;

  // Lists keep only their most recent entries, so a long-running simulator
  // doesn't grow without bound.
  noteDownload(start: string): void {
    this.downloadOrder.push(start);
    if (this.downloadOrder.length > LIST_CAP) this.downloadOrder.splice(0, this.downloadOrder.length - LIST_CAP);
  }

  noteSet(cmd: string): void {
    this.setCalls.push(cmd);
    if (this.setCalls.length > LIST_CAP) this.setCalls.splice(0, this.setCalls.length - LIST_CAP);
  }

  reset(): void {
    // Active counts describe open connections; they are not history.
    Object.assign(this, { logins: 0, loginAttempts: 0, devInfoCalls: 0, streamsOpened: 0, downloads: 0, droppedDownloads: 0, downloadOrder: [], searches: 0, setCalls: [], reboots: 0, ftpUploads: 0, ftpFailures: 0, ftpDropped: 0, baichuanLogins: 0, baichuanDownloads: 0, droppedBaichuanDownloads: 0 });
  }

  snapshot() {
    return { ...this, downloadOrder: [...this.downloadOrder], setCalls: [...this.setCalls] };
  }
}
