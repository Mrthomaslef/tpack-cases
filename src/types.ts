export interface AnnotationItem {
  id: string;
  type: "arrow" | "circle" | "text";
  points: [number, number][];
  label?: string;
}

export interface PedagogicalManifest {
  formatVersion: "1.0";
  caseId: string;
  title: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion?: string;
  clinicalHistory?: string;
  diagnosis?: string;
  keySliceIndex?: number;
  keyWindowKey?: string;
  series: {
    id: string;
    description: string;
    modality: string;
    width: number;
    height: number;
    sliceCount: number;
    pixelSpacing: [number, number];
    effectiveSliceThickness: number;
    availableWindows: {
      key: string;
      label: string;
      folderPath: string;
    }[];
    slices: {
      index: number;
      zPosition: number;
      annotations?: AnnotationItem[];
    }[];
  }[];
}

export interface ClinicalCaseItem {
  id: string;
  title: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion: string;
  clinicalHistory: string;
  diagnosis: string;
  keySliceIndex: number;
  keyWindowKey: string;
  keySeriesId?: string;
  annotatedSlices?: {
    seriesId: string;
    sliceIndex: number;
    label: string;
  }[];
  createdAt: string;
  byteSize: number;
  source: "public_catalog" | "indexeddb";
  origin?: "local" | "drive" | "public";
  tpackUrl?: string;
  tpackBytes?: Uint8Array;
  manifest?: PedagogicalManifest;
}
