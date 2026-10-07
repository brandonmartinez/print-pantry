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
