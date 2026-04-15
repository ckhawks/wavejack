type PlaybackCallback = (roomId: string) => void;

export class PlaybackTimer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  startTrack(roomId: string, durationSeconds: number, onEnd: PlaybackCallback): void {
    this.clearTrack(roomId);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      onEnd(roomId);
    }, durationSeconds * 1000);
    this.timers.set(roomId, timer);
  }

  clearTrack(roomId: string): void {
    const timer = this.timers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(roomId);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
