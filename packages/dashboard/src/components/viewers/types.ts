export type ViewerProps = {
  /** Text body for text-y viewers; Blob for image/binary viewers. */
  content: string | Blob;
  /** Basename of the file (used for alt text + download fallback). */
  filename: string;
  /** Size in bytes if known. Used by the binary fallback's label. */
  size?: number;
  /** Optional download URL (used by the binary fallback affordance). */
  downloadUrl?: string;
};
