import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BookOpen,
  Plus,
  Play,
  ArrowLeft,
  Crosshair,
  Trash2,
  Download,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
  FolderOpen,
  Cloud,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { ClinicalCaseItem } from './types';
import {
  fetchPublicCatalog,
  listClinicalCasesFromIndexedDB,
  saveClinicalCaseToIndexedDB,
  deleteClinicalCaseFromIndexedDB,
  inspectTPackFile,
} from './db/casesDb';
import {
  buildClinicalCaseFromManifest,
  connectAndScanLocalDirectory,
  getSavedDirectoryHandle,
  loadSavedGoogleDriveConfig,
  supportsFileSystemAccessApi,
  syncFromGoogleDrive,
} from './db/storageConnectors';

const PROD_VIEWER_EMBED_URL = 'https://mrthomaslef.github.io/dicomviewer/?embed=1';

export const App: React.FC = () => {
  const [librarySource, setLibrarySource] = useState<'local' | 'drive'>('local');
  const [localCases, setLocalCases] = useState<ClinicalCaseItem[]>([]);
  const [publicCases, setPublicCases] = useState<ClinicalCaseItem[]>([]);
  const [activeCase, setActiveCase] = useState<ClinicalCaseItem | null>(null);
  const [filterModality, setFilterModality] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Volet droit pliable (fermé par défaut)
  const [isSidePanelOpen, setIsSidePanelOpen] = useState<boolean>(false);
  const [showDiagnosis, setShowDiagnosis] = useState<boolean>(false);

  // Dossier local mémorisé (FileSystemDirectoryHandle)
  const [savedDirHandle, setSavedDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [connectedFolderName, setConnectedFolderName] = useState<string | null>(null);

  // État de synchronisation (Dossier local ou Google Drive)
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  // Modal Google Drive Cloud
  const [showDriveModal, setShowDriveModal] = useState<boolean>(false);
  const [driveFolderUrl, setDriveFolderUrl] = useState<string>('');
  const [driveApiKey, setDriveApiKey] = useState<string>('');
  const [driveError, setDriveError] = useState<string | null>(null);

  const viewerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderFallbackInputRef = useRef<HTMLInputElement | null>(null);

  const refreshCases = useCallback(async () => {
    const [loc, pub, handle] = await Promise.all([
      listClinicalCasesFromIndexedDB(),
      fetchPublicCatalog(),
      getSavedDirectoryHandle(),
    ]);
    setLocalCases(loc);
    setPublicCases(pub);
    if (handle) {
      setSavedDirHandle(handle);
      setConnectedFolderName(handle.name);
    }
  }, []);

  useEffect(() => {
    refreshCases();
    const savedDrive = loadSavedGoogleDriveConfig();
    setDriveFolderUrl(savedDrive.folderUrlOrId);
    setDriveApiKey(savedDrive.apiKey);
  }, [refreshCases]);

  const localLibraryCases = useMemo(() => {
    return [
      ...localCases.filter((c) => c.origin !== 'drive'),
      ...publicCases.filter((p) => !localCases.some((l) => l.id === p.id)),
    ];
  }, [localCases, publicCases]);

  const driveLibraryCases = useMemo(() => {
    return localCases.filter((c) => c.origin === 'drive');
  }, [localCases]);

  const allCases = useMemo(() => {
    return librarySource === 'local' ? localLibraryCases : driveLibraryCases;
  }, [librarySource, localLibraryCases, driveLibraryCases]);

  const filteredCases = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allCases.filter((c) => {
      if (filterModality !== 'ALL' && c.modality !== filterModality) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.anatomicalRegion.toLowerCase().includes(q) ||
        c.clinicalHistory.toLowerCase().includes(q) ||
        c.diagnosis.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    });
  }, [allCases, filterModality, searchQuery]);

  const pushCaseToEmbeddedViewer = useCallback((caseItem: ClinicalCaseItem) => {
    const win = viewerIframeRef.current?.contentWindow;
    if (!win) return;

    const caseMeta = {
      title: caseItem.title,
      clinicalHistory: caseItem.clinicalHistory,
      diagnosis: caseItem.diagnosis,
      anatomicalRegion: caseItem.anatomicalRegion,
      keySliceIndex: caseItem.keySliceIndex,
    };

    if (caseItem.tpackBytes) {
      win.postMessage(
        {
          type: 'TPACK_LOAD_BUFFER',
          buffer: caseItem.tpackBytes,
          caseMeta,
        },
        '*'
      );
    } else if (caseItem.tpackUrl) {
      win.postMessage(
        {
          type: 'TPACK_LOAD_URL',
          url: new URL(caseItem.tpackUrl, window.location.href).href,
          caseMeta,
        },
        '*'
      );
    }
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'TPACK_EMBED_READY' && activeCase) {
        pushCaseToEmbeddedViewer(activeCase);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeCase, pushCaseToEmbeddedViewer]);

  useEffect(() => {
    if (activeCase) {
      pushCaseToEmbeddedViewer(activeCase);
    }
  }, [activeCase, pushCaseToEmbeddedViewer]);

  const sendGotoCommand = (opts: {
    sliceIndex?: number;
    windowKey?: string;
    seriesId?: string;
    showAnnotations?: boolean;
  }) => {
    const win = viewerIframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'TPACK_GOTO', ...opts }, '*');
  };

  const handleOpenCaseStudy = (c: ClinicalCaseItem) => {
    setActiveCase(c);
    setShowDiagnosis(false);
    setIsSidePanelOpen(false);
  };

  /**
   * Import de fichiers .tpack (glisser-déposer, sélection de fichiers ou dossier fallback)
   */
  const handleImportTPackFiles = async (files: FileList | File[], openSingle: boolean = true) => {
    const validFiles = Array.from(files).filter(
      (f) =>
        (f.name.toLowerCase().endsWith('.tpack') || f.name.toLowerCase().endsWith('.zip')) &&
        !f.name.startsWith('._')
    );
    if (validFiles.length === 0) return;

    setIsSyncing(true);
    let lastImported: ClinicalCaseItem | null = null;

    try {
      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];
        setSyncStatus(`Indexation (${i + 1}/${validFiles.length}) : ${file.name}`);
        try {
          const { manifest, bytes } = await inspectTPackFile(file);
          const item = buildClinicalCaseFromManifest(manifest, bytes, file.name, 'indexeddb', {
            origin: 'local',
          });
          await saveClinicalCaseToIndexedDB(item);
          lastImported = item;
        } catch {
          // Ignorer les fichiers invalides
        }
      }
      await refreshCases();
      setLibrarySource('local');
      if (openSingle && validFiles.length === 1 && lastImported) {
        handleOpenCaseStudy(lastImported);
      }
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  /**
   * Connexion à un dossier local de .tpack (ou dossier Google Drive for Desktop)
   */
  const handleConnectLocalFolder = async (useRemembered: boolean = false) => {
    if (!supportsFileSystemAccessApi()) {
      folderFallbackInputRef.current?.click();
      return;
    }

    setIsSyncing(true);
    setSyncStatus('Lecture du dossier .tpack...');
    try {
      const { folderName, cases } = await connectAndScanLocalDirectory(
        useRemembered ? savedDirHandle : null,
        (cur, tot) => {
          setSyncStatus(`Synchronisation du dossier (${cur}/${tot})...`);
        }
      );
      setConnectedFolderName(folderName);
      await refreshCases();
      setLibrarySource('local');
      if (cases.length === 0) {
        setSyncStatus(`Aucun fichier .tpack trouvé dans "${folderName}".`);
        setTimeout(() => setSyncStatus(null), 3000);
      } else {
        setSyncStatus(null);
      }
    } catch {
      setSyncStatus(null);
    } finally {
      setIsSyncing(false);
    }
  };

  /**
   * Synchronisation depuis un dossier Google Drive Cloud via API v3
   */
  const handleSyncGoogleDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    setDriveError(null);
    setIsSyncing(true);
    try {
      const imported = await syncFromGoogleDrive(
        driveFolderUrl,
        driveApiKey,
        (cur, tot, name) => {
          setSyncStatus(`Google Drive (${cur}/${tot}) : ${name}`);
        }
      );
      await refreshCases();
      setLibrarySource('drive');
      setShowDriveModal(false);
      if (imported.length === 1) {
        handleOpenCaseStudy(imported[0]);
      }
    } catch (err) {
      setDriveError(err instanceof Error ? err.message : 'Erreur Google Drive');
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleDownloadCaseTpack = (c: ClinicalCaseItem) => {
    if (!c.tpackBytes) return;
    const blob = new Blob(
      [
        c.tpackBytes.buffer.slice(
          c.tpackBytes.byteOffset,
          c.tpackBytes.byteOffset + c.tpackBytes.byteLength
        ) as ArrayBuffer,
      ],
      { type: 'application/octet-stream' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.id.toLowerCase()}.tpack`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
      className="h-[100dvh] w-screen flex flex-col bg-[#090D16] text-slate-100 overflow-hidden box-border"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) {
          handleImportTPackFiles(e.dataTransfer.files, true);
        }
      }}
    >
      {/* Inputs cachés pour import de fichiers ou de dossier complet */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".tpack,.zip"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            handleImportTPackFiles(e.target.files, true);
            e.target.value = '';
          }
        }}
      />
      <input
        ref={folderFallbackInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory pour sélection de dossier complet sur Safari/Firefox/Mobile
        webkitdirectory="true"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            handleImportTPackFiles(e.target.files, false);
            e.target.value = '';
          }
        }}
      />

      {/* HEADER COMPACT */}
      <header className="h-11 shrink-0 bg-[#090D16] border-b border-slate-800/90 px-3 flex items-center justify-between gap-2 z-30">
        <div className="flex items-center gap-2 min-w-0">
          {activeCase ? (
            <button
              type="button"
              onClick={() => setActiveCase(null)}
              className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-cyan-300 flex items-center gap-1 transition cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Base ({allCases.length})</span>
            </button>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <BookOpen className="w-3.5 h-3.5" />
            </div>
          )}

          <span className="font-bold text-xs sm:text-sm text-white truncate">
            {activeCase ? activeCase.title : 'TPack.cases'}
          </span>
        </div>

        {/* Boutons de connexion à la bibliothèque (Dossier Local, Google Drive, Fichier) */}
        <div className="flex items-center gap-1.5 shrink-0">
          {!activeCase && (
            <>
              {savedDirHandle && (
                <button
                  type="button"
                  onClick={() => handleConnectLocalFolder(true)}
                  disabled={isSyncing}
                  className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs text-cyan-300 flex items-center gap-1 transition cursor-pointer"
                  title={`Actualiser le dossier local "${connectedFolderName}"`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  <span className="hidden md:inline max-w-[110px] truncate">
                    {connectedFolderName}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleConnectLocalFolder(false)}
                disabled={isSyncing}
                className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition cursor-pointer"
                title="Pointer vers un dossier local de fichiers .tpack (ou Google Drive Desktop)"
              >
                <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
                <span className="hidden sm:inline">Dossier Local</span>
              </button>

              <button
                type="button"
                onClick={() => setShowDriveModal(true)}
                disabled={isSyncing}
                className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition cursor-pointer"
                title="Connecter un dossier Google Drive"
              >
                <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden sm:inline">Google Drive</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs flex items-center gap-1 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>.tpack</span>
              </button>
            </>
          )}

          {activeCase && (
            <button
              type="button"
              onClick={() => setIsSidePanelOpen((v) => !v)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 border transition cursor-pointer ${
                isSidePanelOpen
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'bg-slate-900 border-slate-700 text-slate-200 hover:border-cyan-500/50'
              }`}
              title="Replier / Déplier le volet clinique"
            >
              {isSidePanelOpen ? (
                <PanelRightClose className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <PanelRightOpen className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span>Infos</span>
            </button>
          )}
        </div>
      </header>

      {/* Barre de progression de synchronisation si active */}
      {syncStatus && (
        <div className="bg-cyan-950/80 border-b border-cyan-500/30 px-4 py-1.5 text-xs text-cyan-200 flex items-center justify-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
          <span>{syncStatus}</span>
        </div>
      )}

      {/* VUE 1 : LECTEUR .TPACK PLEIN ÉCRAN + VOLET DROIT PLIABLE */}
      {activeCase ? (
        <div className="flex-1 min-h-0 w-full flex relative overflow-hidden">
          <div className="relative flex-1 min-w-0 min-h-0 h-full bg-[#090D16]">
            <iframe
              ref={viewerIframeRef}
              src={PROD_VIEWER_EMBED_URL}
              title={activeCase.title}
              className="absolute inset-0 w-full h-full border-0 block bg-[#090D16]"
              allow="fullscreen"
              onLoad={() => pushCaseToEmbeddedViewer(activeCase)}
            />
          </div>

          {isSidePanelOpen && (
            <aside className="w-64 sm:w-72 h-full bg-[#0B101B]/95 backdrop-blur-md border-l border-slate-800 p-3.5 overflow-y-auto flex flex-col gap-3 z-30 absolute right-0 top-0 bottom-0 md:static shrink-0 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                    {activeCase.modality}
                  </span>
                  {activeCase.anatomicalRegion && (
                    <span className="text-xs font-medium text-slate-300 truncate">
                      {activeCase.anatomicalRegion}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setIsSidePanelOpen(false)}
                  className="p-1 rounded text-slate-400 hover:text-white cursor-pointer"
                >
                  <PanelRightClose className="w-4 h-4" />
                </button>
              </div>

              {activeCase.clinicalHistory && (
                <div className="space-y-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Clinique
                  </div>
                  <p className="text-xs text-slate-200 leading-snug bg-slate-900/70 p-2.5 rounded-lg border border-slate-800/80">
                    {activeCase.clinicalHistory}
                  </p>
                </div>
              )}

              <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={() => {
                    const next = !showDiagnosis;
                    setShowDiagnosis(next);
                    if (next) {
                      sendGotoCommand({
                        seriesId: activeCase.keySeriesId,
                        sliceIndex: activeCase.keySliceIndex,
                        windowKey: activeCase.keyWindowKey,
                        showAnnotations: true,
                      });
                    } else {
                      sendGotoCommand({
                        showAnnotations: false,
                      });
                    }
                  }}
                  className="w-full py-2 px-2.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  {showDiagnosis ? (
                    <>
                      <EyeOff className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Masquer réponse &amp; annotations</span>
                    </>
                  ) : (
                    <>
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Révéler réponse &amp; annotations</span>
                    </>
                  )}
                </button>

                {showDiagnosis && (
                  <div className="space-y-2.5">
                    <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-100 leading-snug">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
                        Diagnostic &amp; Réponse
                      </div>
                      {activeCase.diagnosis || 'Aucun diagnostic textuel spécifié.'}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        sendGotoCommand({
                          seriesId: activeCase.keySeriesId,
                          sliceIndex: activeCase.keySliceIndex,
                          windowKey: activeCase.keyWindowKey,
                          showAnnotations: true,
                        })
                      }
                      className="w-full py-1.5 px-2.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                    >
                      <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Coupe Clé (#{activeCase.keySliceIndex + 1})</span>
                    </button>

                    {activeCase.annotatedSlices && activeCase.annotatedSlices.length > 0 && (
                      <div className="space-y-1 pt-1">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Annotations ({activeCase.annotatedSlices.length})
                        </div>
                        {activeCase.annotatedSlices.map((ann, i) => (
                          <button
                            key={`${ann.seriesId}_${ann.sliceIndex}_${i}`}
                            type="button"
                            onClick={() =>
                              sendGotoCommand({
                                seriesId: ann.seriesId,
                                sliceIndex: ann.sliceIndex,
                                showAnnotations: true,
                              })
                            }
                            className="w-full text-left px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 flex items-center justify-between gap-1 cursor-pointer"
                          >
                            <span className="truncate">{ann.label}</span>
                            <span className="text-[10px] font-mono text-cyan-400 shrink-0">
                              #{ann.sliceIndex + 1}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      ) : (
        /* VUE 2 : BASE DE DONNÉES DE CAS (.TPACK) */
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-4xl mx-auto space-y-4">
            {/* Sélecteur de Source : Bibliothèque Locale vs Google Drive */}
            <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl bg-[#0B101B] border border-slate-800">
              <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setLibrarySource('local')}
                  className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
                    librarySource === 'local'
                      ? 'bg-cyan-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <FolderOpen className="w-4 h-4 shrink-0" />
                  <span>Bibliothèque Locale ({localLibraryCases.length})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setLibrarySource('drive')}
                  className={`px-3.5 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition cursor-pointer ${
                    librarySource === 'drive'
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Cloud className="w-4 h-4 shrink-0" />
                  <span>Mon Google Drive ({driveLibraryCases.length})</span>
                </button>
              </div>
            </div>

            {allCases.length === 0 ? (
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Carte 1 : Pointer vers un dossier local ou Google Drive Desktop */}
                <button
                  type="button"
                  onClick={() => handleConnectLocalFolder(false)}
                  className="border border-slate-800 hover:border-cyan-500/50 rounded-2xl p-6 flex flex-col items-center text-center gap-3 bg-[#0B101B] transition cursor-pointer"
                >
                  <div className="w-11 h-11 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                    <FolderOpen className="w-5 h-5" />
                  </div>
                  <div className="text-sm font-bold text-white">
                    Pointer vers un Dossier Local / Google Drive Desktop
                  </div>
                  <p className="text-xs text-slate-400">
                    Sélectionnez le dossier contenant vos fichiers <code className="text-cyan-300">.tpack</code> sur votre ordinateur pour charger toute votre base.
                  </p>
                </button>

                {/* Carte 2 : Connecter un dossier Google Drive Cloud par lien */}
                <button
                  type="button"
                  onClick={() => setShowDriveModal(true)}
                  className="border border-slate-800 hover:border-emerald-500/50 rounded-2xl p-6 flex flex-col items-center text-center gap-3 bg-[#0B101B] transition cursor-pointer"
                >
                  <div className="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                    <Cloud className="w-5 h-5" />
                  </div>
                  <div className="text-sm font-bold text-white">
                    Connecter un Dossier Google Drive (Cloud)
                  </div>
                  <p className="text-xs text-slate-400">
                    Synchronisez un dossier Google Drive partagé en ligne pour accéder à votre base depuis n’importe quel appareil.
                  </p>
                </button>
              </div>
            ) : (
              <>
                {/* Barre de recherche & Filtres par modalité */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Rechercher par titre, région, clinique, diagnostic..."
                      className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-[#0B101B] border border-slate-800 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center gap-1 overflow-x-auto">
                    {(['ALL', 'CT', 'MR', 'CR', 'US'] as const).map((mod) => (
                      <button
                        key={mod}
                        type="button"
                        onClick={() => setFilterModality(mod)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                          filterModality === mod
                            ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {mod === 'ALL' ? `Tous (${allCases.length})` : mod}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Grille des Cas */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredCases.map((c) => (
                    <div
                      key={`${c.source}_${c.id}`}
                      onClick={() => handleOpenCaseStudy(c)}
                      className="rounded-xl bg-[#0B101B] border border-slate-800 hover:border-cyan-500/50 p-4 flex flex-col justify-between gap-3 transition cursor-pointer group"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono font-bold text-[10px]">
                              {c.modality}
                            </span>
                            {c.anatomicalRegion && (
                              <span className="text-xs text-slate-400">{c.anatomicalRegion}</span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-500 font-mono">
                            {(c.byteSize / 1024).toFixed(0)} Ko
                          </span>
                        </div>

                        <h2 className="text-sm font-bold text-white group-hover:text-cyan-300 transition">
                          {c.title}
                        </h2>
                        {c.clinicalHistory && (
                          <p className="text-xs text-slate-400 line-clamp-2">
                            {c.clinicalHistory}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-800/70">
                        <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1">
                          <Play className="w-3 h-3 fill-current" /> Ouvrir
                        </span>

                        <div
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.tpackBytes && (
                            <button
                              type="button"
                              onClick={() => handleDownloadCaseTpack(c)}
                              className="p-1.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300"
                              title="Télécharger .tpack"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {c.source === 'indexeddb' && (
                            <button
                              type="button"
                              onClick={async () => {
                                await deleteClinicalCaseFromIndexedDB(c.id);
                                await refreshCases();
                              }}
                              className="p-1.5 rounded bg-slate-900 hover:bg-red-950/60 text-slate-400 hover:text-red-300"
                              title="Retirer de la base"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      )}

      {/* MODAL DE CONNEXION GOOGLE DRIVE */}
      {showDriveModal && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowDriveModal(false)}
        >
          <div
            className="bg-[#0B101B] border border-slate-800 rounded-2xl max-w-md w-full p-4 space-y-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                <Cloud className="w-4 h-4" />
                <span>Connecter un Dossier Google Drive</span>
              </div>
              <button
                type="button"
                onClick={() => setShowDriveModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSyncGoogleDrive} className="space-y-3 text-xs">
              <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] text-slate-300 space-y-1">
                <div>
                  <strong className="text-cyan-300">Astuce Mac/PC sans clé API :</strong> si
                  l&apos;application <em>Google Drive Desktop</em> est installée sur votre
                  ordinateur, cliquez simplement sur <strong>Dossier Local</strong> et sélectionnez
                  votre dossier Google Drive.
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">
                  Lien ou ID du dossier Google Drive partagé
                </label>
                <input
                  type="text"
                  required
                  value={driveFolderUrl}
                  onChange={(e) => setDriveFolderUrl(e.target.value)}
                  placeholder="https://drive.google.com/drive/folders/1A2B3C..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">
                  Clé API Google Drive (mémorisée localement)
                </label>
                <input
                  type="password"
                  required
                  value={driveApiKey}
                  onChange={(e) => setDriveApiKey(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 focus:border-emerald-500 focus:outline-none font-mono"
                />
              </div>

              {driveError && (
                <div className="p-2 rounded bg-red-950/70 border border-red-500/40 text-red-200 text-[11px]">
                  {driveError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowDriveModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isSyncing}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold cursor-pointer"
                >
                  Synchroniser le Drive
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
