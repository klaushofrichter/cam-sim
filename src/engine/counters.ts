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

  reset(): void {
    // Active counts describe open connections; they are not history.
    Object.assign(this, { logins: 0, loginAttempts: 0, devInfoCalls: 0, streamsOpened: 0, downloads: 0, droppedDownloads: 0, downloadOrder: [], searches: 0, setCalls: [], reboots: 0 });
  }

  snapshot() {
    return { ...this, downloadOrder: [...this.downloadOrder], setCalls: [...this.setCalls] };
  }
}
