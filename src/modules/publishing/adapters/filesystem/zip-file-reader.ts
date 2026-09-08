import { open, type FileHandle } from "node:fs/promises";
import { Reader } from "@zip.js/zip.js";

export class NodeFileReader extends Reader<string> {
  #handle: FileHandle | undefined;
  readonly #path: string;

  constructor(path: string) {
    super(path);
    this.#path = path;
  }

  override async init(): Promise<void> {
    await super.init?.();
    this.#handle = await open(this.#path, "r");
    this.size = (await this.#handle.stat()).size;
  }

  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    if (!this.#handle) throw new Error("ZIP file reader is not initialized");
    const buffer = Buffer.alloc(Math.min(length, this.size - index));
    const { bytesRead } = await this.#handle.read(
      buffer,
      0,
      buffer.length,
      index,
    );
    return new Uint8Array(buffer.subarray(0, bytesRead));
  }

  async dispose(): Promise<void> {
    await this.#handle?.close();
    this.#handle = undefined;
  }
}
