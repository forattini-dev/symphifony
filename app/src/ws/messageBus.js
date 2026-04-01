const WILDCARD = "*";

function normalizeType(type) {
  return typeof type === "string" && type.length > 0 ? type : WILDCARD;
}

export function createMessageBus() {
  const handlersByType = new Map(); // type -> Set<(msg, context) => void>
  const wildcardHandlers = new Set(); // Set<(msg, context) => void>

  function on(type, handler) {
    if (typeof handler !== "function") return () => {};
    const normalizedType = normalizeType(type);
    if (normalizedType === WILDCARD) {
      wildcardHandlers.add(handler);
      return () => wildcardHandlers.delete(handler);
    }

    let handlers = handlersByType.get(normalizedType);
    if (!handlers) {
      handlers = new Set();
      handlersByType.set(normalizedType, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function dispatch(message, context = {}) {
    if (!message || typeof message !== "object") return false;

    let handled = false;

    for (const handler of [...wildcardHandlers]) {
      try {
        handler(message, context);
        handled = true;
      } catch {
        // best-effort fanout for notification routing.
      }
    }

    const type = normalizeType(message.type);
    const handlers = handlersByType.get(type);
    if (!handlers) return handled;

    for (const handler of [...handlers]) {
      try {
        handler(message, context);
        handled = true;
      } catch {
        // best-effort fanout for notification routing.
      }
    }
    return handled;
  }

  return { on, dispatch };
}
