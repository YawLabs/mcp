// Own-property assignment for keys that came out of parsed JSON.
//
// `out[k] = v` is wrong when k is "__proto__". JSON.parse produces
// "__proto__" as an OWN property, but plain assignment does not create an own
// key -- it invokes Object.prototype's inherited __proto__ setter. The
// rebuilt object then has no own "__proto__", so the field silently
// disappears (JSON.stringify only serializes own properties), and when the
// assigned value is an object the fresh object's prototype is repointed at it
// as a side effect, leaving the rebuilt map inheriting that value's fields.
//
// This is NOT prototype pollution: Object.prototype is never touched, only
// the freshly constructed target's own prototype. The observable bug is a
// dropped field.
//
// "__proto__" is the only key that needs this. It is the sole accessor
// property on Object.prototype -- `constructor`, `toString` and the rest are
// writable data properties, and assigning over an inherited data property
// creates an own property normally.
//
// NOT needed when the object is built by object spread ({ ...src }),
// Object.fromEntries, or JSON.parse itself: all three create own properties
// directly and never consult a setter. It IS needed for Object.assign, which
// assigns through setters exactly like `out[k] = v`.

/** Assign `value` to `key` on `target` as a plain own data property, even
 *  when `key` is "__proto__". Ordinary keys take the plain-assignment path,
 *  so there is no added cost on the common path. */
export function setJsonKey<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}
