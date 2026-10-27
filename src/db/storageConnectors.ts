import { inspectTPackFile, saveClinicalCaseToIndexedDB } from './casesDb';
import { ClinicalCaseItem, PedagogicalManifest } from '../types';

const HANDLE_DB_NAME = 'tpack_folder_handles_db';
const HANDLE_STORE = 'handles';
const DRIVE_CONFIG_KEY = 'tpack_google_drive_config_v1';

export interface GoogleDriveConfig {
  folderUrlOrId: string;
  apiKey: string;
}

// Mem-cache pour les FileSystemFileHandle de la session courante (permet de lire les .tpack à la volée)
const sessionFileHandles = new Map<string, FileSystemFileHandle>();

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, 'default_tpack_dir');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Certains navigateurs ne permettent pas de sérialiser FileSystemDirectoryHandle
  }
}

export async function getSavedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get('default_tpack_dir');
      req.onsuccess = () => {
        db.close();
        resolve((req.result as FileSystemDirectoryHandle) || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

export function buildClinicalCaseFromManifest(
  manifest: PedagogicalManifest,
  bytes: Uint8Array,
  fallbackName: string,
  source: ClinicalCaseItem['source'] = 'indexeddb',
  extra?: Partial<ClinicalCaseItem>
): ClinicalCaseItem {
  const firstSeries = manifest.series?.[0];
  const annotatedSlices: { seriesId: string; sliceIndex: number; label: string }[] = [];

  for (const s of manifest.series || []) {
    for (const sl of s.slices || []) {
      if (sl.annotations && sl.annotations.length > 0) {
        const firstLabel =
          sl.annotations.find((a) => a.label)?.label || `Coupe #${sl.index + 1}`;
        annotatedSlices.push({
          seriesId: s.id,
          sliceIndex: sl.index,
          label: firstLabel,
        });
      }
    }
  }

  const keySliceIndex =
    typeof manifest.keySliceIndex === 'number'
      ? manifest.keySliceIndex
      : annotatedSlices.length > 0
      ? annotatedSlices[0].sliceIndex
      : Math.floor((firstSeries?.sliceCount || 1) / 2);

  const keyWindowKey =
    manifest.keyWindowKey || firstSeries?.availableWindows?.[0]?.key || 'default';

  return {
    id: manifest.caseId || fallbackName.replace(/\.tpack$/i, '') || `CAS-${Date.now()}`,
    title: manifest.title || fallbackName.replace(/\.tpack$/i, ''),
    modality: manifest.modality || 'CT',
    anatomicalRegion: manifest.anatomicalRegion || '',
    clinicalHistory: manifest.clinicalHistory || '',
    diagnosis: manifest.diagnosis || '',
    keySliceIndex,
    keyWindowKey,
    keySeriesId: firstSeries?.id,
    annotatedSlices,
    createdAt: new Date().toISOString(),
    byteSize: bytes.byteLength,
    source,
    tpackBytes: bytes,
    manifest,
    ...extra,
  };
}

/**
 * Parcourt récursivement un FileSystemDirectoryHandle (dossier local ou Google Drive for Desktop)
 * et indexe tous les fichiers .tpack qu'il contient.
 */
async function scanDirectoryRecursively(
  dirHandle: FileSystemDirectoryHandle,
  maxDepth: number = 3
): Promise<File[]> {
  const files: File[] = [];
  if (maxDepth < 0) return files;

  // @ts-expect-error values() est standard sur FileSystemDirectoryHandle
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const name: string = entry.name || '';
      if (name.toLowerCase().endsWith('.tpack') && !name.startsWith('._')) {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        sessionFileHandles.set(file.name, fileHandle);
        files.push(file);
      }
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      const subFiles = await scanDirectoryRecursively(
        entry as FileSystemDirectoryHandle,
        maxDepth - 1
      );
      files.push(...subFiles);
    }
  }
  return files;
}

export function supportsFileSystemAccessApi(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Ouvre le sélecteur de dossier natif (ou utilise un handle déjà autorisé) et synchronise tous les .tpack
 */
export async function connectAndScanLocalDirectory(
  existingHandle?: FileSystemDirectoryHandle | null,
  onProgress?: (current: number, total: number) => void
): Promise<{ folderName: string; cases: ClinicalCaseItem[] }> {
  let dirHandle = existingHandle;

  if (!dirHandle) {
    // @ts-expect-error showDirectoryPicker est supporté sur Chrome/Edge/Brave/Opera
    dirHandle = (await window.showDirectoryPicker({
      mode: 'read',
    })) as FileSystemDirectoryHandle;
  } else {
    // Vérifie ou redemande la permission de lecture sur le dossier mémorisé
    // @ts-expect-error queryPermission / requestPermission font partie de FileSystemHandle
    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      // @ts-expect-error requestPermission
      const reqPerm = await dirHandle.requestPermission({ mode: 'read' });
      if (reqPerm !== 'granted') {
        throw new Error('Permission de lecture du dossier refusée.');
      }
    }
  }

  if (!dirHandle) {
    throw new Error('Aucun dossier sélectionné.');
  }

  await saveDirectoryHandle(dirHandle);

  const tpackFiles = await scanDirectoryRecursively(dirHandle, 3);
  const loadedCases: ClinicalCaseItem[] = [];

  for (let i = 0; i < tpackFiles.length; i++) {
    const f = tpackFiles[i];
    if (onProgress) onProgress(i + 1, tpackFiles.length);
    try {
      const { manifest, bytes } = await inspectTPackFile(f);
      const item = buildClinicalCaseFromManifest(manifest, bytes, f.name, 'indexeddb', {
        origin: 'local',
      });
      await saveClinicalCaseToIndexedDB(item);
      loadedCases.push(item);
    } catch {
      // Ignorer un fichier corrompu
    }
  }

  return {
    folderName: dirHandle.name,
    cases: loadedCases,
  };
}

/**
 * Extrait l'ID d'un dossier ou fichier Google Drive depuis une URL de partage ou un ID brut
 */
export function extractGoogleDriveId(input: string): string {
  const trimmed = input.trim();
  // Format https://drive.google.com/drive/folders/1A2B3C4D5E...
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  // Format https://drive.google.com/file/d/1A2B3C4D5E.../view
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];

  // Format ?id=1A2B3C4D5E...
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];

  return trimmed;
}

export function loadSavedGoogleDriveConfig(): GoogleDriveConfig {
  try {
    const raw = localStorage.getItem(DRIVE_CONFIG_KEY);
    if (!raw) return { folderUrlOrId: '', apiKey: '' };
    const parsed = JSON.parse(raw);
    return {
      folderUrlOrId: parsed.folderUrlOrId || '',
      apiKey: parsed.apiKey || '',
    };
  } catch {
    return { folderUrlOrId: '', apiKey: '' };
  }
}

export function saveGoogleDriveConfig(config: GoogleDriveConfig): void {
  try {
    localStorage.setItem(DRIVE_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Ignore
  }
}

interface DriveFileEntry {
  id: string;
  name: string;
  size?: string;
}

/**
 * Synchronise toute une base de fichiers .tpack depuis un dossier Google Drive partagé
 * (ou un fichier Google Drive individuel) via l'API Google Drive v3.
 */
export async function syncFromGoogleDrive(
  folderUrlOrId: string,
  apiKey: string,
  onProgress?: (current: number, total: number, fileName: string) => void
): Promise<ClinicalCaseItem[]> {
  const driveId = extractGoogleDriveId(folderUrlOrId);
  const cleanKey = apiKey.trim();

  if (!driveId) {
    throw new Error('Veuillez saisir le lien ou l’ID de votre dossier Google Drive.');
  }

  saveGoogleDriveConfig({ folderUrlOrId, apiKey: cleanKey });

  // Si l'utilisateur a collé un lien direct vers un fichier unique (/file/d/...) et non un dossier (/folders/...)
  const isSingleFileLink = folderUrlOrId.includes('/file/d/');

  let filesToFetch: DriveFileEntry[] = [];

  if (isSingleFileLink && cleanKey) {
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      driveId
    )}?fields=id,name,size&key=${encodeURIComponent(cleanKey)}`;
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) {
      throw new Error(
        'Impossible de lire ce fichier Google Drive. Vérifiez que le partage est sur "Tous les utilisateurs disposant du lien" et que la clé API est valide.'
      );
    }
    const meta = (await metaRes.json()) as DriveFileEntry;
    filesToFetch = [meta];
  } else {
    if (!cleanKey) {
      throw new Error(
        'Pour lister automatiquement un dossier Google Drive dans le navigateur, renseignez une clé API Google Drive (ou utilisez le bouton "Dossier Local / Google Drive Desktop" sans clé).'
      );
    }

    const q = encodeURIComponent(`'${driveId}' in parents and trashed = false`);
    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=100&fields=files(id,name,size)&key=${encodeURIComponent(
      cleanKey
    )}`;

    const res = await fetch(listUrl);
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      const msg =
        errJson?.error?.message ||
        'Impossible de lister le dossier Google Drive. Vérifiez que le dossier est partagé ("Tous les utilisateurs disposant du lien") et que votre clé API Google Drive est active.';
      throw new Error(msg);
    }

    const data = await res.json();
    const rawFiles: DriveFileEntry[] = Array.isArray(data.files) ? data.files : [];
    filesToFetch = rawFiles.filter(
      (f) =>
        f.name.toLowerCase().endsWith('.tpack') || f.name.toLowerCase().endsWith('.zip')
    );

    if (filesToFetch.length === 0) {
      throw new Error(
        'Aucun fichier .tpack trouvé dans ce dossier Google Drive (vérifiez que le dossier est bien partagé en lecture).'
      );
    }
  }

  const imported: ClinicalCaseItem[] = [];

  for (let i = 0; i < filesToFetch.length; i++) {
    const entry = filesToFetch[i];
    if (onProgress) {
      onProgress(i + 1, filesToFetch.length, entry.name);
    }

    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      entry.id
    )}?alt=media&key=${encodeURIComponent(cleanKey)}`;

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) continue;

    const blob = await fileRes.blob();
    const fileObj = new File([blob], entry.name);
    try {
      const { manifest, bytes } = await inspectTPackFile(fileObj);
      const item = buildClinicalCaseFromManifest(manifest, bytes, entry.name, 'indexeddb', {
        origin: 'drive',
      });
      await saveClinicalCaseToIndexedDB(item);
      imported.push(item);
    } catch {
      // Ignorer si non-.tpack
    }
  }

  return imported;
}
