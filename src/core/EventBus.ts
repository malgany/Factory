type Handler<T> = (payload: T) => void;

export class EventBus<EventMap extends object> {
  private readonly listeners = new Map<keyof EventMap, Set<Handler<never>>>();

  on<Key extends keyof EventMap>(event: Key, handler: Handler<EventMap[Key]>): () => void {
    const handlers = this.listeners.get(event) ?? new Set<Handler<never>>();
    handlers.add(handler as Handler<never>);
    this.listeners.set(event, handlers);
    return () => this.off(event, handler);
  }

  off<Key extends keyof EventMap>(event: Key, handler: Handler<EventMap[Key]>): void {
    this.listeners.get(event)?.delete(handler as Handler<never>);
  }

  emit<Key extends keyof EventMap>(event: Key, payload: EventMap[Key]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload as never);
  }

  clear(): void {
    this.listeners.clear();
  }
}
