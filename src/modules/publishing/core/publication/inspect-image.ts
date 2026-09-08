import sharp from "sharp";
import { SafeApplicationError } from "@/domain/errors";

export type SupportedRasterFormat = "gif" | "jpeg" | "png" | "webp";

export interface RasterInspection {
  readonly format: SupportedRasterFormat;
  readonly hasAlpha: boolean;
  readonly height: number;
  readonly width: number;
}

export async function inspectRasterImage(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
}): Promise<RasterInspection> {
  const metadata = await sharp(Buffer.from(input.bytes), {
    limitInputPixels: false,
    sequentialRead: true,
  })
    .metadata()
    .catch((cause: unknown) => {
      throw new SafeApplicationError(
        "IMAGE_DECODE_FAILED",
        "The image metadata could not be decoded.",
        400,
        { cause },
      );
    });
  const format = metadata.format;
  if (
    (format !== "gif" &&
      format !== "jpeg" &&
      format !== "png" &&
      format !== "webp") ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new SafeApplicationError(
      "IMAGE_FORMAT_UNSUPPORTED",
      "The image format is not supported.",
      400,
    );
  }
  return Object.freeze({
    format,
    hasAlpha: Boolean(metadata.hasAlpha),
    height: metadata.height,
    width: metadata.width,
  });
}
