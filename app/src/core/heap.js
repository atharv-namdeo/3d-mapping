/** Minimal binary min-heap keyed by a parallel Float32Array of priorities. */
export class MinHeap {
  constructor(priority) {
    this.priority = priority;
    this.items = [];
  }

  get size() { return this.items.length; }

  push(node) {
    const { items, priority } = this;
    let k = items.length;
    items.push(node);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (priority[items[parent]] <= priority[node]) break;
      items[k] = items[parent];
      k = parent;
    }
    items[k] = node;
  }

  pop() {
    const { items, priority } = this;
    const top = items[0];
    const last = items.pop();
    const n = items.length;
    if (n > 0) {
      let k = 0;
      for (;;) {
        let child = 2 * k + 1;
        if (child >= n) break;
        if (child + 1 < n && priority[items[child + 1]] < priority[items[child]]) child++;
        if (priority[items[child]] >= priority[last]) break;
        items[k] = items[child];
        k = child;
      }
      items[k] = last;
    }
    return top;
  }
}
