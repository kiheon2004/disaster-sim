/** Min-heap of member indices keyed by an Int32 key (no duplicates, no allocation after construction). */
export class IndexHeap {
  private data: Int32Array;
  private size = 0;
  private readonly inHeap: Uint8Array;

  constructor(n: number, private readonly key: Int32Array, private readonly sign: 1 | -1 = 1) {
    this.data = new Int32Array(Math.max(1, n));
    this.inHeap = new Uint8Array(n);
  }

  clear() {
    for (let k = 0; k < this.size; k++) this.inHeap[this.data[k]] = 0;
    this.size = 0;
  }

  get length() {
    return this.size;
  }

  private k(i: number) {
    return this.sign * this.key[i];
  }

  push(i: number) {
    if (this.inHeap[i]) return;
    this.inHeap[i] = 1;
    let p = this.size++;
    const d = this.data;
    d[p] = i;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.k(d[q]) <= this.k(d[p])) break;
      const t = d[q]; d[q] = d[p]; d[p] = t;
      p = q;
    }
  }

  pop(): number {
    const d = this.data;
    const top = d[0];
    this.inHeap[top] = 0;
    const last = d[--this.size];
    if (this.size > 0) {
      d[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < this.size && this.k(d[l]) < this.k(d[m])) m = l;
        if (r < this.size && this.k(d[r]) < this.k(d[m])) m = r;
        if (m === p) break;
        const t = d[m]; d[m] = d[p]; d[p] = t;
        p = m;
      }
    }
    return top;
  }
}
