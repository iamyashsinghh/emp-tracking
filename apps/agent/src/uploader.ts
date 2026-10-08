import { MediaKind } from "@emptrack/shared";
import { apiClient } from "./api";

/**
 * Shared media upload path: ask the server for a presigned URL, PUT the bytes
 * straight to object storage, then confirm. Keeps media off the API server.
 */
export async function uploadMedia(
  kind: MediaKind,
  contentType: string,
  bytes: Buffer,
  durationSeconds?: number
): Promise<void> {
  const capturedAt = new Date().toISOString();
  const { mediaId, uploadUrl, requiredHeaders } = await apiClient.requestMediaUpload({
    kind,
    contentType,
    capturedAt,
    durationSeconds,
  });
  await apiClient.putBytes(uploadUrl, requiredHeaders, bytes);
  await apiClient.confirmMedia(mediaId, bytes.byteLength);
}
