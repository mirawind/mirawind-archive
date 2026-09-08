import { SafeApplicationError } from "@/domain/errors";

export function requireSupportedBookSchemaVersion(value: unknown): 1 {
  if (value === 1) return 1;
  throw new SafeApplicationError(
    "BOOK_SCHEMA_VERSION_UNSUPPORTED",
    "The book document schema is not supported.",
    400,
  );
}
function requirePublicationVersion(
  value: unknown,
  label: "DOCUMENT_MANIFEST" | "VERSION_MARKER",
): 5 {
  if (value === 5) return 5;
  throw new SafeApplicationError(
    label + "_SCHEMA_VERSION_UNSUPPORTED",
    "The publication schema is not supported.",
    400,
  );
}
export function requireSupportedDocumentManifestSchemaVersion(
  value: unknown,
): 5 {
  return requirePublicationVersion(value, "DOCUMENT_MANIFEST");
}
export function requireSupportedVersionMarkerSchemaVersion(value: unknown): 5 {
  return requirePublicationVersion(value, "VERSION_MARKER");
}
