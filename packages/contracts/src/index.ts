export interface HealthResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ready' | 'unavailable';
}

export type HouseholdRole = 'operator' | 'requester';
export interface HouseholdUser {
  id: string;
  username: string;
  role: HouseholdRole;
}

export interface CatalogScan {
  state: 'never' | 'running' | 'succeeded' | 'partial' | 'failed' | 'offline';
  lastSuccessfulAt: string | null;
  lastError: string | null;
  lastScan: {
    id: string;
    status: string;
    filesSeen: number;
    hashedFiles: number;
    errorsCount: number;
    startedAt: string;
    finishedAt: string | null;
    message?: string | null;
  } | null;
  errors?: Array<{ relative_path: string | null; code: string; message: string }>;
}

export interface CatalogProjectSummary {
  id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  description: string | null;
  tags: string[];
  previewUrl: string | null;
  available: boolean;
  assetCount: number;
  clientPath: string | null;
}

export interface CatalogFile {
  id: string;
  versionId: string | null;
  name: string;
  relativePath: string;
  variant: string | null;
  fileType: 'mesh' | 'source' | 'image' | 'document' | 'print' | 'other';
  extension: string;
  size: number;
  available: boolean;
  clientPath: string | null;
  downloadUrl: string;
  previewUrl: string | null;
  geometryUrl?: string | null;
}

export interface CatalogProjectDetail extends CatalogProjectSummary {
  designer: string | null;
  sourceUrl: string | null;
  license: string | null;
  notes: string | null;
  isBoundary: boolean;
  files: CatalogFile[];
}

export interface CatalogPage {
  items: CatalogProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
  categories: string[];
  fileTypes: CatalogFile['fileType'][];
  scan: CatalogScan;
}

export type PrintRequestStatus = 'requested' | 'queued' | 'printing' | 'completed' | 'declined' | 'canceled';
export type PrintRequestAction = 'approve' | 'decline' | 'start' | 'complete' | 'cancel';

export interface PrintRequestSelection {
  assetId: string;
  versionId: string;
}

export interface SubmitPrintRequest {
  projectId: string;
  selected: PrintRequestSelection[];
  quantity: number;
  material?: string | null;
  color?: string | null;
  notes?: string | null;
}

export interface PrintRequestSummary {
  id: string;
  projectId: string;
  projectName: string;
  requester: HouseholdUser;
  status: PrintRequestStatus;
  quantity: number;
  material: string | null;
  color: string | null;
  notes: string | null;
  selected: PrintRequestFile[];
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
}

export type PrintRequestUnavailableReason =
  'project_missing' | 'asset_missing' | 'version_missing' | 'version_not_current' | 'library_offline';

export interface PrintRequestFile extends PrintRequestSelection {
  name: string;
  relativePath: string;
  variant: string | null;
  fileType: CatalogFile['fileType'];
  extension: string;
  size: number;
  contentHash: string;
  available: boolean;
  unavailableReason: PrintRequestUnavailableReason | null;
  downloadUrl: string | null;
}

export interface PrintRequestEvent {
  id: string;
  actor: HouseholdUser;
  action: 'submit' | PrintRequestAction | 'reorder' | 'select_next';
  fromStatus: PrintRequestStatus | null;
  toStatus: PrintRequestStatus | null;
  fromPosition: number | null;
  toPosition: number | null;
  note: string | null;
  createdAt: string;
}

export interface PrintRequestDetail extends PrintRequestSummary {
  history: PrintRequestEvent[];
}

export interface PrintRequestQueue {
  revision: number;
  selectedNextId: string | null;
  items: PrintRequestSummary[];
}
