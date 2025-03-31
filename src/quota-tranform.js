import { Transform } from "node:stream";

export class QuotaTransform extends Transform {
  constructor(couloir, onQuotaExceeded) {
    super();
    this.couloir = couloir;
    this.onQuotaExceeded = onQuotaExceeded;
  }

  async _transform(chunk, _encoding, callback) {
    await this.couloir.updateQuota(chunk.length);
    if (this.couloir.quotaError) {
      return this.onQuotaExceeded(this.couloir.quotaError);
    }

    callback(null, chunk);
  }
}

export function pipeWithQuota(couloir, sourceStream, targetStream, onQuotaExceeded) {
  const transform = new QuotaTransform(couloir, onQuotaExceeded);
  const transformedStream = sourceStream.pipe(transform);
  transformedStream.pipe(targetStream);
}
