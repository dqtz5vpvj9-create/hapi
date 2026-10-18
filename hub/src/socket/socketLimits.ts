import { MAX_DOCUMENT_FILE_BYTES } from '@hapi/protocol/documents'

// The largest generated image the CLI will serve inline. Must stay in sync with the CLI-side
// limits in cli/src/claude/utils/startHappyServer.ts and cli/src/modules/common/generatedImages.ts.
export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024

// Generated images (and other large RPC payloads) cross the /cli socket as a base64 string wrapped
// in a JSON-RPC envelope, which inflates the payload by ~4/3. The engine.io default of 1e6 bytes
// silently drops the CLI -> hub ack frame for any image above ~750 KB raw (issue #927).
// Documents and workspace uploads allow 64 MiB, so their base64 envelope determines the cap.
export const SOCKET_MAX_HTTP_BUFFER_SIZE = Math.ceil(MAX_DOCUMENT_FILE_BYTES / 3) * 4 + 1024 * 1024
