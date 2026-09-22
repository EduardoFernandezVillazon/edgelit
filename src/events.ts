type Handler<T> = (payload: T) => void

/** Minimal typed emitter. */
export class Emitter<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<never>>>()

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    set.add(fn as Handler<never>)
    return () => this.off(type, fn)
  }

  off<K extends keyof M>(type: K, fn: Handler<M[K]>): void {
    this.handlers.get(type)?.delete(fn as Handler<never>)
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const fn of [...set]) (fn as Handler<M[K]>)(payload)
  }

  clear(): void {
    this.handlers.clear()
  }
}
