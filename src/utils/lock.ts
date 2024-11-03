class EventEmitter {
  private events: { [key: string]: Function[] } = {};

  on(event: string, callback: Function) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }

  removeListener(event: string, callback: Function) {
    if (!this.events[event]) {
      return;
    }
    this.events[event] = this.events[event].filter((cb) => cb !== callback);
  }

  emit(event: string, ...args: any[]) {
    if (!this.events[event]) {
      return;
    }
    this.events[event].forEach((callback) => callback(...args));
  }
}

class RequestLock {
  private locked: { [key: string]: boolean } = {};

  private eventEmitter = new EventEmitter();

  lock(key: string) {
    return new Promise((resolve) => {
      if(!this.locked[key]) {
        this.locked[key] = true;
        resolve(true);
      }
      const callback = () => {
        if(!this.locked[key]) {
          this.locked[key] = true;
          this.eventEmitter.removeListener(key, callback);
          resolve(true);
        }
      };
      this.eventEmitter.on(key, callback);
    });
  }

  async unlock(key: string) {
    delete this.locked[key];
    setImmediate(() => this.eventEmitter.emit(key));
  }

  async run<T>(key: string, fn: () => Promise<T>) {
    await this.lock(key);
    try {
      return await fn();
    } finally {
      await this.unlock(key);
    }
  }
}

export default RequestLock;