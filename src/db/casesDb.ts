import { unzipSync, strFromU8 } from 'fflate';
import { ClinicalCaseItem, PedagogicalManifest } from '../types';

const DB_NAME = 'tpack_cases_site_db_v1';
const STORE_NAME = 'clinical_cases';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveClinicalCaseToIndexedDB(item: ClinicalCaseItem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function listClinicalCasesFromIndexedDB(): Promise<ClinicalCaseItem[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        db.close();
        const items = (req.result as ClinicalCaseItem[]) || [];
        items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        resolve(items);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

export async function deleteClinicalCaseFromIndexedDB(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function fetchPublicCatalog(): Promise<ClinicalCaseItem[]> {
  try {
    const res = await fetch('./cases/catalog.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? (list as ClinicalCaseItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Extrait le manifest.json d'un fichier .tpack en mémoire pour pré-remplir automatiquement la fiche clinique
 */
export async function inspectTPackFile(file: File): Promise<{
  manifest: PedagogicalManifest;
  bytes: Uint8Array;
}> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const unzipped = unzipSync(bytes);
  const manifestBytes = unzipped['manifest.json'];
  if (!manifestBytes) {
    throw new Error('Fichier .tpack invalide : manifest.json introuvable.');
  }
  const manifest = JSON.parse(strFromU8(manifestBytes)) as PedagogicalManifest;
  return { manifest, bytes };
}
