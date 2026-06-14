// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

type Listener<T = unknown> = (event: T) => void

const listeners = new Map<string, Array<{ fn: Listener; key: string }>>()
let listenerIdCounter = 0

/**
 * Register a listener for an event. Returns a key for `off()`.
 */
export function on<T>(event: string, handler: (payload: T) => void): string {
  const key = `${event}_${++listenerIdCounter}`
  const list = listeners.get(event) ?? []
  list.push({ fn: handler, key })
  listeners.set(event, list)
  return key
}

/**
 * Unsubscribe a listener by its key (returned from `on`).
 */
export function off<T>(event: string, handler: (payload: T) => void): void {
  const list = listeners.get(event)
  if (!list) return
  const idx = list.findIndex((l) => l.fn === handler)
  if (idx >= 0) list.splice(idx, 1)
}

/**
 * Emit an event to all registered listeners.
 * Listeners that throw are silently caught (prevents one handler from
 * breaking the rest).
 */
export function emit<T>(event: string, payload: T): void {
  const list = listeners.get(event)
  if (!list) return
  // Iterate a copy so listeners can call off() during iteration
  for (const { fn } of [...list]) {
    try {
      fn(payload)
    } catch {
      // silently ignore listener errors
    }
  }
}

/**
 * Remove all listeners for all events.
 */
export function clearAll(): void {
  listeners.clear()
}
