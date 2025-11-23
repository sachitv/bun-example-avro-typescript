import type { IWritableBuffer } from "@sachitv/avro-typescript";

export class InfiniteInMemoryBuffer implements IWritableBuffer {
  private view: Uint8Array;
  private offset: number;

  constructor(initialSize = 1024) {
    this.view = new Uint8Array(initialSize);
    this.offset = 0;
  }

  public appendBytes(data: Uint8Array): Promise<void> {
    if (this.offset + data.length > this.view.length) {
      const newBuffer = new Uint8Array((this.offset + data.length) * 2);
      newBuffer.set(this.view);
      this.view = newBuffer;
    }
    this.view.set(data, this.offset);
    this.offset += data.length;
    return Promise.resolve();
  }

  getBuffer(): Uint8Array {
    return this.view.slice(0, this.offset);
  }

  public isValid(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public canAppendMore(_size: number): Promise<boolean> {
    // This assumes infinite capacity for simplicity
    return Promise.resolve(true);
  }

  close(): void {
    return;
  }
}