export interface PedagogicalManifest {
  formatVersion: "1.0";
  caseId: string;
  title: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion?: string;
  clinicalHistory?: string;
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
  }[];
}

export interface ClinicalCaseItem {
  id: string;
  title: string;
  modality: "MR" | "CT" | "CR" | "DX" | "XA" | "US";
  anatomicalRegion: string;
  difficulty: "Débutant" | "Intermédiaire" | "Avancé";
  clinicalHistory: string;
  question: string;
  choices: string[];
  correctChoiceIndex: number;
  explanation: string;
  keySliceIndex: number;
  keyWindowKey: string;
  keySeriesId?: string;
  createdAt: string;
  byteSize: number;
  source: "public_catalog" | "indexeddb";
  tpackUrl?: string;
  tpackBytes?: Uint8Array;
  manifest?: PedagogicalManifest;
}
