export type {
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  AnnotationPoint,
  AnnotationRect,
  Cell,
  CellType,
  CommentAnnotation,
  CommentReply,
  DieAnnotations,
  DieConfig,
  DieLevelMetadata,
  DieMetadata,
  DieSummary,
  ImportJobPhase,
  ImportJobProgress,
  ImportJobStatus,
  MetalStack,
} from "shared";

// --- Backend-only types ---

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface AuthPayload {
  userId: string;
  username: string;
}

export interface DieRecord {
  id: string;
  name: string;
  originalFilename: string;
  originalPath: string;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: "jpg" | "png";
  maxZoomLevel: number;
  levels: import("shared").DieLevelMetadata[];
  createdAt: string;
  updatedAt: string;
  config?: import("shared").DieConfig;
  /** "managed" (absent) = inside <dataRoot>/dies; "folder" = external directory. */
  location?: import("shared").ProjectLocationKind;
  /** Absolute external directory for folder projects. */
  folderPath?: string;
}

export interface DieIndex {
  dies: string[];
}

export interface ImportJobRecord {
  id: string;
  type: "import-die";
  status: import("shared").ImportJobStatus;
  originalFilename: string;
  mimeType: string;
  inputFilePath: string;
  dieId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: import("shared").ImportJobProgress;
  /** Folder project destination (null for managed imports). */
  targetDir?: string | null;
  /** Folder project id used for targetDir imports. */
  targetId?: string | null;
}

export interface ImportJobIndex {
  jobs: string[];
}
